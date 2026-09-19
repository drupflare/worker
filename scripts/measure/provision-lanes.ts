/**
 * Drives `action=provision` until a lane is actually VERIFIED, carrying the cursor.
 *
 * `provisionLane()` copies a BOUNDED number of rows per invocation and hands back a cursor. A caller
 * that ignores it restarts from row 0 every time and never finishes anything larger than one
 * budget -- which is what the shell loop this replaces did, and why four arms reported zero
 * provisioned lanes across 66 attempts each while looking busy.
 *
 * Two refusals are expected rather than exceptional, and each has its own answer:
 *
 *   - `torn`: the primary committed between invocations, so the resume is invalid. The cursor is
 *     dropped and the copy begins again. The primary's alarm chain commits every few seconds, so on
 *     a site whose copy needs more than one invocation this can repeat; raising `--budget` until the
 *     whole copy fits in one is what actually converges.
 *   - a lane already VERIFIED answers done immediately, so re-running this is safe.
 *
 *   bun scripts/measure/provision-lanes.ts --base=https://cfw-l096.workers.dev --lanes=96
 */

type Cursor = { generation: number; index: number; offset: number };
type Outcome = {
	ok: boolean;
	reason: string;
	done: boolean;
	cursor?: Cursor;
	copied?: number;
	stage?: string;
	torn?: boolean;
};

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.filter((a) => a.startsWith('--'))
		.map((a) => {
			const [k, v] = a.slice(2).split('=');
			return [k as string, v ?? '1'];
		})
);

const BASE = String(args.base ?? '').replace(/\/$/, '');
const LANES = Number(args.lanes ?? 1);
const SITE = String(args.site ?? 'm');
// high on purpose: a copy that fits in ONE invocation cannot be torn, because the generation is read
// once per call. That is the only way to converge against a primary that keeps committing.
const BUDGET = Number(args.budget ?? 60_000);
const STEPS = Number(args.steps ?? 60);
const FROM = Number(args.from ?? 1);

if (!BASE) {
	console.error('pass --base=https://<arm>.workers.dev');
	process.exit(1);
}

async function step(lane: number, cursor: Cursor | null): Promise<Outcome> {
	const u = new URL(`${BASE}/replica`);
	u.searchParams.set('site', SITE);
	u.searchParams.set('action', 'provision');
	u.searchParams.set('lane', String(lane));
	u.searchParams.set('budget', String(BUDGET));
	if (cursor !== null) u.searchParams.set('cursor', JSON.stringify(cursor));
	const res = await fetch(u, { signal: AbortSignal.timeout(180_000) });
	return (await res.json()) as Outcome;
}

async function provision(lane: number): Promise<{ ok: boolean; steps: number; reason: string }> {
	let cursor: Cursor | null = null;
	let tears = 0;
	for (let i = 1; i <= STEPS; i += 1) {
		let out: Outcome;
		try {
			out = await step(lane, cursor);
		} catch (e) {
			cursor = null;
			if (i === STEPS)
				return { ok: false, steps: i, reason: String((e as Error)?.message ?? e) };
			continue;
		}
		if (out.done) return { ok: true, steps: i, reason: '' };
		if (!out.ok) {
			// a tear invalidates the resume, never the rows already landed; the next attempt clears
			// the lane's markers itself
			if (out.torn || /torn copy/.test(out.reason)) tears += 1;
			cursor = null;
			if (i === STEPS)
				return { ok: false, steps: i, reason: `${out.reason} (${tears} tears)` };
			continue;
		}
		cursor = out.cursor ?? null;
		if (cursor === null) return { ok: true, steps: i, reason: '' };
	}
	return { ok: false, steps: STEPS, reason: `did not finish in ${STEPS} steps (${tears} tears)` };
}

const started = Date.now();
let ok = 0;
const failed: string[] = [];
for (let lane = FROM; lane <= LANES; lane += 1) {
	const r = await provision(lane);
	if (r.ok) ok += 1;
	else failed.push(`lane ${lane}: ${r.reason}`);
	if (lane % 16 === 0 || lane === LANES) {
		const rate = (Date.now() - started) / 1000 / (lane - FROM + 1);
		console.log(
			`  ${BASE.replace(/^https:\/\//, '')} lane ${lane}/${LANES} ok=${ok} ` +
				`failed=${failed.length} ${rate.toFixed(1)}s/lane`
		);
	}
}
console.log(
	`${BASE}: ${ok}/${LANES - FROM + 1} lanes provisioned in ${((Date.now() - started) / 1000).toFixed(0)}s`
);
for (const f of failed.slice(0, 10)) console.log(`  ${f}`);
process.exit(failed.length === 0 ? 0 : 1);
