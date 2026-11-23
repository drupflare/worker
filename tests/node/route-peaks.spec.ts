import { describe, expect, it } from 'vitest';
import { redact } from '../../scripts/measure/headlines';
import {
	activationLink,
	attributeCpu,
	attributeMeter,
	classifyDrive,
	DEFAULT_MODULES,
	DRUPAL_ROUTES,
	encodeForm,
	formatShares,
	formatTable,
	formFields,
	LINE_MIB,
	MIB,
	newDemand,
	newSession,
	parseCensusOptions,
	parseMeterRows,
	parseSnapshot,
	peakOf,
	planLines,
	responseHeadOf,
	routesFor,
	runCensus,
	sharesOf,
	spreadOf,
	summariseRoute,
	WORDPRESS_ROUTES,
	type DemandEntry,
	type Drive,
	type Reply,
	type RouteSummary,
	type Snapshot
} from '../../scripts/measure/route-peaks';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ counters: {}, demand: [], ...over });
const entry = (after: number, over: Partial<DemandEntry> = {}): DemandEntry => ({
	path: '/',
	method: 'GET',
	before: 0,
	after,
	...over
});
const drive = (over: Partial<Drive> = {}): Drive => ({
	route: 'front',
	i: 0,
	tag: 't',
	status: 200,
	requests: 1,
	startedAt: 1000,
	endedAt: 2000,
	before: snap(),
	verdict: { failed: false, incarnationChanged: false, memoryMessage: false, reasons: [] },
	...over
});

describe('reading a stats body', () => {
	it('keeps the fields the object reported and leaves the rest absent', () => {
		const s = parseSnapshot({
			isolate: { id: 'iso-1', interpreters: 1, linearBytes: 100 },
			isolateBytes: { linear: 90, total: 120 },
			phpLaneEntries: 4,
			recycles: 0,
			demand: [{ path: '/', method: 'GET', before: 0, after: 80 }],
			growth: [1, 2],
			limits: { tally: { 'memory-limit': 1 } }
		});
		expect(s.isolateId).toBe('iso-1');
		expect(s.linearBytes).toBe(90);
		expect(s.isolateTotalBytes).toBe(120);
		expect(s.counters).toEqual({ phpLaneEntries: 4, recycles: 0 });
		expect(s.growthEntries).toBe(2);
		expect(s.demand).toHaveLength(1);
		expect(s.limitTally).toEqual({ 'memory-limit': 1 });
	});

	it('reads a malformed body as empty and never as zero', () => {
		for (const bad of [null, undefined, 'x', 7, [], { demand: 'no', isolate: 3 }]) {
			const s = parseSnapshot(bad);
			expect(s.isolateId).toBeUndefined();
			expect(s.linearBytes).toBeUndefined();
			expect(s.counters).toEqual({});
			expect(s.demand).toEqual([]);
		}
	});

	it('drops a demand entry with no sizes', () => {
		expect(
			parseSnapshot({ demand: [{ path: '/' }, { before: 1, after: 2 }] }).demand
		).toHaveLength(1);
	});
});

describe('the demand ring', () => {
	it('returns the entries added after the overlap', () => {
		const a = [entry(10), entry(20)];
		const r = newDemand(a, [...a, entry(30), entry(40)]);
		expect(r.entries.map((e) => e.after)).toEqual([30, 40]);
		expect(r.ambiguous).toBe(false);
	});

	it('follows a ring that shifted its oldest entries out', () => {
		const before = [entry(1), entry(2), entry(3)];
		const after = [entry(2), entry(3), entry(4)];
		expect(newDemand(before, after).entries.map((e) => e.after)).toEqual([4]);
	});

	it('says ambiguous when nothing overlaps, and still returns what it has', () => {
		const r = newDemand([entry(1), entry(2)], [entry(7), entry(8)]);
		expect(r.ambiguous).toBe(true);
		expect(r.entries).toHaveLength(2);
	});

	it('is not ambiguous when there was nothing before', () => {
		expect(newDemand([], [entry(5)])).toEqual({ entries: [entry(5)], ambiguous: false });
	});
});

describe('the peak of a drive', () => {
	it('takes the highest after of the route entries, and skips alarm entries', () => {
		const p = peakOf(
			snap(),
			snap({
				demand: [entry(90 * MIB), entry(120 * MIB, { method: 'ALARM' }), entry(100 * MIB)]
			})
		);
		expect(p).toMatchObject({ bytes: 100 * MIB, from: 'demand', ambiguous: false });
	});

	it('falls back to the resident size only when none was resident before', () => {
		expect(peakOf(snap({ linearBytes: 0 }), snap({ linearBytes: 70 * MIB }))?.from).toBe(
			'resident'
		);
		expect(
			peakOf(snap({ linearBytes: 64 * MIB }), snap({ linearBytes: 70 * MIB }))
		).toBeUndefined();
	});

	it('ignores the entries the stats and recycle reads leave and flags a reused memory', () => {
		const p = peakOf(
			snap(),
			snap({
				demand: [
					entry(98 * MIB, { path: '/__serve-stats' }),
					entry(98 * MIB, { path: '/admin/content', reused: true })
				]
			})
		);
		expect(p).toMatchObject({ bytes: 98 * MIB, from: 'demand', reused: true });
		expect(
			peakOf(snap(), snap({ demand: [entry(98 * MIB, { path: '/__serve-stats' })] }))
		).toBeUndefined();
		expect(peakOf(snap(), snap({ demand: [entry(90 * MIB)] }))?.reused).toBe(false);
	});

	it('counts reused boots and replies that said not ok in a route summary', () => {
		const s = summariseRoute('x', 'x', [
			drive({ peakBytes: 98 * MIB, peakFrom: 'demand', peakReused: true }),
			drive({ replyOk: false }),
			drive({ replyOk: true })
		]);
		expect(s).toMatchObject({ reusedBoots: 1, replyNotOk: 1 });
	});

	it('has no peak with no after read, rather than zero', () => {
		expect(peakOf(snap(), undefined)).toBeUndefined();
	});

	it('reads the size from a new exit record when the demand log holds nothing', () => {
		const after = snap({ lastExit: { at: 9, linearBytes: 140 * MIB } });
		expect(peakOf(snap({ lastExit: { at: 4 } }), after)).toEqual({
			bytes: 140 * MIB,
			from: 'exit',
			ambiguous: false
		});
	});

	it('takes a new exit by its counter when two exits share one timestamp', () => {
		const at = { at: 9, linearBytes: 130 * MIB };
		const before = snap({ counters: { exitedRuns: 1 }, lastExit: at });
		const after = snap({ counters: { exitedRuns: 2 }, lastExit: at });
		expect(peakOf(before, after)?.from).toBe('exit');
		expect(peakOf(after, after)).toBeUndefined();
	});

	it('leaves the peak empty when the exit record is the one read before, or has no size', () => {
		const old = snap({ lastExit: { at: 9, linearBytes: 140 * MIB } });
		expect(peakOf(old, old)).toBeUndefined();
		expect(peakOf(snap(), snap({ lastExit: { at: 9 } }))).toBeUndefined();
	});

	it('reads the exit record out of a stats body and the exit and trap counters', () => {
		const s = parseSnapshot({
			lastExit: { at: 12, partial: 'x', linear: 99 },
			exitedRuns: 3,
			trappedRuns: 1
		});
		expect(s.lastExit).toEqual({ at: 12, linearBytes: 99 });
		expect(s.counters).toEqual({ exitedRuns: 3, trappedRuns: 1 });
		expect(parseSnapshot({ lastExit: { at: 12 } }).lastExit).toEqual({ at: 12 });
	});
});

describe('the drive classifier', () => {
	const ok = { status: 200 };

	it('fails a drive whose isolate id changed', () => {
		const v = classifyDrive(snap({ isolateId: 'a' }), snap({ isolateId: 'b' }), ok);
		expect(v.failed).toBe(true);
		expect(v.incarnationChanged).toBe(true);
	});

	it('does not fail a drive whose id and counters held', () => {
		const v = classifyDrive(
			snap({ isolateId: 'a', counters: { phpLaneEntries: 3 } }),
			snap({ isolateId: 'a', counters: { phpLaneEntries: 4 } }),
			ok
		);
		expect(v).toMatchObject({ failed: false, incarnationChanged: false });
	});

	it('reads a counter that fell as a restart even with the same id', () => {
		const v = classifyDrive(
			snap({ isolateId: 'a', counters: { phpLaneEntries: 3 } }),
			snap({ isolateId: 'a', counters: { phpLaneEntries: 1 } }),
			ok
		);
		expect(v.incarnationChanged).toBe(true);
		expect(v.reasons.join(' ')).toMatch(/phpLaneEntries fell from 3 to 1/);
	});

	it('leaves the incarnation unknown when nothing is comparable', () => {
		const v = classifyDrive(snap(), snap(), ok);
		expect(v.incarnationChanged).toBeUndefined();
		expect(v.failed).toBe(false);
		expect(
			classifyDrive(snap({ isolateId: 'a' }), undefined, ok).incarnationChanged
		).toBeUndefined();
	});

	it('fails a drive whose failed answer carries the memory-limit message', () => {
		const v = classifyDrive(snap(), snap(), {
			status: 500,
			failureText: 'Error: Worker exceeded its memory limit.'
		});
		expect(v.memoryMessage).toBe(true);
		expect(v.failed).toBe(true);
	});

	it('does not read the words memory limit from a page that answered 200', () => {
		const v = classifyDrive(snap(), snap(), {
			status: 200,
			failureText: 'PHP memory limit 256M'
		});
		expect(v.memoryMessage).toBe(false);
		expect(v.failed).toBe(false);
	});

	it('reads a lost connection as a reset and fails the drive', () => {
		const v = classifyDrive(snap(), undefined, {
			status: 0,
			error: 'Network connection lost.'
		});
		expect(v.incarnationChanged).toBe(true);
		expect(v.failed).toBe(true);
	});

	it('does not fail a drive that timed out with no sign of a reset', () => {
		const v = classifyDrive(snap(), undefined, {
			status: 0,
			error: 'The operation was aborted'
		});
		expect(v.failed).toBe(false);
		expect(v.incarnationChanged).toBeUndefined();
	});
});

describe('spread and summaries', () => {
	it('gives n, min, median and max, and nothing for an empty sample', () => {
		expect(spreadOf([3, 1, 2])).toEqual({ n: 3, min: 1, p50: 2, max: 3 });
		expect(spreadOf([4, 1, 2, 3])).toEqual({ n: 4, min: 1, p50: 2.5, max: 4 });
		expect(spreadOf([])).toBeUndefined();
	});

	it('counts a drive with no reading as no peak and never as zero', () => {
		const s = summariseRoute('front', 'front', [
			drive({ peakBytes: 100 * MIB, peakFrom: 'demand' }),
			drive({ i: 1 }),
			drive({ i: 2, peakBytes: 120 * MIB, peakFrom: 'resident' })
		]);
		expect(s.drives).toBe(3);
		expect(s.noPeak).toBe(1);
		expect(s.peak).toEqual({ n: 2, min: 100, p50: 110, max: 120 });
		expect(s.peakFrom).toEqual({ demand: 1, exit: 0, resident: 1 });
		expect(s.meterMissing).toBe(3);
		expect(s.meter).toBeUndefined();
	});

	it('counts changed and unknown incarnations apart', () => {
		const s = summariseRoute('x', 'x', [
			drive({
				verdict: {
					failed: true,
					incarnationChanged: true,
					memoryMessage: false,
					reasons: []
				}
			}),
			drive({
				verdict: {
					failed: false,
					incarnationChanged: undefined,
					memoryMessage: false,
					reasons: []
				}
			}),
			drive()
		]);
		expect(s).toMatchObject({ incarnationChanged: 1, incarnationUnknown: 1, failed: 1 });
	});
});

describe('shares and the table', () => {
	const row = (route: string, meterMax: number | undefined, failed = 0): RouteSummary => ({
		...summariseRoute(route, route, [drive()]),
		failed,
		...(meterMax === undefined
			? {}
			: { meter: { n: 1, min: meterMax, p50: meterMax, max: meterMax } })
	});

	it('counts a pair at the line as at or above, and one just under as within the margin', () => {
		const s = sharesOf(
			[row('a', LINE_MIB), row('b', LINE_MIB - 0.1), row('c', LINE_MIB - 30)],
			LINE_MIB,
			5
		);
		expect(s.atOrAboveLine).toBe(1);
		expect(s.withinMargin).toBe(1);
		expect(s.pairs).toBe(3);
	});

	it('counts a pair with no meter reading apart and never over', () => {
		const s = sharesOf([row('a', undefined), row('b', 250)], LINE_MIB, 5);
		expect(s.noMeter).toBe(1);
		expect(s.atOrAboveLine).toBe(1);
	});

	it('does not count a skipped route as a pair', () => {
		const skipped: RouteSummary = { ...summariseRoute('u', 'u', []), skipped: 'pending' };
		expect(sharesOf([skipped, row('a', 100)]).pairs).toBe(1);
	});

	it('prints no within-margin count and no share without a margin', () => {
		const text = formatShares(sharesOf([row('a', 210)]), { lineMib: LINE_MIB }).join('\n');
		expect(text).toMatch(/--margin-mib not given/);
		expect(text).not.toMatch(/within \d+ MiB below/);
		expect(text).not.toMatch(/arithmetic/);
	});

	it('prints the count but no comparison without a warn share', () => {
		const text = formatShares(sharesOf([row('a', 200)], LINE_MIB, 5), {
			lineMib: LINE_MIB,
			marginMib: 5
		}).join('\n');
		expect(text).toMatch(/within 5 MiB below 203: 1/);
		expect(text).toMatch(/--warn-share not given/);
		expect(text).not.toMatch(/arithmetic/);
	});

	it('prints the arithmetic and no verdict word with both flags', () => {
		const rows = [row('a', 210), row('b', 200), row('c', 100), row('d', 100)];
		const text = formatShares(sharesOf(rows, LINE_MIB, 5), {
			lineMib: LINE_MIB,
			marginMib: 5,
			warnShare: 40
		}).join('\n');
		expect(text).toMatch(/\(1 \+ 1\) \/ 4 = 50\.0%/);
		expect(text).toMatch(/share >= warn-share is true/);
		expect(text).not.toMatch(/warning|extreme|pass|fail verdict/i);
	});

	it('says the share is a floor when pairs have no meter reading', () => {
		const text = formatShares(sharesOf([row('a', undefined), row('b', 210)], LINE_MIB, 5), {
			lineMib: LINE_MIB,
			marginMib: 5,
			warnShare: 10
		}).join('\n');
		expect(text).toMatch(/1 of 2 pairs have no meter reading/);
	});

	it('writes a dash for an empty cell and names a skipped route', () => {
		const lines = formatTable([
			summariseRoute('front', 'front', [drive()]),
			{ ...summariseRoute('update', 'update', []), skipped: 'no update owed' }
		]);
		expect(lines[1]).toMatch(/^front \| 1 \| - \|/);
		expect(lines[2]).toBe('update | 0 | skipped: no update owed');
	});
});

describe('the command line', () => {
	it('leaves the margin and the warn share unset unless given', () => {
		const o = parseCensusOptions(['--cms=wordpress', '--dry']);
		expect(o.marginMib).toBeUndefined();
		expect(o.warnShare).toBeUndefined();
		expect(o.lineMib).toBe(203);
		const g = parseCensusOptions([
			'--cms=drupal',
			'--dry',
			'--margin-mib=24',
			'--warn-share=20'
		]);
		expect([g.marginMib, g.warnShare]).toEqual([24, 20]);
		expect(o.ingestMin).toBeUndefined();
		expect(parseCensusOptions(['--cms=wordpress', '--dry', '--ingest-min=15']).ingestMin).toBe(
			15
		);
		expect(() => parseCensusOptions(['--cms=wordpress', '--dry', '--ingest-min=0'])).toThrow(
			/--ingest-min/
		);
	});

	it('refuses a missing mode, a bad cms, an unknown flag and a bad number', () => {
		expect(() => parseCensusOptions(['--cms=wordpress'])).toThrow(/say one of/);
		expect(() => parseCensusOptions(['--cms=joomla', '--dry'])).toThrow(/--cms/);
		expect(() => parseCensusOptions(['--cms=drupal', '--dry', '--bogus'])).toThrow(
			/unknown argument/
		);
		expect(() => parseCensusOptions(['--cms=drupal', '--dry', '--n=0'])).toThrow(/--n/);
		expect(() => parseCensusOptions(['--cms=drupal', '--dry', '--warn-share=101'])).toThrow(
			/--warn-share/
		);
	});

	it('needs an account for a deployed run and refuses one elsewhere', () => {
		expect(() => parseCensusOptions(['--cms=wordpress', '--deployed'])).toThrow(/--account/);
		expect(() => parseCensusOptions(['--cms=wordpress', '--local', '--account=paid'])).toThrow(
			/belongs to/
		);
		expect(parseCensusOptions(['--cms=wordpress', '--deployed', '--account=paid']).mode).toBe(
			'deployed'
		);
	});

	it('takes an existing site as its own mode and claims only on a fresh one', () => {
		const b = parseCensusOptions(['--cms=drupal', '--base=https://x.example/']);
		expect(b.mode).toBe('base');
		expect(b.base).toBe('https://x.example');
		expect(b.claim).toBe(false);
		expect(parseCensusOptions(['--cms=drupal', '--local']).claim).toBe(true);
		expect(() => parseCensusOptions(['--cms=drupal', '--local', '--base=http://x'])).toThrow(
			/does not combine/
		);
	});

	it('takes --meter only with --base and needs the worker name for it', () => {
		const m = parseCensusOptions([
			'--cms=drupal',
			'--base=https://x.example',
			'--meter',
			'--name=cfw-e2e-thunder-x'
		]);
		expect([m.meter, m.name]).toEqual([true, 'cfw-e2e-thunder-x']);
		expect(parseCensusOptions(['--cms=drupal', '--base=https://x.example']).meter).toBe(false);
		expect(() =>
			parseCensusOptions(['--cms=drupal', '--base=https://x.example', '--meter'])
		).toThrow(/--meter needs --name/);
		expect(() =>
			parseCensusOptions(['--cms=drupal', '--dry', '--meter', '--name=cfw-e2e-thunder-x'])
		).toThrow(/--meter belongs to --base/);
	});

	it('keeps the reset header, the body length and the first 120 bytes of a failed reply only', () => {
		const reply = (status: number, headers: Headers | undefined, text: string): Reply => ({
			status,
			headers,
			text,
			ms: 0
		});
		expect(
			responseHeadOf(reply(503, new Headers({ 'x-cfw-object-reset': '1' }), 'x'.repeat(199)))
		).toEqual({ reset: '1', bodyBytes: 199, head: 'x'.repeat(120) });
		expect(responseHeadOf(reply(0, undefined, ''))).toEqual({ bodyBytes: 0, head: '' });
		expect(responseHeadOf(reply(200, new Headers(), 'ok'))).toBeUndefined();
		expect(responseHeadOf(reply(302, new Headers(), ''))).toBeUndefined();
	});

	it('plans without a network and names a pending route', () => {
		const lines = planLines(parseCensusOptions(['--cms=drupal', '--dry']));
		expect(lines.join('\n')).toMatch(/update: database update \(pending/);
		expect(lines.join('\n')).toMatch(/--margin-mib not given/);
	});

	it('refuses an unknown route id', () => {
		expect(() => routesFor('drupal', ['nope'])).toThrow(/unknown route nope/);
		expect(routesFor('wordpress', ['front']).map((r) => r.id)).toEqual(['front']);
	});

	it('names the routes the roadmap lists for each CMS', () => {
		const wp = WORDPRESS_ROUTES.map((r) => r.id);
		for (const id of [
			'front',
			'post',
			'login-get',
			'login-post',
			'admin',
			'post-new',
			'heartbeat',
			'rest-posts',
			'rest-me',
			'cron',
			'plugin-activate',
			'media-upload'
		]) {
			expect(wp).toContain(id);
		}
		const dr = DRUPAL_ROUTES.map((r) => r.id);
		for (const id of [
			'front',
			'auth-front',
			'admin',
			'flush',
			'cron',
			'module-enable',
			'update'
		]) {
			expect(dr).toContain(id);
		}
		expect(DEFAULT_MODULES.length).toBeGreaterThan(0);
	});
});

describe('reading pages', () => {
	const page = `<form class="x" id="user-login-form" action="/user/login"><input type="hidden" name="form_build_id" value="form-a&amp;b" /><input type="hidden" name="form_id" value="user_login_form" /></form><form id="other"><input type="hidden" name="form_build_id" value="other" /></form>`;

	it('reads the hidden fields of the named form only, decoded', () => {
		expect(formFields(page, 'user-login-form')).toEqual({
			form_build_id: 'form-a&b',
			form_id: 'user_login_form'
		});
		expect(formFields(page, 'absent')).toEqual({});
	});

	it('encodes fields for a form post', () => {
		expect(encodeForm({ a: 'b c', 'd&': 'e' })).toBe('a=b%20c&d%26=e');
	});

	it('finds an activation link and turns it into a path', () => {
		const html = `<a href="plugins.php?action=activate&amp;plugin=hello.php&amp;_wpnonce=abc123" id="activate-hello">Activate</a>`;
		expect(activationLink(html)).toBe(
			'/wp-admin/plugins.php?action=activate&plugin=hello.php&_wpnonce=abc123'
		);
		expect(activationLink('<a href="plugins.php?action=deactivate">x</a>')).toBeUndefined();
	});
});

describe('the platform meter and cpuTime', () => {
	const rows = parseMeterRows({
		data: {
			viewer: {
				accounts: [
					{
						durableObjectsPeriodicGroups: [
							{
								dimensions: { datetime: '2026-11-21T10:00:00Z' },
								max: { memoryUsageBytes: 150 * MIB },
								sum: { exceededMemoryErrors: 0 }
							},
							{
								dimensions: { datetime: '2026-11-21T10:05:00Z' },
								max: { memoryUsageBytes: 210 * MIB },
								sum: { exceededMemoryErrors: 1 }
							}
						]
					}
				]
			}
		}
	});
	const t0 = Date.parse('2026-11-21T10:00:10Z');

	it('reads rows and reads a body with none as no rows', () => {
		expect(rows).toHaveLength(2);
		expect(rows[1]?.exceededMemoryErrors).toBe(1);
		expect(parseMeterRows({ data: { viewer: { accounts: [{}] } } })).toEqual([]);
		expect(parseMeterRows(null)).toEqual([]);
	});

	it('gives a drive the row that overlaps it, and a missing row to one that overlaps none', () => {
		const [a, b] = attributeMeter(
			[
				drive({ startedAt: t0, endedAt: t0 + 5000 }),
				drive({ startedAt: t0 + 120_000, endedAt: t0 + 125_000 })
			],
			rows
		);
		expect(a?.meterBytes).toBe(150 * MIB);
		expect(b?.meterBytes).toBeUndefined();
	});

	it('marks drives that share a row and keeps the highest value', () => {
		const out = attributeMeter(
			[
				drive({ startedAt: t0, endedAt: t0 + 5000 }),
				drive({ i: 1, startedAt: t0 + 20_000, endedAt: t0 + 25_000 })
			],
			rows
		);
		expect(out.every((d) => d.meterShared === true)).toBe(true);
	});

	it('sums the exceeded-memory errors of every row a drive overlaps', () => {
		const two = [
			{ at: t0 - 60_000, maxMemoryBytes: 100 * MIB, exceededMemoryErrors: 2 },
			{ at: t0, maxMemoryBytes: 120 * MIB, exceededMemoryErrors: 3 }
		];
		const [d] = attributeMeter([drive({ startedAt: t0, endedAt: t0 + 5000 })], two);
		expect(d?.meterExceeded).toBe(5);
	});

	it('counts no exceeded-memory errors for a drive with one clean row', () => {
		const [d] = attributeMeter([drive({ startedAt: t0, endedAt: t0 + 5000 })], rows);
		expect(d?.meterExceeded).toBe(0);
	});

	it('keeps no meter cell for a drive with no row', () => {
		const [d] = attributeMeter(
			[drive({ startedAt: t0 + 120_000, endedAt: t0 + 125_000 })],
			rows
		);
		expect(d).not.toHaveProperty('meterBytes');
		expect(d).not.toHaveProperty('meterExceeded');
	});

	it('joins cpuTime by tag and leaves an unjoined drive empty', () => {
		const front = [
			{
				tag: 'tag-a',
				cpuMs: 1,
				wallMs: 40,
				outcome: 'ok',
				cls: 'fetch' as const,
				eventType: 'fetch',
				at: 5000
			}
		];
		const objects = [
			{
				tag: null,
				cpuMs: 30,
				wallMs: 20,
				outcome: 'ok',
				cls: 'fetch' as const,
				eventType: 'fetch',
				at: 4990
			},
			{
				tag: null,
				cpuMs: 12,
				wallMs: 5,
				outcome: 'ok',
				cls: 'fetch' as const,
				eventType: 'fetch',
				at: 4980
			}
		];
		const [a, b] = attributeCpu(
			[drive({ tag: 'tag-a', startedAt: 4950, endedAt: 5000 }), drive({ tag: 'tag-b' })],
			front,
			objects
		);
		expect(a?.cpuMs).toBe(42);
		expect(b?.cpuMs).toBeUndefined();
	});
});

describe('a census against a fake site', () => {
	type Fake = { fetch: typeof fetch; seen: string[] };

	function fakeWordpress(opts: { resetOnRoute?: number } = {}): Fake {
		const seen: string[] = [];
		let isolate = 'iso-1';
		let lane = 0;
		let routeCalls = 0;
		let demand: object[] = [];
		const f = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const path = url.pathname;
			const auth = new Headers(init?.headers).get('authorization') ?? '';
			seen.push(`${init?.method ?? 'GET'} ${path} ${auth}`);
			if (path === '/serve-stats') {
				return Response.json({
					isolate: { id: isolate, interpreters: 1, linearBytes: 0 },
					isolateBytes: { linear: 0, total: 0 },
					phpLaneEntries: lane,
					demand
				});
			}
			if (path === '/recycle') return Response.json({ ok: true, recycled: true });
			if (path === '/wp-login.php') {
				return new Response('', {
					status: 302,
					headers: { 'set-cookie': 'wordpress_logged_in_x=secret-cookie; Path=/' }
				});
			}
			if (path === '/wp-admin/admin-ajax.php') return new Response('nonce-value');
			routeCalls++;
			lane++;
			if (opts.resetOnRoute === routeCalls) {
				isolate = 'iso-2';
				lane = 1;
			}
			demand = [
				...demand,
				{ path, method: 'GET', before: 0, after: (100 + routeCalls) * MIB }
			];
			return new Response('ok');
		}) as typeof fetch;
		return { fetch: f, seen };
	}

	const quiet = async () => undefined;

	it('drives each route n times and records a peak from the demand log', async () => {
		const fake = fakeWordpress();
		const logs: string[] = [];
		const s = newSession(
			'http://site.test',
			'wordpress',
			{ CENSUS_OWNER_TOKEN: 'owner-secret', CENSUS_ADMIN_PASS: 'admin-secret' },
			[],
			fake.fetch,
			(l) => logs.push(l)
		);
		s.sleep = quiet;
		const run = await runCensus(s, routesFor('wordpress', ['front']), {
			n: 2,
			cold: 'recycle',
			name: 'cfw-wp-00000000',
			gapMs: 0
		});
		const front = run.summaries[0] as RouteSummary;
		expect(front.drives).toBe(2);
		expect(front.peak).toEqual({ n: 2, min: 101, p50: 101.5, max: 102 });
		expect(front.failed).toBe(0);
		expect(fake.seen.filter((l) => l.startsWith('POST /recycle'))).toHaveLength(2);
		expect(logs.join('\n')).not.toMatch(/owner-secret|admin-secret|secret-cookie/);
	});

	it('counts a drive whose isolate id changed as failed, and only that drive', async () => {
		const fake = fakeWordpress({ resetOnRoute: 2 });
		const s = newSession(
			'http://site.test',
			'wordpress',
			{ CENSUS_OWNER_TOKEN: 'o', CENSUS_ADMIN_PASS: 'p' },
			[],
			fake.fetch,
			() => undefined
		);
		s.sleep = quiet;
		const run = await runCensus(s, routesFor('wordpress', ['front']), {
			n: 3,
			cold: 'none',
			name: 'cfw-wp-00000000',
			gapMs: 0
		});
		expect(run.summaries[0]).toMatchObject({ drives: 3, failed: 1, incarnationChanged: 1 });
		expect(run.drives.filter((d) => d.verdict.failed).map((d) => d.i)).toEqual([1]);
		expect(fake.seen.some((l) => l.startsWith('POST /recycle'))).toBe(false);
	});

	it('refuses to start with no owner token and no claim', async () => {
		const fake = fakeWordpress();
		const s = newSession('http://site.test', 'wordpress', {}, [], fake.fetch, () => undefined);
		s.sleep = quiet;
		s.owner = '';
		s.adminPass = 'x';
		await expect(
			runCensus(s, routesFor('wordpress', ['front']), {
				n: 1,
				cold: 'none',
				name: 'n',
				gapMs: 0
			})
		).rejects.toThrow(/readiness|never answered|owner token/);
	});

	it('removes the owner token from printed text', () => {
		expect(redact('Bearer owner-secret and owner-secret', ['owner-secret', ''])).toBe(
			'Bearer [redacted] and [redacted]'
		);
	});
});
