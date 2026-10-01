import { Marked } from 'marked';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { createHighlighter, type BundledLanguage } from 'shiki';

const root = new URL('../..', import.meta.url).pathname;
const out = join(root, 'typedoc');
const repo = 'https://github.com/drupflare/worker';
const ref = 'master';
const LANGUAGES: BundledLanguage[] = ['shellscript', 'json'];
const ALIASES: Record<string, BundledLanguage> = {
	sh: 'shellscript',
	bash: 'shellscript',
	jsonc: 'json'
};

/** one line per docs page; a page missing here fails the build, so the front page cannot omit it */
const SUMMARY: Record<string, string> = {
	'building-from-source': 'From a clean clone to a deployable tree, and the release payload.',
	compatibility: 'Which Drupal codebases run, per codebase, from the corpus lane.',
	configuration: 'Every variable and binding in wrangler.jsonc, and how each is changed.',
	database: 'How the site database every new site starts from is built.',
	'external-database': 'Hyperdrive and external databases, and what they change.',
	government: 'OMB M-23-22 and the 21st Century IDEA for US federal sites.',
	impact: 'Cost, electricity, carbon and water, and how far each figure holds.',
	'measurement-classes':
		'The four classes a number belongs to, and which instrument each allows.',
	'php-update-delivery': 'How a new PHP interpreter build reaches a deployed site.',
	recovery: 'The four ways a site moves backwards and how to come back.',
	'repository-layout': 'Every path outside src/ and how it arrives on a clean clone.'
};

/** the header nav: the pages a new reader reaches for first */
const NAV = [
	'impact',
	'configuration',
	'compatibility',
	'building-from-source',
	'recovery',
	'database'
];

const PLACEHOLDER = '<!-- readme -->';

const language = (lang: string | undefined): BundledLanguage | 'text' => {
	const named = lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	const aliased = ALIASES[named] ?? (named as BundledLanguage);
	return LANGUAGES.includes(aliased) ? aliased : 'text';
};

const escapeHtml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

const docs = readdirSync(join(root, 'docs'))
	.filter((file) => file.endsWith('.md'))
	.map((file) => basename(file, '.md'))
	.sort();
for (const name of docs)
	if (!SUMMARY[name]) throw new Error(`docs/${name}.md has no entry in SUMMARY`);
for (const name of [...Object.keys(SUMMARY), ...NAV])
	if (!docs.includes(name)) throw new Error(`docs/${name}.md does not exist`);

/** a link written in the source file `from`, as a site link or else a repository URL */
function resolve(from: string, href: string): string {
	if (/^[a-z][a-z0-9+.-]*:|^[#/]/i.test(href)) return href;
	const [path = '', hash] = href.split('#');
	const target = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, '');
	const suffix = hash ? `#${hash}` : '';
	if (target === 'README.md') return `index.html${suffix}`;
	const page = target.match(/^docs\/([^/]+)\.md$/)?.[1];
	if (page && docs.includes(page)) return `${page}.html${suffix}`;
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
				token.text = highlighter.codeToHtml(token.text, {
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

function titleOf(markdown: string, fallback: string): string {
	return markdown.match(/^# (.+)$/m)?.[1]?.trim() ?? fallback;
}

function nav(current: string, titles: Record<string, string>): string {
	const link = (href: string, label: string, page?: string) =>
		`<a href="${href}"${page === current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
	return [
		...NAV.map((name) => link(`${name}.html`, titles[name] ?? name, name)),
		link('api/index.html', 'API'),
		link('php/index.html', 'PHP'),
		link(repo, 'GitHub')
	].join('\n\t\t\t\t');
}

function page(options: {
	title: string;
	description: string;
	current: string;
	hero: string;
	body: string;
	titles: Record<string, string>;
}): string {
	return template
		.replaceAll('<!-- title -->', escapeHtml(options.title))
		.replaceAll('<!-- description -->', escapeHtml(options.description))
		.replace('<!-- nav -->', () => nav(options.current, options.titles))
		.replace('<!-- hero -->', () => options.hero)
		.replace(PLACEHOLDER, () => options.body.trimEnd());
}

const sources = Object.fromEntries(
	docs.map((name) => [name, readFileSync(join(root, 'docs', `${name}.md`), 'utf8')])
);
const titles = Object.fromEntries(docs.map((name) => [name, titleOf(sources[name]!, name)]));

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const header = readme.match(/^<div[\s\S]*?\n<\/div>\n+(---\n+)?/)?.[0] ?? '';
const tagline = header.match(/<p[^>]*>([^<]+)<\/p>/)?.[1] ?? '';
const badges = header.match(/<img src="https:\/\/img\.shields\.io[^>]*>/g) ?? [];

const card = (href: string, label: string, text: string) =>
	`<a class="card" href="${href}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(text)}</span></a>`;
const cards = [
	card('api/index.html', 'API Reference', 'The TypeScript modules under src/, from TypeDoc.'),
	card('php/index.html', 'PHP Reference', 'The PHP the interpreter runs, under src/site/php/.'),
	...docs.map((name) => card(`${name}.html`, titles[name]!, SUMMARY[name]!))
].join('\n');

const hero = [
	'<h1>Drupflare</h1>',
	`<p class="lead">${escapeHtml(tagline)}</p>`,
	badges.length ? `<p class="badges">${badges.join(' ')}</p>` : '',
	`<div class="links">\n${cards}\n</div>`
].join('\n');

mkdirSync(out, { recursive: true });
const written: string[] = [];
const emit = (file: string, html: string) => {
	writeFileSync(join(out, file), html);
	written.push(file);
};

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
for (const name of docs)
	emit(
		`${name}.html`,
		page({
			title: `${titles[name]} - Drupflare`,
			description: SUMMARY[name]!,
			current: name,
			hero: '',
			body: await render(`docs/${name}.md`, sources[name]!),
			titles
		})
	);
highlighter.dispose();

for (const asset of ['CNAME', 'drupflare.ico', 'drupflare.png', 'drupflare_128.png'])
	cpSync(join(root, 'docs', asset), join(out, asset));

console.log(`docs site: wrote ${written.join(', ')}`);
