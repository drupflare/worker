import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bake } from '../../scripts/bake-wordpress';
import {
	dropInMissing,
	httpGet,
	installWordpress,
	prepareSite,
	readLog,
	startPhpServer,
	WORDPRESS_SRC,
	type PhpServer,
	type Site
} from '../../scripts/wp/harness';
import { startHost, type Host } from '../../scripts/wp/host';
import { fetchPage, tally, titleOf } from '../../scripts/wp/run';

/**
 * WordPress installs and answers its front page on the local PHP CLI, with every statement
 * translated by the real MySQL translator and run on a real SQLite file.
 *
 * Needs the fetched WordPress tree (`bun run fetch:wordpress`), the drop-in in the sibling
 * `drupflare` checkout, and a PHP CLI. A clean checkout has none of those and skips, naming
 * whichever is absent.
 */

const missing = (): string | undefined => {
	if (!existsSync(join(WORDPRESS_SRC, 'wp-load.php'))) {
		return `${WORDPRESS_SRC} is not fetched (bun run fetch:wordpress)`;
	}
	const dropIn = dropInMissing();
	if (dropIn !== undefined) return dropIn;
	return undefined;
};

const reason = missing();
const temps: string[] = [];

if (reason !== undefined) {
	it.skip(`wordpress front page (skipped: ${reason})`, () => {});
}

describe.skipIf(reason !== undefined)(
	'wordpress on the local php cli through the translator',
	() => {
		let site: Site;
		let host: Host;
		let server: PhpServer;
		let installOut: { code: number | null; stdout: string };
		let front: Awaited<ReturnType<typeof fetchPage>>;
		let frontBody: string;

		beforeAll(async () => {
			const dir = mkdtempSync(join(tmpdir(), 'wp-front-'));
			temps.push(dir);
			site = await prepareSite(dir);
			host = await startHost({ dbFile: site.db, socketPath: site.socket, keepText: true });
			server = await startPhpServer(site);
			installOut = await installWordpress(site);
			front = await fetchPage(site, host, '/');
			frontBody = (await httpGet(site, '/')).body;
		}, 120_000);

		afterAll(async () => {
			await server?.stop();
			await host?.stop();
		});

		it('runs the installer to the end', () => {
			expect(installOut.code).toBe(0);
			expect(JSON.parse(installOut.stdout.trim().split('\n').pop() as string)).toMatchObject({
				blogInstalled: true
			});
			const install = host.requests.find((r) => r.label === 'install');
			expect(install?.end?.fatal).toEqual([]);
			expect(tally(install?.statements ?? []).byVerb.CREATE).toBe(12);
		});

		it('fails only before the schema exists', () => {
			const statements = host.requests
				.flatMap((r) => r.statements)
				.sort((a, b) => a.seq - b.seq);
			const firstCreate = statements.findIndex((s) => s.verb === 'CREATE');
			expect(firstCreate).toBeGreaterThan(0);
			expect(statements.slice(firstCreate).filter((s) => !s.ok)).toEqual([]);
		});

		it('answers the front page with the installed title', () => {
			expect(front.status).toBe(200);
			expect(titleOf(frontBody)).toContain(site.title);
			expect(frontBody).toContain('Hello world!');
			expect(front.tally.statements).toBeGreaterThan(0);
			expect(front.tally.errors).toBe(0);
		});

		it('sends every statement to the translator once and meets no unknown class', () => {
			const all = host.requests.flatMap((r) => r.statements).sort((a, b) => a.seq - b.seq);
			expect(all.map((s) => s.seq)).toEqual(all.map((_, i) => i + 1));
			for (const r of host.requests.filter((q) => q.end !== undefined)) {
				expect(r.end?.sent, r.label).toBe(r.statements.length);
			}
			expect(all.filter((s) => s.classes.some((c) => /unknown/.test(c)))).toEqual([]);
			expect(all.filter((s) => s.classes.includes('translate-threw'))).toEqual([]);
		});

		it('logs no PHP error', () => {
			expect(readLog(site)).toBe('');
		});

		it('serves the same page from a new host over the same file without reinstalling', async () => {
			await server.stop();
			await host.stop();
			host = await startHost({ dbFile: site.db, socketPath: site.socket, keepText: true });
			server = await startPhpServer(site);
			const again = await httpGet(site, '/');
			expect(again.status).toBe(200);
			expect(again.body).toBe(frontBody);
			const statements = host.requests.flatMap((r) => r.statements);
			expect(statements.filter((s) => /^\s*CREATE TABLE/i.test(s.sql ?? ''))).toEqual([]);
		}, 60_000);

		it('reaches the host only through the drop-in', async () => {
			const dir = mkdtempSync(join(tmpdir(), 'wp-nodropin-'));
			temps.push(dir);
			const bare = await prepareSite(dir, { withDropIn: false });
			const bareHost = await startHost({ dbFile: bare.db, socketPath: bare.socket });
			const run = await installWordpress(bare);
			await bareHost.stop();
			expect(run.stdout).not.toContain('blogInstalled');
			expect(bareHost.requests.flatMap((r) => r.statements)).toEqual([]);
			expect(readFileSync(join(bare.www, 'wp-config.php'), 'utf8')).toContain('WP_HOME');
		}, 60_000);

		afterAll(() => {
			for (const dir of temps) rmSync(dir, { recursive: true, force: true });
		});
	}
);

describe.skipIf(reason !== undefined)('the baked database on the local php cli', () => {
	let site: Site;
	let host: Host;
	let server: PhpServer;

	beforeAll(async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wp-baked-'));
		temps.push(dir);
		const baked = await bake(join(dir, 'bake'), undefined);
		site = await prepareSite(join(dir, 'site'));
		copyFileSync(baked.db, site.db);
		host = await startHost({ dbFile: site.db, socketPath: site.socket, keepText: true });
		server = await startPhpServer(site);
	}, 120_000);

	afterAll(async () => {
		await server?.stop();
		await host?.stop();
		for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	});

	it('answers the category archive, its feed and the redirect to it', async () => {
		const archive = await httpGet(site, '/category/uncategorized/');
		expect(archive.status).toBe(200);
		expect(titleOf(archive.body)).toContain('Uncategorized');
		expect(archive.body).toContain('Hello world!');
		const feed = await httpGet(site, '/category/uncategorized/feed/');
		expect(feed.status).toBe(200);
		expect(feed.contentType).toMatch(/^application\/rss\+xml/);
		expect(feed.body).toContain('<title>Uncategorized');
		const byId = await httpGet(site, '/?cat=1');
		expect(byId.status).toBe(301);
		expect(byId.location).toBe(`${site.url}/category/uncategorized/`);
	});

	it('answers the sitemap index and the post sitemap', async () => {
		const index = await httpGet(site, '/wp-sitemap.xml');
		expect(index.status).toBe(200);
		expect(index.contentType).toMatch(/^application\/xml/);
		expect(index.body).toContain(`<loc>${site.url}/wp-sitemap-posts-post-1.xml</loc>`);
		const posts = await httpGet(site, '/wp-sitemap-posts-post-1.xml');
		expect(posts.status).toBe(200);
		expect(posts.body).toContain(`<loc>${site.url}/2026/01/01/hello-world/</loc>`);
	});

	it('translates every statement of those routes and logs no PHP error', () => {
		const all = host.requests.flatMap((r) => r.statements);
		expect(all.length).toBeGreaterThan(0);
		expect(all.filter((s) => !s.ok)).toEqual([]);
		expect(all.filter((s) => s.classes.some((c) => /unknown|threw/.test(c)))).toEqual([]);
		expect(readLog(site)).toBe('');
	});

	it('is a control: rules stored without the category rule answer 404 for the archive', async () => {
		const db = new DatabaseSync(site.db);
		const stored = (
			db
				.prepare("SELECT option_value FROM wp_options WHERE option_name = 'rewrite_rules'")
				.get() as { option_value: string }
		).option_value;
		const bare = 'a:1:{s:11:"^wp-json/?$";s:22:"index.php?rest_route=/";}';
		db.prepare(
			"UPDATE wp_options SET option_value = ? WHERE option_name = 'rewrite_rules'"
		).run(bare);
		try {
			expect((await httpGet(site, '/category/uncategorized/')).status).toBe(404);
		} finally {
			db.prepare(
				"UPDATE wp_options SET option_value = ? WHERE option_name = 'rewrite_rules'"
			).run(stored);
			db.close();
		}
		expect((await httpGet(site, '/category/uncategorized/')).status).toBe(200);
	});
});
