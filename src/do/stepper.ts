import type { SiteEnv } from '../env';
import { parseJsonReply } from '../ops/json-reply';
import type { SitePhpDurableObject } from '../site-do';
import { isModuleName } from '../util/php';
import { GrowthRefused } from './growth/cap';
import { STEP_JOB_KEY } from './keys';
import type { Payload } from './types';

/**
 * What `STEPPED_OPS` asks for: `0` never steps, `always` steps every operation, anything else
 * (the default) lets the planner step only an operation predicted to outrun the budget.
 */
export function stepMode(env: SiteEnv | undefined): 'off' | 'planner' | 'always' {
	const v = String(env?.STEPPED_OPS ?? '').trim();
	return v === '0' ? 'off' : v === 'always' ? 'always' : 'planner';
}

/**
 * The CPU one enabled module is predicted to cost, in ms. 12,000 is the middle of the deployed
 * cpuTime of one-module invocations, boot included, on a module site (11.9, 12.5, 14.1 and 15.9 s);
 * a smaller site read 5.2 to 6.2 s. Boot is shared by the modules of one call, so it overstates a
 * module, which errs toward stepping. `STEP_MODULE_COST_MS` overrides it.
 */
export const DEFAULT_MODULE_COST_MS = 12_000;

/** whether `count` modules are predicted to cost more PHP time than one invocation may spend */
export function plannedOverBudget(count: number, env: SiteEnv | undefined): boolean {
	const n = Number(env?.STEP_MODULE_COST_MS);
	const per = Number.isFinite(n) && n > 0 ? n : DEFAULT_MODULE_COST_MS;
	return count * per > stepBudgetMs(env);
}

/** the PHP time one invocation may spend on steps before it answers 202; default 20 s */
export function stepBudgetMs(env: SiteEnv | undefined): number {
	const n = Number(env?.STEP_BUDGET_MS);
	return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/**
 * The least a step is charged against the budget, in ms. The platform clock does not advance
 * across a step, so cpuTime cannot be read in the object and host calls times kappa is the only
 * estimate, and it does not separate sites: two modules with the same call count ran 3.5 s and
 * 11 s of cpuTime, and a module install of 72,575 calls (an estimate of 9.4 s) ran 35.9 s. Two
 * steps in one call took 23.9 s of cpuTime and 30.3 s of wall time against a kill line between
 * 30.3 and 32.4 s. The default equals the budget, so an invocation runs one step; a client that
 * knows its steps are cheap lowers it. `STEP_FLOOR_MS` overrides it.
 */
export const DEFAULT_STEP_FLOOR_MS = 20_000;

/** the least one step is charged; a missing or non-positive value is the default */
export function stepFloorMs(env: SiteEnv | undefined): number {
	const n = Number(env?.STEP_FLOOR_MS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_STEP_FLOOR_MS;
}

/** the steps of one operation and how far it got; `next` only moves with a step's own commit */
export interface StepJob {
	/** what the operation is for, the key a poll finds it by */
	name: string;
	/** one entry per step, in order */
	plan: string[];
	/** the index of the step that has not committed yet */
	next: number;
	/** when the job began */
	startedAt: number;
	/** what the committed steps reported as added, so the last body can list them all */
	added?: string[];
}

/** how an advance ended */
export type StepOutcome =
	| { state: 'done'; job: StepJob; steps: number; reply?: Payload }
	| { state: 'more'; job: StepJob; steps: number; why: 'budget' | 'memory'; reply?: Payload }
	| { state: 'failed'; job: StepJob; steps: number; reply: Payload }
	| { state: 'refused'; job: StepJob; steps: number; step: string; error: GrowthRefused };

/** thrown when a job's name or a planned step is not a Drupal machine name */
export class InvalidStepName extends Error {
	constructor() {
		super('a step name is not a Drupal machine name');
	}
}

/** thrown from a step's checkpoint hook; the slice rolls back */
class StepFailed extends Error {
	constructor(readonly reply: Payload) {
		super('the step reported a failure');
	}
}

/** the modules a module needs that are not installed, dependencies first, ending with the module */
export const ENABLE_PLAN_PHP = `<?php
$want = $GLOBALS['__cfw_enable_module'] ?? '';
$list = \\Drupal::service('extension.list.module')->reset()->getList();
$installed = \\Drupal::configFactory()->get('core.extension')->get('module') ?: [];
$seen = [];
$out = [];
$visit = function ($m) use (&$visit, &$seen, &$out, $list, $installed) {
	if (isset($installed[$m]) || isset($seen[$m]) || !isset($list[$m])) {
		return;
	}
	$seen[$m] = true;
	foreach (array_keys($list[$m]->requires) as $d) {
		$visit($d);
	}
	$out[] = $m;
};
$visit($want);
echo json_encode(['ok' => isset($list[$want]), 'plan' => $out]);
`;

/** reads the stored job for `name`, or undefined */
export function readStepJob(site: SitePhpDurableObject, name: string): StepJob | undefined {
	try {
		const raw = site.metaGet(STEP_JOB_KEY);
		const job = raw ? (JSON.parse(raw) as StepJob) : undefined;
		return job && job.name === name && Array.isArray(job.plan) && job.plan.every(isModuleName)
			? job
			: undefined;
	} catch {
		return undefined;
	}
}

/** forgets the stored job */
export function clearStepJob(site: SitePhpDurableObject): void {
	site.sql.exec('DELETE FROM cfw_meta WHERE k = ?', STEP_JOB_KEY);
}

/**
 * Runs the steps of a job one slice at a time until it ends, the PHP time budget is spent, or the
 * interpreter has grown past its recycle line.
 *
 * Each step is one `run()` with a checkpoint hook: the step's writes and the job's `next` commit in
 * one transaction, so a reset between steps repeats nothing and skips nothing. The interpreter
 * stays between steps of one invocation; when `oversized()` says it should go, the invocation ends
 * with `more` and the next one boots a fresh interpreter, because a drop and a boot cannot share an
 * invocation (the dropped memory is still charged until it is collected). A step keeps the phase
 * its caller is in: the enable route is an owner phase, so the serving cap does not apply (a
 * kernel boot alone reached 95.8 MiB of a 96 MiB cap on a large module site). A step a cap does
 * refuse is rolled back and reported `refused`; a step that reports `ok: false` is rolled back and
 * reported `failed`. The job survives both, so a poll retries from the same step.
 *
 * @param name - the key of the job
 * @param plan - the steps, asked for only when no job is stored
 * @param fragment - the PHP one step runs
 */
export async function advanceStepJob(
	site: SitePhpDurableObject,
	name: string,
	plan: () => Promise<string[]>,
	fragment: (step: string) => string
): Promise<StepOutcome> {
	let job = readStepJob(site, name);
	if (!job) {
		const planned = await plan();
		// a step's name goes into PHP, so a plan with anything else in it never runs
		if (!isModuleName(name) || !planned.every(isModuleName)) throw new InvalidStepName();
		job = { name, plan: planned, next: 0, startedAt: site.nowMs() };
		site.metaSet(STEP_JOB_KEY, JSON.stringify(job));
	}
	const budget = stepBudgetMs(site.env);
	let spent = 0;
	let steps = 0;
	let last: Payload | undefined;
	while (job.next < job.plan.length) {
		if (steps > 0 && spent >= budget)
			return { state: 'more', job, steps, why: 'budget', reply: last };
		if (steps > 0 && site.oversized())
			return { state: 'more', job, steps, why: 'memory', reply: last };
		const step = job.plan[job.next]!;
		const index = job.next;
		try {
			await site.run(fragment(step), (out) => {
				const reply = parseJsonReply(out);
				if (reply['ok'] !== true) throw new StepFailed(reply);
				last = reply;
				const added = Array.isArray(reply['added']) ? (reply['added'] as string[]) : [];
				job = { ...job!, next: index + 1, added: [...(job!.added ?? []), ...added] };
				site.metaSet(STEP_JOB_KEY, JSON.stringify(job));
			});
		} catch (e) {
			if (e instanceof GrowthRefused) return { state: 'refused', job, steps, step, error: e };
			// the step rolled back under a live interpreter that did not: it goes
			site.dropInterpreter();
			if (e instanceof StepFailed) return { state: 'failed', job, steps, reply: e.reply };
			throw e;
		}
		steps += 1;
		spent += Math.max(site.php?.php.clock?.runMs() ?? 0, stepFloorMs(site.env));
	}
	return { state: 'done', job, steps, reply: last };
}
