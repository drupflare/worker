import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type FillOutcome, type ServeDo } from '../helpers/serve-do';

/**
 * A Durable Object with `CMS=wordpress` replays the baked database, boots the interpreter on the
 * packed tree and answers the front page: real DO SQLite, the real interpreter, the real pack.
 *
 * Needs `bun run assets:wordpress`. It is listed in `ARTIFACT_SPECS`, so a clean checkout skips it.
 */

const ORIGIN = 'https://wp.example';

type WordpressSite = ServeDo & {
	migrator(): { runAll(): Promise<{ done: boolean; chunks: number }> };
	php?: unknown;
	heapsReused?: number;
};

const configure = (site: ServeDo): WordpressSite => {
	Object.assign(site.env, {
		CMS: 'wordpress',
		SQL_CHUNK_PREFIX: 'wordpress/sql',
		SITE_ORIGIN: ORIGIN,
		HEAP_SNAPSHOT: '0'
	});
	return site as WordpressSite;
};

type Page = {
	status: number;
	html: string;
	contentType: string;
	setCookie: string[];
	location?: string;
};

describe('wordpress in a durable object', () => {
	it('replays the baked database, boots and answers 200 with the installed title', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = configure(site);
			const migrated = await wp.migrator().runAll();
			const filled = (await wp.fillOne('/', undefined, undefined, {
				origin: ORIGIN
			})) as FillOutcome & { page?: Page };
			return { migrated, filled, php: wp.php === undefined };
		});
		expect(out.migrated.done).toBe(true);
		expect(out.filled.page?.status).toBe(200);
		expect(out.filled.page?.html).toContain('<title>WordPress Site</title>');
		expect(out.filled.page?.html).toContain(`${ORIGIN}/wp-content/themes/twentytwentyfive/`);
		expect(out.filled.page?.contentType).toMatch(/^text\/html/);
		// one request per interpreter: it is gone when the render returns
		expect(out.php).toBe(true);
	}, 120_000);

	it('reports the asset requests a boot made and the files a render opened', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = configure(site);
			await wp.migrator().runAll();
			const read = async () =>
				(
					await site.fetch(new Request('https://do.local/__serve-stats'))
				).json() as Promise<{
					wordpressBoot?: {
						boots: number;
						assetRequests: { packFetched: number; packReused: number; other: number };
						lastMount: { files: number; opened: number; openedBytes: number };
					};
				}>;
			const before = (await read()).wordpressBoot;
			await wp.fillOne('/', undefined, undefined, { origin: ORIGIN });
			const first = (await read()).wordpressBoot;
			await wp.fillOne('/wp-login.php', undefined, undefined, { origin: ORIGIN });
			const second = (await read()).wordpressBoot;
			return { before, first, second };
		});
		expect(out.first!.boots - out.before!.boots).toBe(1);
		expect(out.second!.boots - out.first!.boots).toBe(1);
		// the pack is fetched once per isolate, so the second boot spends one request, the driver
		const spent = (a: typeof out.first, b: typeof out.first) =>
			b!.assetRequests.packFetched -
			a!.assetRequests.packFetched +
			(b!.assetRequests.other - a!.assetRequests.other);
		expect(spent(out.first, out.second)).toBe(1);
		expect(out.second!.assetRequests.packReused).toBeGreaterThan(
			out.first!.assetRequests.packReused
		);
		// a render opens some of the tree, never all of it
		expect(out.second!.lastMount.opened).toBeGreaterThan(50);
		expect(out.second!.lastMount.opened).toBeLessThan(out.second!.lastMount.files);
	}, 120_000);

	it('serves a second request on a fresh interpreter, which is what makes it repeatable', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = configure(site);
			await wp.migrator().runAll();
			const first = (await wp.fillOne('/', undefined, undefined, { origin: ORIGIN })) as {
				page?: Page;
			};
			const second = (await wp.fillOne('/wp-login.php', undefined, undefined, {
				origin: ORIGIN
			})) as { page?: Page };
			return { first: first.page?.html, login: second.page };
		});
		expect(out.first).toContain('<title>WordPress Site</title>');
		expect(out.login?.status).toBe(200);
		expect(out.login?.html).toContain('id="loginform"');
	}, 120_000);

	it('turns the canonical redirect into a 301 with its Location instead of an exit', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = configure(site);
			await wp.migrator().runAll();
			return (await wp.fillOne('/?p=1', undefined, undefined, { origin: ORIGIN })) as {
				page?: Page;
				failed?: string;
				error?: string;
			};
		});
		expect(out.failed).toBeUndefined();
		expect(out.page?.status).toBe(301);
		expect(out.page?.location).toBe(`${ORIGIN}/2026/01/01/hello-world/`);
	}, 120_000);

	it('answers the REST index, which WordPress ends with die()', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = configure(site);
			await wp.migrator().runAll();
			return (await wp.fillOne('/wp-json/', undefined, undefined, { origin: ORIGIN })) as {
				page?: Page;
				failed?: string;
			};
		});
		expect(out.failed).toBeUndefined();
		expect(out.page?.status).toBe(200);
		expect(out.page?.contentType).toMatch(/^application\/json/);
		expect((JSON.parse(out.page!.html) as { name: string }).name).toBe('WordPress Site');
	}, 120_000);

	it('answers the category archive, its feed and the redirect to it from the baked rules', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = configure(site);
			await wp.migrator().runAll();
			const fill = async (path: string) =>
				(await wp.fillOne(path, undefined, undefined, { origin: ORIGIN })) as {
					page?: Page;
					failed?: string;
				};
			return {
				archive: await fill('/category/uncategorized/'),
				feed: await fill('/category/uncategorized/feed/'),
				byId: await fill('/?cat=1')
			};
		});
		expect(out.archive.failed).toBeUndefined();
		expect(out.archive.page?.status).toBe(200);
		expect(out.archive.page?.html).toContain(
			'<title>Uncategorized &#8211; WordPress Site</title>'
		);
		expect(out.archive.page?.html).toContain('Hello world!');
		expect(out.feed.page?.status).toBe(200);
		expect(out.feed.page?.contentType).toMatch(/^application\/rss\+xml/);
		expect(out.feed.page?.html).toContain(
			'<title>Uncategorized &#8211; WordPress Site</title>'
		);
		expect(out.byId.page?.status).toBe(301);
		expect(out.byId.page?.location).toBe(`${ORIGIN}/category/uncategorized/`);
	}, 120_000);

	it('answers the sitemaps and their stylesheets, which WordPress ends with exit', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = configure(site);
			await wp.migrator().runAll();
			const fill = async (path: string) =>
				(await wp.fillOne(path, undefined, undefined, { origin: ORIGIN })) as {
					page?: Page;
					failed?: string;
					error?: string;
				};
			return {
				index: await fill('/wp-sitemap.xml'),
				posts: await fill('/wp-sitemap-posts-post-1.xml'),
				sheet: await fill('/wp-sitemap.xsl'),
				indexSheet: await fill('/wp-sitemap-index.xsl'),
				missing: await fill('/wp-sitemap-posts-post-9.xml')
			};
		});
		for (const name of ['index', 'posts', 'sheet', 'indexSheet'] as const) {
			expect(out[name].failed, name).toBeUndefined();
			expect(out[name].page?.status, name).toBe(200);
			expect(out[name].page?.contentType, name).toMatch(/^application\/xml/);
		}
		expect(out.index.page?.html).toContain(`<loc>${ORIGIN}/wp-sitemap-posts-post-1.xml</loc>`);
		expect(out.posts.page?.html).toContain(`<loc>${ORIGIN}/2026/01/01/hello-world/</loc>`);
		expect(out.sheet.page?.html).toContain('xsl:stylesheet');
		expect(out.indexSheet.page?.html).toContain('xsl:stylesheet');
		expect(out.missing.failed).toBeUndefined();
		expect(out.missing.page?.status).toBe(404);
	}, 120_000);

	it('points siteurl and home at the origin, once', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = configure(site);
			await wp.migrator().runAll();
			const read = () =>
				wp.sql
					.exec(
						"SELECT option_name, option_value FROM wp_options WHERE option_name IN ('siteurl','home') ORDER BY option_name"
					)
					.toArray();
			const before = read();
			await wp.fillOne('/', undefined, undefined, { origin: ORIGIN });
			const after = read();
			const written = wp.sql.exec('SELECT 1').rowsWritten;
			return { before, after, written };
		});
		expect(out.before.map((r) => r['option_value'])).toEqual([
			'http://wordpress.invalid',
			'http://wordpress.invalid'
		]);
		expect(out.after.map((r) => r['option_value'])).toEqual([ORIGIN, ORIGIN]);
	}, 120_000);

	it('is a control: a Drupal site answers nothing from this pack', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			Object.assign(site.env, { CMS: 'joomla' });
			return (await site
				.fillOne('/', undefined, undefined, { origin: ORIGIN })
				.catch((e: Error) => ({
					error: e.message
				}))) as { error?: string };
		});
		expect(out.error).toContain('CMS=joomla has no boot yet');
	}, 60_000);
});

type Served = {
	status: number;
	cache: string | null;
	cacheControl: string | null;
	grant: string | null;
	body: string;
};

describe('what a WordPress object stores', () => {
	const STORE = { WORDPRESS_PAGE_CACHE: '1' };
	const serve = async (
		site: ServeDo,
		path: string,
		headers: Record<string, string> = {}
	): Promise<Served> => {
		const res = await site.fetch(
			new Request(`https://do.local/__serve?path=${encodeURIComponent(path)}`, { headers })
		);
		return {
			status: res.status,
			cache: res.headers.get('x-cfw-cache'),
			cacheControl: res.headers.get('cache-control'),
			grant: res.headers.get('x-cfw-kv-grant'),
			body: await res.text()
		};
	};
	const rows = (site: ServeDo): string[] =>
		site.sql
			.exec('SELECT path FROM cfw_page ORDER BY path')
			.toArray()
			.map((r) => String(r['path']));
	const ready = async (site: ServeDo, extra: Record<string, string> = {}) => {
		const wp = configure(site);
		Object.assign(wp.env, extra);
		await wp.migrator().runAll();
		// the first render of a fresh site writes WordPress's bookkeeping options, announces itself and is
		// untaggable, so it is not stored; the front page takes that render and the cases read the next
		await serve(wp, '/');
		return wp;
	};
	const stubbed = (wp: WordpressSite, result: Record<string, unknown>) => {
		(wp as unknown as { runJsonMaybeParked: () => Promise<unknown> }).runJsonMaybeParked =
			async () => ({
				status: 200,
				html: '<html><body>stub</body></html>',
				contentType: 'text/html; charset=UTF-8',
				renderMs: 1,
				bytes: 30,
				setCookie: [],
				passHeaders: {},
				cacheTags: ['post:1'],
				uid: 0,
				...result
			});
	};

	it('stores nothing by default: the front page renders again, uncacheable, on every request', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			const first = await serve(wp, '/');
			const second = await serve(wp, '/');
			return { first, second, rows: rows(wp) };
		});
		expect(out.first.status).toBe(200);
		expect(out.first.body).toContain('<title>WordPress Site</title>');
		for (const answer of [out.first, out.second]) {
			expect(answer.cache).toBe('RENDER');
			expect(answer.cacheControl).toBe('private, no-store');
			expect(answer.grant).toBeNull();
		}
		expect(out.rows).toEqual([]);
	}, 120_000);

	it('stores an anonymous page once the test switch is on, and replays it from the row', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const first = await serve(wp, '/');
			const second = await serve(wp, '/');
			return { first, second, rows: rows(wp) };
		});
		expect(out.first.cache).toBe('RENDER');
		expect(out.first.cacheControl).toBe('public, max-age=0, must-revalidate');
		expect(out.second.cache).toBe('HIT');
		expect(out.second.body).toBe(out.first.body);
		expect(out.rows).toEqual(['/']);
	}, 120_000);

	it('stops replaying a stored row when the switch goes off', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			await serve(wp, '/');
			const stored = await serve(wp, '/');
			Object.assign(wp.env, { WORDPRESS_PAGE_CACHE: '0' });
			const after = await serve(wp, '/');
			return { stored, after };
		});
		expect(out.stored.cache).toBe('HIT');
		expect(out.after.cache).toBe('RENDER');
		expect(out.after.cacheControl).toBe('private, no-store');
	}, 120_000);

	it('never stores a request that carries a cookie or an Authorization header, switch on', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const h = 'a'.repeat(32);
			const answers = [
				await serve(wp, '/?s=hello', { cookie: `wordpress_logged_in_${h}=x` }),
				await serve(wp, '/?s=hello', { cookie: 'wordpress_test_cookie=1' }),
				await serve(wp, '/?s=hello', { cookie: 'wp-settings-1=x' }),
				await serve(wp, '/?s=hello', { authorization: 'Basic YWRtaW46eHh4eA==' })
			];
			return { answers, rows: rows(wp) };
		});
		for (const answer of out.answers) {
			expect(answer.status).toBe(200);
			expect(answer.cache).toBe('RENDER');
			expect(answer.cacheControl).toBe('private, no-store');
			expect(answer.grant).toBeNull();
		}
		expect(out.rows).toEqual([]);
	}, 120_000);

	// a path-level refusal marks the path unstorable, so it is not queued again on every request; a
	// request-level one (a cookie on a page that is fine) must not
	it('marks a path unstorable when the page itself is refused, and not when the request was', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const unstorable = (path: string) =>
				(wp as unknown as { isUnstorable(path: string): boolean }).isUnstorable(path);
			stubbed(wp, { html: '<form><input name="_wpnonce" value="abcdef0123"></form>' });
			await serve(wp, '/nonce/');
			stubbed(wp, { html: '<html><body>fine</body></html>' });
			await serve(wp, '/cookie/', { cookie: 'wordpress_test_cookie=1' });
			await serve(wp, '/clean/');
			return {
				nonce: unstorable('/nonce/'),
				cookie: unstorable('/cookie/'),
				clean: unstorable('/clean/'),
				rows: rows(wp)
			};
		});
		expect(out.nonce).toBe(true);
		expect(out.cookie).toBe(false);
		expect(out.clean).toBe(false);
		expect(out.rows).toEqual(['/clean/']);
	}, 120_000);

	it('never stores the login page, which sends no-cache headers and carries a nonce', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const login = await serve(wp, '/wp-login.php');
			return { login, rows: rows(wp) };
		});
		expect(out.login.status).toBe(200);
		expect(out.login.cacheControl).toBe('private, no-store');
		expect(out.rows).toEqual([]);
	}, 120_000);

	// the same switch, with the page a render could produce: each rule alone refuses it
	const broken: [string, Record<string, unknown>, string?][] = [
		[
			'an empty 200 feed, which is what the output buffer bug sent',
			{ html: '', contentType: 'application/rss+xml; charset=UTF-8' },
			'/feed/'
		],
		['a response that sets a cookie', { setCookie: ['wp_x=1; path=/'] }],
		['a Cache-Control: private response', { cacheControl: 'private', passHeaders: {} }],
		['a Cache-Control: no-store response', { cacheControl: 'no-store' }],
		['a Vary: Cookie response', { vary: 'Cookie' }],
		['a response with no cache tag', { cacheTags: [] }],
		[
			'a page with a nonce form field',
			{
				html: '<html><body><form><input type="hidden" name="_wpnonce" value="abcdef0123"></form></body></html>'
			}
		],
		['a page cut off before its closing tag', { html: '<html><body>half' }],
		['a JSON body on a page path', { contentType: 'application/json' }],
		['a 404', { status: 404 }],
		['a render for a signed in user', { uid: 1 }]
	];
	for (const [name, result, path] of broken) {
		it(`never stores ${name}, switch on`, async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const wp = await ready(site, STORE);
				stubbed(wp, result);
				const answer = await serve(wp, path ?? '/stub/');
				return { answer, rows: rows(wp) };
			});
			expect(out.answer.cache).toBe('RENDER');
			expect(out.answer.cacheControl).toBe('private, no-store');
			expect(out.answer.grant).toBeNull();
			expect(out.rows).toEqual([]);
		}, 120_000);
	}

	const STORED = [
		'/2026/01/01/hello-world/',
		'/sample-page/',
		'/author/admin/',
		'/2026/01/',
		'/feed/'
	];
	const REFUSED = [
		'/?s=hello',
		'/search/hello/',
		'/wp-json/',
		'/?rest_route=%2F',
		'/robots.txt',
		'/2026/01/01/hello-world/?replytocom=1',
		'/nothing-here/',
		'/hello-world',
		'/?p=1',
		'/wp-login.php',
		'/?preview=true&p=1',
		'/2026/01/01/hello-world/?utm_source=a',
		'/HELLO-world/'
	];

	it('stores the pages the table names and no other, on real renders', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const stored: Record<string, unknown>[] = [];
			const refused: Record<string, unknown>[] = [];
			for (const path of STORED) {
				const a = await serve(wp, path);
				const b = await serve(wp, path);
				stored.push({ path, first: a.cache, second: b.cache, same: a.body === b.body });
			}
			for (const path of REFUSED) {
				const a = await serve(wp, path);
				const b = await serve(wp, path);
				refused.push({
					path,
					first: a.cache,
					second: b.cache,
					cacheControl: b.cacheControl,
					grant: b.grant
				});
			}
			return { stored, refused, rows: rows(wp) };
		});
		for (const s of out.stored) {
			expect(s, String(s['path'])).toMatchObject({
				first: 'RENDER',
				second: 'HIT',
				same: true
			});
		}
		for (const r of out.refused) {
			expect(r, String(r['path'])).toMatchObject({
				first: 'RENDER',
				second: 'RENDER',
				cacheControl: 'private, no-store',
				grant: null
			});
		}
		expect(out.rows).toEqual([...STORED].sort());
	}, 240_000);

	it('mints no row, queue entry or unstorable mark for each search term it is asked', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const probe = wp as unknown as {
				queueDepth(): number;
				unstorablePaths(): string[];
			};
			// the front page the setup render queued is filled for real before the stub goes in
			while (probe.queueDepth() > 0) await wp.fillOne();
			stubbed(wp, {});
			const before = rows(wp);
			const marked = probe.unstorablePaths();
			for (let i = 0; i < 60; i++) await serve(wp, `/?s=term${i}`);
			for (let i = 0; i < 20; i++) await serve(wp, `/search/term${i}/`);
			return {
				before,
				marked,
				rows: rows(wp),
				queue: probe.queueDepth(),
				unstorable: probe.unstorablePaths()
			};
		});
		expect(out.rows).toEqual(out.before);
		expect(out.queue).toBe(0);
		expect(out.unstorable).toEqual(out.marked);
	}, 240_000);

	it('keeps a hostile host, forwarded header, method override or cookie out of what is stored', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const evilServer = await serve(wp, '/sample-page/', {
				'x-forwarded-server': 'evil.example',
				'x-original-url': '/wp-admin/',
				forwarded: 'host=evil.example;proto=http'
			});
			const afterEvil = rows(wp);
			const override = await serve(wp, '/author/admin/', {
				'x-http-method-override': 'DELETE'
			});
			const cookies = [
				await serve(wp, '/2026/01/', { cookie: 'wp-settings-1=libraryContent%3Dbrowse' }),
				await serve(wp, '/2026/01/', { cookie: `comment_author_${'b'.repeat(32)}=Eve` }),
				await serve(wp, '/2026/01/', {
					cookie: `comment_author_email_${'b'.repeat(32)}=eve%40evil.example`
				})
			];
			const afterOthers = rows(wp);
			// the headers Cloudflare itself adds do not stop a store, and cannot change the body
			const evil = await serve(wp, '/2026/', { 'x-forwarded-host': 'evil.example' });
			const evilClean = await serve(wp, '/2026/');
			const plain = await serve(wp, '/2026/01/01/hello-world/', {
				'x-forwarded-proto': 'http',
				'x-forwarded-for': '6.6.6.6',
				'x-real-ip': '6.6.6.6'
			});
			const clean = await serve(wp, '/2026/01/01/hello-world/');
			return {
				evil,
				evilClean,
				evilServer,
				afterEvil,
				override,
				cookies,
				afterOthers,
				plain,
				clean
			};
		});
		for (const answer of [out.evilServer, out.override, ...out.cookies]) {
			expect(answer.cache).toBe('RENDER');
			expect(answer.cacheControl).toBe('private, no-store');
			expect(answer.body).not.toContain('evil.example');
		}
		// the host header is not a refusal: the origin is pinned, so neither answer can carry it
		expect(out.evil.body).not.toContain('evil.example');
		expect(out.evilClean.body).not.toContain('evil.example');
		expect(out.afterEvil).toEqual([]);
		expect(out.afterOthers).toEqual([]);
		expect(out.plain.cache).toBe('RENDER');
		expect(out.clean.cache).toBe('HIT');
		expect(out.clean.body).toBe(out.plain.body);
		expect(out.clean.body).not.toContain('http://wp.example');
		expect(out.clean.body).toContain(`${ORIGIN}/`);
	}, 240_000);

	it('answers a HEAD from the same copy a GET stores, whole', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const head = await wp.fetch(
				new Request('https://do.local/__serve?path=%2Fsample-page%2F', { method: 'HEAD' })
			);
			const get = await serve(wp, '/sample-page/');
			return { head: head.status, get, rows: rows(wp) };
		});
		expect(out.head).toBe(200);
		expect(out.get.cache).toBe('HIT');
		expect(out.get.body.trimEnd().endsWith('</html>')).toBe(true);
		expect(out.rows).toEqual(['/sample-page/']);
	}, 240_000);
	it('never replays a row planted under a path the rule refuses, and does replay one it accepts', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, STORE);
			const plant = (path: string) =>
				wp.sql.exec(
					'INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms, tags, tag_checksum, headers) VALUES (?, 200, ?, ?, ?, 1, ?, 0, NULL)',
					path,
					'text/html; charset=UTF-8',
					'<html><body>planted</body></html>',
					Date.now(),
					'["post:1"]'
				);
			plant('/?s=planted');
			plant('/planted-page/');
			const refused = await serve(wp, '/?s=planted');
			const accepted = await serve(wp, '/planted-page/');
			return { refused, accepted };
		});
		expect(out.refused.cache).toBe('RENDER');
		expect(out.refused.body).not.toContain('<body>planted</body>');
		expect(out.accepted.cache).toBe('HIT');
		expect(out.accepted.body).toContain('<body>planted</body>');
	}, 240_000);
});

describe('what the alarm runs on a WordPress object', () => {
	type Alarmed = WordpressSite & {
		alarm(): Promise<unknown>;
		lastCron?: { at: number; value: Record<string, unknown> };
		lastReconcile?: unknown;
		storage: { put(key: string, value: unknown): Promise<void> };
		metaGet(key: string): string | null;
		reconcileStepOnce(): Promise<unknown>;
		reconcileSkipReason(): string;
		prefillServingTable(asked?: string): Promise<{ prefilled?: number; prefillNote?: string }>;
		sql: ServeDo['sql'];
	};
	const ready = async (site: ServeDo, extra: Record<string, string> = {}) => {
		const wp = configure(site) as Alarmed;
		Object.assign(wp.env, extra);
		await wp.migrator().runAll();
		return wp;
	};
	const option = (wp: Alarmed, name: string): string | undefined => {
		const row = wp.sql
			.exec('SELECT option_value FROM wp_options WHERE option_name = ?', name)
			.toArray()[0];
		return row === undefined ? undefined : String(row['option_value']);
	};
	const NO_LEVERS = { CRON_INTERVAL_MS: '0' };

	it('runs no reconciliation and loads no prefill, with none of the three flags set', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			const flags = { r: wp.env.RECONCILE, p: wp.env.PREFILL, c: wp.env.DRUPAL_CRON };
			const step = await wp.reconcileStepOnce();
			const why = wp.reconcileSkipReason();
			const prefill = await wp.prefillServingTable('1');
			await wp.alarm();
			const pages = wp.sql.exec('SELECT count(*) AS n FROM cfw_page').toArray()[0];
			return { flags, step, why, prefill, pages: pages?.['n'], last: wp.lastReconcile };
		});
		expect(out.flags).toEqual({ r: undefined, p: undefined, c: undefined });
		expect(out.step).toBeUndefined();
		expect(out.why).toBe('this CMS has no reconciliation steps');
		expect(out.prefill).toEqual({
			prefilled: 0,
			prefillNote: 'prefill is not available for this CMS'
		});
		expect(out.pages).toBe(0);
		expect(out.last).toBeUndefined();
	}, 120_000);

	it('runs WordPress cron on the alarm: the due events run once and their rows are written', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, NO_LEVERS);
			const before = option(wp, 'cron');
			await wp.storage.put('cronLastRunMs', 1);
			await wp.alarm();
			const after = option(wp, 'cron');
			const first = wp.lastCron?.value;
			const recorded = option(wp, 'drupflare_host_last_cron');
			const lock = option(wp, '_transient_doing_cron');
			await wp.storage.put('cronLastRunMs', 1);
			await wp.alarm();
			const again = option(wp, 'cron');
			return { before, after, again, first, recorded, lock };
		});
		expect(out.first?.['error'], JSON.stringify(out.first)).toBeUndefined();
		expect(out.first?.['status']).toBe(200);
		expect(out.before).toContain('wp_version_check');
		expect(out.before).toContain('i:1767225600;');
		// every due event was rescheduled: none keeps the baked time
		expect(out.after).not.toContain('i:1767225600;');
		for (const hook of ['wp_update_plugins', 'wp_update_themes', 'wp_version_check']) {
			expect(out.after).toContain(hook);
		}
		// the run reached its end: WordPress deleted its lock and the host plugin recorded the time
		expect(out.lock).toBeUndefined();
		expect(Number(out.recorded)).toBeGreaterThan(1_700_000_000);
		// a second firing found nothing due and left the schedule exactly as it was
		expect(out.again).toBe(out.after);
	}, 120_000);

	it('runs no event when another run holds the lock, and runs them once it is released', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, NO_LEVERS);
			const before = option(wp, 'cron');
			wp.sql.exec(
				"INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('_transient_doing_cron', ?, 'auto')",
				(Date.now() / 1000).toFixed(6)
			);
			await wp.storage.put('cronLastRunMs', 1);
			await wp.alarm();
			const held = option(wp, 'cron');
			const heldRecord = option(wp, 'drupflare_host_last_cron');
			const lockKept = option(wp, '_transient_doing_cron');
			wp.sql.exec("DELETE FROM wp_options WHERE option_name = '_transient_doing_cron'");
			await wp.storage.put('cronLastRunMs', 1);
			await wp.alarm();
			const released = option(wp, 'cron');
			return { before, held, heldRecord, lockKept, released };
		});
		// the schedule may gain events on any request (WordPress adds the ones the bake lacks), but
		// the baked due time is still there: nothing ran
		expect(out.before).toContain('i:1767225600;');
		expect(out.held).toContain('i:1767225600;');
		expect(out.heldRecord).toBeUndefined();
		expect(out.lockKept).toBeDefined();
		expect(out.released).not.toBe(out.before);
		expect(out.released).not.toContain('i:1767225600;');
	}, 120_000);

	it('waits an interval before the first run and respects the lever that turns it off', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site, NO_LEVERS);
			const before = option(wp, 'cron');
			await wp.alarm();
			const first = option(wp, 'cron');
			Object.assign(wp.env, { WORDPRESS_CRON: '0' });
			await wp.storage.put('cronLastRunMs', 1);
			await wp.alarm();
			const off = option(wp, 'cron');
			return { before, first, off };
		});
		// the first alarm only starts the clock
		expect(out.first).toBe(out.before);
		expect(out.off).toBe(out.before);
	}, 120_000);
});

describe('claiming a WordPress site', () => {
	const PASS = `pw-${crypto.randomUUID()}`;
	const claim = (site: ServeDo, body: Record<string, unknown>, query = ''): Promise<Response> =>
		site.fetch(
			new Request(`https://do.local/__firstrun${query}`, {
				method: 'POST',
				body: JSON.stringify(body)
			})
		);
	const ready = async (site: ServeDo) => {
		const wp = configure(site);
		await wp.migrator().runAll();
		return wp;
	};
	const user = (wp: ServeDo) =>
		wp.sql
			.exec('SELECT ID, user_login, user_email, user_pass FROM wp_users ORDER BY ID')
			.toArray();
	const everyText = (wp: ServeDo): string =>
		JSON.stringify(
			['wp_users', 'wp_usermeta', 'wp_options', 'cfw_meta'].map((t) =>
				wp.sql.exec(`SELECT * FROM ${t}`).toArray()
			)
		);

	it('shows the setup page to a browser until the claim, and the front page after it', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			const page = () =>
				site.fetch(
					new Request('https://do.local/__serve?path=%2F', {
						headers: { accept: 'text/html' }
					})
				);
			const before = await page();
			const beforeBody = await before.text();
			const done = await claim(wp, { adminName: 'owner', adminPass: PASS });
			const after = await page();
			return {
				setup: before.headers.get('x-cfw-setup'),
				beforeBody,
				claim: done.status,
				afterSetup: after.headers.get('x-cfw-setup'),
				afterBody: await after.text()
			};
		});
		expect(out.setup).toBe('required');
		expect(out.beforeBody).toContain('Claim This Site');
		expect(out.claim).toBe(200);
		expect(out.afterSetup).toBeNull();
		expect(out.afterBody).toContain('<title>');
	}, 120_000);

	it('creates the administrator through wp_insert_user with the values the owner gave', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			const before = user(wp);
			const res = await claim(wp, {
				adminName: 'owner',
				adminMail: 'owner@example.com',
				adminPass: PASS,
				siteName: 'Claimed Site'
			});
			const body = (await res.json()) as Record<string, unknown>;
			const options = Object.fromEntries(
				wp.sql
					.exec(
						"SELECT option_name, option_value FROM wp_options WHERE option_name IN ('blogname','admin_email','siteurl','home')"
					)
					.toArray()
					.map((r) => [String(r['option_name']), String(r['option_value'])])
			);
			const role = wp.sql
				.exec(
					"SELECT meta_value FROM wp_usermeta WHERE user_id = 1 AND meta_key = 'wp_capabilities'"
				)
				.toArray()[0];
			return { before, status: res.status, body, after: user(wp), options, role };
		});
		expect(out.status).toBe(200);
		expect(out.before).toHaveLength(1);
		expect(out.before[0]?.['user_pass']).toBe('!');
		// the baked administrator is taken over, so nothing else is left behind
		expect(out.after).toHaveLength(1);
		expect(out.after[0]?.['ID']).toBe(1);
		expect(out.after[0]?.['user_login']).toBe('owner');
		expect(out.after[0]?.['user_email']).toBe('owner@example.com');
		const hash = String(out.after[0]?.['user_pass']);
		// WordPress's own hash: phpass or its bcrypt prefix, never the password, never the marker
		expect(hash).toMatch(/^(\$P\$|\$wp\$2y\$)/);
		expect(hash).not.toContain(PASS);
		expect(String(out.role?.['meta_value'])).toContain('administrator');
		expect(out.options['blogname']).toBe('Claimed Site');
		expect(out.options['admin_email']).toBe('owner@example.com');
		expect(out.options['siteurl']).toBe(ORIGIN);
		expect(out.options['home']).toBe(ORIGIN);
		// the owner token is shown once; the supplied password is never echoed
		expect(typeof out.body['ownerToken']).toBe('string');
		expect(out.body['adminPass']).toBeUndefined();
		expect(JSON.stringify(out.body)).not.toContain(PASS);
	}, 120_000);

	it('refuses a second claim, a forced one and a migrated one, and leaves the account alone', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			const first = await claim(wp, { adminName: 'owner', adminPass: PASS });
			const hash = user(wp)[0]?.['user_pass'];
			const second = await claim(wp, { adminName: 'intruder', adminPass: 'other-pass-1' });
			const forced = await claim(
				wp,
				{ adminName: 'intruder', adminPass: 'other-pass-2' },
				'?force=1'
			);
			const query = await claim(wp, { adminPass: 'x' }, '?pass=hunter2');
			return {
				first: first.status,
				second: second.status,
				secondBody: await second.text(),
				forced: forced.status,
				query: query.status,
				same: user(wp)[0]?.['user_pass'] === hash,
				login: user(wp)[0]?.['user_login']
			};
		});
		expect(out.first).toBe(200);
		expect(out.second).toBe(409);
		expect(out.secondBody).toContain('already configured');
		expect(out.forced).toBe(409);
		expect(out.query).toBe(400);
		expect(out.same).toBe(true);
		expect(out.login).toBe('owner');
	}, 120_000);

	it('rejects a migrated claim, which only Drupal has', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			const res = await claim(wp, { migrated: true });
			return { status: res.status, rows: user(wp).length, meta: wp.metaGet('first_run_at') };
		});
		expect(out.status).toBe(400);
		expect(out.meta).toBeNull();
	}, 120_000);

	it('mints a password when none is given, returns it once and stores only its hash', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			const res = await claim(wp, { adminName: 'owner' });
			const body = (await res.json()) as Record<string, unknown>;
			return { body, text: everyText(wp) };
		});
		const minted = String(out.body['adminPass']);
		expect(minted.length, JSON.stringify(out.body)).toBeGreaterThanOrEqual(20);
		expect(out.text).not.toContain(minted);
	}, 120_000);

	it('never writes the password into a row, a log line or a stats report', async () => {
		const logged: string[] = [];
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => {
			const original = console[level];
			console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
			return () => (console[level] = original);
		});
		let out;
		try {
			out = await inObject(freshSite(), async (site: ServeDo) => {
				const wp = await ready(site);
				const res = await claim(wp, { adminName: 'owner', adminPass: PASS });
				const stats = await wp.fetch(new Request('https://do.local/__serve-stats'));
				return { status: res.status, stats: await stats.text(), text: everyText(wp) };
			});
		} finally {
			for (const restore of spies) restore();
		}
		expect(out.status).toBe(200);
		expect(out.stats).not.toContain(PASS);
		expect(out.text).not.toContain(PASS);
		expect(logged.join('\n')).not.toContain(PASS);
	}, 120_000);

	it('answers a refused claim with WordPress error code and no password, and stays unclaimed', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await ready(site);
			const res = await claim(wp, {
				adminName: 'owner',
				adminMail: 'not-an-address',
				adminPass: PASS
			});
			return { status: res.status, body: await res.text(), meta: wp.metaGet('first_run_at') };
		});
		expect(out.body).not.toContain(PASS);
		expect(out.body).toContain('"ok":false');
		expect(out.meta).toBeNull();
	}, 120_000);
});
