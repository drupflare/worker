import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml, pageHref, pageOf, rootPrefix } from './pages';

/** one link in docs/nav.json: a page by repository path, a generated reference by name, or a URL */
export type Entry = {
	title: string;
	path?: string;
	url?: string;
	description: string;
	menu?: string;
};
export type Section = { title: string; pages: Entry[] };
export type Group = { title: string; pages: Entry[]; sections?: Section[] };
export type Manifest = { groups: Group[] };

/** a manifest entry placed in its group and section, with what it points at resolved */
export type Item = {
	entry: Entry;
	group: string;
	section?: string;
	kind: 'page' | 'reference' | 'external';
	/** the published page name for a page, or `api` or `php` for a reference */
	name?: string;
};

export const REFERENCES = ['api', 'php'];

/** reads docs/nav.json */
export function loadNav(root: string): Manifest {
	return JSON.parse(readFileSync(join(root, 'docs/nav.json'), 'utf8'));
}

/** the manifest flattened in reading order: a group's pages, then each section's pages */
export function navItems(manifest: Manifest): Item[] {
	const place = (entry: Entry, group: string, section?: string): Item => {
		if (entry.url) return { entry, group, section, kind: 'external' };
		if (entry.path && REFERENCES.includes(entry.path))
			return { entry, group, section, kind: 'reference', name: entry.path };
		if (entry.path) return { entry, group, section, kind: 'page', name: pageOf(entry.path) };
		throw new Error(`docs/nav.json entry "${entry.title}" has neither path nor url`);
	};
	return manifest.groups.flatMap((group) => [
		...group.pages.map((entry) => place(entry, group.title)),
		...(group.sections ?? []).flatMap((section) =>
			section.pages.map((entry) => place(entry, group.title, section.title))
		)
	]);
}

/** fails when the manifest and the pages the generator walks disagree, listing every difference */
export function checkNav(items: Item[], docs: string[]): void {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const { entry, kind, name } of items) {
		if (!entry.title?.trim())
			problems.push(`an entry for ${entry.path ?? entry.url} has no title`);
		if (!entry.description?.trim()) problems.push(`"${entry.title}" has no description`);
		if (entry.url && !entry.url.startsWith('https://'))
			problems.push(`"${entry.title}" links to ${entry.url}, which is not https`);
		if (kind === 'page') {
			const path = entry.path!;
			if (!/^(README|TECHNICAL_REPORT)\.md$|^docs\/.+\.md$/.test(path))
				problems.push(`"${entry.title}" has the path ${path}, which is not a page`);
			else if (name !== 'index' && !docs.includes(name!))
				problems.push(`docs/nav.json lists ${path}, which does not exist`);
		}
		if (name) {
			if (seen.has(name)) problems.push(`docs/nav.json lists ${name} more than once`);
			seen.add(name);
		}
	}
	for (const name of docs)
		if (!seen.has(name))
			problems.push(
				`${name === 'technical-report' ? 'TECHNICAL_REPORT.md' : `docs/${name}.md`} is not listed in docs/nav.json`
			);
	if (problems.length)
		throw new Error(`docs/nav.json does not match the pages:\n${problems.join('\n')}`);
}

/** the header menus, in order of first use: the entries that carry a `menu` label */
export function navMenus(items: Item[]): { label: string; items: Item[] }[] {
	const menus = new Map<string, Item[]>();
	for (const item of items)
		if (item.entry.menu)
			menus.set(item.entry.menu, [...(menus.get(item.entry.menu) ?? []), item]);
	return [...menus].map(([label, list]) => ({ label, items: list }));
}

/** where an item's link points from the page `current`, which is a page name */
export function itemHref(item: Item, current: string): string {
	if (item.kind === 'external') return item.entry.url!;
	if (item.kind === 'reference') return `${rootPrefix(current)}${item.name}/index.html`;
	return pageHref(current, item.name!);
}

/** true when the item is the page being shown */
export const isCurrent = (item: Item, current: string) =>
	item.kind === 'page' && item.name === current;

/** the left sidebar: collapsible groups and sections, the group of the current page open */
export function sidebarHtml(items: Item[], current: string): string {
	const link = (item: Item) => {
		const { title, description } = item.entry;
		const here = isCurrent(item, current);
		const href = escapeHtml(itemHref(item, current));
		const anchor =
			item.kind === 'external'
				? `<a class="docs-ext" href="${href}" rel="noopener">${escapeHtml(title)}<span class="docs-sr"> (external link)</span></a>`
				: `<a href="${href}"${here ? ' aria-current="page"' : ''}>${escapeHtml(title)}</a>`;
		const line =
			here || item.kind !== 'page'
				? `<span class="docs-desc">${escapeHtml(description)}</span>`
				: '';
		return `<li>${anchor}${line}</li>`;
	};
	const list = (list: Item[]) => (list.length ? `<ul>${list.map(link).join('')}</ul>` : '');
	const groups = [...new Set(items.map((item) => item.group))].map((title) => {
		const inGroup = items.filter((item) => item.group === title);
		const sections = [
			...new Set(inGroup.flatMap((item) => (item.section ? [item.section] : [])))
		].map((name) => {
			const inSection = inGroup.filter((item) => item.section === name);
			const open = inSection.some((item) => isCurrent(item, current));
			return `<details class="docs-section"${open ? ' open' : ''}><summary>${escapeHtml(name)}</summary>${list(inSection)}</details>`;
		});
		const open = inGroup.some((item) => isCurrent(item, current));
		return `<details class="docs-group"${open ? ' open' : ''}><summary>${escapeHtml(title)}</summary>${list(inGroup.filter((item) => !item.section))}${sections.join('')}</details>`;
	});
	return [
		'<div class="docs-sidebar" id="docs-sidebar" popover>',
		'<div class="docs-sidebar-head"><span>Documentation</span><button type="button" class="docs-close" popovertarget="docs-sidebar" popovertargetaction="hide">Close</button></div>',
		`<nav class="docs-nav" aria-label="Documentation">${groups.join('')}</nav>`,
		'</div>'
	].join('\n');
}

/** previous and next page links with their descriptions, in manifest order */
export function pagerHtml(items: Item[], current: string): string {
	const pages = items.filter((item) => item.kind === 'page');
	const at = pages.findIndex((item) => item.name === current);
	if (at < 0) return '';
	const cell = (item: Item | undefined, rel: 'prev' | 'next') =>
		item
			? `<a rel="${rel}" class="docs-pager-${rel}" href="${escapeHtml(itemHref(item, current))}"><span class="docs-pager-label">${rel === 'prev' ? 'Previous' : 'Next'}</span><strong>${escapeHtml(item.entry.title)}</strong><span>${escapeHtml(item.entry.description)}</span></a>`
			: '';
	return `<nav class="docs-pager" aria-label="Previous and next pages">${cell(pages[at - 1], 'prev')}${cell(pages[at + 1], 'next')}</nav>`;
}

/** the header menus and the GitHub link; a folder's index highlights for any page below it */
export function headerNav(items: Item[], current: string, repo: string): string {
	const below = (item: Item) =>
		isCurrent(item, current) ||
		(item.name?.endsWith('/index') === true && current.startsWith(item.name.slice(0, -5)));
	const menu = ({ label, items: list }: ReturnType<typeof navMenus>[number]) =>
		[
			`<details class="menu"${list.some(below) ? ' data-current' : ''}>`,
			`<summary>${escapeHtml(label)}</summary>`,
			`<div class="panel">${list
				.map(
					(item) =>
						`<a href="${escapeHtml(itemHref(item, current))}"${isCurrent(item, current) ? ' aria-current="page"' : ''}>${escapeHtml(item.entry.title)}</a>`
				)
				.join('')}</div>`,
			'</details>'
		].join('');
	return [...navMenus(items).map(menu), `<a href="${repo}">GitHub</a>`].join('\n\t\t\t\t');
}

/** what a page needs besides the template: its head text, its place in the site and its body */
export type PageOptions = {
	title: string;
	description: string;
	current: string;
	hero: string;
	body: string;
	crumbs?: string;
};

/** fills the template: head tags, header menus, sidebar, pager and body for the page `current` */
export function assemblePage(
	template: string,
	items: Item[],
	options: PageOptions,
	repo: string
): string {
	return template
		.replaceAll('<!-- base -->', rootPrefix(options.current))
		.replaceAll('<!-- file -->', options.current === 'index' ? '' : `${options.current}.html`)
		.replaceAll('<!-- title -->', escapeHtml(options.title))
		.replaceAll('<!-- description -->', escapeHtml(options.description))
		.replace('<!-- nav -->', () => headerNav(items, options.current, repo))
		.replace('<!-- sidebar -->', () => sidebarHtml(items, options.current))
		.replace('<!-- pager -->', () => pagerHtml(items, options.current))
		.replace('<!-- hero -->', () => options.hero)
		.replace('<!-- readme -->', () => `${options.crumbs ?? ''}${options.body.trimEnd()}`);
}
