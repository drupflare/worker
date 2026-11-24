import { staleDays } from './rotation';

/** one capability row as a lane records it */
export type CertRow = { state: string; note?: string };

/** what one scheduled run of one fixture leaves behind; the schema names no CMS-specific field */
export type CertRecord = {
	cms: string;
	fixture: string;
	/** the commit the fixture is pinned to in `config/corpus.yml` */
	sha: string;
	/** the worker release the deployed site ran, or `unreleased` for a tree build */
	release: string;
	/** the Cloudflare plan of the account the throwaway ran on */
	plan: string;
	rows: Record<string, CertRow>;
	/** the run's date, `YYYY-MM-DD` */
	date: string;
	/** when the run finished, an ISO 8601 timestamp in UTC */
	at?: string;
	/** `schedule` or `dispatch`, kept for the record */
	trigger: string;
	/** the CI run that produced it */
	run: string;
	/** what the native install skipped or went past: patches that did not apply and advisories ignored */
	skipped?: { patches: string[]; advisories: string[]; relaxed: string[]; changed: string[] };
	/** set on a diagnostic run (a worker var changed on purpose); such a record never counts toward Certified */
	experiment?: string;
	/** the commit and diff digest of the tree the run was built from, when it ran from a clone */
	build?: string;
	/** the CPU ceiling the platform held for the deployed script, when one was asked for */
	limits?: { cpuMs: number };
	/** what the site reported spending in the run, read before teardown */
	/** memory and governor readings taken after the update and cache rebuild rows */
	snapshots?: { after: string; stats: Record<string, unknown> }[];
	/** the answers the front worker repeated, with their x-cfw-retried and x-cfw-effects headers, 200 included */
	repeats?: { path: string; status: number; headers: Record<string, string> }[];
	meters?: {
		rowsToday: number;
		/** the durable growth refusal log and the isolate's byte counts, read before teardown */
		growthRefusalLog?: Record<string, unknown>[];
		isolateBytes?: Record<string, unknown>;
		/** the durable fresh-first record: how many drops and the last one, as `/serve-stats` reports it */
		freshFirst?: Record<string, unknown>;
		/** what the growth governor refused or governed, with its last refusal's numbers, when it acted */
		growth?: {
			refusals: number;
			governedRuns: number;
			lastGoverned: Record<string, unknown> | null;
		};
	};
	/** the anachron commit or version when one was loaded */
	anachron?: string;
};

/** what the published status file says about one fixture */
export type CertStatus = {
	cms: string;
	state: 'certified' | 'deployed' | 'none';
	sha: string;
	release: string;
	plan: string;
	date: string;
	/** the day the evidence stops counting: the latest run plus two intervals */
	expires: string;
	/** when the latest run finished, an ISO 8601 timestamp in UTC */
	at: string;
	/** whether the latest run was started by hand or by the schedule */
	source: 'manual' | 'scheduled';
	/** how many runs in a row, newest first, passed every row */
	streak: number;
	anachron?: string;
	/** rows that did not pass in the latest run */
	failing: string[];
};

/** the published status file */
export type StatusFile = {
	generated: string;
	intervalDays: number;
	fixtures: Record<string, CertStatus>;
};

/** consecutive passing scheduled runs a fixture needs to be Certified */
export const REQUIRED_STREAK = 3;

/** the newest runs a Certified fixture is held to */
export const KEEP_WINDOW = 4;

/** passing runs the newest `KEEP_WINDOW` must hold for a fixture to stay Certified */
export const KEEP_PASSES = 3;

/**
 * Whether a fixture that has earned Certified still holds it: at least `KEEP_PASSES` of its newest
 * `KEEP_WINDOW` runs passed every row and the newest run passed. Three of four leaves room for one
 * failed run only, so a row that failed twice in the window never holds: a defect repeats on its row,
 * a blip does not.
 */
export function holds(window: readonly CertRecord[], rows: readonly string[]): boolean {
	const last = window.at(-1);
	if (!last || !recordPassed(last, rows)) return false;
	return (
		window.filter((r) => recordPassed(r, rows)).length >= Math.min(KEEP_PASSES, window.length)
	);
}

/** scheduled runs kept per fixture in the history file */
export const HISTORY_PER_FIXTURE = 30;

const PASSING = new Set(['inline', 'parked', 'degraded']);
const DAY_MS = 86_400_000;

/** the rows of a record that did not pass, counting a row the corpus lists but the run lacks */
export function failingRows(record: CertRecord, rows: readonly string[]): string[] {
	return rows.filter((row) => !PASSING.has(record.rows[row]?.state ?? 'unknown'));
}

/** whether a record passed every row the corpus lists */
export const recordPassed = (record: CertRecord, rows: readonly string[]): boolean =>
	failingRows(record, rows).length === 0;

/** a date plus a number of days, as `YYYY-MM-DD` */
export function addDays(date: string, days: number): string {
	return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Applies the Certified rule to one fixture's history.
 *
 * A fixture earns Certified the first time it has three consecutive deployed runs on one plan, at the
 * pinned commit, that passed every row. After that it keeps Certified while at least three of its
 * newest four runs passed and the newest run passed (see `holds`). A blip therefore shows Deployed
 * until the next pass brings the window back, and a failure that repeats does not come back until it
 * leaves the window. It also drops when no run has passed for twice the window, and then has to earn
 * the three straight passes again. A
 * fixture that ever passed at the pin is Deployed, and one that never did has no state. The plan
 * reported is the cheapest on which the fixture is Certified, free before paid; a pass on one plan
 * is not evidence on another. A run at another commit is not evidence for the pin.
 */
export function certificationState(history: readonly CertRecord[], opts: JudgeOptions): CertStatus {
	const free = stateOn(history, opts, 'free');
	if (free.state === 'certified') return free;
	const paid = stateOn(history, opts, 'paid');
	if (paid.state === 'certified') return paid;
	return free.state === 'none' && paid.state !== 'none' ? paid : free;
}

/** what a judgement needs besides the history */
export type JudgeOptions = {
	fixture: string;
	sha: string;
	rows: readonly string[];
	now: string;
	/** the rotation period in days, which the status file states */
	intervalDays: number;
	/** the window the pool is covered within; a Certified fixture lapses after twice this many days */
	windowDays?: number;
};

/** the rule on one plan: replays the runs oldest first, because earning and losing the badge is a sequence */
function stateOn(history: readonly CertRecord[], opts: JudgeOptions, plan: string): CertStatus {
	const STALE_DAYS = staleDays(opts.windowDays);
	const own = history
		.filter(
			(r) =>
				r.fixture === opts.fixture && r.sha === opts.sha && r.plan === plan && !r.experiment
		)
		.sort((a, b) => whenOf(a) - whenOf(b));
	const latest = own.at(-1);
	if (!latest) {
		return {
			cms: 'drupal',
			state: 'none',
			sha: opts.sha,
			release: '',
			plan,
			date: '',
			at: '',
			source: 'manual',
			expires: '',
			streak: 0,
			failing: []
		};
	}
	let streak = 0;
	let earned = false;
	let lastPass: string | undefined;
	let window: CertRecord[] = [];
	const lapsed = (date: string) =>
		lastPass !== undefined && Date.parse(date) - Date.parse(lastPass) > STALE_DAYS * DAY_MS;
	for (const r of own) {
		if (earned && lapsed(r.date)) {
			earned = false;
			streak = 0;
			window = [];
		}
		window = [...window, r].slice(-KEEP_WINDOW);
		if (recordPassed(r, opts.rows)) {
			streak++;
			lastPass = r.date;
			if (streak >= REQUIRED_STREAK) earned = true;
		} else {
			streak = 0;
		}
	}
	if (
		earned &&
		lastPass !== undefined &&
		Date.parse(opts.now) - Date.parse(lastPass) > STALE_DAYS * DAY_MS
	) {
		earned = false;
		streak = 0;
	}
	const certified = earned && holds(window, opts.rows);
	const state = certified ? 'certified' : lastPass !== undefined ? 'deployed' : 'none';
	return {
		cms: latest.cms,
		state,
		sha: latest.sha,
		release: latest.release,
		plan: latest.plan,
		date: latest.date,
		at: latest.at ?? `${latest.date}T00:00:00Z`,
		source: latest.trigger === 'schedule' ? 'scheduled' : 'manual',
		expires: lastPass === undefined ? '' : addDays(lastPass, STALE_DAYS),
		streak,
		...(latest.anachron ? { anachron: latest.anachron } : {}),
		failing: failingRows(latest, opts.rows)
	};
}

/** when a run finished, falling back to its date, so runs on one day keep their order */
const whenOf = (r: CertRecord): number => Date.parse(r.at ?? r.date);

/** adds records to a history and keeps the newest `HISTORY_PER_FIXTURE` per fixture */
export function appendRecords(
	history: readonly CertRecord[],
	added: readonly CertRecord[]
): CertRecord[] {
	const all = [...history, ...added].sort((a, b) => whenOf(b) - whenOf(a));
	const seen = new Map<string, number>();
	return all.filter((r) => {
		const n = (seen.get(r.fixture) ?? 0) + 1;
		seen.set(r.fixture, n);
		return n <= HISTORY_PER_FIXTURE;
	});
}

/** the status file for every fixture the corpus pins that has a record */
export function statusFile(
	history: readonly CertRecord[],
	corpus: { rows: readonly string[]; repos: readonly { id: string; sha: string }[] },
	now: string,
	intervalDays: number,
	windowDays?: number
): StatusFile {
	const fixtures: Record<string, CertStatus> = {};
	for (const repo of corpus.repos) {
		if (!history.some((r) => r.fixture === repo.id)) continue;
		fixtures[repo.id] = certificationState(history, {
			fixture: repo.id,
			sha: repo.sha,
			rows: corpus.rows,
			now,
			intervalDays,
			...(windowDays === undefined ? {} : { windowDays })
		});
	}
	return { generated: now, intervalDays, fixtures };
}
