import { Marked } from 'marked';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createHighlighter, type BundledLanguage } from 'shiki';
import {
	ancestors,
	checkPages,
	contentsOf,
	leadOf,
	loadMoves,
	NAV_LABEL,
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
} from './pages';

const root = new URL('../..', import.meta.url).pathname;
const out = process.env.DOCS_OUT ?? join(root, 'typedoc');
const repo = 'https://github.com/drupflare/worker';
const ref = 'master';
const LANGUAGES: BundledLanguage[] = ['shellscript', 'json'];
const ALIASES: Record<string, BundledLanguage> = {
	sh: 'shellscript',
	bash: 'shellscript',
	jsonc: 'json'
};

const PLACEHOLDER = '<!-- readme -->';

const language = (lang: string | undefined): BundledLanguage | 'text' => {
	const named = lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	const aliased = ALIASES[named] ?? (named as BundledLanguage);
	return LANGUAGES.includes(aliased) ? aliased : 'text';
};

const escapeHtml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

const docs = walkDocs(root);
checkPages(docs);
const moves = loadMoves(root);

/** a link written in the source file `from`, as a site link or else a repository URL */
function resolve(from: string, href: string): string {
	if (/^[a-z][a-z0-9+.-]*:|^[#/]/i.test(href)) return href;
	const [path = '', hash] = href.split('#');
	const target = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, '');
	const suffix = hash ? `#${hash}` : '';
	const at = pageOf(from);
	if (target === 'README.md') return `${pageHref(at, 'index')}${suffix}`;
	if (target === 'TECHNICAL_REPORT.md') return `${pageHref(at, REPORT)}${suffix}`;
	const page = target.match(/^docs\/(.+)\.md$/)?.[1];
	if (page && docs.includes(page)) return `${pageHref(at, page)}${suffix}`;
	const directory = statSync(join(root, target), { throwIfNoEntry: false })?.isDirectory();
	return `${repo}/${directory ? 'tree' : 'blob'}/${ref}/${target}${suffix}`;
}

const highlighter = await createHighlighter({
	themes: ['github-light', 'github-dark'],
	langs: LANGUAGES
});

async function render(from: string, markdown: string): Promise<string> {
	const renderer = new Marked({ async: true, gfm: true });
	renderer.use(gfmHeadingId());
	renderer.use({
		async: true,
		walkTokens(token) {
			if (token.type === 'link') token.href = resolve(from, token.href);
			if (token.type === 'code') {
				const drawn = token.lang?.trim().split(/\s+/)[0];
				token.text =
					drawn === 'mermaid' || drawn === 'math'
						? `<pre><code class="${drawn}">${escapeHtml(token.text)}</code></pre>`
						: highlighter.codeToHtml(token.text, {
								lang: language(token.lang),
								themes: { light: 'github-light', dark: 'github-dark' },
								defaultColor: false
							});
				token.escaped = true;
			}
		},
		renderer: { code: ({ text }) => text }
	});
	return (await renderer.parse(markdown))
		.replaceAll('<table>', '<div class="table"><table>')
		.replaceAll('</table>', '</table></div>')
		.replace(/src="docs\//g, 'src="');
}

const template = readFileSync(join(root, 'docs/template.html'), 'utf8');
if (!template.includes(PLACEHOLDER))
	throw new Error(`docs/template.html has no ${PLACEHOLDER} line`);

function nav(current: string, titles: Record<string, string>): string {
	const prefix = rootPrefix(current);
	const here = (name: string) =>
		name === current || (name.endsWith('/index') && current.startsWith(name.slice(0, -5)));
	const link = (href: string, label: string, page?: string) =>
		`<a href="${href}"${page && here(page) ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
	const entry = (name: string) =>
		name === 'api' || name === 'php'
			? link(`${prefix}${name}/index.html`, name.toUpperCase())
			: link(`${prefix}${name}.html`, NAV_LABEL[name] ?? titles[name] ?? name, name);
	const menu = ({ label, items }: (typeof NAV_MENUS)[number]) => {
		const open = items.some(here);
		return [
			`<details class="menu"${open ? ' data-current' : ''}>`,
			`<summary>${escapeHtml(label)}</summary>`,
			`<div class="panel">${items.map(entry).join('')}</div>`,
			'</details>'
		].join('');
	};
	return [...NAV_MENUS.map(menu), link(repo, 'GitHub')].join('\n\t\t\t\t');
}

function page(options: {
	title: string;
	description: string;
	current: string;
	hero: string;
	body: string;
	titles: Record<string, string>;
	crumbs?: string;
}): string {
	return template
		.replaceAll('<!-- base -->', rootPrefix(options.current))
		.replaceAll('<!-- title -->', escapeHtml(options.title))
		.replaceAll('<!-- description -->', escapeHtml(options.description))
		.replace('<!-- nav -->', () => nav(options.current, options.titles))
		.replace('<!-- hero -->', () => options.hero)
		.replace(PLACEHOLDER, () => `${options.crumbs ?? ''}${options.body.trimEnd()}`);
}

const sources = Object.fromEntries(
	docs.map((name) => [name, readFileSync(join(root, sourcePath(name)), 'utf8')])
);
const titles = Object.fromEntries(docs.map((name) => [name, titleOf(sources[name]!, name)]));

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const header = readme.match(/^<div[\s\S]*?\n<\/div>\n+(---\n+)?/)?.[0] ?? '';
const tagline = header.match(/<p[^>]*>([^<]+)<\/p>/)?.[1] ?? '';
const badges = header.match(/<img src="https:\/\/img\.shields\.io[^>]*>/g) ?? [];

const card = (href: string, label: string, text: string) =>
	`<a class="card" href="${href}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(text)}</span></a>`;
const groups = [
	[
		'Documentation',
		TOP.map(({ name, text }) => card(`${name}.html`, titles[name]!, text))
	] as const,
	[
		'Code',
		[
			card(
				'api/index.html',
				'API Reference',
				'The TypeScript modules under src/, from TypeDoc.'
			),
			card(
				'php/index.html',
				'PHP Reference',
				'The PHP the interpreter runs, under src/site/php/.'
			)
		]
	] as const
];
const cards = groups
	.map(
		([title, items]) =>
			`<h2 class="group">${title}</h2>\n<div class="links">\n${items.join('\n')}\n</div>`
	)
	.join('\n');

const hero = [
	'<h1>Drupflare</h1>',
	`<p class="lead">${escapeHtml(tagline)}</p>`,
	badges.length ? `<p class="badges">${badges.join(' ')}</p>` : '',
	cards
].join('\n');

mkdirSync(out, { recursive: true });
const written: string[] = [];
const emitted = new Map<string, string>();
const emit = (file: string, html: string) => {
	mkdirSync(posix.dirname(join(out, file)), { recursive: true });
	writeFileSync(join(out, file), html);
	written.push(file);
	emitted.set(file, html);
};

/** every in-site link must land on a page we wrote and an id that page carries */
function brokenLinks(): string[] {
	const broken: string[] = [];
	for (const [file, html] of emitted)
		for (const [, href = '', hash = ''] of html.matchAll(/href="([^"#]*)(#[^"]*)?"/g)) {
			if (href && (!href.endsWith('.html') || /^[a-z][a-z0-9+.-]*:/i.test(href))) continue;
			const target = href && posix.join(posix.dirname(file), href);
			if (/^(api|php)\//.test(target)) continue;
			const page = target || file;
			const body = emitted.get(page);
			if (!body) broken.push(`${file}: ${target} is not a page`);
			else if (hash && !body.includes(`id="${decodeURIComponent(hash.slice(1))}"`))
				broken.push(`${file}: ${page}${hash} has no such heading`);
		}
	return [...new Set(broken)];
}

emit(
	'index.html',
	page({
		title: 'Drupflare',
		description: tagline,
		current: '',
		hero,
		body: await render('README.md', readme.slice(header.length)),
		titles
	})
);
/** the folder indexes above a page, outermost first, as a line of links */
function crumbs(name: string, titles: Record<string, string>): string {
	const trail = ancestors(name);
	if (!trail.length) return '';
	const links = trail.map(
		(parent) =>
			`<a href="${pageHref(name, parent)}">${escapeHtml(titles[parent] ?? parent)}</a>`
	);
	return `<p class="crumbs">${links.join(' / ')}</p>\n`;
}

for (const name of docs) {
	const body = await render(sourcePath(name), sources[name]!);
	emit(
		`${name}.html`,
		page({
			title: `${titles[name]} - Drupflare`,
			description: leadOf(sources[name]!) || titles[name]!,
			current: name,
			hero: '',
			body: contentsOf(body),
			crumbs: crumbs(name, titles),
			titles
		})
	);
}
highlighter.dispose();

for (const [file, html] of redirectStubs(moves, titles)) emit(file, html);

for (const asset of ['CNAME', 'drupflare.ico', 'drupflare.png', 'drupflare_128.png'])
	cpSync(join(root, 'docs', asset), join(out, asset));
cpSync(join(root, 'scripts/docs/render.js'), join(out, 'render.js'));

const broken = brokenLinks();
if (broken.length) throw new Error(`broken docs links:\n${broken.join('\n')}`);

console.log(`docs site: wrote ${written.join(', ')}`);
