import { describe, expect, it } from 'vitest';
import {
	addDestination,
	applyDnsPlan,
	createSendingSubdomain,
	dnsPlan,
	isVerified,
	listDestinations,
	listSendingSubdomains,
	normaliseContent,
	onboardState,
	ownedByOnboarding,
	requiredDns,
	zoneRecords,
	type DnsRecord,
	type ZoneRecord
} from '../../../src/ops/mail-onboard';

/**
 * Sending-domain onboarding.
 *
 * The fixtures are the LIVE shapes, read off `gmitch215.xyz` and the account on 2026-08-21 rather
 * than copied from documentation -- including the two that would have broken a plausible
 * implementation: the sending API quotes its TXT content and the zone API does not, and the sending
 * subdomain is zone-scoped where the account-scoped path answers `Unable to authenticate request`.
 */

const REQUIRED: DnsRecord[] = [
	{
		name: 'cf-bounce.gmitch215.xyz',
		content: 'route1.mx.cloudflare.net.',
		type: 'MX',
		priority: 15,
		ttl: 1
	},
	{
		name: 'cf-bounce.gmitch215.xyz',
		content: 'route2.mx.cloudflare.net.',
		type: 'MX',
		priority: 2,
		ttl: 1
	},
	{
		name: 'cf-bounce.gmitch215.xyz',
		content: 'route3.mx.cloudflare.net.',
		type: 'MX',
		priority: 29,
		ttl: 1
	},
	{
		name: 'cf-bounce.gmitch215.xyz',
		content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
		type: 'TXT',
		ttl: 1
	},
	{
		name: 'cf-bounce._domainkey.gmitch215.xyz',
		content: '"v=DKIM1; h=sha256; p=AAAA"',
		type: 'TXT',
		ttl: 1
	},
	{ name: '_dmarc.gmitch215.xyz', content: '"v=DMARC1; p=reject;"', type: 'TXT', ttl: 1 }
];

const zoneRec = (r: DnsRecord, id: string): ZoneRecord => ({ ...r, id });

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const capture = (impl: (url: string, init?: RequestInit) => Response) => {
	const calls: { url: string; method: string; body: string }[] = [];
	const fn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? 'GET',
			body: String(init?.body ?? '')
		});
		return impl(String(url), init);
	}) as unknown as typeof fetch;
	return { fn, calls };
};

describe('normaliseContent', () => {
	/**
	 * THE QUOTES ARE THE TRAP.
	 *
	 * The sending API returns TXT wrapped in quotes and the zone API returns it bare. A plain string
	 * compare therefore rewrites all three TXT records on every single run -- which still LOOKS
	 * idempotent from the outside, because the zone ends up correct either way.
	 */
	it('strips the quotes the sending API adds and the zone API does not', () => {
		expect(normaliseContent('TXT', '"v=DMARC1; p=reject;"')).toBe('v=DMARC1; p=reject;');
		expect(normaliseContent('TXT', 'v=DMARC1; p=reject;')).toBe('v=DMARC1; p=reject;');
	});

	it('joins a long TXT that the API split into quoted chunks', () => {
		// a DKIM key over 255 bytes comes back as "part1" "part2"
		expect(normaliseContent('TXT', '"v=DKIM1; p=AA" "BB"')).toBe('v=DKIM1; p=AABB');
	});

	it('treats an MX target as equal with or without its root dot', () => {
		expect(normaliseContent('MX', 'route1.mx.cloudflare.net.')).toBe(
			'route1.mx.cloudflare.net'
		);
		expect(normaliseContent('MX', 'ROUTE1.mx.cloudflare.net')).toBe('route1.mx.cloudflare.net');
	});

	it('leaves anything else alone but trimmed', () => {
		expect(normaliseContent('A', ' 1.2.3.4 ')).toBe('1.2.3.4');
	});
});

describe('dnsPlan', () => {
	it('creates all six against an empty zone', () => {
		const plan = dnsPlan(REQUIRED, []);
		expect(plan).toHaveLength(6);
		expect(plan.every((a) => a.verb === 'create')).toBe(true);
	});

	/**
	 * IDEMPOTENCE, which is the property the entry asked for by name.
	 *
	 * DNS propagation runs to 24 hours, so an operator will re-run this. A second pass has to write
	 * nothing.
	 */
	it('keeps everything on a second run over an onboarded zone', () => {
		const existing = REQUIRED.map((r, i) =>
			// the zone stores TXT unquoted, which is exactly the case that used to look like a diff
			zoneRec({ ...r, content: normaliseContent(r.type, r.content) }, `id-${i}`)
		);
		const plan = dnsPlan(REQUIRED, existing);
		expect(
			plan.every((a) => a.verb === 'keep'),
			JSON.stringify(plan.filter((a) => a.verb !== 'keep'))
		).toBe(true);
	});

	/**
	 * A CHANGED RECORD IS AN UPDATE, NEVER A SECOND CREATE.
	 *
	 * Two SPF TXT records on one name is a permerror under RFC 7208, which fails delivery for the
	 * whole domain -- so "create it again" is not a harmless duplicate.
	 */
	it('updates a record whose content drifted, rather than adding a second one', () => {
		const stale = REQUIRED.map((r, i) =>
			zoneRec(
				r.type === 'TXT' && r.content.includes('spf1')
					? { ...r, content: 'v=spf1 include:sendgrid.net ~all' }
					: { ...r, content: normaliseContent(r.type, r.content) },
				`id-${i}`
			)
		);
		const plan = dnsPlan(REQUIRED, stale);
		const updates = plan.filter((a) => a.verb === 'update');
		expect(updates).toHaveLength(1);
		expect(plan.filter((a) => a.verb === 'create')).toHaveLength(0);
		if (updates[0]?.verb === 'update') expect(updates[0].from).toContain('sendgrid');
	});

	/**
	 * MX IS A SET, so the target is part of the slot.
	 *
	 * Three MX records share one name. Matching on name+type alone would see the first as satisfying
	 * all three and leave two of the three mail routes unwritten.
	 */
	it('treats each MX target as its own record', () => {
		const onlyOne = [zoneRec({ ...(REQUIRED[0] as DnsRecord) }, 'id-0')];
		const plan = dnsPlan(REQUIRED, onlyOne);
		expect(plan.filter((a) => a.verb === 'keep')).toHaveLength(1);
		expect(plan.filter((a) => a.verb === 'create')).toHaveLength(5);
	});

	it('ignores unrelated records already on the zone', () => {
		const noise: ZoneRecord[] = [
			{ id: 'x', name: 'gmitch215.xyz', type: 'A', content: '1.2.3.4' },
			{ id: 'y', name: 'www.gmitch215.xyz', type: 'CNAME', content: 'gmitch215.xyz' }
		];
		expect(dnsPlan(REQUIRED, noise).every((a) => a.verb === 'create')).toBe(true);
	});
});

describe('applyDnsPlan', () => {
	it('costs no request for a record that already agrees', async () => {
		const { fn, calls } = capture(() => json({ success: true, result: {} }));
		const out = await applyDnsPlan(
			't',
			'z',
			dnsPlan(
				REQUIRED,
				REQUIRED.map((r, i) =>
					zoneRec({ ...r, content: normaliseContent(r.type, r.content) }, `id-${i}`)
				)
			),
			fn
		);
		expect(out).toEqual({ created: 0, updated: 0, kept: 6, advised: 0, errors: [] });
		expect(calls, 'a settled zone must cost nothing to re-check').toHaveLength(0);
	});

	it('POSTs a create and PATCHes an update', async () => {
		const { fn, calls } = capture(() => json({ success: true, result: {} }));
		await applyDnsPlan(
			't',
			'z',
			[
				{ verb: 'create', record: REQUIRED[0] as DnsRecord },
				{ verb: 'update', record: REQUIRED[3] as DnsRecord, id: 'abc', from: 'old' }
			],
			fn
		);
		expect(calls[0]?.method).toBe('POST');
		expect(calls[1]?.method).toBe('PATCH');
		expect(calls[1]?.url).toContain('/dns_records/abc');
		expect(JSON.parse(calls[0]!.body).priority).toBe(15);
	});

	it('collects a per-record failure and keeps going', async () => {
		const { fn } = capture((url, init) =>
			init?.method === 'POST' && JSON.parse(String(init.body)).type === 'TXT'
				? json({ success: false, errors: [{ message: 'record already exists' }] }, 400)
				: json({ success: true, result: {} })
		);
		const out = await applyDnsPlan('t', 'z', dnsPlan(REQUIRED, []), fn);
		expect(out.created).toBe(3);
		expect(out.errors).toHaveLength(3);
		expect(out.errors[0]).toContain('record already exists');
	});
});

describe('isVerified', () => {
	/**
	 * The live shapes, both of them, and the answer to the entry's open question.
	 *
	 * It asked whether any API reports a destination address as verified so the setup page can poll
	 * instead of asking the owner to come back. It does, twice over.
	 */
	it('reads the live verified shape', () => {
		expect(
			isVerified({
				id: '1',
				email: 'a@b',
				status: 'verified',
				verified: '2025-01-26T05:40:12Z'
			})
		).toBe(true);
		expect(isVerified({ id: '2', email: 'c@d', status: 'unverified', verified: null })).toBe(
			false
		);
	});

	it('falls back to the timestamp if status stops being sent', () => {
		expect(isVerified({ id: '1', email: 'a@b', verified: '2025-01-26T05:40:12Z' })).toBe(true);
		expect(isVerified({ id: '2', email: 'c@d', verified: null })).toBe(false);
	});

	it('is false for an address that does not exist', () => {
		expect(isVerified(undefined)).toBe(false);
	});
});

describe('onboardState', () => {
	const sub = { id: 's', name: 'gmitch215.xyz', enabled: true };
	const settledPlan = REQUIRED.map((r) => ({ verb: 'keep' as const, record: r }));
	const verified = { id: '1', email: 'a@b', status: 'verified' };

	it('names the step it is waiting on at each stage', () => {
		expect(
			onboardState({ zoneId: null, subdomain: null, plan: [], destination: undefined }).stage
		).toBe('no-zone');
		expect(
			onboardState({ zoneId: 'z', subdomain: null, plan: [], destination: undefined }).stage
		).toBe('needs-subdomain');
		expect(
			onboardState({
				zoneId: 'z',
				subdomain: sub,
				plan: dnsPlan(REQUIRED, []),
				destination: undefined
			}).stage
		).toBe('needs-dns');
		expect(
			onboardState({ zoneId: 'z', subdomain: sub, plan: settledPlan, destination: undefined })
				.stage
		).toBe('awaiting-verification');
		expect(
			onboardState({ zoneId: 'z', subdomain: sub, plan: settledPlan, destination: verified })
				.stage
		).toBe('ready');
	});

	it('counts the records still to write, so progress is visible during a long wait', () => {
		const partial = dnsPlan(REQUIRED, [zoneRec(REQUIRED[0] as DnsRecord, 'id-0')]);
		const state = onboardState({
			zoneId: 'z',
			subdomain: sub,
			plan: partial,
			destination: undefined
		});
		expect(state.waitingOn).toBe('write 5 DNS records');
		expect(state.pending).toHaveLength(5);
	});

	it('says record rather than records when one is left', () => {
		const one = [
			{ verb: 'create' as const, record: REQUIRED[0] as DnsRecord },
			...REQUIRED.slice(1).map((r) => ({ verb: 'keep' as const, record: r }))
		];
		expect(
			onboardState({ zoneId: 'z', subdomain: sub, plan: one, destination: undefined })
				.waitingOn
		).toBe('write 1 DNS record');
	});

	/**
	 * `settled` MEANS "re-running changes nothing", NOT "finished".
	 *
	 * Waiting on a human to click a link is a settled state: nothing more can be done from this side,
	 * and a flow that reported it as failure during a normal wait is one an operator re-runs forever.
	 */
	it('treats awaiting-verification as settled but not ready', () => {
		const state = onboardState({
			zoneId: 'z',
			subdomain: sub,
			plan: settledPlan,
			destination: undefined
		});
		expect(state.settled).toBe(true);
		expect(state.stage).not.toBe('ready');
		expect(state.waitingOn).toContain('click');
	});

	it('has nothing left to say once it is ready', () => {
		expect(
			onboardState({ zoneId: 'z', subdomain: sub, plan: settledPlan, destination: verified })
		).toEqual({
			stage: 'ready',
			waitingOn: '',
			settled: true
		});
	});
});

describe('the API surface', () => {
	/**
	 * ZONE-SCOPED, NOT ACCOUNT-SCOPED.
	 *
	 * Measured: `/accounts/{id}/email/sending/subdomains` answers `Unable to authenticate request`,
	 * which reads like a bad token and would send anyone debugging it at the credential instead of
	 * the path.
	 */
	it('addresses sending subdomains on the zone', async () => {
		const { fn, calls } = capture(() => json({ success: true, result: [] }));
		await listSendingSubdomains('t', 'zone-1', fn);
		expect(calls[0]!.url).toBe(
			`https://api.cloudflare.com/client/v4/zones/zone-1/email/sending/subdomains`
		);
		await createSendingSubdomain('t', 'zone-1', 'x.example', fn);
		expect(calls[1]!.method).toBe('POST');
		await requiredDns('t', 'zone-1', 'sub-1', fn);
		expect(calls[2]!.url).toContain('/email/sending/subdomains/sub-1/dns');
	});

	it('addresses destination addresses on the account, which is a different scope', async () => {
		const { fn, calls } = capture(() => json({ success: true, result: [] }));
		await listDestinations('t', 'acct-1', fn);
		expect(calls[0]!.url).toContain('/accounts/acct-1/email/routing/addresses');
		await addDestination('t', 'acct-1', 'a@b.example', fn);
		expect(JSON.parse(calls[1]!.body).email).toBe('a@b.example');
	});

	it('surfaces the API message rather than a status code', async () => {
		const { fn } = capture(() =>
			json({ success: false, errors: [{ message: 'zone not found' }] }, 404)
		);
		const out = await listSendingSubdomains('t', 'z', fn);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toBe('zone not found');
	});

	it('pages the zone records, since six needles can be past the first hundred', async () => {
		let page = 0;
		const { fn } = capture(() => {
			page++;
			return json({
				success: true,
				result: Array.from({ length: page === 1 ? 100 : 7 }, (_, i) => ({
					id: `${page}-${i}`,
					name: 'x',
					type: 'A',
					content: '1.2.3.4'
				}))
			});
		});
		const out = await zoneRecords('t', 'z', fn);
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.value).toHaveLength(107);
	});

	it('reports an unreachable API instead of throwing on the setup path', async () => {
		const dead = (async () => {
			throw new Error('socket');
		}) as unknown as typeof fetch;
		const out = await listSendingSubdomains('t', 'z', dead);
		expect(out.ok).toBe(false);
	});
});

/**
 * DMARC IS NOT DRUPFLARE'S RECORD TO WRITE, and only a live run showed it.
 *
 * Against the already-onboarded `gmitch215.xyz` the plan came back five `keep` and one `update` on
 * `_dmarc` -- the sending API wants `p=reject;` and the zone holds `p=none; rua=mailto:...`, a
 * working policy with reporting configured. Applying that update would tighten a DOMAIN-WIDE policy
 * to "bounce unauthenticated mail" for every stream the domain has, most of which drupflare knows
 * nothing about. The other five sit on the return-path host and the DKIM selector and exist because
 * of this feature, so those are unambiguous.
 *
 * P22's own entry had asked for "an upsert path for DMARC/BIMI". The live data says upsert is the
 * wrong verb.
 */
describe('records drupflare does not own', () => {
	const apexDmarc: DnsRecord = {
		name: '_dmarc.gmitch215.xyz',
		content: '"v=DMARC1; p=reject;"',
		type: 'TXT',
		ttl: 1
	};

	it('claims the five it created and disclaims the apex policy', () => {
		expect(ownedByOnboarding(REQUIRED[0] as DnsRecord)).toBe(true);
		expect(ownedByOnboarding(REQUIRED[4] as DnsRecord)).toBe(true);
		expect(ownedByOnboarding(apexDmarc)).toBe(false);
	});

	it('advises rather than updates when a DMARC policy already exists', () => {
		const existing = [
			zoneRec({ ...apexDmarc, content: 'v=DMARC1; p=none; rua=mailto:x@y' }, 'dmarc-1')
		];
		const action = dnsPlan([apexDmarc], existing)[0];
		expect(action?.verb).toBe('advise');
		if (action?.verb === 'advise') {
			expect(action.from).toContain('p=none');
			expect(action.why).toContain('operator');
		}
	});

	it('still CREATES it when the domain has no policy at all', () => {
		// adding a first DMARC record breaks nothing; replacing one can
		expect(dnsPlan([apexDmarc], [])[0]?.verb).toBe('create');
	});

	it('never writes an advisory, however the plan is applied', async () => {
		const { fn, calls } = capture(() => json({ success: true, result: {} }));
		const existing = [zoneRec({ ...apexDmarc, content: 'v=DMARC1; p=none' }, 'dmarc-1')];
		const out = await applyDnsPlan('t', 'z', dnsPlan([apexDmarc], existing), fn);
		expect(out.advised).toBe(1);
		expect(out.updated).toBe(0);
		expect(
			calls,
			'an advisory that reaches the API is a domain-wide policy change'
		).toHaveLength(0);
	});

	/**
	 * An advisory must not read as outstanding work, or the flow waits on it forever.
	 */
	it('reaches ready with an advisory outstanding, and reports it', () => {
		const sub = { id: 's', name: 'gmitch215.xyz', enabled: true };
		const plan = [
			...REQUIRED.slice(0, 5).map((r) => ({ verb: 'keep' as const, record: r })),
			{
				verb: 'advise' as const,
				record: apexDmarc,
				id: 'd',
				from: 'p=none',
				why: 'operator call'
			}
		];
		const state = onboardState({
			zoneId: 'z',
			subdomain: sub,
			plan,
			destination: { id: '1', email: 'a@b', status: 'verified' }
		});
		expect(state.stage).toBe('ready');
		expect(state.advisories).toHaveLength(1);
	});
});
