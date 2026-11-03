import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	ancestors,
	checkPages,
	contentsOf,
	headingIds,
	HOST,
	leadOf,
	loadMoves,
	NAV,
	NAV_MENUS,
	pageHref,
	pageOf,
	redirectStubs,
	REPORT,
	rootPrefix,
	sourcePath,
	titleOf,
	TOP,
	walkDocs
} from '../../scripts/docs/pages';

/** the docs site generator: the folder walk, the move map and the redirect stubs for old URLs */

const ROOT = resolve(import.meta.dirname, '..', '..');
const docs = walkDocs(ROOT);
const moves = loadMoves(ROOT);

describe('the docs walk', () => {
	it('finds nested pages under their folder-qualified name and keeps flat pages flat', () => {
		expect(docs).toContain('configuration/runtime');
		expect(docs).toContain('impact/energy/views');
		expect(docs).toContain('security/index');
		expect(docs).toContain('architecture/index');
		expect(docs).toContain(REPORT);
		expect(docs).not.toContain('README');
		expect(docs.some((name) => name.endsWith('.md'))).toBe(false);
		expect(docs).toEqual([...docs].sort());
	});

	it('leaves the old flat names out once a page has moved', () => {
		for (const old of Object.keys(moves)) expect(docs).not.toContain(old);
	});

	it('reads a nested page from its folder', () => {
		expect(sourcePath('configuration/runtime')).toBe('docs/configuration/runtime.md');
		expect(existsSync(join(ROOT, sourcePath('configuration/runtime')))).toBe(true);
		expect(sourcePath(REPORT)).toBe('TECHNICAL_REPORT.md');
	});
});

describe('a nested page output path', () => {
	it('is the folder-qualified name with .html', () => {
		expect(pageOf('docs/configuration/runtime.md')).toBe('configuration/runtime');
		expect(pageOf('docs/architecture/index.md')).toBe('architecture/index');
		expect(pageOf('README.md')).toBe('index');
		expect(pageOf('TECHNICAL_REPORT.md')).toBe(REPORT);
	});

	it('links to its neighbours and to the flat pages with the right number of dots', () => {
		expect(pageHref('configuration/runtime', 'configuration/serving')).toBe('serving.html');
		expect(pageHref('configuration/runtime', 'configuration/index')).toBe('index.html');
		expect(pageHref('configuration/runtime', 'architecture/index')).toBe(
			'../architecture/index.html'
		);
		expect(pageHref('architecture/index', 'configuration/runtime')).toBe(
			'../configuration/runtime.html'
		);
		expect(pageHref('technical-report', 'impact/index')).toBe('impact/index.html');
		expect(pageHref('configuration/runtime', 'index')).toBe('../index.html');
	});

	it('reaches the site root with one prefix per folder', () => {
		expect(rootPrefix('technical-report')).toBe('');
		expect(rootPrefix('index')).toBe('');
		expect(rootPrefix('')).toBe('');
		expect(rootPrefix('configuration/runtime')).toBe('../');
	});
});

describe('navigation', () => {
	it('lists only top-level entries: a folder index at depth one, or a root page', () => {
		for (const name of NAV) expect(name.split('/').length, name).toBeLessThanOrEqual(2);
		expect(
			NAV.filter((name) => name.includes('/')).every((name) => name.endsWith('/index'))
		).toBe(true);
	});

	it('names every top-level folder of docs/ and the report, and nothing else', () => {
		const folders = readdirSync(join(ROOT, 'docs'), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => `${entry.name}/index`);
		expect([...NAV].sort()).toEqual([...folders, REPORT].sort());
		expect(TOP.map((entry) => entry.name)).toEqual(NAV);
	});

	it('groups every nav entry into exactly one header menu, beside the generated references', () => {
		const items = NAV_MENUS.flatMap((menu) => menu.items);
		expect([...items].sort()).toEqual([...NAV, 'api', 'php'].sort());
		expect(NAV_MENUS.length).toBeLessThanOrEqual(4);
	});

	it('names every nav entry as a real page', () => {
		for (const name of NAV) expect(docs).toContain(name);
		expect(() => checkPages(docs)).not.toThrow();
	});

	it('fails on a folder with no index page', () => {
		expect(() => checkPages([...docs, 'impact/new-folder/page'])).toThrow(
			/docs\/impact\/new-folder\/index\.md does not exist/
		);
	});

	it('finds the folder indexes above a page, outermost first', () => {
		expect(ancestors('impact/economics/free-vs-paid/off-worker-arms')).toEqual([
			'impact/index',
			'impact/economics/index',
			'impact/economics/free-vs-paid/index'
		]);
		expect(ancestors('impact/economics/index')).toEqual(['impact/index']);
		expect(ancestors('impact/index')).toEqual([]);
		expect(ancestors(REPORT)).toEqual([]);
	});
});

describe('the contents list of a page', () => {
	const html = (headings: string) => `<p>lead</p>${headings}<p>text</p>`;

	it('holds level-two headings and no deeper ones', () => {
		const out = contentsOf(
			html(
				'<h2 id="a">A</h2><h3 id="a1">A1</h3><h2 id="b">B</h2><h4 id="b1">B1</h4><h3 id="b2">B2</h3>'
			)
		);
		const toc = out.match(/<nav class="toc".*?<\/nav>/)![0];
		expect(toc).toContain('href="#a"');
		expect(toc).toContain('href="#b"');
		expect(toc).not.toMatch(/a1|b1|b2/);
		expect(out).toContain('<h3 id="a1">A1</h3>');
	});

	it('is left out of a page with fewer than two level-two headings', () => {
		expect(contentsOf(html('<h2 id="a">A</h2><h3 id="a1">A1</h3>'))).not.toContain(
			'class="toc"'
		);
	});
});

describe('page descriptions', () => {
	it('come from the first paragraph under the title', () => {
		expect(leadOf('# T\n\nOne [link](x.md) and `code`. Two.\n\n## H\n')).toBe(
			'One link and code. Two.'
		);
		expect(leadOf('# T\n\n## H\n')).toBe('');
	});

	it('are cut at a sentence end', () => {
		const long = `${'Sentence one is here. '.repeat(12)}end`;
		expect(leadOf(`# T\n\n${long}`).length).toBeLessThanOrEqual(200);
		expect(leadOf(`# T\n\n${long}`).endsWith('.')).toBe(true);
	});

	it('exist for every page', () => {
		for (const name of docs)
			expect(
				leadOf(readFileSync(join(ROOT, sourcePath(name)), 'utf8')),
				`${sourcePath(name)} needs a lead paragraph`
			).not.toBe('');
	});
});

describe('titles', () => {
	it('reads the first level-one heading', () => {
		expect(titleOf('intro\n\n# Runtime Settings\n\n# Later', 'configuration/runtime')).toBe(
			'Runtime Settings'
		);
	});

	it('fails on a page with no title, naming the file', () => {
		expect(() => titleOf('## Only a subheading\n', 'configuration/runtime')).toThrow(
			/docs\/configuration\/runtime\.md has no # title/
		);
	});

	it('finds one in every page', () => {
		for (const name of docs)
			expect(() =>
				titleOf(readFileSync(join(ROOT, sourcePath(name)), 'utf8'), name)
			).not.toThrow();
	});
});

describe('the redirect stubs for old URLs', () => {
	const titles = Object.fromEntries(docs.map((name) => [name, name]));
	const stubs = redirectStubs(moves, titles);

	it('writes a stub at every moved page and nowhere else', () => {
		expect([...stubs.keys()].sort()).toEqual(
			Object.keys(moves)
				.map((old) => `${old}.html`)
				.sort()
		);
		expect(Object.keys(moves).length).toBeGreaterThan(0);
	});

	it('keeps a stub at every URL published before the folders existed', () => {
		const published = [
			'configuration',
			'configuration-integrations',
			'configuration-operations',
			'configuration-replicas',
			'configuration-runtime',
			'configuration-serving',
			'energy',
			'energy-fleet',
			'energy-views',
			'security',
			'security-controls',
			'security-incidents'
		];
		for (const old of published) expect(stubs.has(`${old}.html`), `${old}.html`).toBe(true);
	});

	it('keeps a stub at every page the flat layout published', () => {
		const flat = [
			'administration',
			'architecture',
			'building-from-source',
			'compatibility',
			'database',
			'economics',
			'environment',
			'external-database',
			'free-vs-paid',
			'getting-started',
			'git-remotes',
			'government',
			'impact',
			'limitations',
			'measurement-classes',
			'modules',
			'php-update-delivery',
			'recovery',
			'replica-lanes',
			'repository-layout',
			'testing',
			'vps-comparison'
		];
		for (const old of flat) expect(stubs.has(`${old}.html`), `${old}.html`).toBe(true);
	});

	it('resolves every stub to a page the walk found, with the source file on disk', () => {
		for (const [old, { to, anchors }] of Object.entries(moves)) {
			expect(docs, `${old} moved to ${to}, which is not a docs page`).toContain(to);
			for (const [id, page] of Object.entries(anchors)) {
				expect(docs, `${old}#${id} moved to ${page}, which is not a docs page`).toContain(
					page
				);
				expect(
					headingIds(readFileSync(join(ROOT, sourcePath(page)), 'utf8')),
					`${old}#${id} is not a heading on ${page}`
				).toContain(id);
			}
			expect(existsSync(join(ROOT, sourcePath(to))), sourcePath(to)).toBe(true);
			expect(existsSync(join(ROOT, sourcePath(old))), `${old} still has a source`).toBe(
				false
			);
			const html = stubs.get(`${old}.html`)!;
			const href = pageHref(old, to);
			expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${href}">`);
			expect(html).toContain(`<link rel="canonical" href="https://${HOST}/${to}.html">`);
			expect(html).toContain(`<a href="${href}">`);
		}
	});

	it('serves from the host named in docs/CNAME', () => {
		expect(readFileSync(join(ROOT, 'docs', 'CNAME'), 'utf8').trim()).toBe(HOST);
	});

	it('needs no script for the redirect itself', () => {
		for (const html of stubs.values()) {
			expect(html).toContain('http-equiv="refresh"');
			expect(html).not.toMatch(/<script[^>]*\ssrc=/);
		}
	});

	it('maps each new name once', () => {
		const targets = Object.values(moves).map((move) => move.to);
		expect(new Set(targets).size).toBe(targets.length);
	});

	it('sends a moved section to the page that holds it, and keeps the hash', () => {
		const html = stubs.get('configuration-serving.html')!;
		expect(html).toContain('"never_stale":"configuration/serving/page-cache.html"');
		expect(html).toContain('location.hash');
	});
});

describe('relative markdown links in the docs and the README', () => {
	const walk = (dir: string): string[] =>
		readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
			const path = posix.join(dir, entry.name);
			if (entry.isDirectory()) return walk(path);
			return entry.name.endsWith('.md') ? [path] : [];
		});

	it('all resolve to a file or directory on disk', () => {
		const broken: string[] = [];
		for (const file of [...walk('docs'), 'README.md']) {
			const text = readFileSync(join(ROOT, file), 'utf8').replace(/```[\s\S]*?```/g, '');
			for (const [, href = ''] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				if (/^[a-z][a-z0-9+.-]*:|^[#/]/i.test(href)) continue;
				const path = href.split('#')[0]!;
				if (
					path &&
					!existsSync(join(ROOT, normalize(posix.join(posix.dirname(file), path))))
				)
					broken.push(`${file}: ${href}`);
			}
		}
		expect(broken).toEqual([]);
	});
});
