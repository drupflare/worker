import {
	CLIENT_TAG_ATTR,
	clientTag,
	GATE_ATTR,
	gateTag,
	injectClientTag
} from '@drupflare/spool/protocol';
import { Buffer } from 'node:buffer';
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	armConfig,
	articleBody,
	ARTICLES,
	chooseClick,
	cookieHeaderOf,
	cookieNamesOf,
	deviceCounts,
	deviceShape,
	devicesTable,
	EMBED_SRC,
	formDefaults,
	jarWith,
	localHrefs,
	mediaCarried,
	mediaMarkup,
	mediaRewritten,
	navClassOf,
	navRowOf,
	navRowsOf,
	p50Ratio,
	percentile,
	phaseSummary,
	rigClip,
	rigPng,
	serverRequests,
	sideBySide,
	siteFilePaths,
	spoolTagOf,
	spread,
	tierOf,
	timingGroups,
	timingStats,
	timingTable,
	urlClass,
	workerRequests,
	type ArmResult,
	type DeviceResult,
	type DevicesResult,
	type NavEntry,
	type NavRow,
	type Sent,
	type ServerCount
} from '../../scripts/measure/spool-deployed';

const PAGE = '<html><head><title>t</title></head><body><p>text</p></body></html>';

describe('the spool tag check', () => {
	it('reads the gate and the client script the library writes', () => {
		const gate = gateTag({ src: '/.spool/1.0.0/client.js', lease: 86400 }, 'var g=1;');
		const client = clientTag({ src: '/.spool/1.0.0/client.js' });
		expect(gate).toContain(GATE_ATTR);
		expect(client).toContain(CLIENT_TAG_ATTR);
		expect(spoolTagOf(injectClientTag(PAGE, gate))).toBe('gate');
		expect(spoolTagOf(injectClientTag(PAGE, client))).toBe('client');
	});

	it('answers none for a plain page and for prose that names the attribute', () => {
		expect(spoolTagOf(PAGE)).toBe('none');
		expect(spoolTagOf(`<p>the ${GATE_ATTR} and ${CLIENT_TAG_ATTR} attributes</p>`)).toBe(
			'none'
		);
	});

	it('is not fooled by a gate whose source names the client attribute', () => {
		const gate = gateTag({ src: '/.spool/1.0.0/client.js' }, `var a='${CLIENT_TAG_ATTR}';`);
		expect(spoolTagOf(injectClientTag(PAGE, gate))).toBe('gate');
	});
});

describe('url classes and spread', () => {
	it('names documents, spool files, assets and the pages a service worker fetches', () => {
		expect(urlClass('/node/1', 'document')).toBe('document');
		expect(urlClass('/spool-sw.js', 'script')).toBe('spool script');
		expect(urlClass('/.spool/1.0.0/client.js', 'script')).toBe('spool script');
		expect(urlClass('/.spool/sync', 'fetch')).toBe('spool endpoint');
		expect(urlClass('/agg/a1.css', 'stylesheet')).toBe('asset');
		expect(urlClass('/node/2', 'fetch')).toBe('page fetch');
		expect(urlClass('/node/2', 'other')).toBe('other');
	});

	it('takes the nearest rank, and a spread of nothing is zero', () => {
		expect(percentile([], 50)).toBe(0);
		expect(percentile([5, 1, 9, 3, 7], 50)).toBe(5);
		expect(spread([])).toEqual({ n: 0, p50: 0, p90: 0, p99: 0, max: 0 });
		expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
			n: 10,
			p50: 5,
			p90: 9,
			p99: 10,
			max: 10
		});
	});

	it('keeps only the tier headers, sorted, with the prefix cut', () => {
		expect(tierOf({ 'X-Cfw-Edge': 'HIT', 'x-cfw-cache': 'MEM', server: 'x' })).toBe(
			'cache=MEM edge=HIT'
		);
		expect(tierOf({})).toBe('');
	});
});

describe('phase counting from recorded events', () => {
	const sent: Sent[] = [
		{ phase: 'first view', cls: 'document', path: '/', from: 'page' },
		{ phase: 'first view', cls: 'asset', path: '/a.css', from: 'page' },
		{ phase: 'in-page views', cls: 'document', path: '/node/1', from: 'page' },
		{ phase: 'in-page views', cls: 'document', path: '/node/2', from: 'page', local: true },
		{ phase: 'in-page views', cls: 'page fetch', path: '/node/3', from: 'worker' }
	];

	it('counts what reached the network and keeps device answers apart', () => {
		expect(phaseSummary(sent, 'first view')).toEqual({
			total: 2,
			documents: 1,
			local: 0,
			byClass: { document: 1, asset: 1 }
		});
		expect(phaseSummary(sent, 'in-page views')).toEqual({
			total: 2,
			documents: 1,
			local: 1,
			byClass: { document: 1, 'page fetch': 1 }
		});
	});

	it('counts nothing for a phase with no events', () => {
		expect(phaseSummary(sent, 'reload')).toEqual({
			total: 0,
			documents: 0,
			local: 0,
			byClass: {}
		});
	});

	it('puts two arms side by side, one line per phase', () => {
		const arm = (name: 'on' | 'off', s: Sent[], decorated: boolean): ArmResult => ({
			arm: name,
			worker: 'w',
			windows: [],
			sent: s,
			session: {},
			cpuFetch: [
				{
					path: '/',
					status: 200,
					decorated,
					tag: decorated ? 'gate' : 'none',
					artifact: decorated,
					ms: 1
				}
			],
			invocations: {},
			truncated: []
		});
		const lines = sideBySide(arm('on', sent, true), arm('off', [], false));
		expect(lines).toHaveLength(6);
		expect(lines[2]).toBe('in-page views | 1 / 1 / 2 | 0 / 0 / 0');
		expect(lines[5]).toContain('1 of 1 (gate) | 0 of 1 (none)');
	});
});

describe('worker requests per device', () => {
	const page = (phase: Sent['phase'], path: string, extra: Partial<Sent> = {}): Sent => ({
		phase,
		cls: 'document',
		path,
		from: 'page',
		...extra
	});
	const device = (views: number, sent: Sent[]): DeviceResult => ({ views, sent, session: {} });

	it('counts documents, page fetches and endpoints, and leaves assets and spool scripts out', () => {
		const sent: Sent[] = [
			page('first view', '/'),
			{ phase: 'first view', cls: 'asset', path: '/a.css', from: 'page' },
			{ phase: 'in-page views', cls: 'spool script', path: '/spool-sw.js', from: 'worker' },
			page('in-page views', '/node/1', { local: true }),
			{ phase: 'in-page views', cls: 'page fetch', path: '/node/1', from: 'worker' },
			{ phase: 'in-page views', cls: 'spool endpoint', path: '/.spool/sync', from: 'worker' }
		];
		expect(workerRequests(sent, 'first view').total).toBe(1);
		expect(workerRequests(sent, 'in-page views')).toEqual({
			total: 2,
			byClass: { 'page fetch': 1, 'spool endpoint': 1 }
		});
	});

	it('shapes a device of n views as the first view and n minus one clicks', () => {
		expect(deviceShape(1)).toEqual({ clicks: 0, reloads: 0 });
		expect(deviceShape(20)).toEqual({ clicks: 19, reloads: 0 });
	});

	it('splits a device into its visit and its returning view', () => {
		const d = device(2, [
			page('first view', '/'),
			page('in-page views', '/node/1'),
			page('repeat visit', '/')
		]);
		expect(deviceCounts(d)).toMatchObject({ visit: 2, back: 1 });
	});

	// worker requests of the visit measured on a local wrangler dev, n=1 per cell, same site
	const MEASURED_ON = new Map([
		[1, 1],
		[2, 2],
		[3, 3],
		[5, 4],
		[10, 7],
		[20, 11],
		[100, 11]
	]);

	it('keeps the measured on arm at or under one Worker request per view', () => {
		for (const [views, requests] of MEASURED_ON) expect(requests).toBeLessThanOrEqual(views);
	});

	it('fails a trace that fetches page copies ahead of the visitor', () => {
		const ahead = device(2, [
			page('first view', '/'),
			page('in-page views', '/node/1'),
			...Array.from({ length: 9 }, (_, i): Sent => ({
				phase: 'in-page views',
				cls: 'page fetch',
				path: `/node/${i + 2}`,
				from: 'worker'
			}))
		]);
		expect(deviceCounts(ahead).visit).toBeGreaterThan(ahead.views);
	});

	it('prints on minus off for the visit and for the visit with a return', () => {
		const on: DevicesResult = {
			arm: 'on',
			base: 'b',
			devices: [device(2, [page('first view', '/'), page('in-page views', '/node/1')])]
		};
		const off: DevicesResult = {
			arm: 'off',
			base: 'b',
			devices: [
				device(2, [
					page('first view', '/'),
					page('in-page views', '/node/1'),
					page('repeat visit', '/')
				])
			]
		};
		expect(devicesTable(on, off)[1]).toBe('2 | 2 / 3 | 2 / 2 | 0 / -1 | document 2');
	});
});

describe('media articles and the server log count', () => {
	const sent = (cls: string, path: string): Sent => ({
		phase: 'in-page views',
		cls,
		path,
		from: 'worker'
	});

	it('counts a public file and the artifact request as Worker requests', () => {
		expect(urlClass('/sites/default/files/2026-11/rig-image.png', 'image')).toBe('site file');
		expect(urlClass('/sites/default/files/2026-11/rig-clip.mp4', 'media')).toBe('site file');
		expect(urlClass('/.spool/artifact', 'fetch')).toBe('spool artifact');
		expect(urlClass('/core/misc/druplicon.png', 'image')).toBe('asset');
		const trace = [
			sent('site file', '/sites/default/files/a.png'),
			sent('spool artifact', '/.spool/artifact'),
			sent('asset', '/core/misc/druplicon.png')
		];
		expect(workerRequests(trace, 'in-page views')).toEqual({
			total: 2,
			byClass: { 'site file': 1, 'spool artifact': 1 }
		});
	});

	it('finds the three elements in a media article and none in a text article', () => {
		const files = { image: '/sites/default/files/2026-11/rig-image.png', clip: '/c.mp4' };
		const media = `<div>${articleBody(0)}${mediaMarkup(0, files)}</div>`;
		expect(mediaCarried(media)).toEqual({ img: 1, video: 1, iframe: 1 });
		expect(mediaCarried(`<div>${articleBody(0)}</div>`)).toEqual({
			img: 0,
			video: 0,
			iframe: 0
		});
		expect(media).toContain(EMBED_SRC);
		expect(media).toContain(files.image);
	});

	it('tells a rewritten media page from the markup the site wrote', () => {
		const files = { image: '/i.png', clip: '/c.mp4' };
		const written = mediaMarkup(0, files);
		const rewritten = written
			.replace('<video ', '<video preload="none" ')
			.replace('<iframe ', '<iframe srcdoc="<b>facade</b>" ');
		expect(mediaRewritten(written)).toEqual({ preloadNone: 0, facade: 0 });
		expect(mediaRewritten(rewritten)).toEqual({ preloadNone: 1, facade: 1 });
	});

	it('reads the public file paths of a page once each', () => {
		const html =
			'<img src="/sites/default/files/2026-11/a.png"><a href="/sites/default/files/2026-11/a.png">a</a><img src="/core/x.png">';
		expect(siteFilePaths(html)).toEqual(['/sites/default/files/2026-11/a.png']);
		expect(siteFilePaths('<p>none</p>')).toEqual([]);
	});

	it('makes a PNG that decodes and clears the 4 KiB conversion floor', () => {
		const png = Buffer.from(rigPng());
		expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
		expect(png.length).toBeGreaterThan(4096);
		let at = 8;
		const types: string[] = [];
		const idat: Buffer[] = [];
		while (at < png.length) {
			const size = png.readUInt32BE(at);
			const type = png.toString('ascii', at + 4, at + 8);
			const data = png.subarray(at + 8, at + 8 + size);
			expect(png.readUInt32BE(at + 8 + size)).toBe(
				crc32(png.subarray(at + 4, at + 8 + size))
			);
			types.push(type);
			if (type === 'IDAT') idat.push(data);
			at += 12 + size;
		}
		expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
		expect(png.readUInt32BE(16)).toBe(96);
		expect(png.readUInt32BE(20)).toBe(64);
		expect(inflateSync(Buffer.concat(idat)).length).toBe(64 * (1 + 96 * 3));
	});

	it('makes the same PNG every time and carries a real clip', () => {
		expect(Buffer.from(rigPng()).equals(Buffer.from(rigPng()))).toBe(true);
		const clip = Buffer.from(rigClip());
		expect(clip.length).toBe(2441);
		expect(clip.toString('ascii', 4, 8)).toBe('ftyp');
		expect(clip.includes(Buffer.from('mdat'))).toBe(true);
	});

	const log = [
		'[wrangler:info] GET /user/login 200 OK (27ms)',
		'[wrangler:info] GET /__rig-mark 404 Not Found (6ms)',
		'[wrangler:info] GET / 200 OK (9ms)',
		'[wrangler:info] GET /agg/a1.css 200 OK (2ms)',
		'[wrangler:info] GET /sites/default/files/2026-11/rig-image.png 200 OK (4ms)',
		'[wrangler:info] GET /__rig-mark 404 Not Found (5ms)',
		'[wrangler:info] GET /node/2 200 OK (9ms)',
		'[wrangler:info] GET /.spool/artifact 200 OK (3ms)',
		'[wrangler:info] GET /spool-sw.js 200 OK (1ms)',
		'[wrangler:info] GET /.spool/sync 200 OK (3ms)',
		'cfw-fill { page: "/x" }',
		'[wrangler:info] GET /__rig-mark 404 Not Found (5ms)',
		'[wrangler:info] GET /after 200 OK (9ms)'
	].join('\n');

	it('cuts a server log into one segment per device and drops static assets', () => {
		expect(serverRequests(log, [1, 3])).toEqual([
			{ views: 1, total: 2, byClass: { page: 1, 'site file': 1 } },
			{
				views: 3,
				total: 3,
				byClass: { page: 1, 'spool artifact': 1, 'spool endpoint': 1 }
			}
		]);
	});

	it('counts nothing before the first marker or after the last, and nothing without markers', () => {
		expect(serverRequests(log, [1, 3]).reduce((n, d) => n + d.total, 0)).toBe(5);
		expect(serverRequests('[wrangler:info] GET / 200 OK (1ms)', [1])).toEqual([]);
	});

	it('adds the server columns only when both arms carry them', () => {
		const device = (): DeviceResult => ({ views: 1, sent: [], session: {} });
		const one = (total: number): ServerCount[] => [
			{ views: 1, total, byClass: { page: total } }
		];
		const on: DevicesResult = { arm: 'on', base: 'b', devices: [device()], server: one(2) };
		const off: DevicesResult = { arm: 'off', base: 'b', devices: [device()], server: one(3) };
		expect(devicesTable(on, off)[0]).toContain('server log off, on');
		expect(devicesTable(on, off)[1]).toContain(' | 3, 2 | page 2');
		const bare = devicesTable({ ...on, server: undefined }, off);
		expect(bare[0]).not.toContain('server log');
	});
});

describe('click navigation timing', () => {
	const doc = (local?: true): Sent => ({
		phase: 'in-page views',
		cls: 'document',
		path: '/node/1',
		from: 'page',
		...(local === true ? { local } : {})
	});
	const row = (cls: NavRow['cls'], ms: number): NavRow => ({
		phase: 'in-page views',
		path: '/node/1',
		cls,
		responseStart: ms,
		responseEnd: ms + 1,
		domContentLoadedEventEnd: ms + 2,
		loadEventEnd: ms + 3,
		wallMs: ms + 10
	});
	const rows = (cls: NavRow['cls'], from: number, n: number): NavRow[] =>
		Array.from({ length: n }, (_, i) => row(cls, from + i));

	it('tags a navigation by who answered it', () => {
		expect(navClassOf([doc()])).toBe('network');
		expect(navClassOf([doc(true)])).toBe('device');
		expect(navClassOf([doc(true), { ...doc(), path: '/x' }])).toBe('network');
		expect(
			navClassOf([{ phase: 'in-page views', cls: 'asset', path: '/a.css', from: 'page' }])
		).toBeUndefined();
	});

	it('reads offsets from the entry start and drops an entry that never finished loading', () => {
		const entry: NavEntry = {
			name: 'http://127.0.0.1:1/node/4',
			startTime: 100,
			responseStart: 112.34,
			responseEnd: 120,
			domContentLoadedEventEnd: 150,
			loadEventEnd: 180.06
		};
		expect(navRowOf(entry, 'device', 'in-page views', 77)).toEqual({
			phase: 'in-page views',
			path: '/node/4',
			cls: 'device',
			responseStart: 12.3,
			responseEnd: 20,
			domContentLoadedEventEnd: 50,
			loadEventEnd: 80.1,
			wallMs: 77
		});
		expect(
			navRowOf({ ...entry, loadEventEnd: 0 }, 'device', 'in-page views', 1)
		).toBeUndefined();
		expect(navRowOf(null, 'network', 'in-page views', 1)).toBeUndefined();
	});

	it('takes n, min, p50, p90 and max of one class and metric', () => {
		const all = [...rows('network', 1, 10), ...rows('device', 100, 3)];
		expect(timingStats(all, 'network', 'responseStart')).toEqual({
			n: 10,
			min: 1,
			p50: 5,
			p90: 9,
			max: 10
		});
		expect(timingStats(all, 'device', 'wallMs')).toEqual({
			n: 3,
			min: 110,
			p50: 111,
			p90: 112,
			max: 112
		});
		expect(timingStats([], 'device', 'wallMs').n).toBe(0);
	});

	it('divides the p50s and refuses a ratio under twenty samples', () => {
		expect(p50Ratio({ n: 30, p50: 50 }, { n: 25, p50: 10 })).toBe('5.00 (n 30 over n 25)');
		expect(p50Ratio({ n: 19, p50: 50 }, { n: 25, p50: 10 })).toContain('n/a');
		expect(p50Ratio({ n: 30, p50: 50 }, { n: 1, p50: 10 })).toContain('n/a');
	});

	it('prints the arms and the ratios, and the swapped class tag changes the ratio', () => {
		const on = {
			arm: 'on' as const,
			rows: [...rows('network', 40, 20), ...rows('device', 10, 98)]
		};
		const off = { arm: 'off' as const, rows: rows('network', 40, 99) };
		const lines = timingTable([on, off]);
		expect(lines[0]).toContain('arm | class | metric');
		expect(lines).toContain('on | device | responseStart | 98 | 10.0 | 58.0 | 98.0 | 107.0');
		expect(lines.some((l) => l.startsWith('off | device'))).toBe(false);
		expect(lines).toContain(
			'ratio responseStart on: network over device p50 0.84 (n 20 over n 98)'
		);
		expect(lines).toContain(
			'ratio responseStart across arms: off network over on device p50 1.53 (n 99 over n 98)'
		);
		const swapped = {
			arm: 'on' as const,
			rows: on.rows.map((r): NavRow => ({
				...r,
				cls: r.cls === 'network' ? 'device' : 'network'
			}))
		};
		expect(timingTable([swapped, off])).not.toEqual(lines);
		expect(timingTable([swapped, off])).toContain(
			'ratio responseStart on: network over device p50 1.18 (n 98 over n 20)'
		);
	});

	it('pools files of the same arm and reads rows from an arm result and from devices', () => {
		const session = (n: number): Record<string, unknown> => ({
			navigations: rows('device', 1, n)
		});
		const arm = (n: number): ArmResult => ({
			arm: 'on',
			worker: 'w',
			windows: [],
			sent: [],
			session: session(n),
			cpuFetch: [],
			invocations: {},
			truncated: []
		});
		const dev: DevicesResult = {
			arm: 'off',
			base: 'b',
			devices: [
				{ views: 2, sent: [], session: session(2) },
				{ views: 3, sent: [], session: session(3) }
			]
		};
		expect(navRowsOf(arm(4))).toHaveLength(4);
		expect(navRowsOf(dev)).toHaveLength(5);
		const groups = timingGroups([arm(4), arm(6), dev]);
		expect(groups.map((g) => [g.arm, g.rows.length])).toEqual([
			['on', 10],
			['off', 5]
		]);
		expect(timingGroups([{ ...arm(1), session: {} }])).toEqual([]);
	});
});

describe('the click path', () => {
	const front = ['/', '/user/login', '/node?page=1', '/node/10', '/node/9', '/node/2'];

	it('goes from the front page to the articles in numeric order and wraps', () => {
		expect(chooseClick(front, '/', 0)).toBe('/node/2');
		expect(chooseClick(front, '/', 1)).toBe('/node/9');
		expect(chooseClick(front, '/', 2)).toBe('/node/10');
		expect(chooseClick(front, '/', 3)).toBe('/node/2');
	});

	it('goes from an article to the home link', () => {
		expect(chooseClick(['/', '/node/9'], '/node/9', 5)).toBe('/');
	});

	it('answers undefined when the page lists no target', () => {
		expect(chooseClick(['/', '/user/login', '/node?page=1'], '/', 0)).toBeUndefined();
		expect(chooseClick(['/node/9'], '/node/9', 0)).toBeUndefined();
	});

	it('keeps the same-origin paths of a page and drops fragments and other origins', () => {
		const links = [
			'#main-content',
			'/',
			'/node/1',
			'/node/1',
			'../user/register',
			'https://www.drupal.org/community',
			'http://127.0.0.1:8791/user/login?x=1',
			'mailto:a@example.test'
		];
		expect(localHrefs(links, 'http://127.0.0.1:8791/node/9')).toEqual([
			'/',
			'/node/1',
			'/user/register',
			'/user/login?x=1'
		]);
	});
});

describe('forms and cookies', () => {
	const form = `
		<form>
		<input type="hidden" name="form_build_id" value="form-a&amp;b"/>
		<input type="text" name="title[0][value]" value="">
		<input type="checkbox" name="status[value]" value="1" checked="checked"/>
		<input type="checkbox" name="promote[value]" value="1"/>
		<input type="radio" name="mode" value="0"><input type="radio" name="mode" value="1" checked>
		<textarea name="body[0][value]" rows="9">hello &lt;b&gt;</textarea>
		<select name="body[0][format]"><option value="basic_html">B</option><option value="full_html" selected="selected">F</option></select>
		<select name="menu"><option value="main:">m</option><option value="x">x</option></select>
		<input type="submit" name="op" value="Save"/>
		</form>`;

	it('reads the fields a browser would submit and none it would not', () => {
		expect(formDefaults(form)).toEqual({
			form_build_id: 'form-a&b',
			'title[0][value]': '',
			'status[value]': '1',
			mode: '1',
			'body[0][value]': 'hello <b>',
			'body[0][format]': 'full_html',
			menu: 'main:'
		});
	});

	it('keeps the latest value of each cookie and drops an emptied one', () => {
		let jar = new Map<string, string>();
		jar = jarWith(jar, ['SESS1=aaa; path=/; HttpOnly', 'other=1; path=/']);
		jar = jarWith(jar, ['SESS1=bbb; path=/']);
		expect(cookieHeaderOf(jar)).toBe('SESS1=bbb; other=1');
		jar = jarWith(jar, ['other=deleted; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0']);
		expect(cookieHeaderOf(jar)).toBe('SESS1=bbb');
		expect(cookieHeaderOf(new Map())).toBeUndefined();
	});

	it('names cookies without their values', () => {
		expect(cookieNamesOf(['SESS1=secret; path=/', 'b=2'])).toEqual(['SESS1', 'b']);
	});
});

describe('the seeded content', () => {
	it('gives every article a distinct body and keeps the count within one front page', () => {
		const bodies = new Set(Array.from({ length: 10 }, (_, i) => articleBody(i)));
		expect(bodies.size).toBe(10);
		expect(ARTICLES).toBeGreaterThan(0);
		expect(ARTICLES).toBeLessThanOrEqual(10);
		expect(articleBody(0)).not.toContain('—');
	});

	it('leaves SPOOL unset on the on arm and zero on the off arm', () => {
		const vars = (arm: 'on' | 'off') =>
			(armConfig(arm, 'cfw-spool-d-x', '/r') as { vars: Record<string, string> }).vars;
		expect(vars('on')['SPOOL']).toBeUndefined();
		expect(vars('off')['SPOOL']).toBe('0');
	});
});
