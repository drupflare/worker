/**
 * Prices a COLD SERVE on a deployed worker, one arm per heap-image state.
 *
 * THE DROP IS HIBERNATION, not a route that nulls `this.php`. That is the production shape and it
 * needs no shipping-code change: a Durable Object hibernates after 10 s idle and hibernation
 * discards the interpreter, so a request after a 25 s gap boots and renders in ONE invocation --
 * which is what RULE 0 needs, because `cpuTime` meters an invocation.
 *
 * COLDNESS IS CHECKED RATHER THAN ASSUMED. `crossingsTotal` and `alarmFirings` are read after every
 * sample; a fresh incarnation reports one fill's worth and a warm one reports a multiple. An arm
 * that silently stopped hibernating would otherwise report a fast cold serve.
 *
 * Arms:
 *   none      no image; every boot refuses with `no snapshot for this pack generation`
 *   produced  the image the alarm's own producer takes -- `snapshotStep()`, post-kernel-boot
 *   rendered  an image taken from a heap that has already served, which is bigger and faster
 *
 * Read the result with `scripts/measure/obs-cpu.ts`, which joins `?tag=` back to `cpuTime`.
 *
 *   bun scripts/measure/coldserve-ladder.ts --base https://cfw-x.workers.dev --n 8
 */

type Args = Record<string, string | undefined>;

function parseArgs(argv: string[]): Args {
	const out: Args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[key] = next;
			i++;
		} else out[key] = '1';
	}
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Json = Record<string, any>;

async function getJson(url: string, timeoutMs = 240_000): Promise<{ status: number; body: Json }> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctl.signal });
		const text = await res.text();
		try {
			return { status: res.status, body: JSON.parse(text) };
		} catch {
			return { status: res.status, body: { __unparsed: text.slice(0, 300) } };
		}
	} finally {
		clearTimeout(t);
	}
}

const args = parseArgs(process.argv.slice(2));
const base = (args.base ?? '').replace(/\/$/, '');
if (!base) throw new Error('--base <https://worker.example.workers.dev> is required');
const prefix = args.prefix ?? 'cs';
const samples = Number(args.n ?? 8);
const idleMs = Number(args.idle ?? 25_000);
const path = args.path ?? '/';
const out = args.out ?? '/tmp/coldserve/ladder.ndjson';

const ARMS = ['none', 'produced', 'rendered'] as const;
type Arm = (typeof ARMS)[number];
const siteFor = (arm: Arm) => `${prefix}-${arm}`;

const q = (site: string, sql: string) =>
	`${base}/sql?site=${encodeURIComponent(site)}&q=${encodeURIComponent(sql)}`;

async function migrate(site: string): Promise<Json> {
	for (let i = 0; i < 30; i++) {
		const { body } = await getJson(`${base}/migrate?site=${encodeURIComponent(site)}&all=1`);
		if (body.done === true) return body;
		if (body.done === null) throw new Error(`migrate failed for ${site}: ${body.error}`);
		await sleep(500);
	}
	throw new Error(`migrate never reached done for ${site}`);
}

/** clears the stored page and queues the path; arms nothing, so the idle gap is not cut short */
async function queuePath(site: string): Promise<void> {
	await getJson(q(site, `DELETE FROM cfw_page`));
	await getJson(
		q(
			site,
			`INSERT OR REPLACE INTO cfw_fill_queue (path, queued_at, attempts, last_error) ` +
				`VALUES ('${path}', ${Date.now()}, 0, NULL)`
		)
	);
}

/**
 * One alarm firing, driven rather than waited for.
 *
 * `/armfill` arms only when the queue is non-empty, so a path is queued first. The producer needs
 * TWO firings by construction -- the first gives the resident module back and the second images the
 * clean boot -- which is why callers run this twice.
 */
async function driveAlarm(site: string): Promise<void> {
	await queuePath(site);
	await getJson(`${base}/armfill?site=${encodeURIComponent(site)}`);
	await sleep(6_000);
}

type Row = {
	arm: Arm;
	site: string;
	sample: number;
	tag: string;
	status: number;
	wallMs: number;
	filled: string | null;
	bytes: number | null;
	crossingsTotal: number | null;
	alarmFirings: number | null;
	restored: boolean | null;
	restoreReason: string | null;
	imageRows: number | null;
	imageBytes: number | null;
	error: string | null;
};

const rows: Row[] = [];
async function emit(r: Row) {
	rows.push(r);
	await Bun.write(out, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
	console.log(
		`${r.tag.padEnd(24)} http ${r.status} wall ${String(r.wallMs).padStart(6)} ms  ` +
			`filled=${r.filled} crossings=${r.crossingsTotal} firings=${r.alarmFirings} ` +
			`restored=${r.restored}` +
			(r.restoreReason ? ` (${r.restoreReason})` : '') +
			(r.error ? `  ERROR ${r.error}` : '')
	);
}

async function main() {
	console.log(`# base ${base}  n=${samples}  idle=${idleMs}ms  path=${path}`);

	for (const arm of ARMS) {
		const site = siteFor(arm);
		const m = await migrate(site);
		console.log(`# migrated ${site}: chunks=${m.chunks}`);
	}

	// identical warm-up on every arm before any image is taken (RULE 13), and the second render is
	// what writes this site's own cache_container row -- the producer's precondition
	for (let w = 0; w < 2; w++) {
		for (const arm of ARMS) {
			const site = siteFor(arm);
			await queuePath(site);
			const { body } = await getJson(`${base}/fill?site=${encodeURIComponent(site)}`);
			console.log(`# warm ${w} ${site}: filled=${body.filled} bytes=${body.bytes}`);
		}
	}

	// `produced` images itself the way a real site does: through its own alarm, twice
	await driveAlarm(siteFor('produced'));
	await driveAlarm(siteFor('produced'));

	// `rendered` images the live heap instead, which is the arm the producer does NOT take --
	// a served heap carries request state and that safety question is open
	await getJson(`${base}/heap?site=${encodeURIComponent(siteFor('rendered'))}&op=snapshot`);

	const images: Record<string, Json> = {};
	for (const arm of ARMS) {
		const site = siteFor(arm);
		const { body } = await getJson(`${base}/heap?site=${encodeURIComponent(site)}`);
		images[arm] = body;
		console.log(
			`# image ${site}: latest=${JSON.stringify(body.latest)} ` +
				`imagedGeneration=${body.imagedGeneration} attempts=${body.imageAttempts}`
		);
	}

	for (let s = 0; s < samples; s++) {
		// THE IDLE GAP COMES FIRST and the queue is filled after it. Queueing before the sleep
		// leaves `queueNonEmpty` true, which shortens the object's own re-arm from 240 s to 1 ms --
		// so any arm with a live alarm chain drains the page and stays warm through the gap. Measured:
		// that arm reported `filled=null` at 36-40 ms with `alarmFirings` climbing to 33.
		await sleep(idleMs);
		// the order rotates, so a fixed position in the round cannot be read as an arm effect
		const order = ARMS.map((_, i) => ARMS[(i + s) % ARMS.length] as Arm);
		for (const arm of order) {
			const site = siteFor(arm);
			const tag = `${prefix}-${arm}-s${s}`;
			// `/sql` wakes the object but never boots PHP, so the fill that follows is still cold
			await queuePath(site);
			const t0 = Date.now();
			const fill = await getJson(
				`${base}/fill?site=${encodeURIComponent(site)}&tag=${encodeURIComponent(tag)}`
			);
			const wallMs = Date.now() - t0;
			const stats = await getJson(`${base}/serve-stats?site=${encodeURIComponent(site)}`);
			const heap = await getJson(`${base}/heap?site=${encodeURIComponent(site)}`);
			const hr = heap.body?.heapRestore ?? null;
			await emit({
				arm,
				site,
				sample: s,
				tag,
				status: fill.status,
				wallMs,
				filled: fill.body?.filled ?? null,
				bytes: typeof fill.body?.bytes === 'number' ? fill.body.bytes : null,
				crossingsTotal:
					typeof stats.body?.crossingsTotal === 'number'
						? stats.body.crossingsTotal
						: null,
				alarmFirings:
					typeof stats.body?.alarmFirings === 'number' ? stats.body.alarmFirings : null,
				restored: hr === null ? null : Boolean(hr.restored),
				restoreReason: hr?.reason ?? null,
				imageRows: heap.body?.latest?.chunks ?? null,
				imageBytes: heap.body?.latest?.byteLength ?? null,
				error: fill.body?.error ?? null
			});
		}
	}
	console.log(`# wrote ${rows.length} rows to ${out}`);
}

await main();
