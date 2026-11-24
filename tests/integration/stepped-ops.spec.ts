import { describe, expect, it } from 'vitest';
import { enterGrowthExempt, leaveGrowthExempt } from '../../src/do/growth/cap';
import {
	DEFAULT_MODULE_COST_MS,
	ENABLE_PLAN_PHP,
	advanceStepJob,
	clearStepJob,
	plannedOverBudget,
	readStepJob,
	stepBudgetMs,
	stepFloorMs,
	stepMode
} from '../../src/do/stepper';
import type { SiteEnv } from '../../src/env';
import { isModuleName, phpSingle, phpSingleList } from '../../src/util/php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

const MIB = 1_048_576;
const REQUEST_TIMEOUT = 600_000;
const OVER_CAP = `$a = []; for ($i = 0; $i < 64; $i++) { $a[] = str_repeat('x', 4 * 1048576); }`;

const sqlOf = (statement: string) =>
	`$f = vrzno_env('cfwSqlExec'); $f(json_encode(pw_encode(['sql' => ${JSON.stringify(statement)}, 'params' => []])));`;
/** a step that records its own name in a table, so a repeat or a gap shows as a row */
const recording = (step: string, extra = '') =>
	`<?php ${sqlOf(`INSERT INTO step_probe (v) VALUES ('${step}')`)} ${extra} echo json_encode(['ok' => true]);`;

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

const probe = (site: ServeDo) => {
	site.ensureServeTables();
	site.sql.exec('CREATE TABLE IF NOT EXISTS step_probe (v TEXT)');
	site.sql.exec('DELETE FROM step_probe');
	clearStepJob(site as never);
	// most specs here are about the chain, not the floor, so a step is charged its estimate
	(site.env as unknown as Record<string, string>)['STEP_FLOOR_MS'] = '1';
};
const rowsOf = (site: ServeDo) =>
	site.sql
		.exec('SELECT v FROM step_probe ORDER BY rowid')
		.toArray()
		.map((r) => r['v']);
const asSite = (site: ServeDo) => site as never;

describe('the stepper settings', () => {
	it('has a 20 s budget unless one is named', () => {
		expect(stepBudgetMs(undefined)).toBe(20_000);
		expect(stepBudgetMs({ STEP_BUDGET_MS: '5000' } as SiteEnv)).toBe(5000);
		expect(stepBudgetMs({ STEP_BUDGET_MS: 'soon' } as SiteEnv)).toBe(20_000);
	});

	it('charges a step at least the whole budget unless a floor is named', () => {
		expect(stepFloorMs(undefined)).toBe(20_000);
		expect(stepFloorMs(undefined)).toBe(stepBudgetMs(undefined));
		expect(stepFloorMs({ STEP_FLOOR_MS: '2000' } as SiteEnv)).toBe(2000);
		expect(stepFloorMs({ STEP_FLOOR_MS: '0' } as SiteEnv)).toBe(20_000);
		expect(stepFloorMs({ STEP_FLOOR_MS: 'x' } as SiteEnv)).toBe(20_000);
	});

	it('plans in PHP that stays out of a template literal hazard', () => {
		expect(ENABLE_PLAN_PHP).not.toContain('`');
		expect(ENABLE_PLAN_PHP).toContain('requires');
	});
});

describe('a module name that reaches PHP', () => {
	const hostile = [
		'a$b',
		"{$GLOBALS['x']}",
		"a'b",
		'a"b',
		'a\\b',
		'a\nb',
		'a\0b',
		`a${'b'.repeat(60)}`
	];

	it('is a machine name or nothing, and the literal cannot interpolate', () => {
		expect(isModuleName('config_translation')).toBe(true);
		for (const bad of hostile) expect(isModuleName(bad)).toBe(false);
		expect(isModuleName('a'.repeat(50))).toBe(true);
		expect(isModuleName('a'.repeat(51))).toBe(false);
		// even a value that got past a check would stay inert inside single quotes
		expect(phpSingle("x$GLOBALS'\\")).toBe("'x$GLOBALS\\'\\\\'");
		expect(phpSingleList(['a', 'b'])).toBe("['a', 'b']");
	});

	it(
		'is refused with 400 before any PHP runs',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const ran: string[] = [];
				const realRun = site.run.bind(site);
				site.run = (code, after) => {
					ran.push(code);
					return realRun(code, after);
				};
				const statuses: number[] = [];
				for (const bad of hostile) {
					const res = await site.fetch(
						new Request(`https://do.local/__enable?module=${encodeURIComponent(bad)}`)
					);
					statuses.push(res.status);
					const viaWith = await site.fetch(
						new Request(
							`https://do.local/__enable?module=token&with=${encodeURIComponent(bad)}`
						)
					);
					statuses.push(viaWith.status);
				}
				const stop = await site.fetch(
					new Request(
						`https://do.local/__enable?module=token&stop=${encodeURIComponent("a'b")}`
					)
				);
				statuses.push(stop.status);
				return { statuses, ran };
			});
			expect(out.statuses.every((s) => s === 400)).toBe(true);
			expect(out.ran, 'PHP ran for a name that was refused').toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it('would interpolate in a double-quoted literal, which is why JSON.stringify is not used', () => {
		// the control: the removed validation plus the old literal puts the expression in the script
		const old = `$GLOBALS['m'] = ${JSON.stringify("{$GLOBALS['x']}")};`;
		expect(old).toContain('"{$GLOBALS');
		expect(`$GLOBALS['m'] = ${phpSingle("{$GLOBALS['x']}")};`).toContain("'{$GLOBALS");
	});
});

describe('the planner', () => {
	it('steps unless STEPPED_OPS is 0, and forces with always', () => {
		expect(stepMode(undefined)).toBe('planner');
		expect(stepMode({ STEPPED_OPS: '1' } as SiteEnv)).toBe('planner');
		expect(stepMode({ STEPPED_OPS: '0' } as SiteEnv)).toBe('off');
		expect(stepMode({ STEPPED_OPS: 'always' } as SiteEnv)).toBe('always');
	});

	it('keeps a small enable single and steps one predicted past the budget', () => {
		expect(DEFAULT_MODULE_COST_MS).toBe(12_000);
		expect(plannedOverBudget(1, undefined)).toBe(false);
		expect(plannedOverBudget(2, undefined)).toBe(true);
		expect(plannedOverBudget(3, undefined)).toBe(true);
		expect(plannedOverBudget(3, { STEP_MODULE_COST_MS: '100' } as SiteEnv)).toBe(false);
		expect(plannedOverBudget(3, { STEP_BUDGET_MS: '1000' } as SiteEnv)).toBe(true);
	});
});

describe('the queued operation steps', () => {
	it(
		'commit with their cursor, so a failed cursor write leaves no step behind',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				probe(site);
				await site.ensurePhp();
				const realRun = site.run.bind(site);
				// the operation's PHP is replaced by a recording step that reports more to do
				site.run = (_code, after) =>
					realRun(
						`<?php ${sqlOf("INSERT INTO step_probe (v) VALUES ('op')")} echo json_encode(['ok' => true]);`,
						after
					);
				const realSet = site.metaSet.bind(site);
				(site as { metaSet: unknown }).metaSet = () => {
					throw new Error('reset at the cursor write');
				};
				let failed = false;
				try {
					await site.opsJobStep('queue-drain', [], {});
				} catch {
					failed = true;
				}
				const afterFailure = rowsOf(site);
				(site as { metaSet: unknown }).metaSet = realSet;
				// the control: the same step with no hook commits and leaves nothing to resume from
				await realRun(
					`<?php ${sqlOf("INSERT INTO step_probe (v) VALUES ('control')")} echo json_encode(['ok' => true]);`
				);
				return { failed, afterFailure, rows: rowsOf(site), job: site.metaGet('ops_job') };
			});
			expect(out.failed).toBe(true);
			expect(out.afterFailure, 'the step committed without its cursor').toEqual([]);
			expect(out.rows).toEqual(['control']);
			expect(out.job).toBeNull();
		},
		REQUEST_TIMEOUT
	);
});

describe('a stepped job on the real interpreter', () => {
	const plan = (steps: string[]) => async () => steps;

	it(
		'runs every step once, in order, and reports done',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				probe(site);
				await site.ensurePhp();
				const outcome = await advanceStepJob(
					asSite(site),
					'op',
					plan(['a', 'b', 'c']),
					recording
				);
				return { outcome, rows: rowsOf(site) };
			});
			expect(out.outcome.state).toBe('done');
			expect(out.outcome.steps).toBe(3);
			expect(out.rows).toEqual(['a', 'b', 'c']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'ends an invocation when the PHP time budget is spent, and resumes after the interpreter is dropped',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				probe(site);
				await site.ensurePhp();
				return withVars(site, { STEP_BUDGET_MS: '0.01' }, async () => {
					const states: string[] = [];
					const nexts: number[] = [];
					for (let i = 0; i < 8; i++) {
						const outcome = await advanceStepJob(
							asSite(site),
							'op',
							plan(['a', 'b', 'c', 'd']),
							recording
						);
						states.push(`${outcome.state}:${outcome.steps}`);
						nexts.push(outcome.job.next);
						if (outcome.state === 'done') break;
						// the interpreter and the isolate's view of the job are gone between invocations
						site.dropInterpreter();
					}
					return { states, nexts, rows: rowsOf(site) };
				});
			});
			expect(out.states[0]).toBe('more:1');
			expect(out.states.at(-1)).toMatch(/^done/);
			expect(out.nexts).toEqual([1, 2, 3, 4]);
			expect(out.rows, 'a step repeated or was lost').toEqual(['a', 'b', 'c', 'd']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'charges a step the floor, so a cheap-looking step still ends its invocation',
		async () => {
			const invocation = async (site: ServeDo, vars: Record<string, string>) => {
				probe(site);
				return withVars(site, vars, () =>
					advanceStepJob(asSite(site), 'op', plan(['a', 'b', 'c', 'd']), recording)
				);
			};
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.ensurePhp();
				const charged = await invocation(site, { STEP_FLOOR_MS: '20000' });
				// the control: a floor of 1 ms is the host-call estimate alone, which these steps never reach
				const control = await invocation(site, { STEP_FLOOR_MS: '1' });
				return { charged, control };
			});
			expect(out.charged.state).toBe('more');
			expect(out.charged.steps, 'a cheap step did not end the invocation').toBe(1);
			expect(out.control.state).toBe('done');
			expect(out.control.steps).toBe(4);
		},
		REQUEST_TIMEOUT
	);

	it(
		'rolls a failed step back and retries it once, so nothing repeats and nothing is skipped',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				probe(site);
				await site.ensurePhp();
				let failNext = true;
				const flaky = (step: string) =>
					step === 'b' && failNext
						? `<?php ${sqlOf("INSERT INTO step_probe (v) VALUES ('b')")} echo json_encode(['ok' => false, 'error' => 'boom']);`
						: recording(step);
				const first = await advanceStepJob(
					asSite(site),
					'op',
					plan(['a', 'b', 'c']),
					flaky
				);
				const afterFailure = rowsOf(site);
				const heldAt = readStepJob(asSite(site), 'op')?.next;
				failNext = false;
				const second = await advanceStepJob(
					asSite(site),
					'op',
					plan(['a', 'b', 'c']),
					flaky
				);
				return { first, afterFailure, heldAt, second, rows: rowsOf(site) };
			});
			expect(out.first.state).toBe('failed');
			expect(out.afterFailure, 'the failed step left its write behind').toEqual(['a']);
			expect(out.heldAt).toBe(1);
			expect(out.second.state).toBe('done');
			expect(out.rows).toEqual(['a', 'b', 'c']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'control: a checkpoint written after the step, with a reset between, repeats the step',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				probe(site);
				await site.ensurePhp();
				// the step commits with no checkpoint hook, then a reset lands before one is written
				await site.run(recording('a'));
				const held = readStepJob(asSite(site), 'op')?.next;
				await advanceStepJob(asSite(site), 'op', plan(['a', 'b']), recording);
				return { rows: rowsOf(site), held };
			});
			expect(out.held).toBeUndefined();
			expect(out.rows).toEqual(['a', 'a', 'b']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'reports a step the cap refuses, with its writes undone and the job held at that step',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				probe(site);
				await site.ensurePhp();
				const start = site.heapNow();
				return withVars(site, { GROWTH_CAP_BYTES: String(start + 8 * MIB) }, async () => {
					const outcome = await advanceStepJob(
						asSite(site),
						'op',
						plan(['a', 'big']),
						(step) => recording(step, step === 'big' ? OVER_CAP : '')
					);
					return {
						outcome,
						rows: rowsOf(site),
						held: readStepJob(asSite(site), 'op')?.next
					};
				});
			});
			expect(out.outcome.state).toBe('refused');
			expect(out.outcome.state === 'refused' && out.outcome.step).toBe('big');
			expect(out.rows).toEqual(['a']);
			expect(out.held).toBe(1);
		},
		REQUEST_TIMEOUT
	);
});

describe('a step in an owner phase', () => {
	it(
		'is not refused by the serving cap, and still commits with its cursor',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				probe(site);
				await site.ensurePhp();
				const start = site.heapNow();
				const grow = `$a = []; for ($i = 0; $i < 16; $i++) { $a[] = str_repeat('x', 1048576); }`;
				return withVars(site, { GROWTH_CAP_BYTES: String(start + 8 * MIB) }, async () => {
					enterGrowthExempt(asSite(site));
					try {
						const outcome = await advanceStepJob(
							asSite(site),
							'op',
							async () => ['a', 'big'],
							(step) => recording(step, step === 'big' ? grow : '')
						);
						return { outcome, rows: rowsOf(site) };
					} finally {
						leaveGrowthExempt(asSite(site));
					}
				});
			});
			expect(out.outcome.state).toBe('done');
			expect(out.rows).toEqual(['a', 'big']);
		},
		REQUEST_TIMEOUT
	);
});

describe('a module enable that runs a step at a time', () => {
	const MODULE = 'config_translation';
	const enable = async (site: ServeDo, query = '') => {
		const res = await site.fetch(
			new Request(`https://do.local/__enable?module=${MODULE}${query}`)
		);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};

	it(
		'answers 202 until the last module lands, then 200 with the body a single run gives',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				return withVars(
					site,
					{ STEPPED_OPS: 'always', STEP_BUDGET_MS: '0.01' },
					async () => {
						const seen: { status: number; next?: unknown; total?: unknown }[] = [];
						let last = await enable(site);
						for (let i = 0; i < 8; i++) {
							seen.push({
								status: last.status,
								next: last.body['next'],
								total: last.body['total']
							});
							if (last.status === 200) break;
							last = await enable(site);
						}
						return { seen, last };
					}
				);
			});
			const single = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				return withVars(site, { STEPPED_OPS: '0' }, () => enable(site));
			});

			expect(out.seen[0]?.status).toBe(202);
			expect(out.seen.at(-1)?.status).toBe(200);
			expect(out.seen.length).toBeGreaterThan(1);
			const stepped = out.last.body;
			expect(stepped['ok']).toBe(true);
			expect(stepped['nowEnabled']).toBe(true);
			expect(stepped['module']).toBe(MODULE);
			expect([...(stepped['added'] as string[])].sort()).toEqual(
				[...(single.body['added'] as string[])].sort()
			);
			expect(Object.keys(stepped).sort()).toEqual(Object.keys(single.body).sort());
		},
		REQUEST_TIMEOUT
	);

	it(
		'leaves a one-module enable as a single run under the default planner',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const res = await site.fetch(new Request('https://do.local/__enable?module=token'));
				return { status: res.status, body: (await res.json()) as Record<string, unknown> };
			});
			expect(out.status).toBe(200);
			expect(out.body['ok']).toBe(true);
			expect(out.body['next']).toBeUndefined();
		},
		REQUEST_TIMEOUT
	);
});
