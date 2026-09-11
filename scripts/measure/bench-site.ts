/**
 * Provisions a site on a running dev worker so the comparison generator has something to drive.
 *
 * The browser lane's `global-setup.ts` does the same sequence and then launches Chromium to open
 * registration, which a load benchmark does not need. This is the headless half: migrate, claim,
 * warm. Same order and same reason -- firstrun invalidates every cached page, so warming comes last.
 */

const base = (process.argv.find((a) => a.startsWith('--target='))?.split('=')[1] ??
	'http://127.0.0.1:8787') as string;
const site = (process.argv.find((a) => a.startsWith('--site='))?.split('=')[1] ??
	'bench') as string;
const admin = (process.argv.find((a) => a.startsWith('--user='))?.split('=')[1] ??
	'admin') as string;
const pass = (process.argv.find((a) => a.startsWith('--pass='))?.split('=')[1] ??
	'bench-lane-pw') as string;
const paths = (
	process.argv.find((a) => a.startsWith('--warm='))?.split('=')[1] ?? '/,/user/login'
).split(',');

/**
 * Whether the target needs a synthetic `Host` to carry site identity.
 *
 * ONLY A LOCAL ONE DOES. `src/ops/site-id.ts` resolves KV, then `SITE_ID`, then the HOSTNAME, so a
 * deployed worker's own hostname already IS the site -- and overriding `Host` on an https target
 * makes bun verify the certificate against `<site>.localhost`, which fails as
 * `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` and reads as a network or account problem rather than as
 * a header this script added.
 */
function isLocal(target: string): boolean {
	const host = URL.parse(target)?.hostname ?? '';
	return (
		host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')
	);
}

const siteHeaders: Record<string, string> = isLocal(base) ? { host: `${site}.localhost` } : {};

const call = (path: string, init?: RequestInit): Promise<Response> =>
	fetch(`${base}${path}`, {
		...init,
		// `Host`, because THE WORKER NEVER READ `x-cfw-site`. That header appeared only in this
		// script and two of its siblings and in no file under `src/`, so every `--site` here drove
		// the one object `127.0.0.1` resolves to: a fresh id answered "already migrated" and two
		// random ids reported the same generation, the same schema and the same 428 rows.
		// `src/ops/site-id.ts`'s chain is KV, then `SITE_ID`, then the HOSTNAME.
		headers: { ...siteHeaders, ...(init?.headers ?? {}) }
	});

async function json<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await call(path, init);
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${path} answered ${res.status}: ${text.slice(0, 200)}`);
	}
}

// BATCHED, and it used to pass `all=1`. That flag forces `maxChunks` to `Infinity` in
// `migrateChunks()` -- ahead of both `?chunks=` and `chunksPerInvocation()` -- so on the `PLAN:paid`
// this rig runs, one request replayed all 75 chunks inside a single invocation and the object died
// with an empty error and no stack. That is the no-message signature of a memory limit crossed
// INSIDE an invocation, and the caller saw `500 Error: Network connection lost.`
//
// A real site never takes that path: it batches, and the loop below already existed to drive one.
// 10, DOWN FROM 20, AND A LOST CONNECTION IS RETRIED RATHER THAN THROWN. 20 then died the same way
// on three consecutive runs: `500 Error: Network connection lost.` is the client's view of an
// isolate reset, and `USE_ZEND_ALLOC=0` means demand inside one incarnation is the SUM of what it
// has done -- so whether N replays fit depends on what the object did before them, which is why a
// fixed batch works until it does not.
//
// The retry is not papering over it. The cursor is DURABLE, so a reset loses the invocation and not
// the progress, and the next call resumes where it stopped -- which is exactly what the alarm chain
// does on a real site. Throwing here modelled a client that gives up where the product does not.
const MIGRATE_BATCH = 10;
console.error(`[bench-site] migrating ${site} at ${base}`);
let lost = 0;
for (let i = 0; i < 200; i++) {
	let reply: { ok: boolean; done: boolean | null };
	try {
		reply = await json<{ ok: boolean; done: boolean | null }>(
			`/migrate?chunks=${MIGRATE_BATCH}`
		);
	} catch (e: unknown) {
		const text = e instanceof Error ? e.message : String(e);
		// only a lost connection; a refusal with a body is a real answer and must still stop the run
		if (!/Network connection lost|fetch failed|ConnectionRefused/i.test(text)) throw e;
		if (++lost > 20) throw new Error(`the object reset ${lost} times while migrating: ${text}`);
		console.error(`[bench-site] object reset mid-migrate (${lost}), resuming from the cursor`);
		await new Promise((r) => setTimeout(r, 500));
		continue;
	}
	if (reply.done === true) break;
	if (reply.ok === false) throw new Error(`migration refused: ${JSON.stringify(reply)}`);
	if (i === 199) throw new Error('migration did not finish in 200 calls');
}
if (lost > 0) console.error(`[bench-site] migrated through ${lost} isolate reset(s)`);

console.error('[bench-site] claiming');
const claim = await json<{ ok: boolean; error?: string }>('/firstrun?force=1', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({
		siteName: 'CFW Bench',
		adminName: admin,
		adminMail: 'admin@example.invalid',
		adminPass: pass,
		timezone: 'UTC'
	})
});
if (!claim.ok) throw new Error(`firstrun refused: ${claim.error ?? JSON.stringify(claim)}`);

/**
 * Fills are DRIVEN rather than waited for.
 *
 * `/fill?path=` enqueues and arms the alarm, which is correct in production and useless here: a
 * local `wrangler dev` object is torn down and rebuilt often enough that an armed alarm frequently
 * never fires, and a benchmark that waits on one reports `never left 5xx` on a chain that works.
 * `/fill` with no path drains one synchronously, which is what the route exists for.
 */
for (const path of paths) {
	await call(`/fill?path=${encodeURIComponent(path)}`);
	for (let i = 0; i < 40; i++) {
		const drained = await json<{ filled?: string; remaining?: number }>('/fill');
		if (drained.filled === undefined) break;
		if ((drained.remaining ?? 0) === 0) break;
	}
	// RETRIED, because the drain and the store are not the same instant. The first serve after a
	// fill can answer 503 `warming` and the next one 200 -- observed here, and it aborted a
	// provisioning run on a site that was working. A bounded retry is right where an unbounded one
	// would not be: `/fill` above has already reported the queue empty, so the page either lands
	// shortly or something is actually wrong, and the throw still names the last status.
	let res = await call(`/serve?path=${encodeURIComponent(path)}`);
	for (let i = 0; i < 10 && res.status >= 400; i++) {
		await new Promise((r) => setTimeout(r, 500));
		res = await call(`/serve?path=${encodeURIComponent(path)}`);
	}
	if (res.status >= 400) {
		throw new Error(`${path} answered ${res.status} after its fill and 10 retries`);
	}
	console.error(`[bench-site] warm ${path}`);
}

console.error('[bench-site] ready');
