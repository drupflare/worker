import { opsRun } from '../drupal/php/site';
import { parseJsonReply } from '../ops/json-reply';
import { updbOptions, updbStep, type UpdbDeps } from '../ops/updb';
import { errorMessage } from '../util/errors';
import type { SteppedHost } from './host';
import { OPS_JOB_KEY } from './keys';
import type { OpsJob, Payload } from './types';

/** reads the stored stepped job once and caches it, absence included */
function readOpsJob(host: SteppedHost): OpsJob | undefined {
	if (host.steppedJobs.cache !== undefined) return host.steppedJobs.cache.job;
	let job: OpsJob | undefined;
	try {
		const raw = host.metaGet(OPS_JOB_KEY);
		const parsed = raw === null ? undefined : (JSON.parse(raw) as OpsJob);
		job = parsed && typeof parsed.name === 'string' ? parsed : undefined;
	} catch (e) {
		host.noteError('readOpsJob', e);
	}
	host.steppedJobs.cache = { job };
	return job;
}

/** whether a stepped operation is in flight */
export function opsJobActive(host: SteppedHost): boolean {
	return readOpsJob(host) !== undefined;
}

/**
 * Runs one step of a stepped operation, keeping the job only while it reports more to do.
 *
 * A failed step also ends it (a retry from the top would replay what already landed). The first
 * `cim` step carries the payload; the run holds its own state after that.
 */
export async function opsJobStep(
	host: SteppedHost,
	name: string,
	args: string[],
	options: OpsJob['options']
): Promise<Payload> {
	const continues = (reply: Payload) => reply['ok'] !== false && reply['done'] !== true;
	const { payload: _first, ...rest } = options;
	const job: OpsJob = { name, args, options: rest };
	// the cursor is written inside the step's transaction, so a reset between the step's commit and
	// the cursor cannot repeat the step
	const text = await host.run(opsRun(name, args, options), (out) => {
		const reply = parseJsonReply(out);
		if (continues(reply)) host.metaSet(OPS_JOB_KEY, JSON.stringify(job));
		else host.sql.exec('DELETE FROM cfw_meta WHERE k = ?', OPS_JOB_KEY);
	});
	const ran = (await host.settleReply(parseJsonReply(text))) ?? {
		ok: false,
		error: 'no reply'
	};
	const more = continues(ran);
	host.steppedJobs.cache = more ? { job } : {};
	host.lastOpsJob = { name, at: host.nowMs(), more, ...ran };
	return ran;
}

/** advances the stepped operation one step; a throw drops the job (a throwing alarm stops) */
export async function opsJobBeat(host: SteppedHost): Promise<{ opsJob: Payload }> {
	const job = readOpsJob(host);
	if (!job) return { opsJob: { ok: true, idle: true } };
	try {
		return { opsJob: await opsJobStep(host, job.name, job.args, job.options) };
	} catch (e) {
		// recorded rather than rethrown, and the job dropped: a throwing alarm stops re-arming
		host.sql.exec('DELETE FROM cfw_meta WHERE k = ?', OPS_JOB_KEY);
		host.steppedJobs.cache = {};
		const failure = { ok: false, error: errorMessage(e) };
		host.lastOpsJob = { name: job.name, at: host.nowMs(), more: false, ...failure };
		return { opsJob: failure };
	}
}

/** the one dependency bag every updb entry point takes; nothing here holds state */
export function updbDeps(host: SteppedHost): UpdbDeps {
	return {
		sql: host.sql,
		runJson: (code: string) => host.runJson(code),
		// no `phpReady`: a unit boots a cold interpreter itself (free's 10 ms cap does not fail
		// a DO invocation)
		txn: (fn: () => void) => host.storage.transactionSync(fn),
		nowMs: () => host.nowMs(),
		sync: () => host.storage.sync()
	} satisfies UpdbDeps;
}

/**
 * One beat, acquiring the gate only when the caller does not already hold it.
 *
 * The gate is a non-reentrant FIFO chain and `fetch()` already holds it; a second acquire
 * inside the router hangs forever. `alarm()` is its own event and needs the explicit acquire.
 */
export async function updbBeat(host: SteppedHost, gated: boolean): Promise<{ updb: Payload }> {
	const beat = () => updbStep(updbDeps(host), updbOptions(host.env));
	try {
		const step = gated ? await host.gate.run(beat, 'alarm-updb') : await beat();
		host.lastUpdb = { at: Date.now(), value: step };
		return { updb: step };
	} catch (e) {
		// recorded, not rethrown: an alarm that throws stops re-arming
		const failure = { ok: false, error: errorMessage(e) };
		host.lastUpdb = { at: Date.now(), value: failure };
		return { updb: failure };
	}
}

/**
 * Advances a database-update run by one beat; `updbStep()` owns no transport, alarm or env, so
 * the dependency bag is built here.
 */
export async function updbStepOnce(host: SteppedHost): Promise<{ updb: Payload }> {
	return updbBeat(host, true);
}
