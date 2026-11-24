import { describe, expect, it } from 'vitest';
import pristineGlue from '../../.interp/php8.5-worker.mjs';
import pristineWasm from '../../.interp/php8.5.wasm';
import { PhpStatic } from '../../src/do/boot/php';
import {
	BOOT_LINEAR_BYTES,
	DEFAULT_GROWTH_MARGIN_BYTES,
	GROWTH_REFUSED_HEADER,
	GrowthRefused,
	JS_SIDE_AT_MEASUREMENT_BYTES,
	STEADY_HEADROOM_BYTES,
	enterGrowthExempt,
	growthCapBytes,
	growthLedger,
	growthPhaseExempt,
	growthRefusedResponse,
	installGrowthCap,
	isExitOne,
	leaveGrowthExempt,
	memoryOf,
	releaseGrowthCap,
	syncGrowthCap,
	type GrowthRefusal,
	type GrowthSite
} from '../../src/do/growth/cap';
import {
	GROWTH_LOG_KEEP,
	growthRouteOf,
	readGrowthLog,
	recordGrowthRefusal
} from '../../src/do/growth/log';
import { takeSpareMemory } from '../../src/do/isolate';
import { serveStatsSync } from '../../src/do/stats';
import type { SiteEnv } from '../../src/env';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

const MIB = 1_048_576;
const PAGE = 65_536;
const NO_LEDGER = { jsSideBytes: 0 };
const REQUEST_TIMEOUT = 300_000;

const env = (vars: Record<string, string | number>) => vars as unknown as SiteEnv;
const memoryOfPages = (initial: number, maximum = 4096) =>
	new WebAssembly.Memory({ initial, maximum });

describe('the cap growthCapBytes chooses', () => {
	/** the ledger as it read when the headroom was measured */
	const AT_MEASUREMENT = { jsSideBytes: JS_SIDE_AT_MEASUREMENT_BYTES };

	it('is on unless GROWTH_GOVERNOR is 0', () => {
		expect(growthCapBytes(undefined, AT_MEASUREMENT)).toBeDefined();
		expect(growthCapBytes(env({}), AT_MEASUREMENT)).toBeDefined();
		expect(growthCapBytes(env({ GROWTH_GOVERNOR: '1' }), AT_MEASUREMENT)).toBeDefined();
		expect(growthCapBytes(env({ GROWTH_GOVERNOR: '0' }), AT_MEASUREMENT)).toBeUndefined();
		// the tuning vars do not turn the governor back on
		expect(
			growthCapBytes(
				env({ GROWTH_GOVERNOR: '0', GROWTH_HEADROOM_BYTES: 90 * MIB }),
				AT_MEASUREMENT
			)
		).toBeUndefined();
	});

	it('takes an explicit byte count over the ledger and over GROWTH_GOVERNOR', () => {
		expect(growthCapBytes(env({ GROWTH_CAP_BYTES: 100 * MIB }), AT_MEASUREMENT)).toBe(
			100 * MIB
		);
		expect(
			growthCapBytes(
				env({ GROWTH_CAP_BYTES: '104857600', GROWTH_GOVERNOR: '0' }),
				AT_MEASUREMENT
			)
		).toBe(100 * MIB);
		// an unusable explicit value falls back to the ledger rather than disabling it
		const ledger = growthCapBytes(env({}), AT_MEASUREMENT);
		expect(growthCapBytes(env({ GROWTH_CAP_BYTES: 'many' }), AT_MEASUREMENT)).toBe(ledger);
		expect(growthCapBytes(env({ GROWTH_CAP_BYTES: 0 }), AT_MEASUREMENT)).toBe(ledger);
		expect(growthCapBytes(env({ GROWTH_CAP_BYTES: -5 }), AT_MEASUREMENT)).toBe(ledger);
	});

	it('is the boot size plus the headroom minus the margin when the ledger reads as measured', () => {
		expect(BOOT_LINEAR_BYTES).toBe(1024 * PAGE);
		expect(STEADY_HEADROOM_BYTES).toBe(36 * MIB);
		expect(DEFAULT_GROWTH_MARGIN_BYTES).toBe(4 * MIB);
		// 64 + 36 - 4
		expect(growthCapBytes(env({}), AT_MEASUREMENT)).toBe(96 * MIB);
		expect(
			growthCapBytes(
				env({ GROWTH_HEADROOM_BYTES: 40 * MIB, GROWTH_MARGIN_BYTES: 8 * MIB }),
				AT_MEASUREMENT
			)
		).toBe(96 * MIB);
		// a zero margin is a margin, not an absent one
		expect(growthCapBytes(env({ GROWTH_MARGIN_BYTES: 0 }), AT_MEASUREMENT)).toBe(100 * MIB);
		expect(growthCapBytes(env({ GROWTH_MARGIN_BYTES: '' }), AT_MEASUREMENT)).toBe(96 * MIB);
	});

	it('is 18.3 MiB of JS side at the measurement, from the parts it names', () => {
		expect(JS_SIDE_AT_MEASUREMENT_BYTES / MIB).toBeCloseTo(18.3, 1);
	});

	it('rises by the bytes a staged pack frees and falls by the bytes a larger resident set adds', () => {
		const stock = { jsSideBytes: JS_SIDE_AT_MEASUREMENT_BYTES };
		const blob = 13_012_361;
		// COLD_PACK staged: the blob and the index it carries leave the ledger
		const staged = { jsSideBytes: JS_SIDE_AT_MEASUREMENT_BYTES - blob - 1_980_912 };
		const base = growthCapBytes(env({}), stock) as number;
		expect(growthCapBytes(env({}), staged)).toBe(base + blob + 1_980_912);
		// 6 MiB more resident files than at the measurement
		const heavier = { jsSideBytes: JS_SIDE_AT_MEASUREMENT_BYTES + 6 * MIB };
		expect(growthCapBytes(env({}), heavier)).toBe(base - 6 * MIB);
		// a freshly booted stock Drupal reads 0.92 MiB resident, so its cap is higher than 96
		const booted = growthLedger({
			blobBytes: blob,
			inflateStats: { residentBytes: 1_000_707 }
		} as never);
		expect(growthCapBytes(env({}), booted)).toBeGreaterThan(base);
	});

	it('never goes below the boot size, however large the JS side reads', () => {
		const huge = { jsSideBytes: JS_SIDE_AT_MEASUREMENT_BYTES + 200 * MIB };
		expect(growthCapBytes(env({}), huge)).toBe(BOOT_LINEAR_BYTES);
		expect(growthCapBytes(env({ GROWTH_HEADROOM_BYTES: 1 }), AT_MEASUREMENT)).toBe(
			BOOT_LINEAR_BYTES
		);
	});

	it('reads the ledger from the mount the object holds', () => {
		// no mount yet is the measured stock ledger, so a booting request is not given a higher cap
		expect(growthLedger(undefined)).toEqual(AT_MEASUREMENT);
		expect(growthCapBytes(env({}), growthLedger(undefined))).toBe(
			growthCapBytes(env({}), AT_MEASUREMENT)
		);
		const lazy = { blobBytes: 10 * MIB, inflateStats: { residentBytes: 2 * MIB } };
		const read = growthLedger(lazy as never);
		expect(read.jsSideBytes).toBeGreaterThan(12 * MIB);
		expect(read.jsSideBytes).toBeLessThan(15 * MIB);
	});
});

describe('the governor on a real WebAssembly.Memory', () => {
	const refusals = () => {
		const seen: GrowthRefusal[] = [];
		return { seen, onRefuse: (info: GrowthRefusal) => seen.push(info) };
	};

	it('refuses a grow past the cap, reports it, and leaves the memory as it was', () => {
		const memory = memoryOfPages(16);
		const binary = {};
		const { seen, onRefuse } = refusals();
		expect(installGrowthCap(binary, memory, 2 * MIB, onRefuse)).toBe(2 * MIB);

		expect(memory.grow(16)).toBe(16);
		expect(memory.buffer.byteLength).toBe(2 * MIB);
		expect(() => memory.grow(1)).toThrow(RangeError);
		expect(memory.buffer.byteLength).toBe(2 * MIB);
		expect(seen).toEqual([{ fromBytes: 2 * MIB, toBytes: 2 * MIB + PAGE, capBytes: 2 * MIB }]);
	});

	it('holds one governor when a spare or restarted memory is installed again', () => {
		const memory = memoryOfPages(16);
		const binary = {};
		const first = refusals();
		const second = refusals();
		installGrowthCap(binary, memory, 2 * MIB, first.onRefuse);
		installGrowthCap(binary, memory, 4 * MIB, second.onRefuse);

		// two stacked governors would refuse this at the first one's cap
		expect(memory.grow(32)).toBe(16);
		expect(memory.buffer.byteLength).toBe(3 * MIB);
		expect(() => memory.grow(32)).toThrow(RangeError);
		expect(first.seen).toEqual([]);
		expect(second.seen).toHaveLength(1);
	});

	it('takes the governor off on release and when the next install has no cap', () => {
		const memory = memoryOfPages(16);
		const binary = {};
		installGrowthCap(binary, memory, 2 * MIB, () => {});
		expect(Object.getOwnPropertyDescriptor(memory, 'grow')).toBeDefined();
		releaseGrowthCap(memory);
		expect(Object.getOwnPropertyDescriptor(memory, 'grow')).toBeUndefined();
		expect(memory.grow(64)).toBe(16);

		const again = memoryOfPages(16);
		installGrowthCap({}, again, 2 * MIB, () => {});
		expect(installGrowthCap({}, again, undefined, () => {})).toBeUndefined();
		expect(Object.getOwnPropertyDescriptor(again, 'grow')).toBeUndefined();
		releaseGrowthCap(undefined);
	});

	it('lifts a cap below the memory it already holds, so only growth is refused', () => {
		const memory = memoryOfPages(64);
		const effective = installGrowthCap({}, memory, 1 * MIB, () => {});
		expect(effective).toBe(4 * MIB);
		expect(() => memory.grow(1)).toThrow(RangeError);
		expect(memory.buffer.byteLength).toBe(4 * MIB);
	});

	it('finds a memory the instantiation exported through the binary it was remembered for', () => {
		const memory = memoryOfPages(16);
		const binary = {};
		expect(memoryOf(binary)).toBeUndefined();
		installGrowthCap(binary, memory, 2 * MIB, () => {});
		expect(memoryOf(binary)).toBe(memory);
		// a restarted instance hands over only its binary
		expect(installGrowthCap(binary, undefined, 3 * MIB, () => {})).toBe(3 * MIB);
		expect(() => memory.grow(33)).toThrow(RangeError);
		// and a binary nothing was remembered for has nothing to govern
		expect(installGrowthCap({}, undefined, 3 * MIB, () => {})).toBeUndefined();
	});

	it('truncates a fractional page count the way a native grow does', () => {
		const memory = memoryOfPages(16);
		installGrowthCap({}, memory, 2 * MIB, () => {});
		expect(memory.grow(16.9)).toBe(16);
		expect(memory.buffer.byteLength).toBe(2 * MIB);
	});
});

describe('what a refused grow answers', () => {
	it('names the exit the glue throws and nothing else', () => {
		expect(isExitOne({ name: 'ExitStatus', status: 1 })).toBe(true);
		expect(isExitOne({ name: 'ExitStatus', status: 0 })).toBe(false);
		expect(isExitOne({ name: 'ExitStatus', status: 255 })).toBe(false);
		expect(isExitOne(new Error('exit'))).toBe(false);
		expect(isExitOne(null)).toBe(false);
	});

	it('is a 503 the front worker may repeat for a safe method, and says so for an unsafe one', async () => {
		const get = growthRefusedResponse('GET');
		expect(get.status).toBe(503);
		expect(get.headers.get(GROWTH_REFUSED_HEADER)).toBe('1');
		expect(get.headers.get('cache-control')).toBe('no-store');
		expect(await get.text()).toContain('Try again');
		const head = growthRefusedResponse('HEAD');
		expect(head.body).toBeNull();
		const post = growthRefusedResponse('POST');
		expect(post.status).toBe(503);
		expect(await post.text()).toContain('may have been saved');
	});
});

describe('the memory an instantiation hands over', () => {
	it(
		'is the one a binary exports when it imports none, and governs the same way',
		async () => {
			expect(WebAssembly.Module.imports(pristineWasm).some((i) => i.kind === 'memory')).toBe(
				false
			);
			let held: WebAssembly.Memory | undefined;
			const php = new PhpStatic(
				{ factory: pristineGlue, module: pristineWasm },
				{},
				[],
				undefined,
				undefined,
				(memory) => (held = memory)
			);
			const binary = (await php.binary) as object;
			expect(held).toBeInstanceOf(WebAssembly.Memory);
			const memory = held as WebAssembly.Memory;
			const cap = memory.buffer.byteLength + 2 * MIB;
			expect(installGrowthCap(binary, memory, cap, () => {})).toBe(cap);
			expect(() => memory.grow(64)).toThrow(RangeError);
			expect(memory.buffer.byteLength).toBeLessThan(cap);
		},
		REQUEST_TIMEOUT
	);
});

const OVER_CAP_BODY = `$a = []; for ($i = 0; $i < 64; $i++) { $a[] = str_repeat('x', 4 * 1048576); } echo 'survived';`;
const OVER_CAP = `<?php ${OVER_CAP_BODY}`;

/** the body of one statement through the bridge, as PHP sends it */
const sqlFromPhp = (sql: string) =>
	`$f = vrzno_env('cfwMysqlExec'); $r = json_decode($f(json_encode(['sql' => ${JSON.stringify(sql)}])), true); if (empty($r['ok'])) { echo 'sql failed: ' . json_encode($r); }`;

/** boots an interpreter with no cap to read where it starts, drops it, and returns that size */
async function bootSize(site: ServeDo): Promise<number> {
	await site.ensurePhp();
	const bytes = site.heapNow();
	site.dropInterpreter();
	return bytes;
}

/** runs `fn` with the given vars on the object's env, restoring what it held */
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

describe('a run the cap refuses, on the shipped interpreter', () => {
	it(
		'ends the request cleanly, counts it, drops the interpreter, and serves the next run',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const start = await bootSize(site);
				const cap = String(start + 8 * MIB);
				return withVars(site, { GROWTH_CAP_BYTES: cap }, async () => {
					await site.ensurePhp();
					const capInForce = site.growthCap;
					let thrown: unknown;
					try {
						await site.run(OVER_CAP);
					} catch (e) {
						thrown = e;
					}
					const dropped = site.php === undefined;
					const heldAfter = site.growthRefusals;
					const recovered = await site.run('<?php echo "ok";');
					return {
						start,
						cap: Number(cap),
						capInForce,
						thrown,
						dropped,
						refusals: heldAfter,
						governed: site.governedRuns,
						last: site.lastGoverned,
						recovered,
						capAfter: site.growthCap
					};
				});
			});

			expect(out.capInForce).toBe(out.cap);
			expect(out.thrown, 'the run must end in the typed refusal').toBeInstanceOf(
				GrowthRefused
			);
			expect(out.dropped, 'the interpreter stayed eligible to serve').toBe(true);
			expect(out.refusals ?? 0).toBeGreaterThanOrEqual(1);
			expect(out.governed).toBe(1);
			expect(out.last).toMatchObject({ capBytes: out.cap });
			expect(out.last?.toBytes).toBeGreaterThan(out.cap);
			expect(out.recovered).toContain('ok');
			expect(out.capAfter).toBe(out.cap);
		},
		REQUEST_TIMEOUT
	);

	it(
		'does not govern or count a run when GROWTH_GOVERNOR is 0, which is the control',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) =>
				withVars(site, { GROWTH_GOVERNOR: '0' }, async () => {
					await site.ensurePhp();
					const reply = await site.run(OVER_CAP);
					return {
						reply,
						cap: site.growthCap,
						refusals: site.growthRefusals,
						governed: site.governedRuns
					};
				})
			);
			expect(out.reply).toContain('survived');
			expect(out.cap).toBeUndefined();
			expect(out.refusals).toBeUndefined();
			expect(out.governed).toBeUndefined();
		},
		REQUEST_TIMEOUT
	);

	it(
		'is on with no var set: the ledger cap governs a boot and refuses a run past it',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.ensurePhp();
				const cap = site.growthCap;
				let thrown: unknown;
				try {
					await site.run(OVER_CAP);
				} catch (e) {
					thrown = e;
				}
				return { cap, thrown, governed: site.governedRuns };
			});
			expect(out.cap).toBeGreaterThanOrEqual(BOOT_LINEAR_BYTES);
			expect(out.cap).toBeLessThan(110 * MIB);
			expect(out.thrown).toBeInstanceOf(GrowthRefused);
			expect(out.governed).toBe(1);
		},
		REQUEST_TIMEOUT
	);

	it(
		'leaves a script that calls exit(1) alone when no grow was refused',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const start = await bootSize(site);
				return withVars(site, { GROWTH_CAP_BYTES: String(start + 64 * MIB) }, async () => {
					await site.ensurePhp();
					let thrown: unknown;
					let reply = '';
					try {
						reply = await site.run('<?php echo "before"; exit(1);');
					} catch (e) {
						thrown = e;
					}
					return {
						thrown,
						reply,
						governed: site.governedRuns,
						refusals: site.growthRefusals
					};
				});
			});
			expect(out.thrown).not.toBeInstanceOf(GrowthRefused);
			expect(out.governed ?? 0).toBe(0);
			expect(out.refusals ?? 0).toBe(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'has one governor after a second boot on the memory the first left behind',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const start = await bootSize(site);
				return withVars(site, { GROWTH_CAP_BYTES: String(start + 8 * MIB) }, async () => {
					await site.ensurePhp();
					const first = (await site.ensurePhp()).binary.wasmMemory;
					const firstCap = site.growthCap;
					site.dropInterpreter();
					await site.ensurePhp();
					const second = (await site.ensurePhp()).binary.wasmMemory;
					// a looser cap on the reused memory must be the only one in force
					const target = site.env as unknown as Record<string, string>;
					target['GROWTH_CAP_BYTES'] = String(start + 40 * MIB);
					site.dropInterpreter();
					await site.ensurePhp();
					const third = (await site.ensurePhp()).binary.wasmMemory;
					const grown = site.growthCap;
					// 24 MiB over the boot size, past the first cap and under the second
					const reply = await site.run(
						`<?php $s = str_repeat('x', 24 * 1048576); echo 'fit';`
					);
					return { same: first === second && second === third, firstCap, grown, reply };
				});
			});
			expect(out.same, 'the spare memory was not reused, so nothing is proved').toBe(true);
			expect(out.grown).toBeGreaterThan(out.firstCap ?? Infinity);
			expect(out.reply).toContain('fit');
		},
		REQUEST_TIMEOUT
	);

	it(
		'answers a refused GET with a 503 the front worker repeats, and drops the interpreter',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const start = await bootSize(site);
				return withVars(site, { GROWTH_CAP_BYTES: String(start + 8 * MIB) }, async () => {
					site.ensureServeTables();
					await site.ensurePhp();
					site.handle = async () => {
						await site.run(OVER_CAP);
						return new Response('unreachable');
					};
					const res = await site.fetch(new Request('https://do.local/__serve?path=%2F'));
					return {
						status: res.status,
						header: res.headers.get(GROWTH_REFUSED_HEADER),
						dropped: site.php === undefined,
						governed: site.governedRuns
					};
				});
			});
			expect(out.status).toBe(503);
			expect(out.header).toBe('1');
			expect(out.dropped).toBe(true);
			expect(out.governed).toBe(1);
		},
		REQUEST_TIMEOUT
	);

	it(
		'answers a refused POST with an error that says nothing was saved, and saves nothing',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const start = await bootSize(site);
				return withVars(site, { GROWTH_CAP_BYTES: String(start + 8 * MIB) }, async () => {
					site.ensureServeTables();
					const inst = await site.ensurePhp();
					await site.run(
						`<?php ${sqlFromPhp('CREATE TABLE growth_probe (id INT NOT NULL AUTO_INCREMENT, v VARCHAR(20), PRIMARY KEY (id))')}`
					);
					const rowsOf = () =>
						site.sql
							.exec('SELECT v FROM growth_probe ORDER BY id')
							.toArray()
							.map((r) => r['v']);
					// the drop must end the run as a trap's does, so the bridge judges its writes
					let ended = 0;
					const bridge = inst.mysql;
					inst.mysql = {
						...(bridge as NonNullable<typeof bridge>),
						endRun: () => {
							ended += 1;
							bridge?.endRun?.();
						}
					};
					site.handle = async () => {
						await site.run(
							`<?php ${sqlFromPhp("INSERT INTO growth_probe (v) VALUES ('before')")} ${OVER_CAP_BODY} ${sqlFromPhp("INSERT INTO growth_probe (v) VALUES ('after')")}`
						);
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
						header: res.headers.get(GROWTH_REFUSED_HEADER),
						body: await res.text(),
						rows: rowsOf(),
						ended,
						dropped: site.php === undefined
					};
				});
			});
			expect(out.status).toBe(503);
			expect(out.header).toBe('1');
			expect(out.body).toContain('Nothing it did was saved');
			expect(out.dropped).toBe(true);
			expect(out.ended, 'the bridge never judged the run').toBe(1);
			// the run is one transaction, so the statement before the refusal was undone too
			expect(out.rows).toEqual([]);
		},
		REQUEST_TIMEOUT
	);
});

describe('the phases the cap does not apply to', () => {
	const request = (path: string, init?: RequestInit) =>
		new Request(`https://do.local${path}`, init);

	it('are every object route but a page render, and a render the owner phase header marks', () => {
		expect(growthPhaseExempt(request('/__serve?path=%2F'))).toBe(false);
		expect(growthPhaseExempt(request('/__serve?path=%2Fuser', { method: 'POST' }))).toBe(false);
		for (const path of [
			'/__migrate',
			'/__firstrun',
			'/__enable',
			'/__install',
			'/__modify',
			'/__restore',
			'/__fill',
			'/__serve-stats'
		]) {
			expect(growthPhaseExempt(request(path)), path).toBe(true);
		}
		expect(
			growthPhaseExempt(request('/__serve?path=%2F', { headers: { 'x-cfw-phase': 'load' } }))
		).toBe(true);
	});

	it('lift the governor while they run and put it back, nested or not', () => {
		const memory = memoryOfPages(16);
		const binary = {};
		installGrowthCap(binary, memory, undefined, () => {});
		const site: GrowthSite = { php: { binary }, env: env({ GROWTH_CAP_BYTES: 2 * MIB }) };
		const grows = () => {
			try {
				memory.grow(1);
				return true;
			} catch {
				return false;
			}
		};
		syncGrowthCap(site);
		expect(site.growthCap).toBe(2 * MIB);
		// 1 MiB held, 2 MiB cap: 16 pages fit exactly, then the next refuses
		memory.grow(16);
		expect(grows()).toBe(false);

		enterGrowthExempt(site);
		enterGrowthExempt(site);
		expect(site.growthExempt).toBe(2);
		expect(grows()).toBe(true);
		leaveGrowthExempt(site);
		expect(grows()).toBe(true);
		leaveGrowthExempt(site);
		expect(site.growthExempt).toBe(0);
		// back under the cap; it lifts to what the memory holds, so the next grow is refused
		expect(grows()).toBe(false);
		expect(site.growthCap).toBe(2 * MIB);
	});

	it(
		'let an owner route grow past the cap that refuses a page render, under the default',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.ensurePhp();
				site.handle = async () => {
					await site.run(OVER_CAP);
					return new Response('grew');
				};
				const owner = await site.fetch(request('/__enable'));
				const ownerText = await owner.text();
				const ownerGoverned = site.governedRuns ?? 0;
				// the memory the exempt phase grew would be reused by the next boot at its grown size,
				// which lifts the cap to it; start the page render on a fresh memory
				takeSpareMemory();
				const page = await site.fetch(request('/__serve?path=%2F'));
				return {
					owner: owner.status,
					ownerText,
					ownerGoverned,
					page: page.status,
					pageHeader: page.headers.get(GROWTH_REFUSED_HEADER),
					governed: site.governedRuns,
					exemptAfter: site.growthExempt
				};
			});
			expect(out.owner).toBe(200);
			expect(out.ownerText).toBe('grew');
			expect(out.ownerGoverned).toBe(0);
			expect(out.page).toBe(503);
			expect(out.pageHeader).toBe('1');
			expect(out.governed).toBe(1);
			expect(out.exemptAfter).toBe(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'cover an alarm firing, which fills and runs cron',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				site.ensureServeTables();
				let during: number | undefined;
				const real = site.flushTagPurge;
				site.flushTagPurge = () => {
					during = site.growthExempt;
					return real.call(site);
				};
				await (site as unknown as { alarm(): Promise<unknown> }).alarm();
				return { during, after: site.growthExempt };
			});
			expect(seen.during).toBeGreaterThanOrEqual(1);
			expect(seen.after).toBe(0);
		},
		REQUEST_TIMEOUT
	);
});

describe('the durable refusal log', () => {
	const rowOf = (site: ServeDo) => readGrowthLog(site.sql as never);
	const tableCount = (site: ServeDo) =>
		site.sql
			.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'cfw_growth_log'")
			.toArray()[0]!['n'];

	it('files a route under its method and path, without a query or a token', () => {
		expect(growthRouteOf('post', '/__serve', '/admin/config/development/performance?x=1')).toBe(
			'POST /__serve /admin/config/development/performance'
		);
		expect(growthRouteOf('GET', '/__serve', '/user/reset/' + 'a'.repeat(40) + '/login')).toBe(
			'GET /__serve /user/reset/*/login'
		);
		expect(growthRouteOf('GET', '/__enable', null)).toBe('GET /__enable');
	});

	it(
		'has no table until a refusal, and a normal run and a stats read create none',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.ensurePhp();
				await site.run('<?php echo "ok";');
				const stats = serveStatsSync(site as never);
				return {
					tables: tableCount(site),
					rows: rowOf(site),
					stats: stats.growthRefusalLog
				};
			});
			expect(out.tables).toBe(0);
			expect(out.rows).toEqual([]);
			expect(out.stats).toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'keeps a refusal after the rollback and after the in-memory counters are gone',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const start = await bootSize(site);
				return withVars(site, { GROWTH_CAP_BYTES: String(start + 8 * MIB) }, async () => {
					await site.ensurePhp();
					let thrown: unknown;
					try {
						await site.run(OVER_CAP);
					} catch (e) {
						thrown = e;
					}
					// what a restart leaves behind: nothing in memory, the stored rows
					site.growthRefusals = undefined;
					site.governedRuns = undefined;
					site.lastGoverned = undefined;
					const stats = serveStatsSync(site as never);
					return {
						thrown,
						cap: start + 8 * MIB,
						rows: rowOf(site),
						stats: stats.growthRefusalLog as unknown[],
						counter: stats.growthRefusals
					};
				});
			});
			expect(out.thrown).toBeInstanceOf(GrowthRefused);
			expect(out.rows).toHaveLength(1);
			expect(out.rows[0]).toMatchObject({
				capBytes: out.cap,
				rolledBack: true,
				route: 'none'
			});
			expect(out.rows[0]!.toBytes).toBeGreaterThan(out.cap);
			expect(out.rows[0]!.jsSideBytes).toBeGreaterThan(0);
			expect(out.stats).toHaveLength(1);
			expect(out.counter).toBe(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'records the route and the attempt when a request is refused',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const start = await bootSize(site);
				const vars = { GROWTH_CAP_BYTES: String(start + 8 * MIB), FRESH_FIRST_ROUTES: '0' };
				return withVars(site, vars, async () => {
					await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
					await site.ensurePhp();
					site.fillOne = async () => {
						await site.run(OVER_CAP);
						return { filled: null, remaining: 0, page: undefined } as never;
					};
					const res = await site.fetch(
						new Request(
							'https://do.local/__serve?path=%2Fadmin%2Fconfig%2Fdevelopment%2Fperformance',
							{ method: 'POST', body: 'op=Save' }
						)
					);
					return { status: res.status, rows: rowOf(site), route: site.growthRoute };
				});
			});
			expect(out.status).toBe(503);
			expect(out.rows).toHaveLength(1);
			expect(out.rows[0]).toMatchObject({
				route: 'POST /__serve /admin/config/development/performance',
				rolledBack: true,
				attempt: 1
			});
			expect(out.route).toBeUndefined();
		},
		REQUEST_TIMEOUT
	);

	it(
		'keeps the newest 20 rows, deleting the older ones in the same batch',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				for (let i = 1; i <= 25; i++) {
					recordGrowthRefusal(
						site as never,
						{ fromBytes: i, toBytes: i + 1, capBytes: 10 },
						i % 2 === 0
					);
				}
				return rowOf(site);
			});
			expect(out).toHaveLength(GROWTH_LOG_KEEP);
			expect(out[0]!.fromBytes).toBe(25);
			expect(out.at(-1)!.fromBytes).toBe(6);
		},
		REQUEST_TIMEOUT
	);
});
