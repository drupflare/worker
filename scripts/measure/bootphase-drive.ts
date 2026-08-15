/**
 * Drives `/bootphase` on a DEPLOYED worker so the per-phase cost can be read off cpuTime.
 *
 * WHY A SCRIPT. Every figure this produces has to come from `$workers.cpuTimeMs` in the Workers
 * Observability API (RULE 0), and that API meters an INVOCATION. So each phase needs its own
 * request, each request needs a site whose state is known, and the mapping from invocation back to
 * phase has to be exact. Doing that by hand is how a `page_cache` HIT gets recorded as a render.
 *
 * Two modes, and both are needed:
 *
 *   sweep    one FRESH site per phase per sample. Correct but expensive: a site costs one
 *            `/migrate?all=1` (~13 s wall) before it can boot anything.
 *   control  N calls of ONE phase against ONE site. This is the check that makes `sweep`'s cost
 *            avoidable or not: `/bootphase` drops the interpreter, so a repeat call is a cold
 *            interpreter, but it is NOT a cold DATABASE -- `$kernel->boot()` can write
 *            cache_bootstrap/cache_discovery rows and a render writes cache_page. If the repeats
 *            are flat, same-site sampling is sound; if they decline, only fresh sites are.
 *
 * Output is NDJSON, one line per measured request. Every measured request also carries a unique
 * `&tag=` parameter, and that is the correlation key: the observability dataset auto-extracts query
 * parameters as `$workers.event.request.search.tag`, so a `groupBys: [search.tag]` query returns one
 * cpuTime per measurement instead of a wall of events to match up by hand. Matching by timestamp
 * would work too and is worse -- it is latent-space work over data that has an exact join key.
 */

const BOOT_PHASES = [
	'autoload',
	'kernel-new',
	'container-read',
	'container-unserialize',
	'kernel-boot',
	'pre-handle',
	'render'
] as const;

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
		} else {
			out[key] = '1';
		}
	}
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, any>;

async function getJson(url: string, timeoutMs = 180_000): Promise<{ status: number; body: Json }> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctl.signal });
		const text = await res.text();
		let body: Json;
		try {
			body = JSON.parse(text);
		} catch {
			body = { __unparsed: text.slice(0, 400) };
		}
		return { status: res.status, body };
	} finally {
		clearTimeout(t);
	}
}

/**
 * Migrates a site to completion and refuses to return until it is `done`.
 *
 * `all=1` replays all 79 chunks in one invocation. That is NOT the free-plan shape --
 * it is setup, its cost is not part of any figure here, and driving 79 separate invocations per
 * site would make a 3-sample sweep take an hour.
 */
async function migrate(base: string, site: string, attempts = 20): Promise<Json> {
	for (let i = 0; i < attempts; i++) {
		const { body } = await getJson(`${base}/migrate?site=${encodeURIComponent(site)}&all=1`);
		if (body.done === true) return body;
		// `done: null` is the error shape, not a "keep going"
		if (body.done === null) throw new Error(`migrate failed for ${site}: ${body.error}`);
		await sleep(500);
	}
	throw new Error(`migrate never reached done for ${site}`);
}

type Row = {
	kind: 'bootphase' | 'boot-only';
	phase: string;
	sample: number;
	site: string;
	tag: string;
	startedAt: number;
	finishedAt: number;
	wallMs: number;
	status: number;
	alreadyBooted: number | null;
	containerBytes: number | null;
	renderBytes: number | null;
	renderStatus: number | null;
	ok: boolean | null;
	error: string | null;
	localMs: number | null;
	localElapsedMs: number | null;
};

function rowFromBootphase(
	phase: string,
	sample: number,
	site: string,
	tag: string,
	startedAt: number,
	finishedAt: number,
	status: number,
	body: Json
): Row {
	const r = (body.result ?? {}) as Json;
	return {
		kind: 'bootphase',
		phase,
		sample,
		site,
		tag,
		startedAt,
		finishedAt,
		wallMs: finishedAt - startedAt,
		status,
		alreadyBooted: typeof r.alreadyBooted === 'number' ? r.alreadyBooted : null,
		containerBytes: typeof r.containerBytes === 'number' ? r.containerBytes : null,
		renderBytes: typeof r.renderBytes === 'number' ? r.renderBytes : null,
		renderStatus: typeof r.renderStatus === 'number' ? r.renderStatus : null,
		ok: typeof r.ok === 'boolean' ? r.ok : null,
		error: typeof r.error === 'string' ? r.error : null,
		localMs: typeof r.localMs === 'number' ? r.localMs : null,
		localElapsedMs: typeof body.localElapsedMs === 'number' ? body.localElapsedMs : null
	};
}

/**
 * `/php` on a site that has never booted PHP: wasm instantiation plus the lazy MEMFS mount and
 * nothing else. This is the floor every phase figure sits on, and without it `autoload` cannot be
 * separated from the cost of merely having an interpreter.
 */
function rowFromBootOnly(
	sample: number,
	site: string,
	tag: string,
	startedAt: number,
	finishedAt: number,
	status: number,
	body: Json
): Row {
	return {
		kind: 'boot-only',
		phase: 'boot-only',
		sample,
		site,
		tag,
		startedAt,
		finishedAt,
		wallMs: finishedAt - startedAt,
		status,
		alreadyBooted: null,
		containerBytes: null,
		renderBytes: null,
		renderStatus: null,
		ok: typeof body.version === 'string' && body.version.length > 0,
		error: null,
		localMs: null,
		localElapsedMs: null
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const base = (args.base ?? '').replace(/\/$/, '');
	if (!base) throw new Error('--base <https://worker.example.workers.dev> is required');

	const out = args.out ?? '/tmp/bootphase/rows.ndjson';
	const prefix = args.prefix ?? 'bp';
	const rows: Row[] = [];
	const emit = async (row: Row) => {
		rows.push(row);
		await Bun.write(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
		const label = `${row.tag.padEnd(30)}`;
		console.log(
			`${label} http ${row.status} wall ${String(row.wallMs).padStart(6)} ms  ` +
				`alreadyBooted=${row.alreadyBooted} ok=${row.ok}` +
				(row.containerBytes !== null ? ` containerBytes=${row.containerBytes}` : '') +
				(row.renderBytes !== null ? ` renderBytes=${row.renderBytes}` : '') +
				(row.error ? ` ERROR ${row.error}` : '')
		);
	};

	if (args.control) {
		const phase = args.control === '1' ? 'kernel-boot' : args.control;
		const repeat = Number(args.repeat ?? 4);
		const site = args.site ?? `${prefix}-ctl-${phase}`;
		console.log(`control: ${repeat}x ${phase} on ONE site (${site})`);
		await migrate(base, site);
		for (let i = 0; i < repeat; i++) {
			await sleep(1500);
			const tag = `${prefix}-ctl-${phase}-r${i}`;
			const startedAt = Date.now();
			const { status, body } = await getJson(
				`${base}/bootphase?site=${encodeURIComponent(site)}&phase=${phase}&tag=${tag}`
			);
			await emit(rowFromBootphase(phase, i, site, tag, startedAt, Date.now(), status, body));
		}
		console.log(`\nwrote ${rows.length} rows to ${out}`);
		return;
	}

	/**
	 * `/drupal?repeat=N` on FRESH sites, N sweeping 1..max.
	 *
	 * The regression against N separates a cold render from a warm one inside a single cold
	 * invocation, which no `/bootphase` phase can: the slope is the marginal WARM render, and
	 * `repeat=1` minus the slope is the FIRST render plus everything under it. That is the exact
	 * quantity the "~850 ms kernel boot" figure got wrong -- it subtracted a 41 ms warm render out
	 * of a cold path, where the first render also compiles Twig and builds the discovery caches.
	 *
	 * `/drupal` empties `page` and `dynamic_page_cache` before every iteration and resets PageCache's
	 * memoised cid, so all N are renders rather than one render and N-1 cache hits.
	 */
	if (args['repeat-scan']) {
		// two widely separated points beat a dense scan here: the per-invocation spread is around
		// +/-1,500 ms, so 1 vs 3 cannot see a slope of a few hundred ms and 1 vs 10 can
		const ns = args.repeats
			? args.repeats.split(',').map((n) => Number(n.trim()))
			: Array.from({ length: Number(args['max-repeat'] ?? 3) }, (_, i) => i + 1);
		const reps = Number(args.samples ?? 3);
		for (let s = 0; s < reps; s++) {
			for (const n of ns) {
				const site = `${prefix}-rs${s}-n${n}`;
				const tag = `${prefix}-repeat${n}-s${s}`;
				await migrate(base, site);
				await sleep(1500);
				const startedAt = Date.now();
				const { status, body } = await getJson(
					`${base}/drupal?site=${encodeURIComponent(site)}&path=/&repeat=${n}&tag=${tag}`
				);
				const php = (body.php ?? {}) as Json;
				await emit({
					kind: 'bootphase',
					phase: `repeat${n}`,
					sample: s,
					site,
					tag,
					startedAt,
					finishedAt: Date.now(),
					wallMs: Date.now() - startedAt,
					status,
					alreadyBooted: 0,
					containerBytes: null,
					renderBytes: typeof php.bytes === 'number' ? php.bytes : null,
					renderStatus: typeof php.status === 'number' ? php.status : null,
					ok: php.ok === undefined ? null : Boolean(php.ok),
					error: typeof php.error === 'string' ? php.error : null,
					localMs: null,
					localElapsedMs: typeof body.wallMs === 'number' ? body.wallMs : null
				});
			}
		}
		console.log(`\nwrote ${rows.length} rows to ${out}`);
		return;
	}

	const samples = Number(args.samples ?? 3);
	const phases = (args.phases ? args.phases.split(',') : [...BOOT_PHASES]).map((p) => p.trim());
	for (const p of phases) {
		if (!(BOOT_PHASES as readonly string[]).includes(p)) throw new Error(`unknown phase: ${p}`);
	}
	const wantBootOnly = args['boot-only'] !== '0';

	// rotated per sample so an ordering effect cannot line up with a phase across every sweep
	for (let s = 0; s < samples; s++) {
		const order = phases.map((_, i) => phases[(i + s) % phases.length] as string);
		console.log(`\n=== sweep ${s}: ${order.join(' -> ')}`);
		for (const phase of order) {
			const site = `${prefix}-s${s}-${phase}`;
			const tag = `${prefix}-${phase}-s${s}`;
			await migrate(base, site);
			await sleep(1500);
			const startedAt = Date.now();
			const { status, body } = await getJson(
				`${base}/bootphase?site=${encodeURIComponent(site)}&phase=${phase}&tag=${tag}`
			);
			await emit(rowFromBootphase(phase, s, site, tag, startedAt, Date.now(), status, body));
		}
		if (wantBootOnly) {
			const site = `${prefix}-s${s}-bootonly`;
			const tag = `${prefix}-boot-only-s${s}`;
			await migrate(base, site);
			await sleep(1500);
			const startedAt = Date.now();
			const { status, body } = await getJson(
				`${base}/php?site=${encodeURIComponent(site)}&tag=${tag}`
			);
			await emit(rowFromBootOnly(s, site, tag, startedAt, Date.now(), status, body));
		}
	}

	const bad = rows.filter((r) => r.kind === 'bootphase' && r.alreadyBooted !== 0);
	console.log(`\nwrote ${rows.length} rows to ${out}`);
	console.log(
		bad.length === 0
			? 'alreadyBooted === 0 on every bootphase sample'
			: `WORTHLESS: ${bad.length} samples ran on a WARM object: ${bad.map((b) => `${b.phase}/s${b.sample}`).join(', ')}`
	);
	if (bad.length) process.exitCode = 1;
}

await main();
