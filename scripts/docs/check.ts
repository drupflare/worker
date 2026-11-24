import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { loadNav, navItems } from './nav';
import { HOST } from './pages';

/** what a check of a built site found */
export type SiteReport = { problems: string[]; pages: number; links: number };

const ICONS = ['drupflare.ico', 'drupflare.png', 'drupflare_128.png'];
const idsOf = (html: string) => [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? '');
const attr = (html: string, pattern: RegExp) => html.match(pattern)?.[1]?.trim() ?? '';
const decode = (text: string) =>
	text.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

/**
 * Checks a built docs site against docs/nav.json: nav coverage in both directions, links and
 * anchors, a title, description and matching Open Graph tags on every page, one current link in
 * the sidebar, rel on external links, the favicon files, CNAME and the Guides link in the
 * generated references.
 */
export function checkSite(out: string, root: string): SiteReport {
	const problems: string[] = [];
	const files = (readdirSync(out, { recursive: true }) as string[]).map((p) =>
		p.replaceAll('\\', '/')
	);
	const isReference = (path: string) => /^(api|php)\//.test(path);
	const htmlFiles = files.filter((p) => p.endsWith('.html'));
	const html = new Map(htmlFiles.map((p) => [p, readFileSync(join(out, p), 'utf8')]));
	const isStub = (path: string) => html.get(path)!.includes('name="robots" content="noindex"');
	const pages = htmlFiles.filter((p) => !isReference(p) && !isStub(p));

	const items = navItems(loadNav(root));
	const listed = new Set<string>();
	for (const item of items) {
		if (item.kind === 'page') {
			const file = item.name === 'index' ? 'index.html' : `${item.name}.html`;
			listed.add(file);
			if (!html.has(file))
				problems.push(`docs/nav.json lists ${item.entry.path}, which was not built`);
		}
		if (item.kind === 'reference' && !html.has(`${item.name}/index.html`))
			problems.push(`docs/nav.json lists the ${item.name} reference, which was not built`);
	}
	for (const page of pages)
		if (!listed.has(page))
			problems.push(`${page} was built but is not listed in docs/nav.json`);

	let links = 0;
	for (const [page, source] of html) {
		if (isReference(page)) continue;
		if (isStub(page) && !source.includes('http-equiv="refresh"'))
			problems.push(`${page}: a redirect page with no refresh`);
		for (const match of source.matchAll(
			/<(?:a|link|script|img)\s[^>]*?(?:href|src)="([^"]*)"/g
		)) {
			const raw = decode(match[1] ?? '');
			if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
			links++;
			const [path = '', hash = ''] = raw.replace(/\?[^#]*/, '').split('#');
			const target = path === '' ? page : posix.join(posix.dirname(page), path);
			let file = target;
			const full = resolve(out, target);
			if (existsSync(full) && statSync(full).isDirectory())
				file = posix.join(target, 'index.html');
			if (!existsSync(resolve(out, file))) {
				problems.push(`${page}: ${raw} does not exist`);
				continue;
			}
			const body = html.get(file);
			if (
				hash &&
				body &&
				!isReference(file) &&
				!idsOf(body).includes(decodeURIComponent(hash))
			)
				problems.push(`${page}: ${raw} has no such heading`);
		}
	}

	for (const page of pages) {
		const source = html.get(page)!;
		const title = decode(attr(source, /<title>([^<]*)<\/title>/));
		const description = decode(attr(source, /<meta\s+name="description"\s+content="([^"]*)"/));
		if (!title) problems.push(`${page}: no title`);
		if (!description) problems.push(`${page}: no description`);
		const og = (name: string) =>
			decode(attr(source, new RegExp(`<meta\\s+property="og:${name}"\\s+content="([^"]*)"`)));
		if (og('title') !== title) problems.push(`${page}: og:title differs from the title`);
		if (og('description') !== description)
			problems.push(`${page}: og:description differs from the description`);
		const canonical = attr(source, /<link\s+rel="canonical"\s+href="([^"]*)"/);
		if (!canonical.startsWith(`https://${HOST}/`) || og('url') !== canonical)
			problems.push(`${page}: canonical and og:url disagree or leave ${HOST}`);
		if (!/<link\s+rel="icon"/.test(source)) problems.push(`${page}: no favicon link`);
		if (!source.includes('id="docs-sidebar"')) problems.push(`${page}: no sidebar`);
		const current = source.match(/<a [^>]*aria-current="page"/g)?.length ?? 0;
		const inSidebar = source
			.match(/<div class="docs-sidebar"[\s\S]*?<\/nav>/)?.[0]
			.match(/aria-current="page"/g)?.length;
		if (inSidebar !== 1 || current < 1)
			problems.push(`${page}: the sidebar has ${inSidebar ?? 0} current links, not one`);
		if (/<h1[\s>]/.test(source) === false) problems.push(`${page}: no h1`);
		const ids = idsOf(source);
		if (new Set(ids).size !== ids.length) problems.push(`${page}: duplicate ids`);
	}

	for (const [page, source] of html)
		for (const [anchor] of isReference(page)
			? []
			: source.matchAll(/<a\s[^>]*href="https?:\/\/[^"]*"[^>]*>/g))
			if (
				/class="docs-ext"|target="_blank"/.test(anchor) &&
				!/rel="[^"]*noopener/.test(anchor)
			)
				problems.push(
					`${page}: an external link has no rel="noopener": ${anchor.slice(0, 80)}`
				);

	for (const icon of ICONS) {
		if (!existsSync(join(root, 'docs', icon))) problems.push(`docs/${icon} is missing`);
		if (!files.includes(icon)) problems.push(`${icon} was not published`);
	}
	if (!existsSync(join(root, 'docs/CNAME'))) problems.push('docs/CNAME is missing');
	else if (!files.includes('CNAME')) problems.push('CNAME was not published');
	else if (readFileSync(join(out, 'CNAME'), 'utf8').trim() !== HOST)
		problems.push(`CNAME does not name ${HOST}`);

	for (const [page, source] of html)
		if (isReference(page) && !source.includes('class="docs-guides"'))
			problems.push(`${page}: no Guides link back to the docs`);

	return { problems: [...new Set(problems)], pages: pages.length, links };
}

if (import.meta.main) {
	const root = new URL('../..', import.meta.url).pathname;
	const out = resolve(process.argv[2] ?? join(root, 'typedoc'));
	const report = checkSite(out, root);
	console.log(`docs check: ${report.pages} pages, ${report.links} relative links`);
	for (const problem of report.problems.slice(0, 40)) console.error(problem);
	if (report.problems.length > 40) console.error(`... and ${report.problems.length - 40} more`);
	if (report.problems.length) process.exitCode = 1;
}
