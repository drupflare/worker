/**
 * Builds the media page the spool rig measures on a claimed site.
 *
 *   bun scripts/measure/spool-fixture.ts --url=http://localhost:8791 --pass=<admin password>
 *     [--user=admin] [--image=photo.png] [--video=clip.mp4] [--out=fixture.json]
 *
 * An image and a video go in through Drupal's own media forms, so they are stored and served the way
 * an editor's files are, and a Basic page then carries both beside a YouTube embed. Both rig arms get
 * the same page, so a difference between them is spool's. Prints `{ pages, image, video }`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const arg = (name: string, fallback?: string): string => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	const value = hit ? hit.slice(name.length + 3) : fallback;
	if (value === undefined) throw new Error(`pass --${name}=`);
	return value;
};

const base = arg('url').replace(/\/$/, '');
const user = arg('user', 'admin');
const pass = arg('pass');
const imageFile = arg('image', '/tmp/spool-fixture/photo.png');
const videoFile = arg('video', '/tmp/spool-fixture/clip.mp4');
const out = arg('out', '');
const embedId = arg('embed', 'dQw4w9WgXcQ');

async function login(page: Page): Promise<void> {
	await page.goto(`${base}/user/login`);
	await page.locator('#edit-name').fill(user);
	await page.locator('#edit-pass').fill(pass);
	await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);
	if (page.url().includes('/user/login')) throw new Error('login did not leave the form');
}

/** uploads one file through a media type's add form and returns the public path Drupal stored it at */
async function addMedia(page: Page, type: 'image' | 'video', file: string): Promise<string> {
	await page.goto(`${base}/media/add/${type}`);
	const input = page.locator('input[type="file"]').first();
	await input.setInputFiles(file);
	// the upload runs over ajax and replaces the widget with the stored file's link
	await page.locator('input[name$="_remove_button"]').first().waitFor({ timeout: 120_000 });
	const alt = page.locator('input[name$="[alt]"]');
	if (await alt.count()) await alt.first().fill('Spool rig fixture image');
	const name = page.locator('#edit-name-0-value');
	if (await name.count()) if (!(await name.inputValue())) await name.fill(`Spool ${type}`);
	await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);
	return storedPath(file);
}

/**
 * Where Drupal put an upload: `public://<year>-<month>/<name>`, with `_0`, `_1` suffixes for a repeat
 * name. The media pages have no public URL, so each candidate is fetched and the one whose byte
 * length equals the file's is the stored copy.
 */
async function storedPath(file: string): Promise<string> {
	const bytes = readFileSync(file).length;
	const slash = file.lastIndexOf('/');
	const name = file.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const month = new Date().toISOString().slice(0, 7);
	const names = [
		name,
		...[0, 1, 2, 3, 4, 5].map((n) => `${name.slice(0, dot)}_${n}${name.slice(dot)}`)
	];
	for (const candidate of names) {
		const path = `/sites/default/files/${month}/${candidate}`;
		const res = await fetch(base + path, { headers: { accept: 'image/png,video/mp4,*/*' } });
		const got = (await res.arrayBuffer()).byteLength;
		if (res.ok && got === bytes) return path;
	}
	throw new Error(`no stored copy of ${name} with ${bytes} bytes under ${month}`);
}

/** creates a Basic page whose body is raw HTML in the Full HTML format and returns its path */
async function addPage(page: Page, title: string, html: string): Promise<string> {
	await page.goto(`${base}/node/add/page`);
	await page.locator('#edit-title-0-value').fill(title);
	await page.locator('.ck-editor__editable').waitFor();
	const format = page.locator('select[name="body[0][format]"]');
	if (await format.count()) await format.first().selectOption('full_html');
	await page.waitForTimeout(1500);
	await page.evaluate((h) => {
		const el = document.querySelector('.ck-editor__editable') as
			(HTMLElement & { ckeditorInstance?: { setData(d: string): void } }) | null;
		el?.ckeditorInstance?.setData(h);
	}, html);
	await Promise.all([
		page.waitForURL(/\/node\/\d+(\?|$)/, { timeout: 60_000 }),
		page.locator('#edit-submit').click()
	]);
	return new URL(page.url()).pathname;
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
try {
	await login(page);
	const image = await addMedia(page, 'image', imageFile);
	const video = await addMedia(page, 'video', videoFile);
	const img = `<p><img src="${image}" width="1200" height="630" alt="Spool rig fixture image"></p>`;
	const vid = `<p><video controls width="640" height="360"><source src="${video}" type="video/mp4"></video></p>`;
	const emb = `<p><iframe width="560" height="315" src="https://www.youtube.com/embed/${embedId}" title="Embed" allowfullscreen></iframe></p>`;
	/** the three features alone and together, so a difference between arms can be attributed */
	const specs: [string, string, string][] = [
		['all', 'Spool media all', img + vid + emb],
		['image', 'Spool media image', img],
		['video', 'Spool media video', vid],
		['embed', 'Spool media embed', emb]
	];
	const pages: Record<string, string> = {};
	for (const [key, title, html] of specs) {
		pages[key] = await addPage(page, title, `<p>${title}.</p>${html}`);
	}
	const result = { pages, image, video };
	if (out) writeFileSync(out, JSON.stringify(result));
	console.log(JSON.stringify(result));
} finally {
	await browser.close();
}
