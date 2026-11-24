import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	assembleTable,
	assertBudget,
	CACHED_HITS,
	CACHED_PLAN,
	cachedInputs,
	cachedPlanLines,
	CookieJar,
	countBudget,
	describeProbe,
	formatTable,
	joinEvents,
	loginBody,
	meterDelta,
	NAME_RE,
	PACK_FILES,
	PAGE_CACHE_VAR,
	parseProbeBody,
	parseWpOptions,
	pickMeters,
	planLines,
	planRequests,
	PROBE_KEY,
	REQUEST_CEILING,
	REQUEST_PLAN,
	rigTagFromUrl,
	show,
	stageAssets,
	stageProblems,
	TAG_PARAM,
	tagFor,
	withProbe,
	withTag,
	wpConfig,
	wpRows,
	wpVars,
	type PlanStep,
	type RequestRecord
} from '../../../scripts/measure/wordpress-deployed';
import { PAGE_CACHE_SETTING } from '../../../src/wordpress/store-rule';

const root = resolve(import.meta.dirname, '../../..');

describe('the request plan', () => {
	it('stays under the request ceiling', () => {
		const b = countBudget();
		expect(b.total).toBeLessThan(REQUEST_CEILING);
		expect(b.measured).toBe(REQUEST_PLAN.reduce((a, s) => a + s.n, 0));
		expect(() => assertBudget()).not.toThrow();
	});

	it('refuses a plan that sends more than the ceiling', () => {
		const big: PlanStep[] = [{ ...(REQUEST_PLAN[0] as PlanStep), n: REQUEST_CEILING }];
		expect(() => assertBudget(big)).toThrow(/ceiling is 600/);
	});

	it('gives every tagged request its own tag and an untagged step none', () => {
		const reqs = planRequests('cfw-wp-0a1b2c3d');
		const tags = reqs.map((r) => r.tag).filter((t): t is string => t !== null);
		expect(new Set(tags).size).toBe(tags.length);
		expect(reqs.filter((r) => r.step === 'cached').every((r) => r.tag === null)).toBe(true);
		expect(reqs.filter((r) => r.step === 'cached')).toHaveLength(11);
		expect(reqs[0]?.path).toBe(`/?${TAG_PARAM}=cfw-wp-0a1b2c3d-cold-0`);
	});

	it('does not use a WordPress query variable as the tag name', () => {
		expect(TAG_PARAM).not.toBe('tag');
		expect(withTag('/?p=1', 'x')).toBe(`/?p=1&${TAG_PARAM}=x`);
		expect(tagFor('n', 'warm', 3)).toBe('n-warm-3');
	});

	it('runs each phase and the route families n of 5 or more', () => {
		for (const id of ['phase-boot-only', 'phase-load', 'phase-render']) {
			expect(REQUEST_PLAN.find((s) => s.id === id)?.n).toBeGreaterThanOrEqual(5);
		}
		expect(REQUEST_PLAN.find((s) => s.id === 'warm')?.n).toBe(10);
		expect(REQUEST_PLAN.find((s) => s.id === 'cached')?.n).toBe(11);
	});
});

describe('the command line', () => {
	it('defaults to a fresh cfw-wp name and reads --dry', () => {
		const o = parseWpOptions(['--dry']);
		expect(o.mode).toBe('dry');
		expect(o.name).toMatch(NAME_RE);
	});

	it('keeps --dry when it comes with --deployed, as headlines does', () => {
		const o = parseWpOptions(['--deployed', '--account=student', '--dry']);
		expect(o.mode).toBe('dry');
	});

	it('refuses --deployed without the student account, an id, a bad name and no mode', () => {
		expect(() => parseWpOptions(['--deployed'])).toThrow(/account=student/);
		expect(() => parseWpOptions(['--deployed', '--account=abc123'])).toThrow(/account=student/);
		expect(() =>
			parseWpOptions(['--deployed', '--account=student', '--name=cfw-wp-zz'])
		).toThrow(/cfw-wp-<8 hex/);
		expect(() => parseWpOptions([])).toThrow(/say one of/);
		expect(() => parseWpOptions(['--local', '--deployed'])).toThrow(/exclusive/);
		expect(() => parseWpOptions(['--local', '--account=student'])).toThrow(/belongs to/);
		expect(() => parseWpOptions(['--wat'])).toThrow(/unknown argument/);
	});

	it('does not echo an account value in the refusal', () => {
		try {
			parseWpOptions(['--local', '--account=SECRETID']);
		} catch (e) {
			expect((e as Error).message).not.toContain('SECRETID');
		}
		try {
			parseWpOptions(['--bogus', '--account=SECRETID']);
		} catch (e) {
			expect((e as Error).message).not.toContain('SECRETID');
		}
	});
});

describe('the throwaway config and assets', () => {
	it('sets the WordPress vars and leaves the cache setting unset, so the shipped default runs', () => {
		const v = wpVars();
		expect(v).toMatchObject({
			CMS: 'wordpress',
			PLAN: 'free',
			SITE_WARM: '0',
			RETAIN_INTERPRETER: '0'
		});
		expect(PAGE_CACHE_VAR).toBe(PAGE_CACHE_SETTING);
		expect(v[PAGE_CACHE_VAR]).toBeUndefined();
		expect(wpVars('http://localhost:8795').SITE_ORIGIN).toBe('http://localhost:8795');
		expect(v.SITE_ORIGIN).toBeUndefined();
	});

	it('strips every binding the free account lacks and points assets at the staged directory', () => {
		const cfg = wpConfig('cfw-wp-0a1b2c3d', '/repo', '/stage');
		for (const dropped of [
			'kv_namespaces',
			'd1_databases',
			'r2_buckets',
			'triggers',
			'build'
		]) {
			expect(cfg).not.toHaveProperty(dropped);
		}
		expect(cfg.assets).toEqual({ directory: '/stage', binding: 'ASSETS' });
	});

	it('adds the probe to a copy of the driver map and refuses a second one', () => {
		const driver = { 'wp-content/db.php': 'a' };
		const out = withProbe(driver, 'p');
		expect(out[PROBE_KEY]).toBe('p');
		expect(driver).toEqual({ 'wp-content/db.php': 'a' });
		expect(() => withProbe(out, 'p')).toThrow(/already holds a probe/);
	});

	it('flags too many files and an asset over the per-asset size', () => {
		expect(stageProblems([{ path: 'a', bytes: 1 }])).toEqual([]);
		expect(stageProblems([{ path: 'big', bytes: 26 * 1024 * 1024 }])[0]).toMatch(/big is/);
		const many = Array.from({ length: 20_001 }, (_, i) => ({ path: String(i), bytes: 1 }));
		expect(stageProblems(many)[0]).toMatch(/20001 files/);
	});

	it('stages the pack with the probe in the driver map and leaves the repo pack alone', () => {
		const out = mkdtempSync(join(tmpdir(), 'wp-rig-spec-'));
		const files = stageAssets(root, out, '<?php // probe');
		expect(files.map((f) => f.path)).toEqual(expect.arrayContaining([...PACK_FILES]));
		expect(files.some((f) => f.path.startsWith('wordpress/sql/'))).toBe(true);
		const staged = JSON.parse(readFileSync(join(out, 'wordpress/driver.json'), 'utf8'));
		const repo = JSON.parse(readFileSync(join(root, 'assets/wordpress/driver.json'), 'utf8'));
		expect(staged[PROBE_KEY]).toBe('<?php // probe');
		expect(repo[PROBE_KEY]).toBeUndefined();
	});

	it('prints a plan that names the missing variables without calling anything', () => {
		const out = mkdtempSync(join(tmpdir(), 'wp-rig-spec-'));
		const files = stageAssets(root, out, 'p');
		const text = planLines('cfw-wp-0a1b2c3d', root, files, {}).join('\n');
		expect(text).toContain(
			'MISSING: STUDENT_CLOUDFLARE_ACCOUNT_ID, STUDENT_CLOUDFLARE_API_TOKEN'
		);
		expect(text).toContain('gmux-e17');
		expect(text).toContain('of 600');
		const set = planLines('cfw-wp-0a1b2c3d', root, files, {
			STUDENT_CLOUDFLARE_ACCOUNT_ID: 'x',
			STUDENT_CLOUDFLARE_API_TOKEN: 'y'
		}).join('\n');
		expect(set).toContain('both set');
		expect(set).not.toContain('"x"');
	});
});

describe('the probe result', () => {
	const good = {
		gdInfo: false,
		imagecreatefromstring: false,
		curlInit: true,
		blockExternal: true,
		remoteGet: { error: 'http_request_not_executed: blocked' },
		curlExec: { ok: false, status: 0, errno: 6, error: 'x' }
	};

	it('reads the JSON between the markers', () => {
		const p = parseProbeBody(`<html>CFWPROBE${JSON.stringify(good)}CFWPROBE</html>`);
		expect(p.ok).toBe(true);
		const text = describeProbe(p).join('\n');
		expect(text).toContain('gd_info() answered false');
		expect(text).toContain("imagecreatefromstring') = false");
	});

	it('says why a body is not a probe result', () => {
		expect(parseProbeBody('no markers')).toEqual({
			ok: false,
			reason: 'no CFWPROBE markers in the body'
		});
		expect(parseProbeBody('CFWPROBE{nope}CFWPROBE')).toEqual({
			ok: false,
			reason: 'the probe JSON did not parse'
		});
		expect(parseProbeBody('CFWPROBE42CFWPROBE')).toEqual({
			ok: false,
			reason: 'the probe JSON is not an object'
		});
		expect(describeProbe({ ok: false, reason: 'r' })).toEqual(['probe unreadable: r']);
	});

	it('describes an array answer from gd_info as an array', () => {
		const p = parseProbeBody(
			`CFWPROBE${JSON.stringify({ ...good, gdInfo: { a: 1, b: 2 } })}CFWPROBE`
		);
		expect(describeProbe(p)[0]).toContain('array of 2 keys');
	});
});

const ev = (
	cpu: number,
	opts: { type?: string; url?: string; at?: number; wall?: number; outcome?: string } = {}
) => ({
	timestamp: opts.at,
	$workers: {
		cpuTimeMs: cpu,
		wallTimeMs: opts.wall ?? cpu,
		outcome: opts.outcome ?? 'ok',
		eventType: opts.type ?? 'fetch',
		...(opts.url ? { event: { request: { url: opts.url } } } : {})
	}
});
const body = (events: unknown[]) => ({ result: { events: { events } } });

describe('events and the join', () => {
	it('reads the rig tag from a plain or percent-encoded url and nothing else', () => {
		expect(rigTagFromUrl(`https://w/?a=1&${TAG_PARAM}=t-1`)).toBe('t-1');
		expect(rigTagFromUrl(`https://w/__serve?path=%2F%3F${TAG_PARAM}%3Dt-2`)).toBe('t-2');
		expect(rigTagFromUrl('https://w/?tag=t-3')).toBeNull();
		expect(rigTagFromUrl(undefined)).toBeNull();
	});

	it('keeps one row per invocation and skips the log event that carries no cpuTime', () => {
		const rows = wpRows(
			body([
				ev(5, { url: `https://w/?${TAG_PARAM}=a`, at: 10 }),
				{ $workers: { outcome: 'ok' } }
			])
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ tag: 'a', cpuMs: 5, cls: 'fetch', at: 10 });
	});

	const rec = (
		step: string,
		i: number,
		tag: string | null,
		startedAt: number,
		endedAt: number
	): RequestRecord => ({
		step,
		i,
		tag,
		method: 'GET',
		status: 200,
		bytes: 100,
		startedAt,
		endedAt,
		headers: { 'x-worker-ms': '20' }
	});

	it('joins a tagged request to its front event and the object invocation inside its span', () => {
		const front = wpRows(
			body([ev(3, { url: `https://w/?${TAG_PARAM}=t0`, at: 1000, wall: 100 })])
		);
		const objs = wpRows(
			body([ev(40, { at: 960 }), ev(7, { at: 5000 }), ev(9, { type: 'alarm', at: 990 })])
		);
		const [j] = joinEvents([rec('cold', 0, 't0', 900, 1010)], front, objs);
		expect(j?.front?.cpuMs).toBe(3);
		expect(j?.objects.map((o) => o.cpuMs)).toEqual([40]);
	});

	it('leaves a request unjoined when its tag has no event or two', () => {
		const one = wpRows(body([ev(3, { url: `https://w/?${TAG_PARAM}=t0`, at: 1000 })]));
		const two = wpRows(
			body([
				ev(3, { url: `https://w/?${TAG_PARAM}=t0`, at: 1000 }),
				ev(4, { url: `https://w/?${TAG_PARAM}=t0`, at: 1100 })
			])
		);
		expect(joinEvents([rec('a', 0, 'nope', 0, 1)], one, [])[0]?.front).toBeUndefined();
		expect(joinEvents([rec('a', 0, 't0', 0, 1)], two, [])[0]?.front).toBeUndefined();
	});

	it('joins an untagged step by its window only when the event count equals the requests sent', () => {
		const rs = [rec('cached', 0, null, 1000, 1100), rec('cached', 1, null, 1200, 1300)];
		const exact = wpRows(body([ev(1, { at: 1105 }), ev(2, { at: 1305 })]));
		const joined = joinEvents(rs, exact, []);
		expect(joined.map((j) => j.front?.cpuMs)).toEqual([1, 2]);
		const extra = wpRows(body([ev(1, { at: 1105 }), ev(2, { at: 1305 }), ev(3, { at: 1400 })]));
		expect(joinEvents(rs, extra, []).every((j) => j.front === undefined)).toBe(true);
		const tagged = wpRows(body([ev(1, { url: `https://w/?${TAG_PARAM}=z`, at: 1105 })]));
		expect(joinEvents(rs, tagged, []).every((j) => j.front === undefined)).toBe(true);
	});
});

describe('the table', () => {
	const plan: PlanStep[] = [
		{ id: 's', label: 'a step', method: 'GET', path: '/', n: 5, tagged: true, auth: 'none' }
	];
	const records: RequestRecord[] = [10, 12, 11, 13, 40].map((ms, i) => ({
		step: 's',
		i,
		tag: `t${i}`,
		method: 'GET',
		status: i === 4 ? 500 : 200,
		bytes: 1000 + i,
		startedAt: i * 1000,
		endedAt: i * 1000 + 50,
		headers: { 'x-worker-ms': String(ms), 'x-cfw-cache': 'RENDER' }
	}));

	it('prints n and spread, the status mix and the wall hop for a local run, and says CPU was not read', () => {
		const [row] = assembleTable(records, undefined, plan);
		expect(row?.statuses).toBe('200 x4, 500 x1');
		expect(row?.workerMs).toContain('n=5 p50 12, min 10, max 40');
		expect(row?.frontCpu).toBe('not read (local)');
		expect(formatTable(row ? [row] : []).join('\n')).toContain('x-worker-ms (the hop, wall)');
	});

	it('sums the object invocations per request and reports how many joined', () => {
		const front = wpRows(
			body(
				records.map((_, i) =>
					ev(2 + i, { url: `https://w/?${TAG_PARAM}=t${i}`, at: i * 1000 + 40, wall: 40 })
				)
			)
		);
		const objs = wpRows(body(records.map((_, i) => ev(30 + i, { at: i * 1000 + 30 }))));
		const [row] = assembleTable(records, joinEvents(records, front, objs), plan);
		expect(row?.joined).toBe('5 of 5');
		expect(row?.objectCpu).toContain('n=5 p50 32, min 30, max 34');
		expect(row?.frontCpu).toContain('p50 4');
		expect(row?.objectInvocations).toBe('1 x5');
	});

	it('refuses a figure below n of 5 and prints the raw values', () => {
		expect(show([1, 2, 3])).toContain('below the floor');
		expect(show([])).toBe('none');
		expect(show([1, 2, 3, 4, 5])).toContain('n=5 p50 3');
	});

	it('reads the meter fields that matter and the ones that moved', () => {
		const picked = pickMeters({
			rowsToday: 10,
			other: 1,
			wordpressTags: { a: 1 },
			wordpressBoot: { boots: 3 },
			alarmFirings: 7,
			lastAlarmAt: 1,
			heapsReused: 2
		});
		expect(picked).toEqual({
			rowsToday: 10,
			wordpressTags: { a: 1 },
			wordpressBoot: { boots: 3 },
			alarmFirings: 7,
			heapsReused: 2
		});
		expect(pickMeters(null)).toEqual({});
		expect(
			meterDelta({ rowsToday: 10, heapsReused: 2 }, { rowsToday: 14, heapsReused: 2 })
		).toEqual({
			rowsToday: '10 -> 14 (+4)'
		});
	});
});

describe('the cookie jar', () => {
	it('holds a cookie, drops one cleared by a past expiry or max-age 0, and is empty without any', () => {
		const jar = new CookieJar();
		expect(jar.header()).toBeUndefined();
		jar.take(['a=1; Path=/', 'b=2; Path=/']);
		expect(jar.header()).toBe('a=1; b=2');
		jar.take(['a=deleted; expires=Wed, 01 Jan 2020 00:00:00 GMT']);
		jar.take(['b=x; Max-Age=0']);
		expect(jar.size).toBe(0);
	});

	it('does not clear a cookie whose expiry is in the future', () => {
		const jar = new CookieJar();
		jar.take(['a=1; expires=Wed, 01 Jan 2099 00:00:00 GMT']);
		expect(jar.size).toBe(1);
	});

	it('builds a login body with the test cookie flag and the admin redirect', () => {
		const b = new URLSearchParams(loginBody('u', 'p', 'http://h'));
		expect(b.get('redirect_to')).toBe('http://h/wp-admin/');
		expect(b.get('testcookie')).toBe('1');
	});
});

describe('the phase marker in the request fragment', () => {
	const fragment = readFileSync(join(root, 'src/site/php/wordpress/request.php'), 'utf8');

	function run(headers: Record<string, string>): { stdout: string; failed: boolean } {
		const req = {
			origin: 'http://localhost',
			path: '/',
			method: 'GET',
			clientIp: '',
			accept: '',
			cookie: '',
			contentType: '',
			bodyBase64: '',
			headers
		};
		const literal = `'${JSON.stringify(req).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
		const source = fragment
			.replace('// __CFW_HOST_HELPERS__', '')
			.replace('__CFW_REQUEST__', literal);
		const file = join(mkdtempSync(join(tmpdir(), 'wp-phase-')), 'request.php');
		writeFileSync(file, source);
		const r = spawnSync('php', [file], { encoding: 'utf8' });
		return { stdout: r.stdout, failed: r.status !== 0 };
	}

	it('answers boot-only without loading WordPress when the header is present', () => {
		const r = run({ 'x-cfw-phase': 'boot-only' });
		expect(r.failed).toBe(false);
		expect(JSON.parse(r.stdout)).toMatchObject({ status: 200, entry: 'boot-only', bytes: 0 });
	});

	it('does nothing special without the header, so the request goes on to WordPress', () => {
		const r = run({});
		expect(r.stdout).not.toContain('"entry":"boot-only"');
	});

	it('ignores a phase value it does not know', () => {
		const r = run({ 'x-cfw-phase': 'nonsense' });
		expect(r.stdout).not.toContain('"entry":"boot-only"');
	});
});

describe('the cached plan', () => {
	it('fills each route once, hits it, publishes once and refills what the publish purged', () => {
		const ids = CACHED_PLAN.map((s) => s.id);
		for (const r of ['home', 'post', 'page', 'category', 'feed']) {
			expect(ids).toContain(`fill-${r}`);
			expect(CACHED_PLAN.find((s) => s.id === `hit-${r}`)?.n).toBe(CACHED_HITS);
		}
		expect(CACHED_PLAN.find((s) => s.id === 'publish')?.n).toBe(1);
		expect(ids.filter((i) => i.startsWith('refill-'))).toEqual([
			'refill-home',
			'refill-category',
			'refill-feed'
		]);
		expect(() => assertBudget(CACHED_PLAN)).not.toThrow();
	});

	it('sends every page request untagged, because a rig tag makes the path one the store refuses', () => {
		for (const s of CACHED_PLAN.filter((x) => x.method === 'GET' && x.id !== 'rest-nonce')) {
			expect(s.tagged, s.id).toBe(false);
		}
	});

	it('meters each fill and the publish, and counts the reads in the budget', () => {
		const metered = CACHED_PLAN.filter((s) => s.meter).map((s) => s.id);
		expect(metered).toHaveLength(9);
		expect(countBudget(CACHED_PLAN).setup).toBe(countBudget(REQUEST_PLAN).setup + 18);
	});

	it('takes --plan, and runs the dry plan with no credential', () => {
		expect(parseWpOptions(['--dry', '--plan=cached']).plan).toBe('cached');
		expect(parseWpOptions(['--dry']).plan).toBe('full');
		expect(() => parseWpOptions(['--dry', '--plan=other'])).toThrow('--plan takes');
		const lines = cachedPlanLines().join('\n');
		expect(lines).toContain('8 fills, 53 hits, 1 publish');
		expect(lines).toContain('stays assumed');
	});

	it('prints the envelope inputs from a run and says unread where it has no source', () => {
		const rec = (step: string, ms: number): RequestRecord => ({
			step,
			i: 0,
			tag: null,
			method: 'GET',
			status: 200,
			bytes: 1,
			startedAt: 0,
			endedAt: 1,
			headers: { 'x-worker-ms': String(ms) }
		});
		const lines = cachedInputs(
			[rec('fill-home', 2000), rec('fill-post', 1800), rec('hit-home', 40)],
			undefined,
			{ 'fill-home': 9, 'fill-post': 7, publish: 20 }
		).join('\n');
		expect(lines).toContain('home: fill wall 2000 ms (p50, n=1)');
		expect(lines).toContain('fill rows 9');
		expect(lines).toContain('fill object cpu unread');
		expect(lines).toContain('page: fill wall unread');
		expect(lines).toContain('publish rows 20');
		expect(lines).toContain('WORDPRESS_ROWS_PER_FILL candidate: 9 rows');
	});
});

describe('the shipped-vars config for a soak', () => {
	it('leaves diagnostics out on request, and takes --emit-config alone', () => {
		expect(wpVars(undefined, false).PW_DIAGNOSTICS).toBeUndefined();
		expect(wpVars().PW_DIAGNOSTICS).toBe('1');
		const cfg = wpConfig('cfw-wp-0a1b2c3d', '/repo', '/stage', undefined, false);
		expect((cfg.vars as Record<string, string>).PW_DIAGNOSTICS).toBeUndefined();
		expect((cfg.vars as Record<string, string>)[PAGE_CACHE_VAR]).toBeUndefined();
		const o = parseWpOptions(['--emit-config', '--no-diagnostics']);
		expect(o.mode).toBe('emit-config');
		expect(o.diagnostics).toBe(false);
		expect(() => parseWpOptions(['--emit-config', '--dry'])).toThrow(/exclusive/);
	});
});
