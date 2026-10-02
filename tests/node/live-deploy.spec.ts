import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
	encodeForm,
	failures,
	FREE_DAILY_ROWS,
	hiddenFields,
	isEmptyInventory,
	leftovers,
	provision,
	quotaExhausted,
	quotaNotice,
	ROWS_PER_RUN,
	sessionFrom,
	Site,
	slopeVerdict,
	textFields
} from '../../scripts/e2e/live-deploy';
import { SHIPPING_STEP } from '../../scripts/measure/growth-glue';

/**
 * The live deploy lane's verdict and teardown arithmetic, which decide whether a real run is red.
 * The lane itself runs against a Cloudflare account; this is the half that needs none.
 */

describe('the failure verdict', () => {
	it('fails on an object exception and on the reset text a 1101 leaves in the log', () => {
		expect(
			failures([
				{ entry: 'SitePhpDurableObject', outcome: 'exception', url: 'https://x/__serve' },
				{
					level: 'error',
					message:
						'Internal error in Durable Object storage caused object to be reset; reference = a'
				},
				{ level: 'error', message: 'Network connection lost.' },
				{ outcome: 'exceededMemory' }
			])
		).toHaveLength(4);
	});

	it('passes success, a canceled request and an unrelated error log', () => {
		expect(
			failures([
				{ outcome: 'ok' },
				{ outcome: 'canceled' },
				{ level: 'error', message: 'Login attempt failed from 1.2.3.4.' }
			])
		).toEqual([]);
	});
});

describe('the teardown diff', () => {
	const before = { workers: ['prod'], durableObjects: ['a prod_Site'], kv: [], d1: [] };
	it('names only what appeared during the run', () => {
		const after = {
			workers: ['prod', 'cfw-e2e-1'],
			durableObjects: ['a prod_Site', 'b cfw-e2e-1_Site'],
			kv: ['k cfw-e2e-1-CONFIG_KV'],
			d1: []
		};
		expect(leftovers(before, after)).toEqual({
			workers: ['cfw-e2e-1'],
			durableObjects: ['b cfw-e2e-1_Site'],
			kv: ['k cfw-e2e-1-CONFIG_KV'],
			d1: []
		});
	});
	it('reads an account back at its baseline as clean', () => {
		expect(isEmptyInventory(leftovers(before, before))).toBe(true);
	});
});

describe('driving Drupal forms', () => {
	it('carries hidden and text inputs back, and reads the session cookie', () => {
		const html =
			'<input type="hidden" name="form_token" value="a&amp;b"><input type="text" name="site_name" value="Site">';
		expect(hiddenFields(html)).toEqual({ form_token: 'a&b' });
		expect(textFields(html)).toEqual({ site_name: 'Site' });
		expect(encodeForm({ 'title[0][value]': 'a b' })).toBe('title%5B0%5D%5Bvalue%5D=a%20b');
		expect(sessionFrom(['other=1', 'SSESSabc123=xyz; path=/; secure'])).toBe('SSESSabc123=xyz');
	});
});

describe('the warm-drive memory verdict', () => {
	const MIB = 1_048_576;
	const flat = (linear: number, n: number) =>
		Array.from({ length: n }, () => ({ linear, recycles: 3 }));

	it('passes a flat drive and one allocator rung after warm-up', () => {
		expect(slopeVerdict(flat(100 * MIB, 8))).toBeNull();
		const oneRung = [...flat(100 * MIB, 4), ...flat(100 * MIB * (1 + SHIPPING_STEP), 4)];
		expect(slopeVerdict(oneRung)).toBeNull();
	});

	it('ignores what the warm-up passes grew', () => {
		expect(
			slopeVerdict([
				{ linear: 80 * MIB, recycles: 0 },
				{ linear: 99 * MIB, recycles: 0 },
				...flat(103 * MIB, 6)
			])
		).toBeNull();
	});

	it('fails a drive that climbs 3 MiB a pass, which is what the host-call leak did', () => {
		const climbing = Array.from({ length: 8 }, (_, i) => ({
			linear: (100 + 3 * i) * MIB,
			recycles: 0
		}));
		expect(slopeVerdict(climbing)).toMatch(/grew 106.00 -> 121.00 MiB over 5 warm passes/);
	});

	it('fails a drive that recycled, even when the recycle kept linear memory flat', () => {
		const samples = flat(100 * MIB, 8);
		samples[6] = { linear: 100 * MIB, recycles: 4 };
		samples[7] = { linear: 100 * MIB, recycles: 4 };
		expect(slopeVerdict(samples)).toMatch(/recycled the interpreter 1 time/);
	});

	it('refuses to judge a drive with too few readings', () => {
		expect(slopeVerdict(flat(100 * MIB, 2))).toMatch(/too few/);
	});
});

describe('the free quota', () => {
	it('recognises the answer the platform gives once the day is spent', () => {
		expect(
			quotaExhausted('Error: Exceeded allowed rows written in Durable Objects free tier.')
		).toBe(true);
		expect(quotaExhausted('GET / answered 500, expected 200: Internal Server Error')).toBe(
			false
		);
	});

	it('names rows used, rows needed and the reset time', () => {
		const text = quotaNotice(95_000, ROWS_PER_RUN, new Date('2026-09-28T23:45:00Z'));
		expect(text).toContain('95,000 of 100,000');
		expect(text).toContain(`needs ${ROWS_PER_RUN.toLocaleString('en-US')}`);
		expect(text).toContain('2026-09-29T00:00:00.000Z');
		expect(quotaNotice(null, 1)).toContain('the platform refused a write');
	});

	it('leaves room for at least one run a day', () => {
		expect(ROWS_PER_RUN).toBeLessThan(FREE_DAILY_ROWS);
	});
});

const RESET_PAGE =
	'<!doctype html><title>Try Again</title><p>The site restarted while answering this request.</p>';

/** a stand-in site whose /firstrun answers the given statuses in order, then repeats the last */
async function serveClaims(answers: { status: number; body: string }[]) {
	let claims = 0;
	const server = createServer((req, res) => {
		if (req.url === '/firstrun') {
			const answer = answers[Math.min(claims++, answers.length - 1)]!;
			res.writeHead(answer.status).end(answer.body);
			return;
		}
		res.writeHead(200).end('<html>ok</html>');
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		claims: () => claims,
		close: () => server.close()
	};
}

describe('claiming the site through /firstrun', () => {
	it('claims with one request when the first answer is 200', async () => {
		const rig = await serveClaims([{ status: 200, body: '{"ownerToken":"tok"}' }]);
		const site = new Site(rig.origin);
		try {
			expect(await provision(site, 'pw', 0)).toBe('tok');
			expect(rig.claims()).toBe(1);
			expect(site.problems).toEqual([]);
		} finally {
			rig.close();
		}
	});

	it('retries once on the Try Again page and returns the owner token', async () => {
		const rig = await serveClaims([
			{ status: 503, body: RESET_PAGE },
			{ status: 200, body: '{"ownerToken":"tok"}' }
		]);
		const site = new Site(rig.origin);
		try {
			expect(await provision(site, 'pw', 0)).toBe('tok');
			expect(rig.claims()).toBe(2);
			expect(site.problems).toEqual([]);
		} finally {
			rig.close();
		}
	});

	it('does not retry a second reset, so a persistent one still fails the lane', async () => {
		const rig = await serveClaims([{ status: 503, body: RESET_PAGE }]);
		const site = new Site(rig.origin);
		try {
			await expect(provision(site, 'pw', 0)).rejects.toThrow(/no JSON/);
			expect(rig.claims()).toBe(2);
		} finally {
			rig.close();
		}
	});

	it('does not retry any other 503 and records it as a problem', async () => {
		const rig = await serveClaims([{ status: 503, body: 'warming' }]);
		const site = new Site(rig.origin);
		try {
			await expect(provision(site, 'pw', 0)).rejects.toThrow();
			expect(rig.claims()).toBe(1);
			expect(site.problems.join(' ')).toContain('/firstrun answered 503');
		} finally {
			rig.close();
		}
	});
});
