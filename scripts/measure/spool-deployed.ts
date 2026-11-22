/**
 * Drives one deployed Drupal worker through a fixed browser session and a plain fetch loop, and
 * reads what the platform recorded for it.
 *
 * ```sh
 * bun scripts/measure/spool-deployed.ts --dry
 * bun scripts/measure/spool-deployed.ts --deployed --account=student --arm=on --name=cfw-spool-d-0a1b2c --out=on.json
 * bun scripts/measure/spool-deployed.ts --deployed --account=student --arm=off --name=cfw-spool-d-3d4e5f --out=off.json
 * bun scripts/measure/spool-deployed.ts --compare on.json off.json
 * ```
 *
 * The two arms deploy the same throwaway config and differ only in `SPOOL`. Before either is
 * measured the rig claims the site, creates an Article content type and a handful of published,
 * promoted articles over plain HTTP, logs out, and checks that `/` and an article answer 200 with a
 * cacheable response, so the session meets pages spool can keep. A session is one Chromium: a first
 * view of `/`, link clicks between the front page and the articles, document reloads, then a repeat
 * visit after the context is closed and reopened on the same profile directory. The browser counts
 * requests that reached the network, from the page by the DevTools network events (a copy answered
 * from the service worker or the HTTP cache is not counted) and from the service worker by
 * Playwright's worker network events. The platform side is Workers Observability events per
 * window, which carry the `cpuTime` of each invocation and its outcome. The plain fetch loop reads
 * the same pages with no cookie, so each answer is a decorated page on the on arm and a plain one on
 * the off arm.
 *
 * `--local --base=<url> --arm=on|off --out=<file>` runs the same preparation, session and fetch loop
 * against a `wrangler dev` of the arm's config and skips Observability. `--latency=<ms>` adds that
 * much latency to every request the browser makes (Chromium, no bandwidth limit).
 *
 * Every click navigation also records the browser's navigation timing and the wall time from the
 * click to the load state, tagged by who answered it: the network or the service worker alone.
 * `--timing` prints n, min, p50, p90 and max per arm and class, and `--compare --timing a.json
 * b.json` prints the same table from saved files, pooling files of the same arm.
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium, firefox, type BrowserContext, type Page } from 'playwright';
import { RIG_CLIP_MP4_BASE64 } from '../../tests/fixtures/spool-rig-media';
import { OBSERVABILITY_INGEST_LAG_MS } from './bench';
import {
	childEnv,
	diffIsEmpty,
	inventoryDiff,
	paidCredentials,
	queryEventsRaw,
	readInventory,
	redact,
	studentCredentials,
	throwawayConfig,
	type Deps,
	type Inventory,
	type RunContext
} from './headlines';

/** the phases of the browser session, in order */
export const PHASES = ['first view', 'in-page views', 'reload', 'repeat visit'] as const;

/** a phase name */
export type Phase = (typeof PHASES)[number];

const sized = (name: string, fallback: number): number => {
	const n = Number(process.env[name]);
	return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** how many link clicks the in-page phase makes; `SPOOL_RIG_CLICKS` sets it for a larger session */
export const CLICKS = sized('SPOOL_RIG_CLICKS', 20);

/** how many document reloads the reload phase makes; `SPOOL_RIG_RELOADS` sets it */
export const RELOADS = sized('SPOOL_RIG_RELOADS', 1);

/** plain fetches per arm in the cpu loop; `SPOOL_RIG_FETCHES` sets it */
export const CPU_FETCHES = sized('SPOOL_RIG_FETCHES', 50);

/** how many articles the rig creates; `SPOOL_RIG_ARTICLES` sets it, and the front page lists ten */
export const ARTICLES = Math.min(sized('SPOOL_RIG_ARTICLES', 8), 10);

/** how many clicks and reloads one device's visit makes; the defaults are the fixed session */
export type DeviceShape = { clicks: number; reloads: number };

/** the shape of the fixed session, from `SPOOL_RIG_CLICKS` and `SPOOL_RIG_RELOADS` */
export const FIXED_SHAPE: DeviceShape = { clicks: CLICKS, reloads: RELOADS };

/** the shape of a device that makes `views` views in one visit: the first view and a click for each other */
export const deviceShape = (views: number): DeviceShape => ({
	clicks: Math.max(0, views - 1),
	reloads: 0
});

/** the request headers of a browser navigation to a page, which a plain fetch does not send */
export const NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
	accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'sec-fetch-dest': 'document',
	'sec-fetch-mode': 'navigate',
	'sec-fetch-site': 'none',
	'sec-fetch-user': '?1',
	'upgrade-insecure-requests': '1'
};

/** which spool tag a document carries: the inline gate, the client script tag, or neither */
export type SpoolTag = 'gate' | 'client' | 'none';

/**
 * The spool tag in a page's HTML. Both are attributes on a script element the library writes
 * (`GATE_ATTR` and `CLIENT_TAG_ATTR` in its tag module), so the match is an opening script tag and
 * not the bare string, which the gate's own source also contains.
 */
export function spoolTagOf(html: string): SpoolTag {
	if (/<script\b[^>]*\sdata-spool-gate\b/i.test(html)) return 'gate';
	if (/<script\b[^>]*\sdata-spool-client\b/i.test(html)) return 'client';
	return 'none';
}

/**
 * The same-origin paths of the `href` attributes of the page at `pageUrl`, in order, once each. A
 * link that only moves within the page (`#main-content`) is not a navigation and is left out.
 */
export function localHrefs(hrefs: readonly string[], pageUrl: string): string[] {
	const seen = new Set<string>();
	const origin = new URL(pageUrl).origin;
	for (const raw of hrefs) {
		if (raw.startsWith('#')) continue;
		let url: URL;
		try {
			url = new URL(raw, pageUrl);
		} catch {
			continue;
		}
		if (url.origin !== origin) continue;
		seen.add(`${url.pathname}${url.search}`);
	}
	return [...seen];
}

/** the path of an article page, `/node/<id>` with nothing after it */
export const ARTICLE_PATH = /^\/node\/\d+$/;

/**
 * Where the next click goes. From the front page it is the article after the last one visited, in
 * numeric order and wrapping; from an article it is the home link. Undefined when the page lists
 * nothing to click, which the session counts as a miss.
 */
export function chooseClick(
	hrefs: readonly string[],
	here: string,
	visits: number
): string | undefined {
	if (ARTICLE_PATH.test(here)) return hrefs.includes('/') ? '/' : undefined;
	const articles = hrefs
		.filter((h) => ARTICLE_PATH.test(h))
		.sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
	if (articles.length === 0) return undefined;
	return articles[visits % articles.length];
}

/** the `name=value` pairs a browser would submit for a form's untouched fields */
export function formDefaults(html: string): Record<string, string> {
	const out: Record<string, string> = {};
	const attr = (tag: string, name: string): string | undefined =>
		new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];
	const decode = (v: string) =>
		v
			.replace(/&quot;/g, '"')
			.replace(/&#039;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&');
	for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
		const tag = m[0];
		const name = attr(tag, 'name');
		if (name === undefined) continue;
		const type = (attr(tag, 'type') ?? 'text').toLowerCase();
		if (['submit', 'button', 'image', 'file', 'reset'].includes(type)) continue;
		if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/i.test(tag)) continue;
		out[name] = decode(attr(tag, 'value') ?? (type === 'checkbox' ? 'on' : ''));
	}
	for (const m of html.matchAll(
		/<textarea\b[^>]*\sname="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/gi
	)) {
		out[m[1] as string] = decode(m[2] as string);
	}
	for (const m of html.matchAll(/<select\b[^>]*\sname="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
		const options = [...(m[2] as string).matchAll(/<option\b[^>]*>/gi)].map((o) => o[0]);
		const chosen = options.find((o) => /\sselected\b/i.test(o)) ?? options[0];
		if (chosen !== undefined) out[m[1] as string] = decode(attr(chosen, 'value') ?? '');
	}
	return out;
}

/** the cookie names a `Set-Cookie` list sets, for a log line that must not print values */
export function cookieNamesOf(setCookies: readonly string[]): string[] {
	return setCookies.map((c) => c.split('=')[0]?.trim() ?? '').filter((n) => n !== '');
}

/** a cookie jar: the latest value of each name a `Set-Cookie` list sets, and the header that sends them */
export function jarWith(
	jar: ReadonlyMap<string, string>,
	setCookies: readonly string[]
): Map<string, string> {
	const next = new Map(jar);
	for (const line of setCookies) {
		const pair = line.split(';')[0] ?? '';
		const at = pair.indexOf('=');
		if (at <= 0) continue;
		const name = pair.slice(0, at).trim();
		const value = pair.slice(at + 1).trim();
		if (value === '' || /;\s*max-age=0\b/i.test(line)) next.delete(name);
		else next.set(name, value);
	}
	return next;
}

/** the `Cookie` header for a jar, or undefined for an empty one */
export function cookieHeaderOf(jar: ReadonlyMap<string, string>): string | undefined {
	return jar.size === 0 ? undefined : [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** whether the articles carry an image and a video, which change a page's body on its way to a device; `SPOOL_RIG_MEDIA=1` */
export const MEDIA = process.env['SPOOL_RIG_MEDIA'] === '1';

/** which browser engine drives the session; `SPOOL_RIG_BROWSER=firefox` selects Firefox */
export const ENGINE: 'chromium' | 'firefox' =
	process.env['SPOOL_RIG_BROWSER'] === 'firefox' ? 'firefox' : 'chromium';

/** the public file paths the media articles point at, from the files the rig uploaded */
export type RigFiles = { image: string; clip: string };

/** the embed address a media article carries; the facade rewrite reads it and never fetches it */
export const EMBED_SRC = 'https://www.youtube.com/embed/dQw4w9WgXcQ';

/**
 * The markup `SPOOL_RIG_MEDIA` appends to an article: an image and a video that are public files
 * the site serves, and an embed iframe whose address is a tag only.
 */
export function mediaMarkup(i: number, files: RigFiles): string {
	return [
		`<p><img src="${files.image}" alt="rig image ${i + 1}" width="96" height="64"></p>`,
		`<p><video src="${files.clip}" controls width="320" height="180"></video></p>`,
		`<p><iframe src="${EMBED_SRC}" title="rig embed ${i + 1}" width="320" height="180"></iframe></p>`
	].join('\n');
}

/** how many image, video and iframe elements a page's HTML carries */
export function mediaCarried(html: string): { img: number; video: number; iframe: number } {
	const count = (tag: string) => html.match(new RegExp(`<${tag}\\b`, 'gi'))?.length ?? 0;
	return { img: count('img'), video: count('video'), iframe: count('iframe') };
}

/** how many videos carry `preload="none"` and how many iframes carry a `srcdoc` facade, which only spool writes */
export function mediaRewritten(html: string): { preloadNone: number; facade: number } {
	return {
		preloadNone: html.match(/<video\b[^>]*\spreload="none"/gi)?.length ?? 0,
		facade: html.match(/<iframe\b[^>]*\ssrcdoc=/gi)?.length ?? 0
	};
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
	let c = 0xffffffff;
	for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

/**
 * A decodable PNG of 96 by 64 pixels: a gradient with a little seeded noise, so it is over the 4 KiB
 * floor under which the proxy leaves an image alone and still compresses to a smaller WebP.
 */
export function rigPng(): Uint8Array {
	const width = 96;
	const height = 64;
	const raw = Buffer.alloc(height * (1 + width * 3));
	let seed = 0x2545f491;
	let at = 0;
	for (let y = 0; y < height; y++) {
		raw[at++] = 0;
		for (let x = 0; x < width; x++) {
			for (let c = 0; c < 3; c++) {
				seed ^= seed << 13;
				seed ^= seed >>> 17;
				seed ^= seed << 5;
				raw[at++] = (x * 2 + y + c * 40 + ((seed >>> 0) % 24)) & 0xff;
			}
		}
	}
	const chunk = (type: string, data: Uint8Array): Buffer => {
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		out.write(type, 4, 'ascii');
		out.set(data, 8);
		out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', new Uint8Array(0))
	]);
}

/** the clip the media articles carry */
export const rigClip = (): Uint8Array => Buffer.from(RIG_CLIP_MP4_BASE64, 'base64');

/** the body text of article `i`, distinct from every other article's */
export function articleBody(i: number): string {
	const topics = [
		'harvest records',
		'irrigation schedules',
		'soil samples',
		'seed inventory',
		'equipment logs',
		'field notes',
		'market prices',
		'weather summaries',
		'crop rotation',
		'pest scouting'
	];
	const topic = topics[i % topics.length] as string;
	return [
		`<p>Article ${i + 1} covers ${topic} for the season, written for the front page of the rig site.</p>`,
		`<p>The first paragraph of article ${i + 1} sets out what the ${topic} show and why a reader would open this page.</p>`,
		`<p>The closing paragraph of article ${i + 1} links the ${topic} to the other articles on the site.</p>`
	].join('\n');
}

/** the requests of one phase: the total, the documents among them, and the count of each class */
export function phaseSummary(
	sent: readonly Sent[],
	phase: Phase
): { total: number; documents: number; local: number; byClass: Record<string, number> } {
	const byClass: Record<string, number> = {};
	let documents = 0;
	let total = 0;
	let local = 0;
	for (const s of sent) {
		if (s.phase !== phase) continue;
		if (s.local) {
			local++;
			continue;
		}
		total++;
		if (s.cls === 'document') documents++;
		byClass[s.cls] = (byClass[s.cls] ?? 0) + 1;
	}
	return { total, documents, local, byClass };
}

/**
 * The requests of one phase that invoke the Worker: network documents, the pages and spool
 * endpoints the service worker fetches, and anything unclassified. The spool scripts and the
 * assets are the static tier and are not counted.
 */
export function workerRequests(
	sent: readonly Sent[],
	phase: Phase
): { total: number; byClass: Record<string, number> } {
	const byClass: Record<string, number> = {};
	let total = 0;
	for (const s of sent) {
		if (s.phase !== phase || s.local) continue;
		if (s.cls === 'asset' || s.cls === 'spool script') continue;
		total++;
		byClass[s.cls] = (byClass[s.cls] ?? 0) + 1;
	}
	return { total, byClass };
}

/** the class a url is counted under */
export function urlClass(path: string, type: string): string {
	if (type === 'document') return 'document';
	if (path === '/.spool/artifact') return 'spool artifact';
	if (/^\/sites\/[^/]+\/files\//.test(path)) return 'site file';
	const spoolOwn = path === '/spool-sw.js' || path.startsWith('/.spool/');
	if ((type === 'fetch' || type === 'xhr') && !/\.[a-z0-9]+$/i.test(path) && !spoolOwn)
		return 'page fetch';
	if (path === '/spool-sw.js' || /^\/\.spool\/[^/]+\/[^/]+\.js$/.test(path))
		return 'spool script';
	if (path.startsWith('/.spool/')) return 'spool endpoint';
	if (/\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)$/.test(path)) return 'asset';
	return 'other';
}

/** nearest-rank percentile of a list, 0 for an empty one */
export function percentile(xs: readonly number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
}

/** n, p50, p90, p99 and max of a list, in the unit of its values */
export function spread(xs: readonly number[]): {
	n: number;
	p50: number;
	p90: number;
	p99: number;
	max: number;
} {
	return {
		n: xs.length,
		p50: percentile(xs, 50),
		p90: percentile(xs, 90),
		p99: percentile(xs, 99),
		max: xs.length === 0 ? 0 : Math.max(...xs)
	};
}

/** one request the browser sent to the origin */
export type Sent = {
	phase: Phase;
	cls: string;
	path: string;
	from: 'page' | 'worker';
	/** the `x-cfw-*` tier headers of a document answer, joined, when the browser read them */
	tier?: string;
	/** a document the service worker answered from the device; it never reached the network */
	local?: true;
};

/** the response headers that say which tier answered a document, `name=value` joined */
export function tierOf(headers: Record<string, string>): string {
	return Object.entries(headers)
		.map(([k, v]) => [k.toLowerCase(), v] as const)
		.filter(([k]) => k === 'x-cfw-cache' || k === 'x-cfw-edge' || k === 'x-cfw-do-cache')
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([k, v]) => `${k.slice(6)}=${v}`)
		.join(' ');
}

/** one invocation read from Observability */
export type Invocation = {
	at: number;
	model: 'stateless' | 'durableObject';
	type: string;
	path: string;
	cpuMs: number;
	wallMs: number;
	outcome: string;
};

/** the invocations in a raw events response, with the request path where the event carries one */
export function invocationsOf(body: any, model: Invocation['model']): Invocation[] {
	const events = body?.result?.events?.events ?? [];
	const out: Invocation[] = [];
	for (const e of events) {
		const w = e?.$workers;
		if (!w || typeof w.cpuTimeMs !== 'number') continue;
		const url = w.event?.request?.url;
		let path = '';
		if (typeof url === 'string') {
			try {
				path = new URL(url).pathname;
			} catch {
				path = '';
			}
		}
		out.push({
			at: typeof e.timestamp === 'number' ? e.timestamp : 0,
			model,
			type: String(w.eventType ?? ''),
			path,
			cpuMs: w.cpuTimeMs,
			wallMs: typeof w.wallTimeMs === 'number' ? w.wallTimeMs : 0,
			outcome: String(w.outcome ?? 'unknown')
		});
	}
	return out;
}

/** a window of the run, in epoch milliseconds, named for the report */
export type Window = { name: string; from: number; to: number };

/** what one arm leaves behind */
export type ArmResult = {
	arm: 'on' | 'off';
	worker: string;
	windows: Window[];
	sent: Sent[];
	session: Record<string, unknown>;
	cpuFetch: {
		path: string;
		status: number;
		decorated: boolean;
		tag: SpoolTag;
		artifact: boolean;
		ms: number;
	}[];
	invocations: Record<string, Invocation[]>;
	truncated: string[];
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** the profile directory outlives the context so a repeat visit keeps its storage */
async function openContext(dir: string): Promise<BrowserContext> {
	const engine = ENGINE === 'firefox' ? firefox : chromium;
	// a dead proxy fails every request to another host at once, so an embed address is never fetched
	return engine.launchPersistentContext(dir, {
		headless: true,
		...(MEDIA ? { proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost' } } : {})
	});
}

/** watches a page and its service worker, and appends each request that reached the network */
async function watch(
	context: BrowserContext,
	base: string,
	sent: Sent[],
	phase: () => Phase
): Promise<void> {
	const host = new URL(base).host;
	context.on('request', (request) => {
		const url = new URL(request.url());
		if (url.host !== host || request.serviceWorker() === null) return;
		sent.push({
			phase: phase(),
			cls: urlClass(url.pathname, request.resourceType()),
			path: url.pathname,
			from: 'worker'
		});
	});
	const hookWithoutCdp = (page: Page) => {
		page.on('response', (r) => {
			const url = new URL(r.url());
			if (url.host !== host) return;
			const cls = urlClass(url.pathname, r.request().resourceType());
			if (r.fromServiceWorker()) {
				if (cls === 'document') {
					sent.push({
						phase: phase(),
						cls,
						path: url.pathname,
						from: 'page',
						local: true
					});
				}
				return;
			}
			sent.push({
				phase: phase(),
				cls,
				path: url.pathname,
				from: 'page',
				...(cls === 'document' ? { tier: tierOf(r.headers()) } : {})
			});
		});
	};
	const hook = async (page: Page) => {
		if (ENGINE !== 'chromium') return hookWithoutCdp(page);
		const cdp = await context.newCDPSession(page);
		await cdp.send('Network.enable');
		const types = new Map<string, string>();
		const cached = new Set<string>();
		cdp.on('Network.requestWillBeSent', (e: any) => types.set(e.requestId, e.type ?? ''));
		cdp.on('Network.requestServedFromCache', (e: any) => cached.add(e.requestId));
		cdp.on('Network.responseReceived', (e: any) => {
			const url = new URL(e.response.url);
			if (url.host !== host) return;
			const r = e.response;
			const cls = urlClass(
				url.pathname,
				String(e.type ?? types.get(e.requestId) ?? '').toLowerCase()
			);
			if (r.fromServiceWorker && cls === 'document') {
				sent.push({ phase: phase(), cls, path: url.pathname, from: 'page', local: true });
				return;
			}
			if (r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache) return;
			if (cached.has(e.requestId)) return;
			sent.push({
				phase: phase(),
				cls,
				path: url.pathname,
				from: 'page',
				...(cls === 'document' ? { tier: tierOf(r.headers ?? {}) } : {})
			});
		});
	};
	context.on('page', (page) => void hook(page));
	for (const page of context.pages()) await hook(page);
}

/** adds `ms` of latency to every request the page makes, with no bandwidth limit; Chromium only */
async function emulateLatency(context: BrowserContext, page: Page, ms: number): Promise<void> {
	if (ms <= 0 || ENGINE !== 'chromium') return;
	const cdp = await context.newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('Network.emulateNetworkConditions', {
		offline: false,
		latency: ms,
		downloadThroughput: -1,
		uploadThroughput: -1
	});
}

/** page expressions as text, because the scripts program has no DOM types */
const IN_PAGE = {
	controlled: `'serviceWorker' in navigator ? !!navigator.serviceWorker.controller : null`,
	tag: `document.querySelector('script[data-spool-gate]') ? 'gate' : document.querySelector('script[data-spool-client]') ? 'client' : 'none'`,
	marker: `window.__rig === 1`,
	setMarker: `void (window.__rig = 1)`
};

/** the waits around each window; a local run needs none, since no platform clock is read */
export type Pace = { before: number; after: number };

/** the waits a deployed run keeps so each window holds only its own invocations */
export const DEPLOYED_PACE: Pace = { before: 8_000, after: 3_000 };

/** the longest a click may take to reach its target before it counts as a miss */
const CLICK_TIMEOUT_MS = 8_000;

/** the pause after a navigation lands, so its late requests are counted before the next click */
const CLICK_FLOOR_MS = 120;

/** one click of the in-page phase, as the session recorded it */
export type ClickRecord = {
	from: string;
	want: string;
	reached: string;
	documents: number;
	local: number;
	requests: number;
};

/** who answered a navigation: a document that reached the network, or the service worker alone */
export type NavClass = 'network' | 'device';

/** the browser's own timing of one click navigation, in ms from its start, and the wall time to load */
export type NavRow = {
	phase: Phase;
	path: string;
	cls: NavClass;
	responseStart: number;
	responseEnd: number;
	domContentLoadedEventEnd: number;
	loadEventEnd: number;
	wallMs: number;
};

/** the timing metrics a row carries, in table order */
export const NAV_METRICS = [
	'responseStart',
	'responseEnd',
	'domContentLoadedEventEnd',
	'loadEventEnd',
	'wallMs'
] as const;

/** a timing metric name */
export type NavMetric = (typeof NAV_METRICS)[number];

/** the fewest samples a figure may be quoted from */
export const MIN_QUOTE_N = 20;

/**
 * Who answered the navigation whose requests are `mine`. A document at the origin means the
 * network answered; a document the service worker answered with no network document means the
 * device did. Undefined when neither was seen, as for a copy the HTTP cache answered.
 */
export function navClassOf(mine: readonly Sent[]): NavClass | undefined {
	if (mine.some((s) => s.cls === 'document' && s.local !== true)) return 'network';
	if (mine.some((s) => s.cls === 'document' && s.local === true)) return 'device';
	return undefined;
}

/** one navigation timing entry as the page reports it */
export type NavEntry = {
	name: string;
	startTime: number;
	responseStart: number;
	responseEnd: number;
	domContentLoadedEventEnd: number;
	loadEventEnd: number;
};

/** the page expression that reads the navigation entry */
const NAV_TIMING = `(() => { const e = performance.getEntriesByType('navigation')[0]; return e ? { name: e.name, startTime: e.startTime, responseStart: e.responseStart, responseEnd: e.responseEnd, domContentLoadedEventEnd: e.domContentLoadedEventEnd, loadEventEnd: e.loadEventEnd } : null; })()`;

/** a row from a navigation entry, offsets taken from its start; undefined when the load never finished */
export function navRowOf(
	entry: NavEntry | null,
	cls: NavClass,
	phase: Phase,
	wallMs: number
): NavRow | undefined {
	if (entry === null || entry.loadEventEnd <= 0) return undefined;
	const rel = (v: number) => Math.round((v - entry.startTime) * 10) / 10;
	return {
		phase,
		path: new URL(entry.name).pathname,
		cls,
		responseStart: rel(entry.responseStart),
		responseEnd: rel(entry.responseEnd),
		domContentLoadedEventEnd: rel(entry.domContentLoadedEventEnd),
		loadEventEnd: rel(entry.loadEventEnd),
		wallMs
	};
}

/** the session's facts; the browser saw these apart from the requests it counted */
export type SessionFacts = Record<string, unknown>;

/** the front page and the articles a session moves between, from the paths the rig created */
export type SessionSite = { articles: string[] };

/** the fixed session; returns what the browser saw, apart from the requests it counted */
export async function runSession(
	base: string,
	site: SessionSite,
	sent: Sent[],
	windows: Window[],
	log: (s: string) => void,
	pace: Pace = DEPLOYED_PACE,
	shape: DeviceShape = FIXED_SHAPE,
	latencyMs = 0
): Promise<SessionFacts> {
	const profile = mkdtempSync(join(tmpdir(), 'spool-session-'));
	let current: Phase = 'first view';
	const facts: SessionFacts = {};
	const mark = async (phase: Phase, run: () => Promise<void>) => {
		current = phase;
		await sleep(pace.before);
		const from = Date.now() - 1_000;
		await run();
		await sleep(pace.after);
		windows.push({ name: phase, from, to: Date.now() + 1_000 });
		const s = phaseSummary(sent, phase);
		log(
			`phase ${phase}: ${s.total} requests to the origin, ${s.documents} documents, ${s.local} documents answered on the device`
		);
	};
	const controlled = (page: Page) => page.evaluate<boolean | null>(IN_PAGE.controlled);
	const tagOf = (page: Page) => page.evaluate<SpoolTag>(IN_PAGE.tag);
	const untilControlled = async (page: Page, ms: number): Promise<number | null> => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			if (await controlled(page)) return Date.now() - t0;
			await sleep(100);
		}
		return null;
	};
	const visit = async (page: Page, key: string) => {
		const res = await page.goto(`${base}/`, { waitUntil: 'load' });
		const took = await untilControlled(page, 6_000);
		await sleep(1_000);
		facts[`controlledAfter${key}`] = await controlled(page);
		facts[`controlledAfter${key}Ms`] = took;
		facts[`tag${key}`] = await tagOf(page);
		facts[`tier${key}`] = tierOf(((await res?.allHeaders()) ?? {}) as Record<string, string>);
		log(
			`${key}: controlled ${String(facts[`controlledAfter${key}`])} (after ${String(took)} ms), tag ${String(facts[`tag${key}`])}, tier ${String(facts[`tier${key}`])}`
		);
	};
	let context = await openContext(profile);
	try {
		await watch(context, base, sent, () => current);
		let page = context.pages()[0] ?? (await context.newPage());
		await emulateLatency(context, page, latencyMs);
		await mark('first view', () => visit(page, 'FirstView'));
		await mark('in-page views', async () => {
			await page.evaluate(IN_PAGE.setMarker);
			const clicks: ClickRecord[] = [];
			const navigations: NavRow[] = [];
			let untagged = 0;
			const misses: string[] = [];
			let visits = 0;
			let markerLost = 0;
			for (let i = 0; i < shape.clicks; i++) {
				const here = new URL(page.url()).pathname;
				const hrefs = localHrefs(
					await page.$$eval('a[href]', (as) =>
						as.map((a) => a.getAttribute('href') ?? '')
					),
					page.url()
				);
				const want = chooseClick(hrefs, here, visits);
				if (want === undefined) {
					misses.push(
						`click ${i + 1} on ${here}: no target among ${hrefs.length} links: ${hrefs.slice(0, 40).join(' ')}`
					);
					continue;
				}
				const seen0 = sent.length;
				const link = page.locator(`a[href="${want}"]:visible`).first();
				if ((await link.count()) === 0) {
					misses.push(`click ${i + 1} on ${here}: ${want} is listed but not visible`);
					continue;
				}
				const t0 = Date.now();
				await link.click();
				try {
					await page.waitForURL((u) => u.pathname === want, {
						waitUntil: 'load',
						timeout: CLICK_TIMEOUT_MS
					});
				} catch {
					misses.push(`click ${i + 1} on ${here}: ${want} not reached, at ${page.url()}`);
					continue;
				}
				const wallMs = Date.now() - t0;
				await sleep(CLICK_FLOOR_MS);
				if (ARTICLE_PATH.test(want)) visits++;
				const mine = sent.slice(seen0);
				const cls = navClassOf(mine);
				const entry = await page.evaluate<NavEntry | null>(NAV_TIMING).catch(() => null);
				const row =
					cls === undefined || entry === null || new URL(entry.name).pathname !== want
						? undefined
						: navRowOf(entry, cls, 'in-page views', wallMs);
				if (row === undefined) untagged++;
				else navigations.push(row);
				const kept = await page.evaluate<boolean>(IN_PAGE.marker).catch(() => false);
				if (!kept) {
					markerLost++;
					await page.evaluate(IN_PAGE.setMarker);
				}
				clicks.push({
					from: here,
					want,
					reached: new URL(page.url()).pathname,
					documents: mine.filter((s) => s.cls === 'document' && !s.local).length,
					local: mine.filter((s) => s.local).length,
					requests: mine.filter((s) => !s.local).length
				});
			}
			facts.navigations = navigations;
			facts.navUntimed = untagged;
			facts.latencyMs = latencyMs;
			facts.markerLostClicks = markerLost;
			facts.documentClicks = clicks.flatMap((c, i) => (c.documents > 0 ? [i + 1] : []));
			facts.clicks = clicks.length;
			facts.clickMisses = misses.length;
			facts.clickMissDetail = misses.slice(0, 5);
			facts.clickDocuments = clicks.reduce((n, c) => n + c.documents, 0);
			facts.clickLocalDocuments = clicks.reduce((n, c) => n + c.local, 0);
			facts.clicksWithDocument = clicks.filter((c) => c.documents > 0).length;
			facts.clickPaths = clicks.map((c) => c.reached);
			facts.pathAfterClicks = new URL(page.url()).pathname;
			facts.controlledAfterClicks = await controlled(page);
			log(
				`clicks ${clicks.length}, misses ${misses.length}, network documents ${String(facts.clickDocuments)} (clicks ${JSON.stringify(facts.documentClicks)}), documents answered on the device ${String(facts.clickLocalDocuments)}, clicks that unloaded the page ${String(markerLost)}, controlled ${String(facts.controlledAfterClicks)}`
			);
			for (const m of misses.slice(0, 5)) log(`miss: ${m}`);
		});
		await mark('reload', async () => {
			facts.reloadPath = new URL(page.url()).pathname;
			for (let i = 0; i < shape.reloads; i++) {
				await page.reload({ waitUntil: 'load' });
				await sleep(300);
			}
			facts.controlledAfterReload = await controlled(page);
			facts.tagReload = await tagOf(page);
		});
		await context.close();
		context = await openContext(profile);
		await watch(context, base, sent, () => current);
		page = context.pages()[0] ?? (await context.newPage());
		await emulateLatency(context, page, latencyMs);
		await mark('repeat visit', () => visit(page, 'Repeat'));
	} finally {
		await context.close().catch(() => undefined);
	}
	return facts;
}

/** the plain fetch loop: no cookie, a browser navigation's headers, one window */
export async function runCpuLoop(
	base: string,
	site: SessionSite,
	windows: Window[],
	log: (s: string) => void,
	pace: Pace = DEPLOYED_PACE
): Promise<ArmResult['cpuFetch']> {
	await sleep(pace.before);
	const from = Date.now() - 1_000;
	const out: ArmResult['cpuFetch'] = [];
	const pages = ['/', ...site.articles];
	for (let i = 0; i < CPU_FETCHES; i++) {
		const path = pages[i % pages.length]!;
		const t0 = Date.now();
		const res = await fetch(`${base}${path}`, { headers: NAVIGATION_HEADERS });
		const body = await res.text();
		if (i < pages.length) log(`probe ${path}: ${describe(res, body)}`);
		out.push({
			path,
			status: res.status,
			decorated: spoolTagOf(body) !== 'none',
			tag: spoolTagOf(body),
			artifact: res.headers.has('spool-artifact'),
			ms: Date.now() - t0
		});
	}
	windows.push({ name: 'fetch loop', from, to: Date.now() + 1_000 });
	log(`fetch loop: ${out.length} requests, ${out.filter((r) => r.decorated).length} decorated`);
	return out;
}

/** one response as a log line: status, size, the tag, and the headers that say whether it is cacheable; no cookie value */
function describe(res: Response, body: string): string {
	const h = (k: string) => res.headers.get(k) ?? '';
	const all: Record<string, string> = {};
	res.headers.forEach((v, k) => (all[k] = v));
	return `${res.status} ${body.length} B, tag ${spoolTagOf(body)}, spool-artifact ${res.headers.has('spool-artifact')}, cache-control "${h('cache-control')}", vary "${h('vary')}", set-cookie names "${cookieNamesOf(res.headers.getSetCookie()).join(' ')}", x-cfw-setup "${h('x-cfw-setup')}", ${tierOf(all)}`;
}

/** polls a public page until it answers 200; the first requests start the migration and answer 503 */
async function ready(base: string, log: (s: string) => void): Promise<void> {
	for (let i = 0; i < 60; i++) {
		const res = await fetch(`${base}/user/login`, { headers: { accept: 'text/html' } });
		await res.text();
		if (res.status === 200) {
			log(`ready after ${i + 1} polls`);
			return;
		}
		await sleep(2_000);
	}
	throw new Error(
		'the site never answered 200 on /user/login; measuring it would measure warming'
	);
}

/** a form-driving HTTP client with a cookie jar, for the rig's own setup requests */
function formClient(base: string) {
	let jar = new Map<string, string>();
	const call = async (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		for (const [k, v] of Object.entries(NAVIGATION_HEADERS)) headers.set(k, v);
		const cookie = cookieHeaderOf(jar);
		if (cookie !== undefined) headers.set('cookie', cookie);
		const res = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
		jar = jarWith(jar, res.headers.getSetCookie());
		return { res, text: await res.text() };
	};
	const getForm = async (path: string) => {
		const got = await call(path);
		if (got.res.status !== 200) throw new Error(`GET ${path} answered ${got.res.status}`);
		return formDefaults(got.text);
	};
	const post = (path: string, fields: Record<string, string>) =>
		call(path, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(fields).toString()
		});
	const postMultipart = (path: string, form: FormData) =>
		call(path, { method: 'POST', body: form });
	return { call, getForm, post, postMultipart };
}

/** the form client the rig's setup requests go through */
type WebClient = ReturnType<typeof formClient>;

/** a field added to the Article type through the field UI */
export type ArticleField = {
	group: string;
	option: string;
	label: string;
	name: string;
	/** values of the settings form to replace; null drops a setting, which unchecks a box */
	settings?: Record<string, string | null>;
};

/** the fields the rig adds: a body, and for media articles an image and a clip */
export const BODY_FIELD: ArticleField = {
	group: 'formatted_text',
	option: 'text_with_summary',
	label: 'Body',
	name: 'body'
};

/** the image field of a media article; the alt text is not required, so one upload step is enough */
export const IMAGE_FIELD: ArticleField = {
	group: 'file_upload',
	option: 'image',
	label: 'Rig image',
	name: 'rig_image',
	settings: { 'settings[alt_field_required]': null }
};

/** the file field of a media article, which takes the clip */
export const CLIP_FIELD: ArticleField = {
	group: 'file_upload',
	option: 'file',
	label: 'Rig clip',
	name: 'rig_clip',
	settings: { 'settings[file_extensions]': 'mp4' }
};

/** adds a field to the Article type: the storage step, then the field's own settings form */
async function addArticleField(web: WebClient, base: string, field: ArticleField): Promise<void> {
	const start = `/admin/structure/types/manage/article/fields/add-field/${field.group}/true?entity_type=node`;
	const first = await web.getForm(start);
	const next = await web.post(start, {
		...first,
		label: field.label,
		field_name: field.name,
		field_options_wrapper: field.option,
		op: 'Continue'
	});
	const where = next.res.headers.get('location');
	if (where === null) {
		throw new Error(`adding field ${field.name} answered ${next.res.status} with no location`);
	}
	const at = new URL(where, base);
	const path = `${at.pathname}${at.search}`;
	const settings = await web.getForm(path);
	for (const [key, value] of Object.entries(field.settings ?? {})) {
		if (value === null) delete settings[key];
		else settings[key] = value;
	}
	const saved = await web.post(path, { ...settings, op: 'Save' });
	if (saved.res.status !== 303) {
		throw new Error(`saving field ${field.name} answered ${saved.res.status}, not a redirect`);
	}
}

/** the public file paths in a page's HTML, once each, in order */
export function siteFilePaths(html: string): string[] {
	const seen = new Set<string>();
	for (const m of html.matchAll(/\/sites\/[^/"'<>\s?]+\/files\/[^"'<>\s?]+/g)) seen.add(m[0]);
	return [...seen];
}

/**
 * Uploads the image and the clip on one unpublished node, through the form a person uses. The
 * image's public path is read from the node's page; the file field renders no link, so the clip
 * sits beside it under its own name. Both are fetched before the articles point their tags at them.
 */
async function uploadRigFiles(web: WebClient, base: string): Promise<RigFiles> {
	const page = await web.call('/node/add/article');
	const form = formDefaults(page.text);
	const inputs = [...page.text.matchAll(/<input\b[^>]*\stype="file"[^>]*>/gi)].map(
		(m) => /\sname="([^"]*)"/i.exec(m[0])?.[1] ?? ''
	);
	const slotFor = (name: string) => inputs.find((n) => n.includes(`field_${name}`));
	const imageSlot = slotFor(IMAGE_FIELD.name);
	const clipSlot = slotFor(CLIP_FIELD.name);
	if (imageSlot === undefined || clipSlot === undefined) {
		throw new Error(
			`the article form has no upload inputs for the media fields: ${inputs.join(' ')}`
		);
	}
	const body = new FormData();
	// an unchecked box is a missing key, and any posted value reads as checked
	delete form['status[value]'];
	delete form['promote[value]'];
	for (const [k, v] of Object.entries({
		...form,
		'title[0][value]': 'Rig Media Files',
		op: 'Save'
	})) {
		body.append(k, v);
	}
	body.append(
		imageSlot,
		new Blob([new Uint8Array(rigPng())], { type: 'image/png' }),
		'rig-image.png'
	);
	body.append(
		clipSlot,
		new Blob([new Uint8Array(rigClip())], { type: 'video/mp4' }),
		'rig-clip.mp4'
	);
	const saved = await web.postMultipart('/node/add/article', body);
	const id = /\/node\/(\d+)/.exec(saved.res.headers.get('location') ?? '')?.[1];
	if (id === undefined) {
		throw new Error(
			`saving the media host node answered ${saved.res.status} with no node location`
		);
	}
	const view = await web.call(`/node/${id}`);
	const image = siteFilePaths(view.text).find((p) => /rig-image[^/]*\.png$/i.test(p));
	if (image === undefined) throw new Error('the media host node page lists no uploaded image');
	const clip = `${image.slice(0, image.lastIndexOf('/'))}/rig-clip.mp4`;
	for (const path of [image, clip]) {
		const res = await fetch(`${base}${path}`);
		await res.arrayBuffer();
		if (res.status !== 200) throw new Error(`the uploaded file ${path} answered ${res.status}`);
	}
	return { image, clip };
}

/** the owner claim; the admin password is chosen here and lives in memory only */
async function claimSite(base: string, adminPass: string, log: (s: string) => void) {
	for (let attempt = 1; attempt <= 8; attempt++) {
		let res: Response;
		let text: string;
		try {
			res = await fetch(`${base}/firstrun`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
				body: JSON.stringify({
					siteName: 'Spool Rig',
					adminName: 'rigadmin',
					adminMail: 'rig@example.test',
					adminPass
				})
			});
			text = await res.text();
		} catch (e) {
			const state = await fetch(`${base}/firstrun`, {
				headers: { 'accept-encoding': 'identity' }
			}).then((r) => r.json() as Promise<{ configured?: boolean }>);
			if (attempt > 1 && state.configured === true) {
				log(
					`claim attempt ${attempt} lost its response (${(e as Error).message}); the site reports itself claimed after an earlier attempt of this run, so the run goes on`
				);
				return;
			}
			throw e;
		}
		if (res.status === 409 && attempt === 1)
			throw new Error('the site is already claimed; the rig needs a fresh one');
		if (res.status === 409) {
			log(`claim attempt ${attempt} answered 409: an earlier attempt of this run claimed it`);
			return;
		}
		let token = '';
		try {
			token = String((JSON.parse(text) as { ownerToken?: unknown }).ownerToken ?? '');
		} catch {
			token = '';
		}
		if (res.status === 200 && token !== '') {
			log(
				`claim answered 200 on attempt ${attempt}; admin password and owner token received (not printed)`
			);
			return;
		}
		log(`claim attempt ${attempt} answered ${res.status}; retrying`);
		await sleep(5_000);
	}
	throw new Error('the claim never answered 200 with an owner token');
}

/**
 * Claims the site, creates an Article content type that promotes to the front page and the
 * articles, logs out, and reads `/` and the first article with no cookie. Returns the article
 * paths. Throws when the pages a session needs are not cacheable HTML with article links.
 */
export async function prepareSite(base: string, log: (s: string) => void): Promise<SessionSite> {
	const adminPass = `rig-${randomUUID()}`;
	await claimSite(base, adminPass, log);
	const web = formClient(base);
	const login = await web.getForm('/user/login');
	const signedIn = await web.post('/user/login', {
		...login,
		name: 'rigadmin',
		pass: adminPass,
		op: 'Log in'
	});
	if (signedIn.res.status !== 302 && signedIn.res.status !== 303) {
		throw new Error(`the admin login answered ${signedIn.res.status}, not a redirect`);
	}
	log('logged in as the admin');
	const typeForm = await web.getForm('/admin/structure/types/add');
	const typed = await web.post('/admin/structure/types/add', {
		...typeForm,
		name: 'Article',
		type: 'article',
		'options[promote]': 'promote',
		op: 'Save'
	});
	log(`created the Article type: ${typed.res.status}`);
	// the type starts with no fields, so a body posted before this step is dropped
	await addArticleField(web, base, BODY_FIELD);
	let files: RigFiles | undefined;
	if (MEDIA) {
		await addArticleField(web, base, IMAGE_FIELD);
		await addArticleField(web, base, CLIP_FIELD);
		files = await uploadRigFiles(web, base);
		log(`uploaded the media files: ${files.image} ${files.clip}`);
	}
	const paths: string[] = [];
	for (let i = 0; i < ARTICLES; i++) {
		const form = await web.getForm('/node/add/article');
		const saved = await web.post('/node/add/article', {
			...form,
			'title[0][value]': `Rig Article ${i + 1}`,
			'field_body[0][value]':
				files === undefined
					? articleBody(i)
					: `${articleBody(i)}\n${mediaMarkup(i, files)}`,
			'field_body[0][format]': files === undefined ? 'basic_html' : 'full_html',
			'promote[value]': '1',
			'status[value]': '1',
			op: 'Save'
		});
		const where = /\/node\/(\d+)/.exec(saved.res.headers.get('location') ?? '')?.[1];
		if (where === undefined) {
			throw new Error(
				`saving article ${i + 1} answered ${saved.res.status} with no node location`
			);
		}
		paths.push(`/node/${where}`);
	}
	log(`created ${paths.length} articles: ${paths.join(' ')}`);
	const out = await web.call('/user/logout');
	const confirm = formDefaults(out.text);
	if (confirm['form_id'] !== undefined)
		await web.post('/user/logout', { ...confirm, op: 'Log out' });
	log('logged out; the session below runs with no cookie');
	for (const path of ['/', paths[0] as string]) {
		const res = await fetch(`${base}${path}`, { headers: NAVIGATION_HEADERS });
		const body = await res.text();
		log(`check ${path}: ${describe(res, body)}`);
		if (path !== '/') {
			const carried = mediaCarried(body);
			log(
				`article carries ${JSON.stringify(carried)}, rewritten ${JSON.stringify(mediaRewritten(body))}, text ${body.includes('Article 1 covers')}`
			);
			if (!body.includes('Article 1 covers')) throw new Error(`${path} lacks its body text`);
			if (
				files !== undefined &&
				!(carried.img > 0 && carried.video > 0 && carried.iframe > 0)
			) {
				throw new Error(
					`${path} lacks an image, a video or an iframe: ${JSON.stringify(carried)}`
				);
			}
		}
		const cc = res.headers.get('cache-control') ?? '';
		if (res.status !== 200 || res.headers.has('x-cfw-setup') || /no-store|private/.test(cc)) {
			throw new Error(`${path} is not a cacheable public page: ${res.status} "${cc}"`);
		}
		if (path === '/') {
			const linked = localHrefs(
				[...body.matchAll(/<a\b[^>]*\shref="([^"]*)"/gi)].map((m) => m[1] as string),
				`${base}/`
			).filter((h) => ARTICLE_PATH.test(h));
			log(`the front page links ${linked.length} articles`);
			if (linked.length < paths.length) {
				throw new Error(
					`the front page links ${linked.length} of ${paths.length} articles`
				);
			}
		}
	}
	for (const path of files === undefined ? [] : [files.image, files.clip]) {
		const res = await fetch(`${base}${path}`, {
			headers: { accept: 'image/webp,image/*;q=0.8' }
		});
		const bytes = new Uint8Array(await res.arrayBuffer());
		log(
			`file ${path}: ${res.status} ${res.headers.get('content-type') ?? ''} ${bytes.length} B`
		);
		if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
	}
	return { articles: paths };
}

/** the browser session and the fetch loop against a prepared site; no platform clock is read */
export async function driveArm(
	base: string,
	log: (s: string) => void,
	pace: Pace,
	latencyMs = 0
): Promise<Pick<ArmResult, 'windows' | 'sent' | 'session' | 'cpuFetch'>> {
	await ready(base, log);
	const site = await prepareSite(base, log);
	const windows: Window[] = [];
	const sent: Sent[] = [];
	const session = await runSession(base, site, sent, windows, log, pace, FIXED_SHAPE, latencyMs);
	const cpuFetch = await runCpuLoop(base, site, windows, log, pace);
	return { windows, sent, session, cpuFetch };
}

/** one device of the views matrix: the views of its visit, what it sent, and what the browser saw */
export type DeviceResult = { views: number; sent: Sent[]; session: SessionFacts };

/** the requests a server log lists between one device's marker and the next, by class */
export type ServerCount = { views: number; total: number; byClass: Record<string, number> };

/** what a set of devices on one arm leaves behind */
export type DevicesResult = {
	arm: 'on' | 'off';
	base: string;
	devices: DeviceResult[];
	/** the same devices counted from the server's request log, which no browser engine can skew */
	server?: ServerCount[];
};

/**
 * Counts the Worker-class requests in a `wrangler dev` log, one segment per device. A segment runs
 * from a `/__rig-mark` line to the next one, so `viewCounts` has one more marker than devices. The
 * log has no request type, so a path with no extension is a `page`; static assets and the spool
 * scripts are left out, as they are in the browser counts.
 */
export function serverRequests(log: string, viewCounts: readonly number[]): ServerCount[] {
	const out: ServerCount[] = [];
	let device = -1;
	for (const line of log.split('\n')) {
		const m = /^\[wrangler:info\] (?:GET|HEAD|POST) (\S+) \d{3}\b/.exec(line);
		if (m === null) continue;
		const path = new URL(m[1] as string, 'http://x').pathname;
		if (path === '/__rig-mark') {
			device++;
			if (device < viewCounts.length) {
				out.push({ views: viewCounts[device] as number, total: 0, byClass: {} });
			}
			continue;
		}
		const open = out[device];
		if (open === undefined || device >= viewCounts.length) continue;
		const cls = urlClass(path, 'fetch');
		if (cls === 'asset' || cls === 'spool script') continue;
		const name = cls === 'page fetch' ? 'page' : cls;
		open.total++;
		open.byClass[name] = (open.byClass[name] ?? 0) + 1;
	}
	return out;
}

/** the Worker requests of a device's visit and of its returning view, each by class */
export function deviceCounts(d: DeviceResult): {
	visit: number;
	back: number;
	byClass: Record<string, number>;
} {
	const byClass: Record<string, number> = {};
	let visit = 0;
	for (const phase of ['first view', 'in-page views', 'reload'] as const) {
		const w = workerRequests(d.sent, phase);
		visit += w.total;
		for (const [k, v] of Object.entries(w.byClass)) byClass[k] = (byClass[k] ?? 0) + v;
	}
	return { visit, back: workerRequests(d.sent, 'repeat visit').total, byClass };
}

/**
 * One fresh device per view count, each in its own browser profile against the same prepared
 * site: a visit of that many views, then a returning view after the browser is closed and
 * reopened. A request to a path the front worker refuses is sent before each device, so the
 * server's own request log can be cut into one segment per device.
 */
export async function driveDevices(
	base: string,
	viewCounts: readonly number[],
	log: (s: string) => void,
	pace: Pace,
	latencyMs = 0
): Promise<DeviceResult[]> {
	await ready(base, log);
	const site = await prepareSite(base, log);
	const devices: DeviceResult[] = [];
	for (const views of viewCounts) {
		await fetch(`${base}/__rig-mark?device=${views}`).then((r) => r.text());
		const sent: Sent[] = [];
		const session = await runSession(
			base,
			site,
			sent,
			[],
			log,
			pace,
			deviceShape(views),
			latencyMs
		);
		const d: DeviceResult = { views, sent, session };
		const c = deviceCounts(d);
		log(
			`device ${views} views: Worker requests in the visit ${c.visit}, returning view ${c.back}, by class ${JSON.stringify(c.byClass)}`
		);
		devices.push(d);
	}
	await fetch(`${base}/__rig-mark?device=end`).then((r) => r.text());
	return devices;
}

/** the two arms' devices side by side: Worker requests of the visit and of the visit with a returning view */
export function devicesTable(on: DevicesResult, off: DevicesResult): string[] {
	const served = on.server !== undefined && off.server !== undefined;
	const lines = [
		`views in the visit | off visit / with return | on visit / with return | on minus off, visit / with return | on classes${served ? ' | server log off, on (visit with return) | server on classes' : ''}`
	];
	for (const d of on.devices) {
		const o = off.devices.find((x) => x.views === d.views);
		const a = deviceCounts(d);
		const b = o === undefined ? undefined : deviceCounts(o);
		const classes = Object.entries(a.byClass)
			.map(([k, v]) => `${k} ${v}`)
			.join(', ');
		const sOn = on.server?.find((x) => x.views === d.views);
		const sOff = off.server?.find((x) => x.views === d.views);
		const extra = served
			? ` | ${sOff?.total ?? 'none'}, ${sOn?.total ?? 'none'} | ${
					Object.entries(sOn?.byClass ?? {})
						.map(([k, v]) => `${k} ${v}`)
						.join(', ') || 'none'
				}`
			: '';
		lines.push(
			`${d.views} | ${b === undefined ? 'none' : `${b.visit} / ${b.visit + b.back}`} | ${a.visit} / ${a.visit + a.back} | ${b === undefined ? 'none' : `${a.visit - b.visit} / ${a.visit + a.back - b.visit - b.back}`} | ${classes || 'none'}${extra}`
		);
	}
	return lines;
}

/** the misses a run may have before it is failed, out of all its clicks */
export const MAX_CLICK_MISSES = 2;

/** drives one arm and reads Observability for each window */
export async function measureArm(ctx: RunContext, arm: 'on' | 'off', out: string): Promise<void> {
	const log = ctx.deps.log;
	const { windows, sent, session, cpuFetch } = await driveArm(ctx.base, log, DEPLOYED_PACE);
	if (Number(session['clickMisses']) > MAX_CLICK_MISSES) {
		throw new Error(
			`${String(session['clickMisses'])} clicks missed their target; the run measured no session`
		);
	}
	log(`waiting ${OBSERVABILITY_INGEST_LAG_MS / 60_000} min for Observability ingest`);
	await sleep(OBSERVABILITY_INGEST_LAG_MS);
	const invocations: Record<string, Invocation[]> = {};
	const truncated: string[] = [];
	for (const w of windows) {
		for (const model of ['stateless', 'durableObject'] as const) {
			let rows: Invocation[] = [];
			let previous = -1;
			for (let attempt = 0; attempt < 6; attempt++) {
				const body = await queryEventsRaw(ctx, model, w.from, w.to);
				rows = invocationsOf(body, model);
				if (rows.length === previous) break;
				previous = rows.length;
				await sleep(60_000);
			}
			if (rows.length >= 1000) truncated.push(`${w.name}/${model}`);
			invocations[`${w.name}|${model}`] = rows;
		}
	}
	const result: ArmResult = {
		arm,
		worker: ctx.name,
		windows,
		sent,
		session,
		cpuFetch,
		invocations,
		truncated
	};
	writeFileSync(out, JSON.stringify(result, null, '\t'));
	log(`wrote ${out}`);
	for (const line of timingTable(timingGroups([result]))) log(line);
}

/** the table of one arm's results, as lines */
export function tableOf(r: ArmResult): string[] {
	const lines: string[] = [`arm ${r.arm}: ${r.worker}`];
	for (const phase of PHASES) {
		const mine = phaseSummary(r.sent, phase);
		const front = r.invocations[`${phase}|stateless`] ?? [];
		const obj = r.invocations[`${phase}|durableObject`] ?? [];
		const classes = Object.entries(mine.byClass).map(([k, v]) => `${k} ${v}`);
		lines.push(
			`${phase}: origin requests ${mine.total}, documents ${mine.documents}, answered on the device ${mine.local} (${classes.join(', ') || 'none'}); worker invocations ${front.length}; object invocations ${obj.length}`
		);
	}
	const facts = r.session;
	lines.push(
		`session: controlled first view ${String(facts['controlledAfterFirstView'])}, tag ${String(facts['tagFirstView'])}; clicks ${String(facts['clicks'])}, misses ${String(facts['clickMisses'])}, network documents from clicks ${String(facts['clickDocuments'])}, answered on the device ${String(facts['clickLocalDocuments'])}; controlled after reload ${String(facts['controlledAfterReload'])}; repeat visit controlled ${String(facts['controlledAfterRepeat'])}, tag ${String(facts['tagRepeat'])}`
	);
	const front = (r.invocations['fetch loop|stateless'] ?? []).filter(
		(i) => i.type === 'fetch' || i.type === ''
	);
	const cpu = front.map((i) => i.cpuMs);
	const s = spread(cpu);
	const failed = front.filter((i) => i.outcome !== 'ok').length;
	lines.push(
		`fetch loop: sent ${r.cpuFetch.length}, decorated ${r.cpuFetch.filter((f) => f.decorated).length}, statuses ${[...new Set(r.cpuFetch.map((f) => f.status))].join('/')}; worker cpuTime ms n ${s.n} p50 ${s.p50} p90 ${s.p90} p99 ${s.p99} max ${s.max}; not ok ${failed}`
	);
	if (r.truncated.length > 0) lines.push(`truncated: ${r.truncated.join(', ')}`);
	return lines;
}

/** the two arms' browser counts side by side, one line per phase, documents and all requests */
export function sideBySide(on: ArmResult, off: ArmResult): string[] {
	const lines = [
		'phase | on network documents / answered on the device / origin requests | off network documents / answered on the device / origin requests'
	];
	for (const phase of PHASES) {
		const a = phaseSummary(on.sent, phase);
		const b = phaseSummary(off.sent, phase);
		lines.push(
			`${phase} | ${a.documents} / ${a.local} / ${a.total} | ${b.documents} / ${b.local} / ${b.total}`
		);
	}
	const tag = (r: ArmResult) => [...new Set(r.cpuFetch.map((f) => f.tag))].join('/') || 'none';
	lines.push(
		`fetch loop decorated | ${on.cpuFetch.filter((f) => f.decorated).length} of ${on.cpuFetch.length} (${tag(on)}) | ${off.cpuFetch.filter((f) => f.decorated).length} of ${off.cpuFetch.length} (${tag(off)})`
	);
	return lines;
}

/** the navigation rows of a result, from an arm session or from every device of a views run */
export function navRowsOf(r: ArmResult | DevicesResult): NavRow[] {
	const rows = (session: SessionFacts): NavRow[] =>
		Array.isArray(session['navigations']) ? (session['navigations'] as NavRow[]) : [];
	return 'devices' in r ? r.devices.flatMap((d) => rows(d.session)) : rows(r.session);
}

/** n, min, p50, p90 and max of one metric over the rows of one class */
export function timingStats(
	rows: readonly NavRow[],
	cls: NavClass,
	metric: NavMetric
): { n: number; min: number; p50: number; p90: number; max: number } {
	const xs = rows.filter((r) => r.cls === cls).map((r) => r[metric]);
	return {
		n: xs.length,
		min: xs.length === 0 ? 0 : Math.min(...xs),
		p50: percentile(xs, 50),
		p90: percentile(xs, 90),
		max: xs.length === 0 ? 0 : Math.max(...xs)
	};
}

/** the ratio of two p50s as text, or `n/a` when either class has fewer than `MIN_QUOTE_N` samples */
export function p50Ratio(
	over: { n: number; p50: number },
	under: { n: number; p50: number }
): string {
	const counts = `n ${over.n} over n ${under.n}`;
	if (over.n < MIN_QUOTE_N || under.n < MIN_QUOTE_N || under.p50 <= 0)
		return `n/a (${counts}, under ${MIN_QUOTE_N} samples)`;
	return `${(over.p50 / under.p50).toFixed(2)} (${counts})`;
}

/** the arms' navigation rows, pooled over every file of the same arm, on first */
export function timingGroups(
	results: readonly (ArmResult | DevicesResult)[]
): { arm: 'on' | 'off'; rows: NavRow[] }[] {
	return (['on', 'off'] as const)
		.map((arm) => ({
			arm,
			rows: results.filter((r) => r.arm === arm).flatMap((r) => navRowsOf(r))
		}))
		.filter((g) => g.rows.length > 0);
}

/**
 * The timing table: per arm, class and metric, n, min, p50, p90 and max in ms, then the ratio of
 * the p50s (network over device) inside each arm and across arms (the off arm's network p50 over
 * the on arm's device p50).
 */
export function timingTable(
	groups: readonly { arm: 'on' | 'off'; rows: readonly NavRow[] }[]
): string[] {
	const f = (v: number) => v.toFixed(1);
	const lines = ['arm | class | metric | n | min | p50 | p90 | max (ms)'];
	for (const g of groups) {
		for (const cls of ['network', 'device'] as const) {
			for (const metric of NAV_METRICS) {
				const s = timingStats(g.rows, cls, metric);
				if (s.n === 0) continue;
				lines.push(
					`${g.arm} | ${cls} | ${metric} | ${s.n} | ${f(s.min)} | ${f(s.p50)} | ${f(s.p90)} | ${f(s.max)}`
				);
			}
		}
	}
	for (const metric of NAV_METRICS) {
		for (const g of groups) {
			lines.push(
				`ratio ${metric} ${g.arm}: network over device p50 ${p50Ratio(timingStats(g.rows, 'network', metric), timingStats(g.rows, 'device', metric))}`
			);
		}
		const on = groups.find((g) => g.arm === 'on');
		const off = groups.find((g) => g.arm === 'off');
		if (on !== undefined && off !== undefined) {
			lines.push(
				`ratio ${metric} across arms: off network over on device p50 ${p50Ratio(timingStats(off.rows, 'network', metric), timingStats(on.rows, 'device', metric))}`
			);
		}
	}
	return lines;
}

/** the throwaway config with the arm's `SPOOL` set; the on arm leaves it unset, as shipped */
export function armConfig(
	arm: 'on' | 'off',
	name: string,
	root: string,
	plan: 'free' | 'paid' = 'free'
): Record<string, unknown> {
	const config = throwawayConfig(name, root) as { vars: Record<string, string> };
	if (arm === 'off') config.vars.SPOOL = '0';
	config.vars.PLAN = plan;
	return config;
}

/** the prefix every worker this script creates carries */
export const OWN_PREFIX = 'cfw-spool-';

const NAME_RE = /^cfw-spool-[dp]-[a-z0-9][a-z0-9-]{0,24}$/;

/** the names in an inventory that carry the script's prefix, on any list */
export function ownNames(inv: Inventory): string[] {
	return [...inv.workers, ...inv.durableObjects, ...inv.kv, ...inv.d1].filter((n) =>
		n.startsWith(OWN_PREFIX)
	);
}

/** an inventory without the names that carry the script's prefix */
export function withoutOwn(inv: Inventory): Inventory {
	const keep = (xs: string[]) => xs.filter((n) => !n.startsWith(OWN_PREFIX));
	return {
		workers: keep(inv.workers),
		durableObjects: keep(inv.durableObjects),
		kv: keep(inv.kv),
		d1: keep(inv.d1)
	};
}

/**
 * Deploys one worker beside whatever other workers the account holds, measures it, and deletes
 * only itself. It refuses when a worker with its own prefix already exists. The inventory check
 * compares the account without its own names before and after, and reports a change to anyone
 * else's workers as a note, since this script did not make it.
 */
export async function deployAlongside(
	name: string,
	arm: 'on' | 'off',
	env: Record<string, string | undefined>,
	deps: Deps,
	root: string,
	account: 'student' | 'paid' = 'student'
): Promise<number> {
	const creds = account === 'paid' ? paidCredentials(env) : studentCredentials(env);
	const cenv = childEnv(env, creds);
	const log = (s: string) => deps.log(redact(s, [creds.id, creds.token]));
	const before = await readInventory(creds, deps.fetch);
	if (ownNames(before).length > 0) {
		log(`refusing: ${ownNames(before).join(', ')} already carry the ${OWN_PREFIX} prefix`);
		return 2;
	}
	log(`inventory at start: ${JSON.stringify(before)}`);
	const dir = mkdtempSync(join(tmpdir(), `spool-deployed-${name}-`));
	const config = join(dir, 'wrangler.jsonc');
	writeFileSync(
		config,
		JSON.stringify(armConfig(arm, name, root, account === 'paid' ? 'paid' : 'free'), null, '\t')
	);
	let code = 0;
	let deployed = false;
	try {
		deployed = true;
		const dep = await deps.run('bunx', ['wrangler', 'deploy', '-c', config], cenv);
		log(dep.out);
		if (dep.code !== 0) throw new Error(`wrangler deploy exited ${dep.code}`);
		const url = new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`).exec(dep.out)?.[0];
		if (!url) throw new Error('no workers.dev url in the deploy output');
		log('waiting 60 s for the object namespace to propagate');
		await deps.sleep(60_000);
		await deps.measure({ name, base: url, creds, deps });
	} catch (e) {
		log(`run failed: ${(e as Error).message}`);
		code = 1;
	} finally {
		if (deployed) {
			const del = await deps.run(
				'bunx',
				['wrangler', 'delete', '--name', name, '--force'],
				cenv
			);
			log(del.out);
			if (del.code !== 0) {
				log(`teardown exited ${del.code}; delete ${name} by hand`);
				code = 1;
			}
		}
		const after = await readInventory(creds, deps.fetch);
		if (ownNames(after).length > 0) {
			log(`still present after teardown: ${ownNames(after).join(', ')}`);
			code = 1;
		}
		const diff = inventoryDiff(withoutOwn(before), withoutOwn(after));
		log(
			`inventory diff without this script's names: ${diffIsEmpty(diff) ? 'none' : `${JSON.stringify(diff)} (another lane's change, not this script's)`}`
		);
	}
	return code;
}

/** one command-line option, or undefined */
const flag = (argv: readonly string[], name: string): string | undefined =>
	argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const root = resolve(import.meta.dirname, '../..');
	const files = argv.slice(1).filter((a) => !a.startsWith('--'));
	const timing = argv.includes('--timing');
	if (argv[0] === '--compare-devices') {
		const results = files.map(
			(file) => JSON.parse(readFileSync(file, 'utf8')) as DevicesResult
		);
		const on = results.find((r) => r.arm === 'on');
		const off = results.find((r) => r.arm === 'off');
		if (on === undefined || off === undefined)
			throw new Error('--compare-devices on.json off.json');
		for (const line of devicesTable(on, off)) console.log(line);
		if (timing) for (const line of timingTable(timingGroups(results))) console.log(line);
	} else if (argv[0] === '--compare') {
		const results = files.map((file) => JSON.parse(readFileSync(file, 'utf8')) as ArmResult);
		if (timing) {
			for (const line of timingTable(timingGroups(results))) console.log(line);
		} else {
			for (const r of results) for (const line of tableOf(r)) console.log(line);
			const on = results.find((r) => r.arm === 'on');
			const off = results.find((r) => r.arm === 'off');
			if (on !== undefined && off !== undefined)
				for (const line of sideBySide(on, off)) console.log(line);
		}
	} else if (argv.includes('--dry')) {
		console.log(JSON.stringify(armConfig('off', 'cfw-spool-d-dry', root), null, '\t'));
		console.log(
			JSON.stringify({
				phases: PHASES,
				clicks: CLICKS,
				reloads: RELOADS,
				articles: ARTICLES,
				cpuFetches: CPU_FETCHES,
				setupRequests: 1 + 1 + 2 + 2 + 2 * ARTICLES + 2 + 2
			})
		);
	} else if (argv.includes('--local')) {
		const arm = flag(argv, 'arm');
		const base = flag(argv, 'base') ?? '';
		const out = flag(argv, 'out') ?? '';
		if (arm !== 'on' && arm !== 'off') throw new Error('--arm=on or --arm=off');
		if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
			throw new Error('--base=http://127.0.0.1:<port> of a local wrangler dev');
		}
		if (out === '') throw new Error('--out=<path>');
		mkdirSync(resolve(out, '..'), { recursive: true });
		const log = (s: string) => console.log(s);
		const latency = Number(flag(argv, 'latency') ?? '0');
		if (!Number.isInteger(latency) || latency < 0) {
			throw new Error('--latency=<ms, a non-negative integer>');
		}
		const counts = (flag(argv, 'devices') ?? '')
			.split(',')
			.filter((s) => s !== '')
			.map(Number);
		if (counts.length > 0) {
			if (!counts.every((n) => Number.isInteger(n) && n > 0)) {
				throw new Error('--devices=<comma list of view counts, each a positive integer>');
			}
			const devices = await driveDevices(
				base,
				counts,
				log,
				{ before: 300, after: 3_000 },
				latency
			);
			const result: DevicesResult = { arm, base, devices };
			const serverLog = flag(argv, 'server-log');
			if (serverLog !== undefined) {
				await sleep(2_000);
				result.server = serverRequests(readFileSync(serverLog, 'utf8'), counts);
			}
			writeFileSync(out, JSON.stringify(result, null, '\t'));
			process.exit(0);
		}
		const done = await driveArm(base, log, { before: 500, after: 500 }, latency);
		const result: ArmResult = {
			arm,
			worker: base,
			...done,
			invocations: {},
			truncated: []
		};
		writeFileSync(out, JSON.stringify(result, null, '\t'));
		for (const line of tableOf(result)) log(line);
		if (timing) for (const line of timingTable(timingGroups([result]))) log(line);
		process.exit(Number(done.session['clickMisses']) > MAX_CLICK_MISSES ? 1 : 0);
	} else {
		const arm = flag(argv, 'arm');
		const name = flag(argv, 'name') ?? '';
		const out = flag(argv, 'out') ?? '';
		const account = flag(argv, 'account');
		if (!argv.includes('--deployed') || (account !== 'student' && account !== 'paid')) {
			throw new Error('say --deployed --account=student or --account=paid');
		}
		if (account === 'paid' && !(Number(flag(argv, 'max-usd')) > 0)) {
			throw new Error('--account=paid needs --max-usd=<the written price cap>');
		}
		if (arm !== 'on' && arm !== 'off') throw new Error('--arm=on or --arm=off');
		if (!NAME_RE.test(name))
			throw new Error('--name=cfw-spool-d-<suffix> or cfw-spool-p-<suffix>');
		if (account === 'paid' && !name.startsWith('cfw-spool-p-')) {
			throw new Error('a paid run uses a cfw-spool-p- name');
		}
		if (out === '') throw new Error('--out=<path>');
		mkdirSync(resolve(out, '..'), { recursive: true });
		const deps: Deps = {
			fetch,
			sleep,
			log: (s) => console.log(s),
			measure: (ctx) => measureArm(ctx, arm, out),
			run: async (cmd, args, env) => {
				const heavy = args.includes('deploy');
				const lock = process.env.DRUPFLARE_HEAVY_LOCK ?? '/tmp/drupflare-heavy.lock';
				while (heavy) {
					try {
						mkdirSync(lock);
						break;
					} catch {
						await sleep(15_000);
					}
				}
				try {
					return await new Promise<{ code: number; out: string }>((res) => {
						const child = spawn(cmd, args, { cwd: root, env });
						let text = '';
						child.stdout.on('data', (d) => (text += d));
						child.stderr.on('data', (d) => (text += d));
						child.on('close', (code) => res({ code: code ?? 1, out: text }));
					});
				} finally {
					if (heavy) rmdirSync(lock);
				}
			}
		};
		process.exit(await deployAlongside(name, arm, process.env, deps, root, account));
	}
}
