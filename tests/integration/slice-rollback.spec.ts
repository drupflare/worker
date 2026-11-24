import { describe, expect, it } from 'vitest';
import { GROWTH_REFUSED_HEADER, GrowthRefused, ROLLED_BACK_HEADER } from '../../src/do/growth/cap';
import {
	canRunSlice,
	deferEffect,
	runSlice,
	sliceRollbackEnabled,
	sliceRunning,
	type SliceInstance
} from '../../src/do/slice';
import type { SiteEnv } from '../../src/env';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

const MIB = 1_048_576;
const REQUEST_TIMEOUT = 300_000;

const OVER_CAP = `$a = []; for ($i = 0; $i < 64; $i++) { $a[] = str_repeat('x', 4 * 1048576); }`;

/** one statement through a bridge the driver or the WordPress layer reaches, as PHP sends it */
const bridge = (name: string, payload: string) =>
	`$f = vrzno_env('${name}'); $r = json_decode($f(json_encode(pw_encode(${payload}))), true); if (empty($r['ok'])) { echo 'bridge failed: ' . json_encode($r); }`;
const insert = (v: string) =>
	bridge(
		'cfwSqlExec',
		`['sql' => "INSERT INTO slice_probe (v) VALUES ('${v}')", 'params' => []]`
	);
const insertInTxn = (v: string, commit: boolean) =>
	bridge(
		'cfwSqlTxn',
		`['statements' => [['sql' => "INSERT INTO slice_probe (v) VALUES ('${v}')", 'params' => []]], 'commit' => ${commit}, 'read' => null]`
	);

async function bootSize(site: ServeDo): Promise<number> {
	await site.ensurePhp();
	const bytes = site.heapNow();
	site.dropInterpreter();
	return bytes;
}

async function withVars<T>(site: ServeDo, vars: Record<string, string>, fn: () => Promise<T>) {
	const target = site.env as unknown as Record<string, string | undefined>;
	const before = Object.fromEntries(Object.keys(vars).map((k) => [k, target[k]]));
	Object.assign(target, vars);
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(before)) {
			if (v === undefined) delete target[k];
			else target[k] = v;
		}
	}
}

/** a site whose cap sits 8 MiB over the boot size, with an empty probe table */
async function capped<T>(vars: Record<string, string>, fn: (site: ServeDo) => Promise<T>) {
	return inObject(freshSite(), async (site: ServeDo) => {
		const start = await bootSize(site);
		return withVars(site, { GROWTH_CAP_BYTES: String(start + 8 * MIB), ...vars }, async () => {
			site.ensureServeTables();
			site.sql.exec('CREATE TABLE IF NOT EXISTS slice_probe (v TEXT)');
			site.sql.exec('DELETE FROM slice_probe');
			await site.ensurePhp();
			return fn(site);
		});
	});
}

const rowsOf = (site: ServeDo) =>
	site.sql
		.exec('SELECT v FROM slice_probe ORDER BY rowid')
		.toArray()
		.map((r) => r['v']);

async function refused(site: ServeDo, code: string): Promise<unknown> {
	try {
		await site.run(code);
	} catch (e) {
		return e;
	}
	return undefined;
}

describe('a governed run is one transaction', () => {
	it(
		'undoes the writes of a run the cap refuses, and the control that keeps them is the old behaviour',
		async () => {
			const out = await capped({}, async (site) => {
				const thrown = await refused(
					site,
					`<?php ${insert('before')} ${OVER_CAP} ${insert('after')}`
				);
				return { thrown, rows: rowsOf(site), rolledBack: site.rolledBackRuns };
			});
			expect(out.thrown).toBeInstanceOf(GrowthRefused);
			expect((out.thrown as GrowthRefused).rolledBack).toBe(true);
			expect(out.rows).toEqual([]);

			const control = await capped({ GROWTH_ROLLBACK: '0' }, async (site) => {
				const thrown = await refused(
					site,
					`<?php ${insert('before')} ${OVER_CAP} ${insert('after')}`
				);
				return { thrown, rows: rowsOf(site) };
			});
			expect(control.thrown).toBeInstanceOf(GrowthRefused);
			expect((control.thrown as GrowthRefused).rolledBack).toBe(false);
			expect(control.rows).toEqual(['before']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'undoes a Drupal transaction that had already committed inside the slice',
		async () => {
			const out = await capped({}, async (site) => {
				const thrown = await refused(
					site,
					`<?php ${insertInTxn('t1', true)} ${OVER_CAP} ${insert('after')}`
				);
				return { thrown, rows: rowsOf(site) };
			});
			expect(out.thrown).toBeInstanceOf(GrowthRefused);
			expect(out.rows, 'the inner transactionSync escaped the outer one').toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'lets a speculative replay roll back inside the slice without taking the slice with it',
		async () => {
			const out = await capped({}, async (site) => {
				const reply = await site.run(
					`<?php ${insertInTxn('speculative', false)} ${insert('kept')} echo 'done';`
				);
				return { reply, rows: rowsOf(site) };
			});
			expect(out.reply).toContain('done');
			expect(out.reply).not.toContain('bridge failed');
			expect(out.rows).toEqual(['kept']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'commits a run that ends in a fatal, as an unwrapped run does',
		async () => {
			const out = await capped({}, async (site) => {
				await site.run(`<?php ${insert('before')} no_such_function_here();`);
				return rowsOf(site);
			});
			expect(out).toEqual(['before']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'commits a run that ends in exit() and returns its page, and refuses nothing for it',
		async () => {
			const run = async (vars: Record<string, string>) =>
				capped(vars, async (site) => {
					let transactions = 0;
					const storage = site.storage as unknown as {
						transactionSync: (fn: () => unknown) => unknown;
					};
					const real = storage.transactionSync.bind(storage);
					storage.transactionSync = (fn: () => unknown) => {
						transactions += 1;
						return real(fn);
					};
					try {
						const page = await site.run(
							`<?php ${insert('before')} echo 'page'; exit(0);`
						);
						const refusals = site.governedRuns ?? 0;
						return { page, rows: rowsOf(site), transactions, refusals };
					} finally {
						storage.transactionSync = real;
					}
				});

			const governed = await run({});
			expect(governed.page).toBe('page');
			expect(governed.rows).toEqual(['before']);
			expect(governed.transactions, 'the run did not go through a slice').toBe(1);
			expect(governed.refusals).toBe(0);

			// the control: the unwrapped path gives the same page and rows, so the slice changed neither
			const control = await run({ GROWTH_ROLLBACK: '0' });
			expect(control.transactions).toBe(0);
			expect({ page: control.page, rows: control.rows }).toEqual({
				page: governed.page,
				rows: governed.rows
			});
		},
		REQUEST_TIMEOUT
	);

	it(
		'rolls back the writes of a run that traps and still carries the trap message to the caller',
		async () => {
			const run = async (vars: Record<string, string>) =>
				capped(vars, async (site) => {
					const inst = await site.ensurePhp();
					const binary = inst.binary as unknown as {
						ccall: (...args: unknown[]) => unknown;
					};
					const real = binary.ccall;
					// the trap lands after PHP wrote its row, as one from a later statement would
					binary.ccall = function (this: unknown, ...args: unknown[]) {
						const ret = real.apply(this, args);
						if (args[0] !== 'pib_run') return ret;
						throw new WebAssembly.RuntimeError('memory access out of bounds');
					};
					const thrown = await refused(site, `<?php ${insert('before')}`);
					binary.ccall = real;
					return {
						thrown,
						rows: rowsOf(site),
						trapped: site.trappedRuns,
						dropped: site.php === undefined
					};
				});

			const governed = await run({});
			expect(String((governed.thrown as Error)?.message)).toContain('out of bounds');
			expect(governed.rows, 'the trap kept the slice that hit it').toEqual([]);
			expect(governed.trapped).toBe(1);
			expect(governed.dropped).toBe(true);

			// the control: without the transaction the statement that ran before the trap stays
			const control = await run({ GROWTH_ROLLBACK: '0' });
			expect(String((control.thrown as Error)?.message)).toContain('out of bounds');
			expect(control.rows).toEqual(['before']);
			expect(control.dropped).toBe(true);
		},
		REQUEST_TIMEOUT
	);

	it(
		'rolls back the refused slice only, and keeps a slice that returned before it',
		async () => {
			const out = await capped({}, async (site) => {
				await site.run(`<?php ${insert('one')}`);
				const thrown = await refused(site, `<?php ${insert('two')} ${OVER_CAP}`);
				return { thrown, rows: rowsOf(site), written: site.sliceWrites };
			});
			expect(out.thrown).toBeInstanceOf(GrowthRefused);
			expect(out.rows).toEqual(['one']);
			expect(out.written).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'does not wrap an exempt phase, whose cap is lifted',
		async () => {
			const out = await capped({}, async (site) => {
				let calls = 0;
				const storage = site.storage as unknown as {
					transactionSync: (fn: () => unknown) => unknown;
				};
				const real = storage.transactionSync.bind(storage);
				storage.transactionSync = (fn: () => unknown) => {
					calls += 1;
					return real(fn);
				};
				try {
					await site.run(`<?php echo 'governed';`);
					const governed = calls;
					calls = 0;
					site.growthExempt = 1;
					await site.run(`<?php echo 'exempt';`);
					site.growthExempt = 0;
					return { governed, exempt: calls };
				} finally {
					storage.transactionSync = real;
				}
			});
			expect(out.governed).toBe(1);
			expect(out.exempt).toBe(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'writes the same rows with the transaction on and off, so a normal render pays nothing extra',
		async () => {
			const measure = async (vars: Record<string, string>) =>
				capped(vars, async (site) => {
					const before = site.rowsSinceFlush ?? 0;
					await site.run(`<?php ${insert('a')} ${insert('b')} ${insertInTxn('c', true)}`);
					return (site.rowsSinceFlush ?? 0) - before;
				});
			const on = await measure({});
			const off = await measure({ GROWTH_ROLLBACK: '0' });
			expect(on).toBeGreaterThan(0);
			expect(on).toBe(off);
		},
		REQUEST_TIMEOUT
	);
});

describe('what the front door says after a refusal', () => {
	it(
		'answers a refused POST that wrote nothing before it with nothing saved',
		async () => {
			const out = await capped({}, async (site) => {
				site.handle = async () => {
					await site.run(`<?php ${insert('x')} ${OVER_CAP}`);
					return new Response('unreachable');
				};
				const res = await site.fetch(
					new Request('https://do.local/__serve?path=%2Fnode%2Fadd', {
						method: 'POST',
						body: 'a=b'
					})
				);
				return {
					status: res.status,
					growth: res.headers.get(GROWTH_REFUSED_HEADER),
					rolled: res.headers.get(ROLLED_BACK_HEADER),
					body: await res.text(),
					rows: rowsOf(site)
				};
			});
			expect(out.status).toBe(503);
			expect(out.growth).toBe('1');
			expect(out.rolled).toBe('all');
			expect(out.body).toContain('Nothing it did was saved');
			expect(out.rows).toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'says earlier steps were kept when a slice before the refused one wrote',
		async () => {
			const out = await capped({}, async (site) => {
				site.handle = async () => {
					await site.run(`<?php ${insert('one')}`);
					await site.run(`<?php ${insert('two')} ${OVER_CAP}`);
					return new Response('unreachable');
				};
				const res = await site.fetch(
					new Request('https://do.local/__serve?path=%2Fnode%2Fadd', {
						method: 'POST',
						body: 'a=b'
					})
				);
				return {
					rolled: res.headers.get(ROLLED_BACK_HEADER),
					body: await res.text(),
					rows: rowsOf(site)
				};
			});
			expect(out.rolled).toBe('slice');
			expect(out.body).toContain('Steps that finished before it were saved');
			expect(out.rows).toEqual(['one']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'keeps the old wording when the transaction is off',
		async () => {
			const out = await capped({ GROWTH_ROLLBACK: '0' }, async (site) => {
				site.handle = async () => {
					await site.run(`<?php ${insert('x')} ${OVER_CAP}`);
					return new Response('unreachable');
				};
				const res = await site.fetch(
					new Request('https://do.local/__serve?path=%2Fnode%2Fadd', {
						method: 'POST',
						body: 'a=b'
					})
				);
				return { rolled: res.headers.get(ROLLED_BACK_HEADER), body: await res.text() };
			});
			expect(out.rolled).toBeNull();
			expect(out.body).toContain('may have been saved');
		},
		REQUEST_TIMEOUT
	);
});

describe('the effect outbox', () => {
	/** a storage whose transaction undoes the rows a thrown callback added */
	const storage = () => {
		const rows: string[] = [];
		return {
			rows,
			transactionSync<T>(fn: () => T): T {
				const mark = rows.length;
				try {
					return fn();
				} catch (e) {
					rows.length = mark;
					throw e;
				}
			}
		};
	};
	const instance = (ccall: () => unknown): SliceInstance =>
		({ php: { flush() {} }, binary: { ccall } }) as unknown as SliceInstance;
	const exit1 = () => Object.assign(new Error('exit'), { name: 'ExitStatus', status: 1 });

	it('fires queued effects in order after the commit', () => {
		const s = storage();
		const fired: string[] = [];
		const inst = instance(() => {
			s.rows.push('w');
			deferEffect(() => fired.push(`first after ${s.rows.length} row`));
			deferEffect(() => fired.push('second'));
			expect(sliceRunning()).toBe(true);
			return 0;
		});
		const { ret } = runSlice(inst, s, '<?php 1;', () => false);
		expect(ret).toBe(0);
		expect(fired).toEqual(['first after 1 row', 'second']);
		expect(sliceRunning()).toBe(false);
	});

	it('drops them on a rollback, along with the rows', () => {
		const s = storage();
		const fired: string[] = [];
		const inst = instance(() => {
			s.rows.push('w');
			deferEffect(() => fired.push('mail'));
			throw exit1();
		});
		expect(() =>
			runSlice(inst, s, '<?php 1;', (e) => (e as Error).name === 'ExitStatus')
		).toThrow();
		expect(fired).toEqual([]);
		expect(s.rows).toEqual([]);
		expect(sliceRunning()).toBe(false);
	});

	it('commits and then rethrows an error the caller did not ask to roll back', () => {
		const s = storage();
		const fired: string[] = [];
		const inst = instance(() => {
			s.rows.push('w');
			deferEffect(() => fired.push('kept'));
			throw new Error('trap');
		});
		expect(() => runSlice(inst, s, '<?php 1;', () => false)).toThrow('trap');
		expect(s.rows).toEqual(['w']);
		expect(fired).toEqual(['kept']);
	});

	it('runs an effect at once outside a slice and flushes output either way', () => {
		const fired: string[] = [];
		deferEffect(() => fired.push('now'));
		expect(fired).toEqual(['now']);
		let flushed = 0;
		const s = storage();
		const inst = {
			php: {
				flush() {
					flushed += 1;
				}
			},
			binary: {
				ccall() {
					throw exit1();
				}
			}
		} as unknown as SliceInstance;
		expect(() => runSlice(inst, s, '<?php 1;', () => true)).toThrow();
		expect(flushed).toBe(1);
	});

	it('is chosen only where the interpreter can run synchronously', () => {
		expect(
			canRunSlice(
				instance(() => 0),
				storage()
			)
		).toBe(true);
		expect(
			canRunSlice({ php: { flush() {} }, binary: {} } as unknown as SliceInstance, storage())
		).toBe(false);
		expect(
			canRunSlice(
				instance(() => 0),
				undefined
			)
		).toBe(false);
		expect(sliceRollbackEnabled(undefined)).toBe(true);
		expect(sliceRollbackEnabled({ GROWTH_ROLLBACK: '0' } as SiteEnv)).toBe(false);
		expect(sliceRollbackEnabled({ GROWTH_ROLLBACK: '1' } as SiteEnv)).toBe(true);
	});
});
