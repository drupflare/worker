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

const call = (path: string, init?: RequestInit): Promise<Response> =>
	fetch(`${base}${path}`, {
		...init,
		headers: { 'x-cfw-site': site, ...(init?.headers ?? {}) }
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

console.error(`[bench-site] migrating ${site} at ${base}`);
for (let i = 0; i < 80; i++) {
	const reply = await json<{ ok: boolean; done: boolean | null }>('/migrate?all=1');
	if (reply.done === true) break;
	if (reply.ok === false) throw new Error(`migration refused: ${JSON.stringify(reply)}`);
	if (i === 79) throw new Error('migration did not finish in 80 calls');
}

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
	const res = await call(`/serve?path=${encodeURIComponent(path)}`);
	if (res.status >= 400) throw new Error(`${path} answered ${res.status} after its fill`);
	console.error(`[bench-site] warm ${path}`);
}

console.error('[bench-site] ready');
