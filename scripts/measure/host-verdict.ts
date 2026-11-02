import { writeFileSync } from 'node:fs';
import {
	type Cell,
	P95_CLOCK_QUANTUM_MS,
	TRAFFIC_MIX,
	decide,
	generatorBound,
	ratio,
	withRtt
} from './verdict-math';
import {
	type Sample,
	type Summary,
	WORKLOADS,
	bodiesAgree,
	isLocalTarget as isLocal,
	login,
	one,
	percentile,
	renderArm,
	run,
	setExtraHeaders
} from './vps-compare';

/**
 * ```sh
 * bun run vps:up                                        # nginx + php-fpm 8.5 on the same tree
 * bun run dev                                           # the drupflare arm
 * bun run measure:bench-site -- --pass=<pw>             # provision the site the edge arm serves
 * bun run measure:host -- --pass=<pw>
 * ```
 */

function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? (hit.split('=').slice(1).join('=') as string) : fallback;
}

const VPS = arg('vps', 'http://127.0.0.1:8099').replace(/\/$/, '');
const EDGE = arg('edge', 'http://127.0.0.1:8787').replace(/\/$/, '');
const SITE = arg('site', 'bench');
const USER = arg('user', 'admin');
const PASS = arg('pass', '');
const SECOND_USER = arg('second-user', 'bench-editor');
const SECONDS = Number(arg('seconds', '10'));
const WARMUP = Number(arg('warmup', '3'));
const RTT = Number(arg('rtt', '0'));
/** a 284-byte static file both arms serve without PHP, so the reading is the generator's */
const CEILING_PATH = arg('ceiling-path', '/core/misc/checkbox.js');
const CEILING_SECONDS = Number(arg('ceiling-seconds', '3'));
/** a network the operator injected on the VPS arm, in ms of round trip; declared, not detected */
const NETWORK_MS = Number(arg('network-ms', '0'));
/** bodies under this many bytes are not pages; 512 is under the smallest real one either arm serves */
const EMPTY_BODY_BYTES = 512;
const LEVELS = arg('concurrency', '1,4,16')
	.split(',')
	.map((n) => Number(n.trim()))
	.filter((n) => Number.isFinite(n) && n >= 1);
/** the closed-loop matrix excludes `anon-miss`, which `coldPathArm` measures instead */
const CLOSED_LOOP = Object.keys(TRAFFIC_MIX).filter((w) => w !== 'anon-miss');
const WANTED = arg('workload', CLOSED_LOOP.join(',')).split(',');

/** only a local edge needs the synthetic Host; a deployed hostname already resolves to the site */
const HEADERS = {
	vps: {} as Record<string, string>,
	edge: (isLocal(EDGE) ? { host: `${SITE}.localhost` } : {}) as Record<string, string>
} as const;

/** creates the second account through Drupal's own form, so both arms serve an identical site */
async function ensureSecondUser(
	base: string,
	cookie: string,
	headers: Record<string, string>
): Promise<'created' | 'present'> {
	const form = await fetch(`${base}/admin/people/create`, {
		headers: { ...headers, cookie },
		redirect: 'manual'
	});
	const html = await form.text();
	const buildId = /name="form_build_id" value="([^"]+)"/.exec(html)?.[1];
	const token = /name="form_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
	if (!buildId) throw new Error(`${base}/admin/people/create served no form to ${USER}`);

	const body = new URLSearchParams({
		name: SECOND_USER,
		mail: `${SECOND_USER}@example.invalid`,
		'pass[pass1]': PASS,
		'pass[pass2]': PASS,
		status: '1',
		// the same role as the benchmark admin, so the two sessions land in ONE role set. Two
		// sessions in DIFFERENT role sets key different plans and neither ever gets a second witness
		'roles[administrator]': 'administrator',
		form_build_id: buildId,
		form_id: 'user_register_form',
		form_token: token,
		op: 'Create new account'
	});
	const res = await fetch(`${base}/admin/people/create`, {
		method: 'POST',
		body,
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers }
	});
	const after = await res.text();
	if (/is already taken|already in use/.test(after)) return 'present';
	if (res.status >= 400) throw new Error(`creating ${SECOND_USER} answered ${res.status}`);
	// a rejected form is a 200, so read the messages region rather than trusting the status.
	const plain = after
		.replace(/<svg[\s\S]*?<\/svg>/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ');
	const refusal = /Error message(.{0,200})/.exec(plain)?.[1];
	if (refusal !== undefined) {
		throw new Error(`creating ${SECOND_USER} was refused: ${refusal.trim()}`);
	}
	return 'created';
}

/** the authenticated curve, driven by two alternating sessions; returns session A's requests only */
async function pairedSessionArm(
	base: string,
	kind: 'vps' | 'edge',
	path: string,
	n: number,
	a: string,
	b: string
): Promise<Sample[]> {
	if (kind === 'edge') {
		await fetch(`${base}/bump?reason=hostverdict`, { headers: HEADERS.edge });
		// the bump empties the page store and a local rig fires no alarm to refill it, so
		// `/user/login` would answer 503 `warming`. Driven synchronously, as `bench-site.ts` does
		for (const warm of ['/user/login', path]) {
			await fetch(`${base}/fill?path=${encodeURIComponent(warm)}`, { headers: HEADERS.edge });
			await fetch(`${base}/fill`, { headers: HEADERS.edge });
		}
	}
	const out: Sample[] = [];
	for (let i = 0; i < n; i++) {
		out.push(await one(`${base}${path}`, a));
		await one(`${base}${path}`, b);
	}
	return out;
}

/** provisions the replica lanes the edge arm needs; returns the lanes that reached SERVING */
async function provisionLanes(base: string, lanes: number): Promise<number[]> {
	const ready: number[] = [];
	for (let lane = 1; lane <= lanes; lane++) {
		let done = false;
		// the caller carries the cursor back; a loop that drops it re-copies the same chunk forever.
		let cursor = '';
		// a bound rather than a while(true): a lane that cannot copy would otherwise spin here, and
		// the degradation path is a 421 retry on the primary, which is a usable arm
		for (let step = 0; step < 120 && !done; step++) {
			const res = await fetch(
				`${base}/replica?action=provision&lane=${lane}&budget=4000` +
					(cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`),
				{ headers: HEADERS.edge }
			);
			if (!res.ok) break;
			const body = (await res.json()) as {
				ok?: boolean;
				done?: boolean;
				reason?: string;
				cursor?: unknown;
			};
			// a refusal is HTTP 200 with `ok:false`; stop asking after the first one.
			if (body.ok === false) {
				console.error(`[host-verdict] lane ${lane} refused: ${body.reason ?? 'no reason'}`);
				break;
			}
			done = body.done === true;
			if (body.cursor !== undefined) cursor = JSON.stringify(body.cursor);
		}
		if (done) ready.push(lane);
	}
	return ready;
}

/** ms from the first request to the first 2xx for an uncached URL, and the requests that took */
async function coldPathArm(
	base: string,
	kind: 'vps' | 'edge',
	n: number
): Promise<{ ms: number; attempts: number }[]> {
	const out: { ms: number; attempts: number }[] = [];
	for (let i = 0; i < n; i++) {
		const url = `${base}/?coldpath=${i}-${SECONDS}`;
		const t0 = Date.now();
		let attempts = 0;
		let served = false;
		// 12 is a bound, not an expectation: an unbounded retry against a path the chain has proven
		// it cannot store would never terminate, which `noteStorable()` exists to stop on the host
		while (attempts < 12 && !served) {
			attempts++;
			const sample = await one(url, null);
			if (sample.status >= 200 && sample.status < 400) {
				served = true;
				break;
			}
			if (kind === 'edge') await fetch(`${base}/fill`, { headers: HEADERS.edge });
		}
		out.push({ ms: served ? Date.now() - t0 : -1, attempts });
	}
	return out;
}

async function measureArm(
	base: string,
	kind: 'vps' | 'edge',
	workload: string,
	concurrency: number,
	cookie: string | null
): Promise<Summary> {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const summary = await run(base, workload, concurrency, SECONDS, cookie);
	// stop the run rather than note it: a cell whose samples never reached the host reads as fast
	if (summary.edgeRefusals > 0) {
		console.error(
			`[host-verdict] ${kind} ${workload} c=${concurrency}: ${summary.edgeRefusals} of ` +
				`${summary.n} samples were refused at the EDGE (a 4xx carrying no x-worker-ms). ` +
				'Nothing below measured the host; fix the request the generator is sending.'
		);
		process.exit(3);
	}
	return summary;
}

if (PASS === '') {
	console.error('usage: bun scripts/measure/host-verdict.ts --pass=<admin password> [--rtt=25]');
	console.error(
		'  every authenticated workload needs it, and so does creating the second editor'
	);
	process.exit(2);
}

// #region the generator's own ceiling, which bounds every cell below it
// each arm's own no-work endpoint, because the two arms do not share one
WORKLOADS.ceiling!.path = CEILING_PATH;

/** the generator's ceiling per concurrency level, through the same closed loop the cells use */
const ceilings: Record<string, Record<number, number>> = { vps: {}, edge: {} };
const ceilingBytes: Record<string, number> = {};
/** each arm's transport cost with no application code in it; see the c=1 branch below */
const floorMs: Record<string, number> = {};
for (const [kind, base] of [
	['vps', VPS],
	['edge', EDGE]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const probe = await one(`${base}${CEILING_PATH}`, null);
	ceilingBytes[kind] = probe.bytes;
	if (probe.status !== 200) {
		console.error(
			`[host-verdict] ${kind} answered ${probe.status} for the ceiling path ${CEILING_PATH}; ` +
				'a ceiling taken against a non-200 measures the refusal'
		);
		process.exit(2);
	}
	for (const concurrency of LEVELS) {
		const summary = await run(base, 'ceiling', concurrency, CEILING_SECONDS, null);
		ceilings[kind]![concurrency] = summary.rps;
		// the ceiling path runs no app code, so its time is each arm's transport floor.
		// integer ms rounds the floor: measured at c=1 as 0.561 ms vps and 1.165 ms edge.
		if (concurrency === 1) floorMs[kind] = summary.p50;
		console.error(
			`[host-verdict] ${kind} generator ceiling c=${String(concurrency).padStart(3)} ` +
				`${summary.rps.toFixed(1).padStart(8)} req/s` +
				(concurrency === 1 ? `  harness floor p50 ${summary.p50} ms` : '')
		);
		// let the client's connection pool drain: a burst of loopback sockets leaves it refusing.
		await new Promise((r) => setTimeout(r, 3000));
	}
}
// #endregion

/** fills the login paths after the lanes are copied; copying a lane empties the page store */
const LANES = Number(arg('lanes', '3'));
const lanesReady = LANES > 0 ? await provisionLanes(EDGE, LANES) : [];
console.error(
	`[host-verdict] edge replica lanes ready: ${lanesReady.length}/${LANES}` +
		`${lanesReady.length < LANES ? ' (the rest degrade to a 421 retry on the primary)' : ''}`
);

// `/user/login` last: the run's later arms bump the generation and would invalidate it.
for (const path of ['/', '/admin/content', '/user', '/user/login']) {
	// fill until this path serves, not once: one drain per path leaves a cold `/user/login` behind.
	for (let i = 0; i < 40; i++) {
		// `redirect: 'manual'` is required: a 302 to `<site>.localhost` throws ConnectionRefused,
		// which reads like the worker dying. A 302 counts as served here (the `< 400` check below).
		const res = await fetch(`${EDGE}/serve?path=${encodeURIComponent(path)}`, {
			headers: HEADERS.edge,
			redirect: 'manual'
		});
		await res.arrayBuffer();
		if (res.status < 400) break;
		await fetch(`${EDGE}/fill?path=${encodeURIComponent(path)}`, { headers: HEADERS.edge });
		await fetch(`${EDGE}/fill`, { headers: HEADERS.edge });
	}
}

console.error(`[host-verdict] logging in to both arms as ${USER}`);
/** retried: a login fails intermittently on a cold form, and that failure is not a wrong password */
async function loginRetrying(
	base: string,
	headers: Record<string, string>
): Promise<string | null> {
	for (let i = 0; i < 4; i++) {
		setExtraHeaders(headers);
		const cookie = await login(base, USER, PASS);
		if (cookie !== null) return cookie;
		const res = await fetch(`${base}/serve?path=${encodeURIComponent('/user/login')}`, {
			headers
		});
		await res.arrayBuffer();
		console.error(`[host-verdict] login attempt ${i + 1} failed; /user/login is ${res.status}`);
		await fetch(`${base}/fill?path=${encodeURIComponent('/user/login')}`, { headers }).catch(
			() => undefined
		);
		await fetch(`${base}/fill`, { headers }).catch(() => undefined);
	}
	return null;
}

const vpsCookie = await loginRetrying(VPS, HEADERS.vps);
const edgeCookie = await loginRetrying(EDGE, HEADERS.edge);
setExtraHeaders(HEADERS.edge);
if (vpsCookie === null || edgeCookie === null) {
	console.error(
		`could not log in: vps=${vpsCookie === null ? 'failed' : 'ok'} ` +
			`edge=${edgeCookie === null ? 'failed' : 'ok'}. Is --pass right, and has ` +
			'`bun run measure:bench-site` provisioned the edge site?'
	);
	process.exit(2);
}

const notes: string[] = [];

/** a local edge arm cannot measure concurrency: one workerd thread stands in for a colo */
if (isLocal(EDGE) && LEVELS.some((c) => c > 1)) {
	notes.push(
		'the edge arm is a local `wrangler dev`, which is one workerd thread, so every cell above ' +
			'c=1 measures that thread rather than the platform; the deployed anonymous cached path ' +
			'holds p50 flat from c=4 to c=32'
	);
	console.error(`[host-verdict] ${notes[notes.length - 1]}`);
}

for (const [kind, base, cookie] of [
	['vps', VPS, vpsCookie],
	['edge', EDGE, edgeCookie]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const state = await ensureSecondUser(base, cookie, kind === 'edge' ? HEADERS.edge : {});
	notes.push(`${kind}: second editor ${SECOND_USER} ${state}`);
	console.error(`[host-verdict] ${kind} second editor ${state}`);
}

setExtraHeaders(HEADERS.vps);
const vpsSecond = await login(VPS, SECOND_USER, PASS);
setExtraHeaders(HEADERS.edge);
const edgeSecond = await login(EDGE, SECOND_USER, PASS);
if (vpsSecond === null || edgeSecond === null) {
	console.error('the second editor exists but cannot log in; the plan tier cannot be reached');
	process.exit(2);
}

/** the rig's resolution, from running one arm as both arms; its ratio is 1.000x by construction */
async function selfControl(): Promise<{ p50: number; rps: number; p95SpreadMs: number }> {
	setExtraHeaders(HEADERS.edge);
	const a = await measureArm(EDGE, 'edge', CONTROL_WORKLOAD, CONTROL_LEVEL, edgeCookie);
	const b = await measureArm(EDGE, 'edge', CONTROL_WORKLOAD, CONTROL_LEVEL, edgeCookie);
	// the absolute spread as well as the ratio: a ratio over one or two clock quanta is quantisation.
	return {
		p50: ratio(a.p50, b.p50),
		rps: ratio(b.rps, a.rps),
		p95SpreadMs: Math.abs(a.p95 - b.p95)
	};
}

const CONTROL_WORKLOAD = 'anon-cached';
const CONTROL_LEVEL = 4;

function reportControl(
	when: 'before' | 'after',
	c: { p50: number; rps: number; p95SpreadMs: number }
): void {
	console.error(
		`[host-verdict] rig resolution ${when} the matrix, one arm as both: ` +
			`p50x=${c.p50.toFixed(2)} rpsx=${c.rps.toFixed(2)} p95spread=${c.p95SpreadMs}ms`
	);
}

/** two controls: a pair dates drift, where a single reading dates only the noise floor */
const controlBefore = await selfControl();
reportControl('before', controlBefore);

// #region the matrix
const cells: Cell[] = [];
let round = 0;
for (const workload of WANTED) {
	const spec = TRAFFIC_MIX[workload];
	if (!spec) {
		console.error(
			`unknown workload ${workload}; known: ${Object.keys(TRAFFIC_MIX).join(', ')}`
		);
		process.exit(2);
	}
	// warm each arm once per workload, outside the readings, so an opcache fill or a lazy mount is
	// not folded into the first level
	if (WARMUP > 0) {
		await measureArm(VPS, 'vps', workload, 2, vpsCookie);
		await measureArm(EDGE, 'edge', workload, 2, edgeCookie);
	}
	for (const concurrency of LEVELS) {
		// rotated per cell: a fixed order charges any drift inside a cell to the same arm every time.
		const edgeLeads = round++ % 2 === 1;
		let vps: Summary;
		let edge: Summary;
		if (edgeLeads) {
			edge = await measureArm(EDGE, 'edge', workload, concurrency, edgeCookie);
			vps = await measureArm(VPS, 'vps', workload, concurrency, vpsCookie);
		} else {
			vps = await measureArm(VPS, 'vps', workload, concurrency, vpsCookie);
			edge = await measureArm(EDGE, 'edge', workload, concurrency, edgeCookie);
		}
		// a ceiling bigger than the cell is not a ceiling: a heavy no-work path reads as a lower bound.
		// a 200 carrying a 2-byte body is not a page, and the error-fraction check cannot see it.
		for (const [kind, arm] of [
			['vps', vps],
			['edge', edge]
		] as const) {
			const ceilBytes = ceilingBytes[kind] ?? 0;
			if (arm.bytes > 0 && arm.bytes < EMPTY_BODY_BYTES) {
				console.error(
					`[host-verdict] ${kind} ${workload} c=${concurrency}: a mean body of ` +
						`${arm.bytes} bytes over ${arm.n} samples. A page workload answering in ` +
						'fewer bytes than a redirect measured no page, whatever status it carried.'
				);
				process.exit(3);
			}
			if (arm.bytes > 0 && ceilBytes > arm.bytes) {
				console.error(
					`[host-verdict] ${kind} ${workload} c=${concurrency}: the ceiling path is ` +
						`${ceilBytes} bytes against this cell's ${arm.bytes}, so the ceiling is the ` +
						'heavier request and cannot bound it. Pass a smaller --ceiling-path.'
				);
				process.exit(2);
			}
		}
		const bound = generatorBound(
			concurrency,
			{ vps: vps.rps, edge: edge.rps },
			{ vps: ceilings.vps, edge: ceilings.edge }
		);
		cells.push({
			workload,
			concurrency,
			vps,
			edge,
			p50Ratio: ratio(withRtt(vps.p50, RTT), edge.p50),
			p95Ratio: ratio(withRtt(vps.p95, RTT), edge.p95),
			rpsRatio: ratio(edge.rps, vps.rps),
			generatorBound: bound
		});
		const c = cells[cells.length - 1] as Cell;
		console.error(
			`[host-verdict] ${workload.padEnd(13)} c=${String(concurrency).padStart(3)} ` +
				`vps p50=${String(vps.p50).padStart(5)}ms rps=${vps.rps.toFixed(1).padStart(7)} | ` +
				`edge p50=${String(edge.p50).padStart(5)}ms rps=${edge.rps.toFixed(1).padStart(7)} | ` +
				`p50x=${c.p50Ratio.toFixed(2)} rpsx=${c.rpsRatio.toFixed(2)}` +
				`${bound ? ' GENERATOR-BOUND' : ''}${edge.errors || vps.errors ? ' ERRORS' : ''}`
		);
	}
}

const controlAfter = await selfControl();
reportControl('after', controlAfter);
const drifted = Math.abs(controlAfter.p50 - controlBefore.p50) > 0.25;
if (drifted) {
	notes.push(
		`the rig drifted during the matrix: self-control p50x ${controlBefore.p50.toFixed(2)} ` +
			`before against ${controlAfter.p50.toFixed(2)} after, so a cross-arm ratio taken ` +
			'between them is not safe to read'
	);
	console.error(`[host-verdict] ${notes[notes.length - 1]}`);
}
// #endregion

// #region the authenticated curve, where the plan tier finally has two witnesses
const curves: Record<string, { first: number; converged: number; tiers: string[] }> = {};
for (const [kind, base, a, b] of [
	['vps', VPS, vpsCookie, vpsSecond],
	['edge', EDGE, edgeCookie, edgeSecond]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	// 12 rather than 8: 8 sits on the convergence point, and one ERROR in the sequence costs a witness.
	const samples = await pairedSessionArm(base, kind, '/admin/content', 12, a, b);
	const tail = samples
		.slice(3)
		.map((s) => s.ms)
		.sort((x, y) => x - y);
	curves[kind] = {
		first: samples[0]?.ms ?? 0,
		converged: percentile(tail, 50),
		tiers: samples.map((s) => s.tier)
	};
	console.error(
		`[host-verdict] ${kind} /admin/content paired curve first=${curves[kind]?.first}ms ` +
			`converged p50=${curves[kind]?.converged}ms tiers=[${curves[kind]?.tiers.join(' ')}]`
	);
}
// #endregion

// #region the uncached tail, as a visitor meets it
const coldPaths: Record<string, { ms: number; attempts: number }[]> = {};
for (const [kind, base] of [
	['vps', VPS],
	['edge', EDGE]
] as const) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	coldPaths[kind] = await coldPathArm(base, kind, 5);
	const served = (coldPaths[kind] ?? []).filter((r) => r.ms >= 0);
	const times = served.map((r) => r.ms).sort((a, b) => a - b);
	console.error(
		`[host-verdict] ${kind} cold path served ${served.length}/5 ` +
			`p50=${percentile(times, 50)}ms attempts=[${(coldPaths[kind] ?? [])
				.map((r) => r.attempts)
				.join(', ')}]`
	);
}
// #endregion

// #region the render arm, which is the same workload on both sides
// edge first on odd runs, so drift inside the block does not favour one arm
const renders: Record<string, { cold: number; warm: number[]; bytes: number; dpc: string }> = {};
const renderOrder = [
	['vps', VPS],
	['edge', EDGE]
] as const;
for (const [kind, base] of Date.now() % 2 === 0 ? renderOrder : [...renderOrder].reverse()) {
	setExtraHeaders(kind === 'edge' ? HEADERS.edge : HEADERS.vps);
	const samples = await renderArm(base, kind === 'edge' ? 'drupflare' : 'vps', 7);
	const rest = samples.slice(1);
	renders[kind] = {
		cold: samples[0]?.ms ?? 0,
		warm: rest.map((s) => s.ms).sort((a, b) => a - b),
		bytes: rest[0]?.bytes ?? 0,
		dpc: rest[0]?.dynamicCache ?? ''
	};
	const w = renders[kind]?.warm ?? [];
	console.error(
		`[host-verdict] ${kind} re-render cold=${renders[kind]?.cold}ms ` +
			`warm p50=${percentile(w, 50)}ms bytes=${renders[kind]?.bytes} ` +
			`dpc=${renders[kind]?.dpc} all=[${w.join(', ')}]`
	);
}
// a ratio across two different pages is not a ratio; see `bodiesAgree()`.
if (!bodiesAgree(renders.vps?.bytes ?? 0, renders.edge?.bytes ?? 0)) {
	notes.push(
		`THE RENDER ARMS RENDERED DIFFERENT PAGES: vps ${renders.vps?.bytes} bytes against edge ` +
			`${renders.edge?.bytes}. The re-render ratio is not comparable. Re-seed the VPS with ` +
			'`bun run vps:down && bun run vps:up`, which drops the volume, and re-run.'
	);
}
// #endregion

const planned = (curves.edge?.tiers ?? []).some((t) => t.startsWith('PLAN'));
if (!planned) {
	notes.push(
		'NO CELL WAS ANSWERED BY THE COMPILED-PLAN TIER. The two-witness pair did not converge, so ' +
			'the authenticated figures are a render-against-render comparison and understate the arm.'
	);
}
if (lanesReady.length < LANES) {
	notes.push(
		`the edge arm ran with ${lanesReady.length} of ${LANES} replica lanes, so its concurrency ` +
			'cells are closer to the single-object reading than to the pooled one'
	);
}
// the arms are not equidistant from the generator; the gap is reported rather than subtracted.
const floorGap = Math.abs((floorMs.edge ?? 0) - (floorMs.vps ?? 0));
if (floorMs.edge !== undefined && floorMs.vps !== undefined && floorGap > 0) {
	notes.push(
		NETWORK_MS > 0
			? `THE VPS ARM CARRIES AN INJECTED ${NETWORK_MS} ms ROUND TRIP, which is what the ` +
					`${floorGap} ms floor difference is: vps ${floorMs.vps} ms against edge ` +
					`${floorMs.edge} ms on a path that runs no application code on either arm. That gap ` +
					'is the QUANTITY BEING MEASURED, not an artifact to discount -- a single-region VPS ' +
					'is one network hop from a visitor and an edge network answers from their own colo. ' +
					'It understates twice: the proxy delays data rather than the TCP handshake, and the ' +
					'edge arm stays local and pays no network at all.'
			: `HARNESS FLOORS DIFFER: vps ${floorMs.vps} ms against edge ${floorMs.edge} ms on a ` +
					'path that runs no application code on either arm (it carries no `x-worker-ms`, so ' +
					`the Worker script never executes for it). Any cell whose p50 gap is at or under ` +
					`${floorGap} ms is inside the transport difference rather than the hosts. nginx ` +
					'answers on a published docker port; `wrangler dev` proxies a node process in front ' +
					'of workerd, which a deployed worker does not do.'
	);
}
if (RTT > 0) {
	notes.push(
		`the VPS arm carries a stated ${RTT} ms network round trip; the verdict itself is taken ` +
			'from rtt=0, which is the VPS at its best'
	);
}

/** asymmetric arms are judged on the quantity chosen here, not on total latency */
const DECIDED_ON = isLocal(EDGE) === isLocal(VPS) ? 'total-p50' : 'service-time';
// the rig's own resolution, from a pair of identical runs; the worse of the two controls
const P95_FLOOR = Math.max(
	P95_CLOCK_QUANTUM_MS,
	controlBefore.p95SpreadMs,
	controlAfter.p95SpreadMs
);
const verdict = decide(cells, RTT, notes, TRAFFIC_MIX, DECIDED_ON, P95_FLOOR);
const weighted = verdict.weighted;

const report = {
	generatedBy: 'scripts/measure/host-verdict.ts',
	vps: VPS,
	edge: EDGE,
	seconds: SECONDS,
	rttMs: RTT,
	ceilings,
	// each arm's transport-only cost, so a reader can subtract it themselves rather than trust a
	// cross-arm p50 on a workload smaller than the difference between the two harnesses
	harnessFloorMs: floorMs,
	lanesRequested: LANES,
	lanesReady,
	trafficMix: TRAFFIC_MIX,
	cells,
	curves,
	coldPaths,
	renders,
	verdict
};

console.error('');
console.error(
	`[host-verdict] weighted ${verdict.decidedOn}  vps=${weighted.vps.toFixed(1)}ms ` +
		`edge=${weighted.edge.toFixed(1)}ms  ratio=${verdict.weightedRatio.toFixed(2)}x`
);
console.error(`[host-verdict] ${verdict.because}`);
console.error(`[host-verdict] VIABLE: ${verdict.viable ? 'yes' : 'no'}`);
for (const r of verdict.regressions) console.error(`[host-verdict]   regression: ${r}`);
for (const n of verdict.notes) console.error(`[host-verdict]   note: ${n}`);

const out = arg('out', '');
if (out !== '') {
	writeFileSync(out, JSON.stringify(report, null, 2));
	console.error(`[host-verdict] wrote ${out}`);
} else {
	console.log(JSON.stringify(report, null, 2));
}

process.exit(verdict.viable ? 0 : 1);
