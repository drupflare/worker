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

/** the front page groups; every docs page needs a line here, so the front page cannot omit one */
const GROUPS: { title: string; pages: Record<string, string> }[] = [
	{
		title: 'Start',
		pages: {
			'getting-started':
				'From a clean clone to a running site, claimed, and moving an existing one in.',
			architecture:
				'How a request is answered, what the build packs, and how a site repairs itself.',
			'free-vs-paid': 'What each Cloudflare plan allows a site, and which limit binds first.',
			'vps-comparison':
				'Latency, throughput and cost against nginx and PHP-FPM on the same tree.',
			limitations: 'What does not run, what runs differently, and the limit behind each.'
		}
	},
	{
		title: 'Operate',
		pages: {
			administration:
				'The surfaces an owner operates a site from, and how each is authorised.',
			configuration:
				'Every variable and binding in wrangler.jsonc, and the page each lives on.',
			'configuration-serving': 'Page caching, static assets, prefill, files and images.',
			'configuration-runtime': 'Cron, warming, the interpreter lifecycle, boot and storage.',
			'configuration-replicas': 'Lane count, autoscaling, write forwarding and lag.',
			'configuration-operations':
				'Maintenance, owner access, audit, overrides, updates and reconciliation.',
			'configuration-integrations': 'Mail, TCP, Workers AI, OIDC login and Spool.',
			'replica-lanes':
				'Read replicas for a site: what a lane buys, how it scales, how it is built.',
			'git-remotes': 'Delivering modules and themes from a git host.',
			modules:
				'Contributed modules, module revisions, and which modules have run on a real site.',
			recovery: 'The four ways a site moves backwards and how to come back.',
			'external-database': 'Hyperdrive and external databases, and what they change.'
		}
	},
	{
		title: 'Measure',
		pages: {
			impact: 'The labels, limits and references behind every energy, carbon and cost figure.',
			energy: 'The saving against conventional hosting, operating states and the per-request model.',
			'energy-views': 'The energy of one view, the traffic mix, visitor devices and Spool.',
			'energy-fleet':
				'Many sites at once, institutional workloads and the saving by site count.',
			economics: 'What each host costs at each traffic level.',
			environment: 'Carbon, water and embodied carbon.',
			'measurement-classes':
				'The four classes a number belongs to, and which instrument each allows.'
		}
	},
	{
		title: 'Reference',
		pages: {
			security:
				'What the architecture removes and what it leaves, with the label on every claim.',
			'security-controls': 'The controls in place today, from the host surface to patching.',
			'security-incidents':
				'The CVE and incident map, PHP2Shell, and the work still planned.',
			government: 'OMB M-23-22 and the 21st Century IDEA for US federal sites.',
			compatibility: 'Which Drupal codebases run, per codebase, from the corpus lane.',
			'building-from-source':
				'From a clean clone to a deployable tree, and the release payload.',
			'repository-layout': 'Every path outside src/ and how it arrives on a clean clone.',
			database: 'How the site database every new site starts from is built.',
			'php-update-delivery': 'How a new PHP interpreter build reaches a deployed site.',
			testing: 'The test lanes, what each can see, and how to add a test.',
			'technical-report':
				'The engineering record: architecture, platform limits, costs and measurements.'
		}
	}
];
const SUMMARY: Record<string, string> = Object.fromEntries(
	GROUPS.flatMap((group) => Object.entries(group.pages))
);

/** the header nav: the pages a new reader reaches for first */
const NAV = [
	'getting-started',
	'architecture',
	'configuration',
	'security',
	'impact',
	'technical-report'
];

/** the report lives at the repository root and is published beside the docs pages */
const REPORT = 'technical-report';
const sourcePath = (name: string) => (name === REPORT ? 'TECHNICAL_REPORT.md' : `docs/${name}.md`);

/** nav labels where the page's H1 is too long for the bar */
const NAV_LABEL: Record<string, string> = { [REPORT]: 'Technical Report' };

const PLACEHOLDER = '<!-- readme -->';

const language = (lang: string | undefined): BundledLanguage | 'text' => {
	const named = lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	const aliased = ALIASES[named] ?? (named as BundledLanguage);
	return LANGUAGES.includes(aliased) ? aliased : 'text';
};

const escapeHtml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

const docs = [
	...readdirSync(join(root, 'docs'))
		.filter((file) => file.endsWith('.md'))
		.map((file) => basename(file, '.md')),
	REPORT
].sort();
for (const name of docs)
	if (!SUMMARY[name]) throw new Error(`${sourcePath(name)} has no entry in SUMMARY`);
for (const name of [...Object.keys(SUMMARY), ...NAV])
	if (!docs.includes(name)) throw new Error(`${sourcePath(name)} does not exist`);

/** a link written in the source file `from`, as a site link or else a repository URL */
function resolve(from: string, href: string): string {
	if (/^[a-z][a-z0-9+.-]*:|^[#/]/i.test(href)) return href;
	const [path = '', hash] = href.split('#');
	const target = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, '');
	const suffix = hash ? `#${hash}` : '';
	if (target === 'README.md') return `index.html${suffix}`;
	if (target === 'TECHNICAL_REPORT.md') return `${REPORT}.html${suffix}`;
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

function titleOf(markdown: string, fallback: string): string {
	return markdown.match(/^# (.+)$/m)?.[1]?.trim() ?? fallback;
}

function nav(current: string, titles: Record<string, string>): string {
	const link = (href: string, label: string, page?: string) =>
		`<a href="${href}"${page === current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
	return [
		...NAV.map((name) => link(`${name}.html`, NAV_LABEL[name] ?? titles[name] ?? name, name)),
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
	...GROUPS.map(
		(group) =>
			[
				group.title,
				Object.entries(group.pages).map(([name, text]) =>
					card(`${name}.html`, titles[name]!, text)
				)
			] as const
	),
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
	writeFileSync(join(out, file), html);
	written.push(file);
	emitted.set(file, html);
};

/** every in-site link must land on a page we wrote and an id that page carries */
function brokenLinks(): string[] {
	const broken: string[] = [];
	for (const [file, html] of emitted)
		for (const [, target = '', hash = ''] of html.matchAll(/href="([^"#]*)(#[^"]*)?"/g)) {
			if (target && (!target.endsWith('.html') || /^[a-z][a-z0-9+.-]*:/i.test(target)))
				continue;
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
/** a contents list of the level-two headings, placed before the first one */
function withContents(html: string): string {
	const items = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(
		([, id, text]) => `<li><a href="#${id}">${text}</a></li>`
	);
	if (!items.length) return html;
	const toc = `<nav class="toc" aria-label="Contents"><strong>Contents</strong><ol>${items.join('')}</ol></nav>`;
	return html.replace('<h2', () => `${toc}<h2`);
}

for (const name of docs) {
	const body = await render(sourcePath(name), sources[name]!);
	emit(
		`${name}.html`,
		page({
			title: `${titles[name]} - Drupflare`,
			description: SUMMARY[name]!,
			current: name,
			hero: '',
			body: name === REPORT ? withContents(body) : body,
			titles
		})
	);
}
highlighter.dispose();

for (const asset of ['CNAME', 'drupflare.ico', 'drupflare.png', 'drupflare_128.png'])
	cpSync(join(root, 'docs', asset), join(out, asset));
cpSync(join(root, 'scripts/docs/render.js'), join(out, 'render.js'));

const broken = brokenLinks();
if (broken.length) throw new Error(`broken docs links:\n${broken.join('\n')}`);

console.log(`docs site: wrote ${written.join(', ')}`);
