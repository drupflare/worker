import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What a content-keyed `cfw_page` would actually save, on a real fill corpus.
 *
 * `cfw_page` is `path TEXT PRIMARY KEY ... html TEXT`, so identical HTML at two paths is stored
 * twice. The lever is `path -> hash` plus `hash -> blob`. It is scored here BEFORE being built,
 * because the saving is a property of what Drupal renders rather than of the schema: a corpus with
 * no byte-identical pages saves nothing however the store is keyed.
 *
 * The corpus is chosen to contain the duplicate classes the lever was proposed for -- two 404s, two
 * 403s, and one path rendered twice -- so a zero reading is a refusal rather than an unlucky sample.
 */

const TIMEOUT = 900_000;

/** paths a fresh standard-profile site answers, grouped by the duplicate class each one probes */
const CORPUS = [
	'/',
	'/user/login',
	'/user/register',
	'/user/password',
	// the class the lever was proposed for: two paths that do not exist
	'/missing-alpha',
	'/missing-beta',
	'/missing-gamma',
	// anonymous 403s, which render core's access-denied page at two different paths
	'/admin',
	'/admin/config'
] as const;

type Stored = { path: string; status: number; html: string };

const call = (site: ServeDo, path: string) => site.fetch(new Request(`https://do.local${path}`));

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** longest shared prefix and suffix, which is what a near-duplicate scheme would key on instead */
function overlap(a: string, b: string): { prefix: number; suffix: number } {
	let prefix = 0;
	const max = Math.min(a.length, b.length);
	while (prefix < max && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	return { prefix, suffix };
}

let corpusOnce: Promise<Stored[]> | null = null;

/**
 * One provisioned site, filled over {@link CORPUS}.
 *
 * `/__firstrun` first: an anonymous 403 renders differently before and after a site has an admin,
 * and the corpus is meant to be what a real site stores.
 */
function corpus(): Promise<Stored[]> {
	corpusOnce ??= inObject(freshSite(), async (site: ServeDo) => {
		await call(site, '/__migrate?all=1&prefill=0');
		const first = await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ adminPass: 'cfw-Ckey-2291-pass', siteName: 'Ckey' })
			})
		);
		expect(first.status, await first.clone().text()).toBe(200);
		for (const path of CORPUS) await site.fillOne(path);
		return site.sql
			.exec('SELECT path, status, html FROM cfw_page ORDER BY path')
			.toArray() as unknown as Stored[];
	});
	return corpusOnce;
}

describe('content-keying the page store', () => {
	it(
		'prices the saving against what a real fill corpus stores',
		async () => {
			const rows = await corpus();
			// a corpus that stored nothing prices nothing, and this project has taken that reading
			// before: `cache.page.max_age` at 0 made every render `no-store` and the table stayed empty
			expect(rows.length).toBeGreaterThan(3);

			const byHash = new Map<string, string[]>();
			let raw = 0;
			for (const row of rows) {
				const html = String(row.html ?? '');
				raw += html.length;
				const key = await sha256(html);
				byHash.set(key, [...(byHash.get(key) ?? []), row.path]);
			}

			let keyed = 0;
			const duplicated: string[][] = [];
			for (const [, paths] of byHash) {
				const html = rows.find((r) => r.path === paths[0])?.html ?? '';
				keyed += html.length;
				if (paths.length > 1) duplicated.push(paths);
			}

			console.log(
				`[page-content-key] ${JSON.stringify({
					paths: rows.length,
					uniqueBodies: byHash.size,
					rawBytes: raw,
					contentKeyedBytes: keyed,
					savedBytes: raw - keyed,
					savedShare: +((raw - keyed) / Math.max(1, raw)).toFixed(4),
					duplicated
				})}`
			);

			// the claim under test, either way: this asserts the measurement HAPPENED, and the
			// verdict is the logged share. Bytes can never grow under content keying
			expect(keyed).toBeLessThanOrEqual(raw);
			expect(byHash.size).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'reads the 404s as byte-identical, which is where the whole saving comes from',
		async () => {
			const rows = await corpus();
			const misses = rows.filter((r) => r.path.startsWith('/missing-'));
			expect(misses.length, 'the corpus lost its 404s').toBeGreaterThan(1);

			const a = String(misses[0]?.html ?? '');
			const b = String(misses[1]?.html ?? '');
			const { prefix, suffix } = overlap(a, b);
			const differing = Math.max(a.length, b.length) - prefix - suffix;

			console.log(
				`[page-content-key 404] ${JSON.stringify({
					a: misses[0]?.path,
					b: misses[1]?.path,
					statusA: misses[0]?.status,
					statusB: misses[1]?.status,
					bytesA: a.length,
					bytesB: b.length,
					sharedPrefix: prefix,
					sharedSuffix: suffix,
					differingBytes: differing,
					sharedShare: +((prefix + suffix) / Math.max(1, a.length)).toFixed(4),
					// what differs, so the reason is on the record rather than inferred
					middleA: a.slice(prefix, prefix + 200),
					middleB: b.slice(prefix, prefix + 200)
				})}`
			);

			// Drupal's 404 carries no path-varying byte, so the three collapse to one blob. A
			// reading short of the full length means core started varying the page and the saving
			// measured above went with it
			expect(differing, 'the 404s stopped being byte-identical').toBe(0);
			expect(prefix).toBe(a.length);
		},
		TIMEOUT
	);

	it(
		'counts the rows a content-keyed fill charges against what the path-keyed one charges',
		async () => {
			// RULE 0b: storage is not a binding meter here and ROWS WRITTEN is. A lever that saves
			// bytes and spends rows is scored on the rows, so the two schemas are charged side by
			// side on a real `ctx.storage.sql` rather than reasoned about from the DDL
			const charged = await inObject(freshSite(), (site: ServeDo) => {
				const sql = site.sql;
				sql.exec(
					`CREATE TABLE ck_path (path TEXT PRIMARY KEY, status INTEGER NOT NULL,
					 content_type TEXT, html TEXT NOT NULL, rendered_at INTEGER NOT NULL,
					 render_ms REAL)`
				);
				sql.exec(
					`CREATE TABLE ck_pointer (path TEXT PRIMARY KEY, status INTEGER NOT NULL,
					 content_type TEXT, hash TEXT NOT NULL, rendered_at INTEGER NOT NULL,
					 render_ms REAL)`
				);
				sql.exec(`CREATE TABLE ck_blob (hash TEXT PRIMARY KEY, html TEXT NOT NULL)`);

				const html = 'x'.repeat(15_440);
				const insertPath = (path: string) =>
					sql.exec(
						`INSERT INTO ck_path (path, status, content_type, html, rendered_at, render_ms)
						 VALUES (?, 404, 'text/html', ?, 1, 1)
						 ON CONFLICT(path) DO UPDATE SET html = excluded.html`,
						path,
						html
					).rowsWritten;
				// the blob first, so a duplicate body is the INSERT that writes nothing
				const insertKeyed = (path: string, hash: string) => {
					const blob = sql.exec(
						'INSERT INTO ck_blob (hash, html) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING',
						hash,
						html
					).rowsWritten;
					const pointer = sql.exec(
						`INSERT INTO ck_pointer (path, status, content_type, hash, rendered_at, render_ms)
						 VALUES (?, 404, 'text/html', ?, 1, 1)
						 ON CONFLICT(path) DO UPDATE SET hash = excluded.hash`,
						path,
						hash
					).rowsWritten;
					return { blob, pointer, total: blob + pointer };
				};

				return {
					pathKeyed: insertPath('/a'),
					keyedNewBody: insertKeyed('/a', 'h-a'),
					keyedDuplicateBody: insertKeyed('/b', 'h-a')
				};
			});

			console.log(`[page-content-key rows] ${JSON.stringify(charged)}`);

			// a duplicate body is the case the lever exists for, and it must not cost more than the
			// schema it replaces or the saving is bought with the meter that binds
			expect(charged.keyedDuplicateBody.blob).toBe(0);
			expect(charged.keyedDuplicateBody.total).toBeLessThanOrEqual(charged.pathKeyed);
			// and a NEW body pays for the split; asserted rather than assumed, because this is the
			// number that decides whether the lever ships
			expect(charged.keyedNewBody.total).toBeGreaterThan(charged.pathKeyed);
		},
		TIMEOUT
	);
});
