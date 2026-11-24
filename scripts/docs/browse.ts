import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadNav, navItems } from './nav';

const root = new URL('../..', import.meta.url).pathname;
const out = resolve(process.argv[2] ?? join(root, 'typedoc'));
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const ACCENT = { light: '#c2540a', dark: '#ff9a3c' };
const failures: string[] = [];
const say = (line: string) => console.log(line);
const expectThat = (ok: boolean, what: string) => {
	if (!ok) failures.push(what);
};

let browser: Browser;
try {
	browser = await chromium.launch();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (!/Executable doesn't exist|playwright install/i.test(message)) throw error;
	say(
		'docs browse skipped: Playwright has no Chromium here; run bunx playwright install chromium'
	);
	process.exit(0);
}

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		let path = decodeURIComponent(new URL(req.url).pathname);
		if (path.endsWith('/')) path += 'index.html';
		const file = Bun.file(join(out, path));
		return (await file.exists())
			? new Response(file)
			: new Response('missing', { status: 404 });
	}
});
const base = `http://localhost:${server.port}`;

const items = navItems(loadNav(root));
const pages = items.flatMap((item) =>
	item.kind === 'page' ? [{ name: item.name!, title: item.entry.title }] : []
);
const file = (name: string) => (name === 'index' ? 'index.html' : `${name}.html`);

async function open(options: {
	width: number;
	scheme?: 'light' | 'dark';
	reducedMotion?: 'reduce';
}) {
	const context = await browser.newContext({
		viewport: { width: options.width, height: 900 },
		colorScheme: options.scheme ?? 'light',
		reducedMotion: options.reducedMotion ?? 'no-preference'
	});
	const page = await context.newPage();
	const errors: string[] = [];
	await page.route(/cdn\.jsdelivr\.net/, (route) => route.abort());
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error' && !/jsdelivr|ERR_FAILED/.test(`${m.text()} ${m.location().url}`))
			errors.push(m.text());
	});
	return { context, page, errors };
}

const overflow = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

async function sidebarPass(context: BrowserContext, page: Page, errors: string[]) {
	for (const { name, title } of pages) {
		errors.length = 0;
		const response = await page.goto(`${base}/${file(name)}`, { waitUntil: 'load' });
		expectThat(response?.status() === 200, `${name}: status ${response?.status()}`);
		const state = await page.evaluate(() => {
			const current = Array.from(document.querySelectorAll('#docs-sidebar a[aria-current]'));
			const link = current[0];
			const box = document.getElementById('docs-sidebar')?.getBoundingClientRect();
			return {
				current: current.length,
				text: link?.firstChild?.textContent ?? '',
				groupOpen: link?.closest('details.docs-group')?.hasAttribute('open') ?? false,
				visible: !!box && box.width > 0 && box.height > 0,
				title: document.title,
				description: document
					.querySelector('meta[name="description"]')
					?.getAttribute('content')
			};
		});
		expectThat(state.current === 1, `${name}: ${state.current} current links in the sidebar`);
		expectThat(
			state.text === title,
			`${name}: current link reads "${state.text}", not "${title}"`
		);
		expectThat(state.groupOpen, `${name}: the group of the current page is closed`);
		expectThat(state.visible, `${name}: the sidebar is not visible at 1280`);
		expectThat(!!state.description, `${name}: no description`);
		expectThat(!(await overflow(page)), `${name}: horizontal overflow at 1280`);
		expectThat(
			errors.length === 0,
			`${name}: ${errors.length} console errors, first ${errors[0]}`
		);
	}
	await context.close();
	say(
		`pages: ${pages.length} visited at 1280 light, sidebar current link, group open, no overflow`
	);
}

async function linkPass() {
	const { context, page } = await open({ width: 1280 });
	let checked = 0;
	let external = 0;
	for (const from of ['index', 'configuration/serving/page-cache', pages.at(-1)!.name]) {
		await page.goto(`${base}/${file(from)}`);
		const links = await page.evaluate(() =>
			Array.from(document.querySelectorAll<HTMLAnchorElement>('#docs-sidebar a[href]')).map(
				(a) => ({
					href: a.href,
					rel: a.rel,
					external: a.classList.contains('docs-ext')
				})
			)
		);
		for (const link of links) {
			if (link.external) {
				external++;
				expectThat(/noopener/.test(link.rel), `${from}: ${link.href} has no rel noopener`);
				continue;
			}
			checked++;
			const status = (await page.request.get(link.href)).status();
			expectThat(status === 200, `${from}: ${link.href} answers ${status}`);
		}
	}
	await context.close();
	say(`sidebar links: ${checked} resolved from 3 pages, ${external} external with rel noopener`);
}

async function behaviourPass() {
	const wide = await open({ width: 1280 });
	await wide.page.goto(`${base}/configuration/runtime.html`);
	const summary = wide.page.locator('#docs-sidebar .docs-group > summary', {
		hasText: /^Security$/
	});
	const group = summary.locator('..');
	await summary.click();
	expectThat(
		await group.evaluate((d: HTMLDetailsElement) => d.open),
		'a closed group does not open'
	);
	await summary.click();
	expectThat(
		await group.evaluate((d: HTMLDetailsElement) => !d.open),
		'an open group does not close'
	);
	await wide.page.goto(`${base}/configuration/runtime.html`);
	await wide.page.keyboard.press('Tab');
	expectThat(
		await wide.page.evaluate(
			() => document.activeElement?.classList.contains('docs-skip') === true
		),
		'the first Tab stop is not the skip link'
	);
	await wide.page.locator('.site .menu summary').first().click();
	expectThat(
		(await wide.page.locator('.site .menu[open] .panel a').count()) > 0,
		'a header menu opens with no links'
	);
	if (shots)
		await wide.page.screenshot({ path: join(shots, 'configuration-runtime-1280-light.png') });
	await wide.context.close();

	const phone = await open({ width: 360 });
	for (const name of ['index', 'configuration/runtime', 'technical-report']) {
		await phone.page.goto(`${base}/${file(name)}`);
		expectThat(!(await overflow(phone.page)), `${name}: horizontal overflow at 360`);
	}
	await phone.page.goto(`${base}/configuration/runtime.html`);
	const shown = () =>
		phone.page.evaluate(() =>
			document.getElementById('docs-sidebar')!.matches(':popover-open')
		);
	expectThat(!(await shown()), 'the drawer is open on load at 360');
	await phone.page.focus('.docs-menu');
	await phone.page.keyboard.press('Enter');
	await phone.page.waitForTimeout(400);
	expectThat(await shown(), 'the Menu button does not open the drawer');
	expectThat(
		await phone.page.locator('#docs-sidebar a[aria-current]').isVisible(),
		'the current link is not visible in the open drawer'
	);
	if (shots) await phone.page.screenshot({ path: join(shots, 'drawer-360.png') });
	await phone.page.keyboard.press('Escape');
	await phone.page.waitForTimeout(400);
	expectThat(!(await shown()), 'Escape does not close the drawer');
	expectThat(
		await phone.page.evaluate(
			() => document.activeElement?.classList.contains('docs-menu') === true
		),
		'focus does not return to the Menu button'
	);
	await phone.context.close();
	say(
		'behaviour: groups toggle, skip link first, header menu opens, drawer opens and closes by keyboard, no overflow at 360'
	);
}

async function schemePass() {
	for (const scheme of ['light', 'dark'] as const) {
		const { context, page } = await open({ width: 1280, scheme });
		await page.goto(`${base}/index.html`);
		const accent = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
		);
		expectThat(accent.toLowerCase() === ACCENT[scheme], `${scheme} accent is ${accent}`);
		if (shots) await page.screenshot({ path: join(shots, `index-1280-${scheme}.png`) });
		await context.close();
	}
	const calm = await open({ width: 360, reducedMotion: 'reduce' });
	await calm.page.goto(`${base}/index.html`);
	const duration = await calm.page.evaluate(
		() => getComputedStyle(document.getElementById('docs-sidebar')!).transitionDuration
	);
	expectThat(
		/^0s(, 0s)*$/.test(duration),
		`the drawer still animates under reduced motion: ${duration}`
	);
	await calm.context.close();
	say('scheme: orange accent in light and dark, no drawer transition under reduced motion');
}

try {
	const first = await open({ width: 1280 });
	await sidebarPass(first.context, first.page, first.errors);
	await linkPass();
	await behaviourPass();
	await schemePass();
} finally {
	await browser.close();
	server.stop(true);
}

say(`docs browse: ${failures.length} failures`);
for (const failure of failures.slice(0, 40)) console.error(failure);
if (failures.length) process.exitCode = 1;
