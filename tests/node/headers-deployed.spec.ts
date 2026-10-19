import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	assetPaths,
	guardArms,
	pairedRequestRatios,
	parseArgs,
	reduceNavigation,
	rotation,
	summarize,
	type CdpEvent,
	type NavRow
} from '../../scripts/measure/headers-deployed';
import {
	pairedEnergy,
	perNavByRound,
	raplReader,
	type EnergyRow
} from '../../scripts/measure/headers-energy';

const sent = (id: string, url: string): CdpEvent => ({
	method: 'Network.requestWillBeSent',
	params: { requestId: id, request: { url } }
});
const got = (id: string, status: number, extra: Record<string, unknown> = {}): CdpEvent => ({
	method: 'Network.responseReceived',
	params: { requestId: id, response: { status, ...extra } }
});
const done = (id: string, bytes: number): CdpEvent => ({
	method: 'Network.loadingFinished',
	params: { requestId: id, encodedDataLength: bytes }
});

describe('reduceNavigation', () => {
	it('counts a 200 and a 304 on the wire', () => {
		const c = reduceNavigation([
			sent('1', 'https://x/'),
			got('1', 200),
			done('1', 5000),
			sent('2', 'https://x/a.css'),
			got('2', 304),
			done('2', 300)
		]);
		expect(c).toMatchObject({ requests: 2, network: 2, net200: 1, net304: 1, cache: 0 });
		expect(c.encodedBytes).toBe(5300);
	});

	it('keeps a disk-cache hit out of the network count and its bytes', () => {
		const c = reduceNavigation([
			sent('1', 'https://x/'),
			got('1', 200),
			done('1', 5000),
			sent('2', 'https://x/a.css'),
			got('2', 200, { fromDiskCache: true }),
			done('2', 9000)
		]);
		expect(c).toMatchObject({
			requests: 2,
			network: 1,
			net200: 1,
			cache: 1,
			encodedBytes: 5000
		});
	});

	it('counts a memory-cache serve as cache', () => {
		const c = reduceNavigation([
			sent('1', 'https://x/b.js'),
			{ method: 'Network.requestServedFromCache', params: { requestId: '1' } },
			got('1', 200)
		]);
		expect(c).toMatchObject({ requests: 1, network: 0, cache: 1 });
	});

	it('excludes data: URLs and their later events', () => {
		const c = reduceNavigation([
			sent('1', 'data:image/png;base64,AAAA'),
			got('1', 200),
			done('1', 99)
		]);
		expect(c).toMatchObject({ requests: 0, network: 0, encodedBytes: 0 });
	});

	it('counts a failed request as network and a 404 as other', () => {
		const c = reduceNavigation([
			sent('1', 'https://x/gone'),
			got('1', 404),
			sent('2', 'https://x/dead'),
			{ method: 'Network.loadingFailed', params: { requestId: '2' } }
		]);
		expect(c).toMatchObject({ network: 2, other: 1, failed: 1 });
	});
});

describe('rotation', () => {
	it('puts every arm first and keeps every order over a full cycle', () => {
		const arms = ['on', 'off', 'idle'];
		const orders = [0, 1, 2].map((r) => rotation(arms, r));
		expect(new Set(orders.map((o) => o[0]))).toEqual(new Set(arms));
		expect(orders.every((o) => [...o].sort().join() === [...arms].sort().join())).toBe(true);
		expect(rotation(arms, 3)).toEqual(arms);
	});

	it('alternates two arms', () => {
		expect(rotation(['on', 'off'], 1)).toEqual(['off', 'on']);
	});
});

const row = (arm: string, round: number, network: number, page = '/', hit = 'HIT'): NavRow => ({
	requests: network,
	network,
	net200: 1,
	net304: network - 1,
	cache: 0,
	other: 0,
	failed: 0,
	encodedBytes: 100 * network,
	urls: [],
	arm,
	round,
	page,
	kind: 'repeat',
	loadMs: 10,
	status: 200,
	headers: { 'x-cfw-cache': hit, 'x-cfw-edge': null, 'x-cfw-plan': null, 'cf-cache-status': null }
});

describe('summarize and pairing', () => {
	const rows = [
		row('on', 0, 1),
		row('on', 0, 1),
		row('on', 0, 3, '/', 'MISS'),
		row('off', 0, 28),
		row('on', 1, 1),
		row('off', 1, 30),
		{ ...row('on', 0, 99), kind: 'cold' as const }
	];

	it('gives median, min, max and n per arm and page, repeats only', () => {
		const on = summarize(rows).find((c) => c.arm === 'on' && c.page === '/');
		expect(on?.network).toEqual({ median: 1, min: 1, max: 3, n: 4 });
		expect(on?.notHit).toBe(1);
	});

	it('pairs rounds, off over on', () => {
		expect(pairedRequestRatios(rows, 'on', 'off')).toEqual([28, 30]);
	});

	it('refuses a round with no control', () => {
		expect(() => pairedRequestRatios([row('on', 0, 1)], 'on', 'off')).toThrow();
	});
});

describe('assetPaths and guardArms', () => {
	const html = (css: string, extra = '') =>
		`<link href="/agg/${css}.css?tok" rel=stylesheet><script src="/agg/j.js"></script><a href="/user/login">x</a>${extra}`;
	const probe = (h: string) => ({ status: 200, cache: 'HIT', html: h });

	it('lists same-origin assets without query and ignores links and external urls', () => {
		expect(assetPaths(html('a', '<script src="https://cdn.example/x.js"></script>'))).toEqual([
			'/agg/a.css',
			'/agg/j.js'
		]);
	});

	it('passes identical arms', () => {
		expect(
			guardArms({ on: { '/': probe(html('a')) }, off: { '/': probe(html('a')) } })
		).toEqual([]);
	});

	it('stops on a different asset set, a miss and a length gap', () => {
		const f = guardArms({
			on: { '/': probe(html('a')) },
			off: { '/': { status: 200, cache: 'MISS', html: html('b', 'z'.repeat(500)) } }
		});
		expect(f.some((x) => x.includes('x-cfw-cache MISS'))).toBe(true);
		expect(f.some((x) => x.includes('asset sets differ'))).toBe(true);
		expect(f.some((x) => x.includes('html length differs'))).toBe(true);
	});
});

describe('parseArgs', () => {
	it('reads arms, counts and pages', () => {
		const o = parseArgs([
			'--arm',
			'on=https://a/',
			'--arm',
			'off=https://b',
			'--rounds',
			'2',
			'--pages',
			'/',
			'/x',
			'--out',
			'o'
		]);
		expect(o).toMatchObject({ rounds: 2, repeats: 20, pages: ['/', '/x'], out: 'o' });
		expect(o.arms).toEqual([
			{ name: 'on', url: 'https://a' },
			{ name: 'off', url: 'https://b' }
		]);
	});

	it('rejects one arm', () => {
		expect(() => parseArgs(['--arm', 'on=https://a', '--out', 'o'])).toThrow();
	});
});

describe('energy arithmetic', () => {
	const e = (
		arm: string,
		round: number,
		pkgJ: number,
		elapsedMs: number,
		navs = 100
	): EnergyRow => ({
		arm,
		round,
		navs: arm === 'idle' ? 0 : navs,
		requests: 0,
		errors: 0,
		elapsedMs,
		pkgJ,
		coreJ: 0,
		load0: 0,
		load1: 0
	});

	it('subtracts the idle floor and divides by navigations', () => {
		const rows = [e('idle', 0, 100, 10000), e('on', 0, 150, 10000), e('off', 0, 200, 10000)];
		const by = perNavByRound(rows);
		expect(by.on?.[0]).toBeCloseTo(0.5);
		expect(by.off?.[0]).toBeCloseTo(1);
	});

	it('pairs off over on per round', () => {
		const rows = [
			e('idle', 0, 100, 10000),
			e('on', 0, 150, 10000),
			e('off', 0, 200, 10000),
			e('idle', 1, 100, 10000),
			e('on', 1, 150, 10000),
			e('off', 1, 250, 10000)
		];
		const p = pairedEnergy(rows, 'on', 'off');
		expect(p.ratios[0]).toBeCloseTo(2);
		expect(p.ratios[1]).toBeCloseTo(3);
		expect(p.median).toBeCloseTo(2.5);
	});

	it('refuses a round without an idle window', () => {
		expect(() => perNavByRound([e('on', 0, 1, 1000)])).toThrow(/no idle/);
	});

	it('reads fixture counters and survives a wrap', () => {
		const dir = mkdtempSync(join(tmpdir(), 'rapl-'));
		mkdirSync(join(dir, 'intel-rapl:0:0'));
		writeFileSync(join(dir, 'max_energy_range_uj'), '1000000');
		writeFileSync(join(dir, 'energy_uj'), '900000');
		writeFileSync(join(dir, 'intel-rapl:0:0', 'energy_uj'), '10');
		const close = raplReader(dir)();
		writeFileSync(join(dir, 'energy_uj'), '100000');
		writeFileSync(join(dir, 'intel-rapl:0:0', 'energy_uj'), '500010');
		expect(close()).toEqual({ pkgJ: 0.2, coreJ: 0.5 });
	});
});
