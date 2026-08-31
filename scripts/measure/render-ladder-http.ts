/**
 * The render ladder measured with a clock OUTSIDE the isolate.
 *
 * Every figure in the previous round came from `renderMs`, which is PHP `microtime()` inside the
 * Durable Object -- and that clock was measured going fully flat inside one invocation
 * (`distinctReadings: 1` over 3,000 samples). Accumulating it over 30 renders is fine for
 * attributing a bucket and is not evidence for "faster than a VPS". This script drives a
 * `wrangler dev` over HTTP and times each request from node, so nothing being measured shares a
 * clock with the thing measuring it.
 *
 * It measures MORE than the render: local HTTP, the front worker, the edge-cache tier and the JSON
 * boundary are all inside every number, which is the end-to-end quantity a VPS comparison is
 * about; the `floor` arm is what prices the part that is not Drupal.
 *
 *   bunx wrangler dev -c wrangler.jsonc --port 8799 --var SITE_ID:extclock --persist-to <dir>
 *   bun scripts/measure/render-ladder-http.ts [--port=8799] [--site=extclock] [--n=40]
 */

const arg = (name: string, fallback: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const PORT = Number(arg('port', '8799'));
const SITE = arg('site', 'extclock');
const N = Number(arg('n', '40'));
const ROUTE = arg('route', '/user/login');
const BASE = `http://127.0.0.1:${PORT}`;

const call = async (path: string, init?: RequestInit): Promise<Response> => {
	const url = new URL(BASE + path);
	if (!url.searchParams.has('site')) url.searchParams.set('site', SITE);
	return fetch(url, { signal: AbortSignal.timeout(300_000), ...init });
};

const json = async <T>(path: string, init?: RequestInit): Promise<T> =>
	(await (await call(path, init)).json()) as T;

async function provision(): Promise<void> {
	for (let i = 0; i < 80; i++) {
		const r = await json<{ ok: boolean; done: boolean | null }>('/migrate?all=1');
		if (r.done === true) break;
		if (r.ok === false) throw new Error(`migration refused: ${JSON.stringify(r)}`);
	}
	const first = await call('/firstrun?force=1', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ adminPass: 'cfw-ExtClock-8812-pass', siteName: 'ExtClock' })
	});
	if (!first.ok)
		throw new Error(`firstrun ${first.status}: ${(await first.text()).slice(0, 300)}`);
}

/** one timed request; the body is drained inside the window or the clock stops before the work does */
async function timed(path: string): Promise<{ ms: number; status: number; bytes: number }> {
	const t0 = performance.now();
	const res = await call(path);
	const body = await res.arrayBuffer();
	return { ms: performance.now() - t0, status: res.status, bytes: body.byteLength };
}

const both = 'page,dynamic_page_cache';
const arms: Record<string, () => Promise<{ ms: number; status: number; bytes: number }>> = {
	// the front worker alone: no Durable Object PHP at all
	floor: () => timed('/stats'),
	// a route whose controller returns a Response with no render array
	bare: () => timed(`/assemble?path=${encodeURIComponent('/session/token')}&bins=`),
	full: () => timed(`/assemble?path=${encodeURIComponent(ROUTE)}&bins=${both}`),
	dpc: async () => {
		await call(`/assemble?path=${encodeURIComponent(ROUTE)}&bins=${both}`);
		return timed(`/assemble?path=${encodeURIComponent(ROUTE)}&bins=page`);
	},
	// a stored page answered off ctx.storage.sql without booting PHP
	stored: () => timed(`/serve?path=${encodeURIComponent(ROUTE)}&edge=0`),
	// the compiled plan executed by the JS VM: same bytes, no interpreter
	plan: () => timed(`/plan?action=run&path=${encodeURIComponent(ROUTE)}`)
};

function stat(ms: number[]): Record<string, number> {
	const s = [...ms].sort((a, b) => a - b);
	const q = (p: number) => +s[Math.floor(p * (s.length - 1))]!.toFixed(2);
	return { n: s.length, min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75) };
}

await provision();

// the plan the `plan` arm executes, recompiled here so the op count is the one reported
const CHUNK = Number(arg('chunk', '0'));
const compiled = await json<Record<string, unknown>>(
	`/plan?action=compile&chunk=${CHUNK}&path=${encodeURIComponent(ROUTE)}`
);
if (compiled.roundTrips !== true || compiled.explainsBoth !== true) {
	throw new Error(`the plan does not explain both renders: ${JSON.stringify(compiled)}`);
}
if ((compiled.unservable as string[] | undefined)?.length) {
	throw new Error(`the plan holds a slot with no generator: ${JSON.stringify(compiled)}`);
}

const names = Object.keys(arms);
// warm every arm, including the stored page, before any clock starts
for (let i = 0; i < 4; i++) for (const k of names) await arms[k]!();

const samples: Record<string, number[]> = {};
const facts: Record<string, { status: number; bytes: number }> = {};
for (const k of names) samples[k] = [];

for (let i = 0; i < N; i++) {
	const order = i % 2 === 0 ? names : [...names].reverse();
	for (const k of order) {
		const r = await arms[k]!();
		samples[k]!.push(r.ms);
		facts[k] ??= { status: r.status, bytes: r.bytes };
	}
}

const rows = Object.fromEntries(
	Object.entries(samples).map(([k, v]) => [k, { ...stat(v), ...facts[k] }])
);
console.log(
	JSON.stringify({ base: BASE, site: SITE, route: ROUTE, n: N, compiled, arms: rows }, null, 2)
);
