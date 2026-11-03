import GithubSlugger from 'github-slugger';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** the report lives at the repository root and is published beside the docs pages */
export const REPORT = 'technical-report';

/** the published host, from docs/CNAME */
export const HOST = 'docs.drupflare.com';

/** the top-level entries: each folder's index page and the report, in navigation order */
export const TOP: { name: string; text: string }[] = [
	{
		name: 'getting-started/index',
		text: 'From a clean clone to a running site, claiming it, updating it, and building from source.'
	},
	{
		name: 'operating/index',
		text: 'Administration, recovery, git remotes, external databases, interpreter updates and replica lanes.'
	},
	{
		name: 'architecture/index',
		text: 'How a request is answered, what the build packs, measurement classes, compatibility and limits.'
	},
	{
		name: 'configuration/index',
		text: 'Every variable and binding in the two wrangler configs, and the page each lives on.'
	},
	{
		name: 'security/index',
		text: 'What the architecture removes and what it leaves, the controls in place, and incidents.'
	},
	{
		name: 'impact/index',
		text: 'Energy, carbon, water and cost, with the label and reference behind every figure.'
	},
	{ name: 'audiences/index', text: 'Pages for a specific procurement or compliance reader.' },
	{
		name: REPORT,
		text: 'The engineering record: architecture, platform limits, costs and measurements.'
	}
];

/** the header nav: the top-level entries only; a folder's children are reached from its index */
export const NAV = TOP.map((entry) => entry.name);

/** the header menus: every NAV entry once, then the generated API and PHP references */
export const NAV_MENUS: { label: string; items: string[] }[] = [
	{ label: 'Run', items: ['getting-started/index', 'operating/index', 'configuration/index'] },
	{
		label: 'Understand',
		items: ['architecture/index', 'security/index', 'impact/index', 'audiences/index']
	},
	{ label: 'Reference', items: [REPORT, 'api', 'php'] }
];

/** nav labels where the page's H1 is too long for the bar */
export const NAV_LABEL: Record<string, string> = { [REPORT]: 'Technical Report' };

/** the folder-qualified name of the index of each ancestor folder of a page, outermost first */
export function ancestors(name: string): string[] {
	const parts = name.split('/');
	const folders = name.endsWith('/index') ? parts.slice(0, -2) : parts.slice(0, -1);
	return folders.map((_, i) => `${folders.slice(0, i + 1).join('/')}/index`);
}

/** the first paragraph after the title as plain text, cut at a sentence end near 200 characters */
export function leadOf(markdown: string): string {
	const body = markdown.replace(/^# .+$/m, '').trimStart();
	const paragraph = body.split(/\n\s*\n/)[0] ?? '';
	if (/^(#|\||```|[-*] )/.test(paragraph.trimStart())) return '';
	const plain = paragraph
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[`*_]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (plain.length <= 200) return plain;
	const cut = plain.slice(0, 200);
	const end = Math.max(cut.lastIndexOf('. '), 0);
	return end > 40 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}...`;
}

/** the ids a page's headings carry once rendered */
export function headingIds(markdown: string): Set<string> {
	const slugger = new GithubSlugger();
	const ids = new Set<string>();
	let code = false;
	for (const line of markdown.split('\n')) {
		if (/^```/.test(line)) code = !code;
		const title = code ? undefined : line.match(/^#{1,6} (.+)$/)?.[1];
		if (title) ids.add(slugger.slug(title.trim().replace(/[`*]/g, '')));
	}
	return ids;
}

/** a contents list of the level-two headings only, placed before the first one; none under two */
export function contentsOf(html: string): string {
	const items = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(
		([, id, text]) => `<li><a href="#${id}">${text}</a></li>`
	);
	if (items.length < 2) return html;
	const toc = `<nav class="toc" aria-label="Contents"><strong>Contents</strong><ol>${items.join('')}</ol></nav>`;
	return html.replace('<h2', () => `${toc}<h2`);
}

export type Move = { to: string; anchors: Record<string, string> };

/** old page name to its new page, and the headings that now live on a different page */
export function loadMoves(root: string): Record<string, Move> {
	const raw: Record<string, string | Partial<Move>> = JSON.parse(
		readFileSync(join(root, 'scripts/docs/moves.json'), 'utf8')
	);
	return Object.fromEntries(
		Object.entries(raw).map(([from, value]) => [
			from,
			typeof value === 'string'
				? { to: value, anchors: {} }
				: { to: value.to!, anchors: value.anchors ?? {} }
		])
	);
}

/** every page name under docs/, folder-qualified and without an extension, plus the report; docs/README.md is a map for the repository and is not a page */
export function walkDocs(root: string): string[] {
	const walk = (dir: string): string[] =>
		readdirSync(join(root, 'docs', dir), { withFileTypes: true }).flatMap((entry) => {
			const path = posix.join(dir, entry.name);
			if (entry.isDirectory()) return walk(path);
			return entry.name.endsWith('.md') && path !== 'README.md'
				? [path.slice(0, -'.md'.length)]
				: [];
		});
	return [...walk(''), REPORT].sort();
}

export const sourcePath = (name: string) =>
	name === REPORT ? 'TECHNICAL_REPORT.md' : `docs/${name}.md`;

/** the page a source file publishes as: README.md is index, docs/a/b.md is a/b */
export function pageOf(from: string): string {
	if (from === 'README.md') return 'index';
	if (from === 'TECHNICAL_REPORT.md') return REPORT;
	return from.replace(/^docs\//, '').replace(/\.md$/, '');
}

/** the path that gets from the page `from` to the page `to`, both names without an extension */
export function pageHref(from: string, to: string): string {
	return posix.relative(posix.dirname(`${from}.html`), `${to}.html`);
}

/** the prefix that gets from a page back to the site root: '' flat, '../' one folder down */
export const rootPrefix = (name: string) => '../'.repeat(name.split('/').length - 1);

/** the first level-one heading; a page without one has no title to publish */
export function titleOf(markdown: string, name: string): string {
	const title = markdown.match(/^# (.+)$/m)?.[1]?.trim();
	if (!title) throw new Error(`${sourcePath(name)} has no # title`);
	return title;
}

/** fails when a nav entry names a page that does not exist, or a folder has no index page */
export function checkPages(docs: string[]): void {
	for (const name of NAV)
		if (!docs.includes(name)) throw new Error(`${sourcePath(name)} does not exist`);
	for (const name of docs)
		for (const parent of ancestors(name))
			if (!docs.includes(parent)) throw new Error(`${sourcePath(parent)} does not exist`);
}

const escapeAttr = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

/** a page for an old URL: meta refresh, canonical and a visible link, with a script only to keep the hash */
export function redirectStub(from: string, move: Move, title: string): string {
	const href = pageHref(from, move.to);
	const canonical = `https://${HOST}/${move.to}.html`;
	const anchors = Object.fromEntries(
		Object.entries(move.anchors).map(([id, page]) => [id, pageHref(from, page)])
	);
	const script = Object.keys(anchors).length
		? `var a=${JSON.stringify(anchors)},h=location.hash.slice(1);if(h)location.replace((a[h]||${JSON.stringify(href)})+location.hash)`
		: `if(location.hash)location.replace(${JSON.stringify(href)}+location.hash)`;
	return [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		`<title>${escapeAttr(title)} moved - Drupflare</title>`,
		`<meta http-equiv="refresh" content="0; url=${escapeAttr(href)}">`,
		`<link rel="canonical" href="${escapeAttr(canonical)}">`,
		'<meta name="robots" content="noindex">',
		`<script>${script}</script>`,
		'</head>',
		'<body>',
		`<p>${escapeAttr(title)} moved to <a href="${escapeAttr(href)}">${escapeAttr(canonical)}</a>.</p>`,
		'</body>',
		'</html>',
		''
	].join('\n');
}

/** every old page's stub, keyed by the file it is written to */
export function redirectStubs(
	moves: Record<string, Move>,
	titles: Record<string, string>
): Map<string, string> {
	return new Map(
		Object.entries(moves).map(([from, move]) => [
			`${from}.html`,
			redirectStub(from, move, titles[move.to] ?? move.to)
		])
	);
}
