import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import { openElastic } from '../../src/do/elastic-run';
import { renderPage } from '../../src/drupal/php/site';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

const ROUTES = (process.env.PROBE_ROUTES ?? '/,/user/login,/user/register,/user/password,/no-such-page').split(',');
const N = Number(process.env.PROBE_N ?? 3);
const FRAMES = (process.env.PROBE_FRAMES ?? '4096,512,256').split(',').map(Number);

const norm = (html: string) =>
	html
		.replace(/form-build-id-[A-Za-z0-9_-]+/g, 'FBID')
		.replace(/value="form-[A-Za-z0-9_-]+"/g, 'FBID')
		.replace(/(data-drupal-selector="[a-z-]+)-[A-Za-z0-9_-]{20,}"/g, '$1-RND"')
		.replace(/ajax-page-state[^"]*/g, 'APS');
const md5 = (s: string) => createHash('md5').update(norm(s)).digest('hex').slice(0, 10);
const diff = (a: string, b: string) => {
	const x = norm(a);
	const y = norm(b);
	let i = 0;
	while (i < x.length && x[i] === y[i]) i++;
	return i === x.length && i === y.length ? 'same' : `@${i}: ${JSON.stringify(x.slice(Math.max(0, i - 60), i + 80))} vs ${JSON.stringify(y.slice(Math.max(0, i - 60), i + 80))}`;
};

async function renderOnce(site: ServeDo, path: string) {
	for (const bin of ['cache_page', 'cache_dynamic_page_cache', 'cache_render', 'cfw_page']) {
		try {
			site.sql.exec(`DELETE FROM ${bin}`);
		} catch {
			// the bin does not exist yet
		}
	}
	const t0 = performance.now();
	const out = await site.runJson(renderPage(path, ['page', 'dynamic_page_cache']));
	const ms = performance.now() - t0;
	const html = String(out['html'] ?? out['error'] ?? '');
	return { ms, html, status: out['status'] };
}

const emit = (r: unknown) => console.log('ROW ' + JSON.stringify(r));

describe('probe', () => {
	it(
		'native then elastic',
		async () => {
			const native = new Map<string, string[]>();
			await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.ensurePhp();
				const cold = await renderOnce(site, ROUTES[0]!);
				emit({ arm: 'native-cold', path: ROUTES[0], ms: Math.round(cold.ms) });
				for (const path of ROUTES) {
					const runs = [];
					for (let i = 0; i < N + 1; i++) runs.push(await renderOnce(site, path));
					native.set(path, runs.map((r) => r.html));
					emit({ arm: 'native', path, ms: runs.map((r) => Math.round(r.ms)), status: runs[0]!.status, len: runs[0]!.html.length, selfDiff: diff(runs[0]!.html, runs[1]!.html) });
				}
				site.dropInterpreter();
				for (const frames of FRAMES) {
					const session = await openElastic(site, { frames, capBytes: 384 * 1048576, pageWrites: 1_000_000 });
					if (typeof session === 'string') throw new Error(session);
					try {
						const first = await renderOnce(site, ROUTES[0]!);
						emit({ arm: `elastic-cold-f${frames}`, path: ROUTES[0], ms: Math.round(first.ms), read: session.read() });
						for (const path of ROUTES) {
							const runs = [];
							const before = session.read();
							for (let i = 0; i < N; i++) runs.push(await renderOnce(site, path));
							const after = session.read();
							emit({
								arm: `elastic-f${frames}`,
								path,
								ms: runs.map((r) => Math.round(r.ms)),
								status: runs[0]!.status,
								len: runs[0]!.html.length,
								vsNative: diff(native.get(path)![0]!, runs[0]!.html),
								writesPerRender: Math.round((after.pageWrites - before.pageWrites) / N),
								readsPerRender: Math.round((after.pageReads - before.pageReads) / N)
							});
						}
						emit({ arm: `end-f${frames}`, stats: { ...session.pager.stats }, read: session.read() });
					} finally {
						session.close();
					}
				}
			});
		},
		1_800_000
	);
});
