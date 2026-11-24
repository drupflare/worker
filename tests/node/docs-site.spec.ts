import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, posix, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSite } from '../../scripts/docs/check';
import {
	checkFences,
	docSlug,
	extractFences,
	formatProblem,
	planFences,
	writeFences
} from '../../scripts/docs/fences';
import {
	assemblePage,
	checkNav,
	loadNav,
	navItems,
	navMenus,
	pagerHtml,
	sidebarHtml,
	type Entry,
	type Manifest
} from '../../scripts/docs/nav';
import {
	ancestors,
	checkPages,
	contentsOf,
	headingIds,
	HOST,
	loadMoves,
	pageHref,
	pageOf,
	redirectStubs,
	REPORT,
	rootPrefix,
	sourcePath,
	titleOf,
	walkDocs
} from '../../scripts/docs/pages';
import { linkBack } from '../../scripts/docs/references';

/** the docs site generator: the folder walk, the move map, the navigation manifest and its checks */

const ROOT = resolve(import.meta.dirname, '..', '..');
const docs = walkDocs(ROOT);
const moves = loadMoves(ROOT);
const manifest = loadNav(ROOT);
const items = navItems(manifest);
const pageItems = items.filter((item) => item.kind === 'page');
const repo = 'https://github.com/drupflare/worker';

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

describe('the navigation manifest', () => {
	const entry = (path: string): Entry => ({ title: 'T', path, description: 'D.' });
	const withPage = (path: string): Manifest => ({
		groups: [{ title: 'G', pages: [...manifest.groups.flatMap((g) => g.pages), entry(path)] }]
	});

	it('lists every page the walk finds, once', () => {
		const names = pageItems.map((item) => item.name!);
		expect(new Set(names).size).toBe(names.length);
		for (const name of docs) expect(names, name).toContain(name);
		expect(names.filter((name) => !docs.includes(name))).toEqual(['index']);
		expect(() => checkNav(items, docs)).not.toThrow();
	});

	it('fails when a page is missing from the manifest, naming its file', () => {
		expect(() => checkNav(items, [...docs, 'impact/new-page'])).toThrow(
			/docs\/impact\/new-page\.md is not listed in docs\/nav\.json/
		);
		expect(() => checkNav(items, docs)).not.toThrow();
	});

	it('fails when the manifest lists a page that does not exist', () => {
		expect(() => checkNav(navItems(withPage('docs/gone/page.md')), docs)).toThrow(
			/docs\/nav\.json lists docs\/gone\/page\.md, which does not exist/
		);
	});

	it('fails on a page listed twice', () => {
		expect(() => checkNav(navItems(withPage('docs/impact/index.md')), docs)).toThrow(
			/lists impact\/index more than once/
		);
	});

	it('fails on an entry with no description, a link that is not https and a path that is no page', () => {
		const broken = (patch: Partial<Entry>): Manifest => ({
			groups: [
				{ title: 'G', pages: [...manifest.groups.flatMap((g) => g.pages), patch as Entry] }
			]
		});
		expect(() =>
			checkNav(
				navItems(broken({ title: 'X', url: 'https://a.test', description: ' ' })),
				docs
			)
		).toThrow(/"X" has no description/);
		expect(() =>
			checkNav(
				navItems(broken({ title: 'X', url: 'http://a.test', description: 'D.' })),
				docs
			)
		).toThrow(/not https/);
		expect(() =>
			checkNav(navItems(broken({ title: 'X', path: 'notes/a.md', description: 'D.' })), docs)
		).toThrow(/not a page/);
		expect(() => navItems(broken({ title: 'X', description: 'D.' }))).toThrow(
			/neither path nor url/
		);
	});

	it('gives every folder of docs/ a group entry with its index, and the report one too', () => {
		const folders = readdirSync(join(ROOT, 'docs'), { withFileTypes: true })
			.filter((dirent) => dirent.isDirectory())
			.map((dirent) => `${dirent.name}/index`);
		const featured = pageItems.filter((item) => item.entry.menu).map((item) => item.name);
		expect([...featured].sort()).toEqual([...folders, REPORT].sort());
	});

	it('builds the header menus from the manifest, each entry once, with the references', () => {
		const menus = navMenus(items);
		const listed = menus.flatMap((menu) => menu.items.map((item) => item.name));
		expect(new Set(listed).size).toBe(listed.length);
		expect(listed).toEqual(expect.arrayContaining([REPORT, 'api', 'php']));
		expect(menus.length).toBeLessThanOrEqual(4);
		expect(menus.map((menu) => menu.label)).toEqual(['Run', 'Understand', 'Reference']);
	});

	it('puts the sibling repositories under On GitHub, each at a drupflare URL', () => {
		const group = manifest.groups.find((g) => g.title === 'On GitHub')!;
		expect(group.pages.length).toBeGreaterThanOrEqual(10);
		for (const link of group.pages)
			expect(link.url, link.title).toMatch(
				new RegExp(`^https://github\\.com/drupflare/${link.title}$`)
			);
		expect(group.pages.map((link) => link.title)).toEqual(
			expect.arrayContaining([
				'worker',
				'drupflare',
				'rom',
				'phasm',
				'anachron',
				'stream-http'
			])
		);
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
	it('exist in the manifest for every page and link', () => {
		for (const item of items) {
			expect(item.entry.title.trim(), item.entry.path ?? item.entry.url).not.toBe('');
			expect(item.entry.description.trim(), item.entry.title).not.toBe('');
		}
	});

	it('fit one line of a search result', () => {
		for (const item of items)
			expect(item.entry.description.length, item.entry.title).toBeLessThanOrEqual(170);
	});
});

describe('the sidebar', () => {
	const at = 'configuration/runtime';

	it('marks one current page and opens only its group and section', () => {
		const html = sidebarHtml(items, 'configuration/serving/page-cache');
		expect(html).toContain('id="docs-sidebar"');
		expect(html).toContain('popover');
		expect(html.match(/aria-current="page"/g)).toHaveLength(1);
		expect(html).toContain('<details class="docs-group" open><summary>Configuration</summary>');
		expect(html).toContain('<details class="docs-section" open><summary>Serving and Caching');
		expect(html).toContain('<details class="docs-group"><summary>Security</summary>');
		expect(html).toContain('<details class="docs-section"><summary>Operations');
	});

	it('moves the open group with the current page', () => {
		const home = sidebarHtml(items, 'index');
		expect(home).toContain('<details class="docs-group" open><summary>Getting Started');
		expect(home).toContain('<details class="docs-group"><summary>Configuration</summary>');
		expect(home.match(/aria-current="page"/g)).toHaveLength(1);
	});

	it('marks an external link, gives it rel noopener and shows its description', () => {
		const html = sidebarHtml(items, at);
		const anchors = html.match(/<a [^>]*href="https:\/\/[^"]*"[^>]*>/g) ?? [];
		expect(anchors.length).toBeGreaterThanOrEqual(10);
		for (const anchor of anchors) {
			expect(anchor).toContain('rel="noopener"');
			expect(anchor).toContain('class="docs-ext"');
		}
		expect(html).toContain('<span class="docs-sr"> (external link)</span>');
		expect(html).toContain('<span class="docs-desc">The Drupflare project site.</span>');
	});

	it('does not give an internal link a noopener, and links relative to the page', () => {
		const html = sidebarHtml(items, at);
		expect(html).toContain('<a href="../architecture/index.html">Architecture</a>');
		expect(html).toContain('<a href="../api/index.html">API Reference</a>');
		expect(html).toContain('<a href="serving/index.html">Serving and Caching Settings</a>');
		expect(sidebarHtml(items, REPORT)).toContain('<a href="api/index.html">API Reference</a>');
		expect(html).not.toMatch(/<a href="\.\.\/architecture[^>]*rel=/);
	});

	it('shows the description of the current page and no other page', () => {
		const html = sidebarHtml(items, at);
		expect(html).toContain('Settings for cron, warming, the interpreter lifecycle');
		expect(html).not.toContain('Settings for replica lanes: count');
	});

	it('escapes a title', () => {
		const odd: Manifest = {
			groups: [
				{
					title: 'G',
					pages: [{ title: 'A <b> & "c"', url: 'https://a.test', description: 'D.' }]
				}
			]
		};
		const html = sidebarHtml(navItems(odd), 'index');
		expect(html).toContain('A &lt;b> &amp; &quot;c&quot;');
		expect(html).not.toContain('<b>');
	});

	it('gives a page its neighbours with their descriptions, and the ends one side', () => {
		const first = pageItems[0]!.name!;
		const last = pageItems.at(-1)!.name!;
		const middle = pagerHtml(items, pageItems[3]!.name!);
		expect(middle).toContain('rel="prev"');
		expect(middle).toContain('rel="next"');
		expect(middle).toContain(pageItems[4]!.entry.description);
		expect(pagerHtml(items, first)).not.toContain('rel="prev"');
		expect(pagerHtml(items, last)).not.toContain('rel="next"');
		expect(pagerHtml(items, 'api')).toBe('');
	});
});

describe('a built page', () => {
	const template = readFileSync(join(ROOT, 'docs/template.html'), 'utf8');
	const build = (current: string) =>
		assemblePage(
			template,
			items,
			{
				title: `T - Drupflare`,
				description: 'A "quoted" description.',
				current,
				hero: '',
				body: '<h2 id="a">A</h2>'
			},
			repo
		);

	it('carries the sidebar, the header menus, the pager and one current link', () => {
		const html = build('configuration/runtime');
		expect(html).toContain('<div class="docs-sidebar" id="docs-sidebar" popover>');
		expect(html).toContain('<nav class="docs-nav" aria-label="Documentation">');
		expect(html).toContain('class="docs-menu"');
		expect(html).toContain('<details class="menu" data-current>');
		expect(html).toContain('<nav class="docs-pager"');
		expect(html.match(/<a [^>]*aria-current="page"/g)).toHaveLength(1);
		expect(build('configuration/index').match(/<a [^>]*aria-current="page"/g)).toHaveLength(2);
		expect(
			html.match(/<div class="docs-sidebar"[\s\S]*?<\/nav>/)![0].match(/aria-current/g)
		).toHaveLength(1);
		expect(html).not.toMatch(
			/<!-- (nav|sidebar|pager|hero|readme|file|base|title|description) -->/
		);
	});

	it('keeps the title, description and Open Graph tags in step', () => {
		const html = build('impact/energy/index');
		expect(html).toContain('<title>T - Drupflare</title>');
		expect(html.match(/content="A &quot;quoted&quot; description\."/g)).toHaveLength(2);
		expect(html).toContain('content="https://docs.drupflare.com/impact/energy/index.html"');
		expect(html).toContain('href="https://docs.drupflare.com/impact/energy/index.html"');
		expect(build('index')).toContain('content="https://docs.drupflare.com/"');
	});

	it('wires the favicon files from the page depth', () => {
		expect(build('impact/energy/index')).toContain('href="../../drupflare.ico"');
		expect(build('impact/energy/index')).toContain('href="../../drupflare_128.png"');
		expect(build(REPORT)).toContain('href="drupflare.ico"');
		for (const icon of ['drupflare.ico', 'drupflare.png', 'drupflare_128.png'])
			expect(existsSync(join(ROOT, 'docs', icon)), icon).toBe(true);
	});
});

describe('the site check', () => {
	const MINI: Manifest = {
		groups: [
			{
				title: 'Guides',
				pages: [
					{ title: 'Overview', path: 'README.md', description: 'The overview.' },
					{
						title: 'Start',
						path: 'docs/start/index.md',
						menu: 'Run',
						description: 'Where to begin.'
					},
					{
						title: 'API Reference',
						path: 'api',
						menu: 'Reference',
						description: 'The API.'
					},
					{ title: 'Source', url: repo, description: 'The code.' }
				]
			}
		]
	};
	const template = readFileSync(join(ROOT, 'docs/template.html'), 'utf8');
	const made: string[] = [];
	afterAll(() => {
		for (const dir of made) rmSync(dir, { recursive: true, force: true });
	});

	function site() {
		const dir = mkdtempSync(join(tmpdir(), 'docs-site-'));
		made.push(dir);
		const root = join(dir, 'root');
		const out = join(dir, 'out');
		mkdirSync(join(root, 'docs'), { recursive: true });
		mkdirSync(join(out, 'start'), { recursive: true });
		mkdirSync(join(out, 'api'), { recursive: true });
		writeFileSync(join(root, 'docs/nav.json'), JSON.stringify(MINI));
		for (const target of [root + '/docs', out]) {
			writeFileSync(join(target, 'CNAME'), `${HOST}\n`);
			for (const icon of ['drupflare.ico', 'drupflare.png', 'drupflare_128.png'])
				writeFileSync(join(target, icon), 'x');
		}
		writeFileSync(join(out, 'render.js'), '');
		const mini = navItems(MINI);
		for (const name of ['index', 'start/index'])
			writeFileSync(
				join(out, `${name}.html`),
				assemblePage(
					template,
					mini,
					{
						title: `${name} - Drupflare`,
						description: `About ${name}.`,
						current: name,
						hero: '',
						body: '<h1>Title</h1><h2 id="a">A</h2><p><a href="#a">a</a></p>'
					},
					repo
				)
			);
		writeFileSync(
			join(out, 'api/index.html'),
			linkBack('<html><head></head><body></body></html>', 'api/index.html')
		);
		return { root, out };
	}
	const edit = (file: string, from: string, to: string) =>
		writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));

	it('passes a complete site', () => {
		const { root, out } = site();
		expect(checkSite(out, root)).toEqual({ problems: [], pages: 2, links: expect.any(Number) });
	});

	it('fails a page the manifest lists that was not built, and one built but not listed', () => {
		const { root, out } = site();
		rmSync(join(out, 'start/index.html'));
		expect(checkSite(out, root).problems).toContain(
			'docs/nav.json lists docs/start/index.md, which was not built'
		);
		const fresh = site();
		writeFileSync(join(fresh.out, 'extra.html'), readFileSync(join(fresh.out, 'index.html')));
		expect(checkSite(fresh.out, fresh.root).problems).toContain(
			'extra.html was built but is not listed in docs/nav.json'
		);
	});

	it('fails a stale link and a stale anchor', () => {
		const { root, out } = site();
		edit(
			join(out, 'index.html'),
			'<a href="#a">a</a>',
			'<a href="start/gone.html">x</a><a href="start/index.html#nope">y</a>'
		);
		const problems = checkSite(out, root).problems;
		expect(problems).toContain('index.html: start/gone.html does not exist');
		expect(problems).toContain('index.html: start/index.html#nope has no such heading');
	});

	it('fails an external link with no rel noopener, and passes one that has it', () => {
		const { root, out } = site();
		const page = join(out, 'index.html');
		edit(page, '</main>', '<a class="docs-ext" href="https://a.test/">x</a></main>');
		expect(checkSite(out, root).problems.join('\n')).toMatch(
			/external link has no rel="noopener"/
		);
		edit(
			page,
			'class="docs-ext" href="https://a.test/"',
			'class="docs-ext" href="https://a.test/" rel="noopener"'
		);
		expect(checkSite(out, root).problems).toEqual([]);
	});

	it('fails a page whose description and Open Graph description differ', () => {
		const { root, out } = site();
		edit(
			join(out, 'index.html'),
			'property="og:description"\n\t\t\tcontent="About index."',
			'property="og:description"\n\t\t\tcontent="Other."'
		);
		expect(checkSite(out, root).problems).toContain(
			'index.html: og:description differs from the description'
		);
	});

	it('fails a missing favicon, CNAME and Guides link', () => {
		const { root, out } = site();
		rmSync(join(out, 'drupflare.ico'));
		rmSync(join(out, 'CNAME'));
		edit(join(out, 'api/index.html'), 'class="docs-guides"', 'class="other"');
		const problems = checkSite(out, root).problems;
		expect(problems).toContain('drupflare.ico was not published');
		expect(problems).toContain('CNAME was not published');
		expect(problems).toContain('api/index.html: no Guides link back to the docs');
	});

	it('fails a sidebar with no current link', () => {
		const { root, out } = site();
		edit(join(out, 'index.html'), 'aria-current="page"', 'data-x');
		expect(checkSite(out, root).problems.join('\n')).toMatch(
			/index\.html: the sidebar has 0 current links/
		);
	});
});

describe('the generated references', () => {
	const bare = '<html><head></head><body></body></html>';

	it('get a Guides link back that resolves from their folder', () => {
		expect(linkBack(bare, 'api/index.html')).toContain(
			'<a class="docs-guides" href="../index.html">'
		);
		expect(linkBack(bare, 'api/classes/a.html')).toContain('href="../../index.html">Guides');
	});

	it('resolve from the base element where the page sets one', () => {
		const php = '<html><head><base href="../"/></head><body></body></html>';
		expect(linkBack(php, 'php/classes/a.html')).toContain('href="../index.html">Guides');
		expect(linkBack(php.replace('../', './'), 'php/index.html')).toContain(
			'href="../index.html">Guides'
		);
	});

	it('add the favicon links only where a page has none, and only once', () => {
		const once = linkBack(bare, 'api/index.html');
		expect(once).toContain('href="../drupflare.ico"');
		expect(linkBack(once, 'api/index.html')).toBe(once);
		const icon = '<html><head><link rel="icon" href="x.ico"/></head><body></body></html>';
		expect(linkBack(icon, 'api/index.html')).not.toContain('drupflare.ico');
	});
});

describe('the docs fences', () => {
	const fence = (code: string, info = '') => `\`\`\`ts ${info}\n${code}\n\`\`\``;

	it('are found in lists and quotes, with their line and flags, and other languages skipped', () => {
		const page = [
			'# T',
			'',
			fence('const a = 1;'),
			'',
			'- item',
			'',
			'  ```ts no-check',
			'  const b = ;',
			'  ```',
			'',
			'```sh',
			'ls',
			'```'
		].join('\n');
		const found = extractFences(page, 'x.md');
		expect(found.map((f) => [f.line, f.flags])).toEqual([
			[3, []],
			[9, ['no-check']]
		]);
		expect(found[1]!.code).toBe('const b = ;\n');
	});

	it('are named by a first-line path or else by position, and a no-check fence is left out', () => {
		const found = extractFences(
			[
				fence('// a/b.ts\nconst a = 1;'),
				fence('const c = 2;', 'no-check'),
				fence('const d = 3;')
			].join('\n'),
			'docs/x/y.md'
		);
		expect(planFences('docs/x/y.md', found).map((p) => p.out)).toEqual([
			'x-y/a/b.ts',
			'x-y/3.ts'
		]);
		expect(docSlug('README.md')).toBe('readme');
	});

	it('refuse to write outside the output folder', () => {
		const dir = mkdtempSync(join(tmpdir(), 'docs-fences-'));
		try {
			const [bad] = planFences('x.md', extractFences(fence('const a = 1;'), 'x.md'));
			expect(() => writeFences(dir, [{ ...bad!, out: '../escape.ts' }])).toThrow(/outside/);
			expect(() => writeFences(dir, [bad!])).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('fail a stale snippet at its position in the page, and pass a good one', () => {
		const dir = mkdtempSync(join(tmpdir(), 'docs-fences-'));
		try {
			mkdirSync(join(dir, 'scripts/docs'), { recursive: true });
			writeFileSync(
				join(dir, 'scripts/docs/tsconfig.fences.json'),
				JSON.stringify({
					compilerOptions: {
						lib: ['es5'],
						types: [],
						strict: true,
						noEmit: true,
						target: 'es5',
						moduleDetection: 'force'
					},
					include: ['../../build/docs-fences/**/*.ts']
				})
			);
			writeFileSync(
				join(dir, 'good.md'),
				`# T\n\n${fence('const n: number = 1;\nexport {};')}\n`
			);
			writeFileSync(
				join(dir, 'stale.md'),
				`# T\n\n${fence('const n: number = "x";\nexport {};')}\n`
			);
			expect(checkFences(dir, { docs: ['good.md'] }).problems).toEqual([]);
			const report = checkFences(dir, { docs: ['stale.md'] });
			expect(report.problems).toHaveLength(1);
			expect(report.problems[0]).toMatch(/^stale\.md:4:7 error TS2322/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('format a compile error in page coordinates', () => {
		const [planned] = planFences('p.md', extractFences(fence('x'), 'p.md'));
		expect(formatProblem(planned, { line: 2, column: 5 }, 2322, 'm')).toBe(
			'p.md:3:5 error TS2322: m'
		);
		expect(formatProblem(undefined, undefined, 1005, 'm', 'f.ts:1:1')).toBe(
			'f.ts:1:1 error TS1005: m'
		);
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
