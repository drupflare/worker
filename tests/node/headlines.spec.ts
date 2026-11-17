import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as measured from '../../scripts/economics/measured';
import {
	ARM_N,
	assembledCold,
	assembleFacts,
	baselineProblems,
	chainedAlarmSums,
	childEnv,
	classedRows,
	classOfEventType,
	classTable,
	diffIsEmpty,
	eventTypeOf,
	filledCold,
	formatChain,
	formatClassTable,
	HEADLINES,
	inventoryDiff,
	judgeArm,
	KNOWN_BASELINE,
	literalValue,
	localReport,
	measureArms,
	measuredLiteralNames,
	namesFrom,
	NOT_HEADLINES,
	parseOptions,
	priceRun,
	readingOf,
	readInventory,
	redact,
	redactDump,
	registryGaps,
	runDeployed,
	sampleOf,
	splitDriven,
	studentCredentials,
	tagOfEvent,
	throwawayConfig,
	type Deps,
	type Inventory
} from '../../scripts/measure/headlines';

const creds = { id: 'acct-student-1', token: 'tok-student-1' };
const env = {
	STUDENT_CLOUDFLARE_ACCOUNT_ID: creds.id,
	STUDENT_CLOUDFLARE_API_TOKEN: creds.token
};

describe('the headline registry', () => {
	it('names every literal exported by measured.ts, or says why it is not a headline', () => {
		const gaps = registryGaps(measuredLiteralNames());
		expect(gaps).toEqual({ unregistered: [], stale: [] });
	});

	it('reports a literal no entry names and an entry whose literal is gone', () => {
		const gaps = registryGaps(
			[...measuredLiteralNames(), 'NEW_LITERAL_MS'].filter((n) => n !== 'PARK_TAX_MS')
		);
		expect(gaps.unregistered).toEqual(['NEW_LITERAL_MS']);
		expect(gaps.stale).toEqual(['PARK_TAX_MS']);
	});

	it('keeps a name out of both the headlines and the exemptions', () => {
		const named = HEADLINES.flatMap((h) => h.literals);
		expect(named.filter((n) => n in NOT_HEADLINES)).toEqual([]);
	});

	it('reads each compared literal from measured.ts by import', () => {
		expect(literalValue('COLD_BOOT_MS')).toBe(measured.COLD_BOOT_MS);
		expect(literalValue('CACHED_SERVE_TOTAL_MS')).toBe(measured.CACHED_SERVE_TOTAL_MS);
	});
});

describe('readings', () => {
	it('refuses below five samples and reports n, p50, min, max and mean above', () => {
		expect(readingOf([1, 2, 3, 4])).toBeNull();
		expect(readingOf([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, min: 1, max: 5, mean: 3 });
	});

	const row = (cpuMs: number, outcome = 'ok') => ({ tag: null, cpuMs, wallMs: 0, outcome });

	it('is ok only when every sample was valid and the window holds exactly the driven count', () => {
		const rows = [1, 2, 3, 4, 5].map((v) => row(v));
		expect(judgeArm({ driven: 5, valid: 5, observed: rows }).status).toBe('ok');
		const extra = judgeArm({ driven: 5, valid: 5, observed: [...rows, row(900)] });
		expect(extra).toMatchObject({ status: 'unresolved' });
		expect((extra as { reasons: string[] }).reasons[0]).toContain('6 object fetch invocations');
	});

	it('is unresolved on an invalid sample or a non-ok outcome', () => {
		const rows = [1, 2, 3, 4, 5].map((v, i) => row(v, i === 0 ? 'exceededCpu' : 'ok'));
		const v = judgeArm({ driven: 5, valid: 4, observed: rows });
		expect(v.status).toBe('unresolved');
		expect((v as { reasons: string[] }).reasons).toHaveLength(2);
	});
});

describe('the command line', () => {
	it('defaults to local and takes no account or name there', () => {
		expect(parseOptions([]).mode).toBe('local');
		expect(() => parseOptions(['--local', '--name=cfw-headlines-a'])).toThrow(
			/belong to --deployed/
		);
	});

	it('refuses --deployed without --account=student', () => {
		expect(() => parseOptions(['--deployed', '--name=cfw-headlines-a'])).toThrow(
			/--account=student/
		);
	});

	it('refuses an account that is not the word student, without echoing it', () => {
		const id = '0123456789abcdef0123456789abcdef';
		expect(() =>
			parseOptions(['--deployed', `--account=${id}`, '--name=cfw-headlines-a'])
		).toThrow(/--account=student/);
		try {
			parseOptions(['--deployed', `--account=${id}`, '--name=cfw-headlines-a']);
		} catch (e) {
			expect((e as Error).message).not.toContain(id);
		}
	});

	it('refuses a name outside cfw-headlines-<suffix>', () => {
		expect(() => parseOptions(['--deployed', '--account=student', '--name=drupflare'])).toThrow(
			/cfw-headlines/
		);
		expect(() =>
			parseOptions(['--deployed', '--account=student', '--name=cfw-headlines-A!'])
		).toThrow();
	});

	it('accepts the full deployed form', () => {
		expect(
			parseOptions(['--deployed', '--account=student', '--name=cfw-headlines-a1', '--dry'])
		).toEqual({
			mode: 'deployed',
			name: 'cfw-headlines-a1',
			dry: true,
			account: 'student'
		});
	});
});

describe('credentials', () => {
	it('needs both student variables', () => {
		expect(() => studentCredentials({})).toThrow(/STUDENT_CLOUDFLARE_ACCOUNT_ID/);
		expect(() => studentCredentials({ STUDENT_CLOUDFLARE_ACCOUNT_ID: 'x' })).toThrow(
			/STUDENT_CLOUDFLARE_API_TOKEN/
		);
	});

	it('refuses a student id that equals the free account id', () => {
		expect(() => studentCredentials({ ...env, FREE_CLOUDFLARE_ACCOUNT_ID: creds.id })).toThrow(
			/non-student/
		);
	});

	it('hands the child only the student pair and drops every other Cloudflare variable', () => {
		const out = childEnv(
			{
				...env,
				PATH: '/bin',
				CLOUDFLARE_ACCOUNT_ID: 'paid-id',
				CLOUDFLARE_API_TOKEN: 'paid-token',
				FREE_CLOUDFLARE_API_TOKEN: 'free-token'
			},
			creds
		);
		expect(out.CLOUDFLARE_ACCOUNT_ID).toBe(creds.id);
		expect(out.CLOUDFLARE_API_TOKEN).toBe(creds.token);
		expect(
			Object.keys(out)
				.filter((k) => /CLOUDFLARE/.test(k))
				.sort()
		).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
		expect(out.PATH).toBe('/bin');
	});

	it('redacts the id and token from printed text', () => {
		expect(redact(`acct ${creds.id} tok ${creds.token}`, [creds.id, creds.token])).toBe(
			'acct [redacted] tok [redacted]'
		);
	});
});

describe('the inventory', () => {
	const clean: Inventory = structuredClone(KNOWN_BASELINE);

	it('accepts exactly the known gmux pair', () => {
		expect(baselineProblems(clean)).toEqual([]);
	});

	it('refuses a worker, namespace, KV or D1 beyond the pair', () => {
		expect(baselineProblems({ ...clean, workers: ['gmux-e17', 'cfw-left-over'] })).toEqual([
			'workers: cfw-left-over'
		]);
		expect(
			baselineProblems({ ...clean, durableObjects: [...clean.durableObjects, 'x_Y'] })
		).toEqual(['durableObjects: x_Y']);
		expect(baselineProblems({ ...clean, kv: ['ns'] })).toEqual(['kv: ns']);
		expect(baselineProblems({ ...clean, d1: ['db'] })).toEqual(['d1: db']);
	});

	it('diffs two inventories and calls an identical pair empty', () => {
		expect(diffIsEmpty(inventoryDiff(clean, clean))).toBe(true);
		const diff = inventoryDiff(clean, {
			...clean,
			durableObjects: [...clean.durableObjects, 'cfw-headlines-a_SitePhpDurableObject']
		});
		expect(diff.durableObjects.added).toEqual(['cfw-headlines-a_SitePhpDurableObject']);
		expect(diffIsEmpty(diff)).toBe(false);
	});

	it('refuses a page that is not the whole list', () => {
		expect(() =>
			namesFrom({ result: [{ id: 'a' }], result_info: { total_count: 2 } }, 'id')
		).toThrow(/incomplete/);
		expect(namesFrom({ result: [{ id: 'b' }, { id: 'a' }] }, 'id')).toEqual(['a', 'b']);
	});

	it('reads the four lists with the student token and no other', async () => {
		const seen: { url: string; auth: string | null }[] = [];
		const fake = (async (url: string, init?: RequestInit) => {
			seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
			const key = url.includes('scripts') ? 'id' : url.includes('kv') ? 'title' : 'name';
			const name = url.includes('scripts')
				? 'gmux-e17'
				: url.includes('durable')
					? 'gmux-e17_MachineDO'
					: null;
			return new Response(
				JSON.stringify({ success: true, result: name ? [{ [key]: name }] : [] })
			);
		}) as unknown as typeof fetch;
		expect(await readInventory(creds, fake)).toEqual(KNOWN_BASELINE);
		expect(seen).toHaveLength(4);
		expect(
			seen.every((s) => s.auth === `Bearer ${creds.token}` && s.url.includes(creds.id))
		).toBe(true);
	});
});

describe('the throwaway deploy', () => {
	const cfg = throwawayConfig('cfw-headlines-a1', '/repo');

	it('keeps the shipping config shape and strips what the free account lacks', () => {
		expect(cfg).toMatchObject({
			name: 'cfw-headlines-a1',
			main: '/repo/src/site.ts',
			observability: { enabled: true },
			alias: { './runtime/php-binary.js': '/repo/src/runtime/php-binary-raw.ts' }
		});
		for (const dropped of [
			'kv_namespaces',
			'd1_databases',
			'r2_buckets',
			'version_metadata',
			'triggers',
			'build'
		]) {
			expect(cfg).not.toHaveProperty(dropped);
		}
		expect((cfg.durable_objects as { bindings: unknown[] }).bindings).toHaveLength(2);
	});

	it('prices a run well inside the free plan daily meters', () => {
		const p = priceRun();
		expect(p.workerRequests).toBeGreaterThanOrEqual(
			Object.values(ARM_N).reduce((a, b) => a + b, 0)
		);
		expect(p.rowsFractionOfDay).toBeLessThan(1);
		expect(p.requestsFractionOfDay).toBeLessThan(1);
	});

	it('prints the literals and no local figure as a headline in --local', () => {
		const text = localReport().join('\n');
		for (const h of HEADLINES) for (const l of h.literals) expect(text).toContain(l);
		expect(text).toContain('not an absolute CPU figure');
	});
});

describe('the deployed run order', () => {
	const baseline = structuredClone(KNOWN_BASELINE);
	const opts = parseOptions(['--deployed', '--account=student', '--name=cfw-headlines-t1']);

	function rig(inventories: Inventory[], measure: Deps['measure']) {
		const calls: string[] = [];
		const logs: string[] = [];
		let inv = 0;
		const deps: Deps = {
			fetch: (async (url: string) => {
				const list = inventories[Math.min(inv, inventories.length - 1)] as Inventory;
				if (url.includes('/d1/')) inv++;
				const rows = url.includes('scripts')
					? list.workers.map((id) => ({ id }))
					: url.includes('durable')
						? list.durableObjects.map((name) => ({ name }))
						: [];
				return new Response(JSON.stringify({ success: true, result: rows }));
			}) as unknown as typeof fetch,
			run: async (_c, args) => {
				calls.push(args[1] as string);
				return { code: 0, out: `https://cfw-headlines-t1.sub.workers.dev ${creds.token}` };
			},
			sleep: async () => {},
			log: (l) => logs.push(l),
			measure
		};
		return { deps, calls, logs };
	}

	it('refuses to deploy when the account holds more than the gmux pair', async () => {
		const { deps, calls } = rig(
			[{ ...baseline, workers: ['gmux-e17', 'someone-else'] }],
			async () => {}
		);
		expect(await runDeployed(opts, env, deps, '/repo')).toBe(2);
		expect(calls).toEqual([]);
	});

	it('tears down and diffs even when the measurement throws, and never prints the token', async () => {
		const { deps, calls, logs } = rig([baseline, baseline], async () => {
			throw new Error('boom');
		});
		expect(await runDeployed(opts, env, deps, '/repo')).toBe(1);
		expect(calls).toEqual(['deploy', 'delete']);
		expect(logs.join('\n')).toContain('inventory diff against the pre-run list: none');
		expect(logs.join('\n')).not.toContain(creds.token);
	});

	it('exits 1 when the teardown leaves something behind', async () => {
		const leaked = {
			...baseline,
			durableObjects: [...baseline.durableObjects, 'cfw-headlines-t1_SitePhpDurableObject']
		};
		const { deps, logs } = rig([baseline, leaked], async () => {});
		expect(await runDeployed(opts, env, deps, '/repo')).toBe(1);
		expect(logs.join('\n')).toContain('cfw-headlines-t1_SitePhpDurableObject');
	});

	it('exits 0 on a clean run', async () => {
		const { deps } = rig([baseline, baseline], async () => {});
		expect(await runDeployed(opts, env, deps, '/repo')).toBe(0);
	});

	it('deploys the config a caller builds instead of the Drupal one', async () => {
		const { deps } = rig([baseline, baseline], async () => {});
		const code = await runDeployed(opts, env, deps, '/repo', (name) => ({
			name,
			marker: 'custom'
		}));
		expect(code).toBe(0);
		const written = readFileSync(
			join(tmpdir(), `headlines-${opts.name}`, 'wrangler.jsonc'),
			'utf8'
		);
		expect(JSON.parse(written)).toEqual({ name: opts.name, marker: 'custom' });
	});
});

describe('event classes', () => {
	const ev = (
		cpu: number,
		eventType?: string,
		opts: { tag?: string; at?: number; outcome?: string } = {}
	) => ({
		timestamp: opts.at,
		$workers: {
			cpuTimeMs: cpu,
			wallTimeMs: cpu + 1,
			outcome: opts.outcome ?? 'ok',
			...(eventType ? { eventType } : {}),
			...(opts.tag
				? {
						event: {
							request: { url: `https://w.example/__serve?site=hl&tag=${opts.tag}` }
						}
					}
				: {})
		}
	});
	const body = (events: unknown[]) => ({ result: { events: { events } } });

	it('classes an event by its type string and never assumes a missing one is a fetch', () => {
		expect(classOfEventType('fetch')).toBe('fetch');
		expect(classOfEventType('alarm')).toBe('alarm');
		expect(classOfEventType('rpc')).toBe('other');
		expect(classOfEventType(null)).toBe('unclassified');
		expect(eventTypeOf(ev(1))).toBeNull();
		expect(eventTypeOf(ev(1, 'alarm'))).toBe('alarm');
	});

	it('reads the tag from the request url, or from the search map when that is present', () => {
		expect(tagOfEvent(ev(1, 'fetch', { tag: 'a-1' }))).toBe('a-1');
		expect(
			tagOfEvent({
				$workers: { event: { search: { tag: 'b-2' }, request: { url: 'https://x/y' } } }
			})
		).toBe('b-2');
		expect(tagOfEvent(ev(1, 'alarm'))).toBeNull();
	});

	it('keeps zero-cost rows and skips the log event that carries no cpuTimeMs', () => {
		const rows = classedRows(
			body([ev(0, 'fetch'), { $workers: { eventType: 'fetch' } }, ev(7, 'alarm')])
		);
		expect(rows.map((r) => [r.cls, r.cpuMs])).toEqual([
			['fetch', 0],
			['alarm', 7]
		]);
	});

	it('takes as driven only the fetches that carry a driven tag, and keeps every other row', () => {
		const rows = classedRows(
			body([
				ev(5, 'fetch', { tag: 't-0' }),
				ev(90, 'alarm'),
				ev(3, 'rpc'),
				ev(4),
				ev(6, 'fetch', { tag: 't-1' }),
				ev(9, 'fetch'),
				ev(8, 'fetch', { tag: 'other-9' })
			])
		);
		const { driven, others, missingTags, duplicateTags } = splitDriven(rows, [
			't-0',
			't-1',
			't-2'
		]);
		expect(driven.map((r) => r.tag)).toEqual(['t-0', 't-1']);
		expect(others.map((r) => r.cls)).toEqual([
			'alarm',
			'other',
			'unclassified',
			'other-fetch',
			'other-fetch'
		]);
		expect(driven.length + others.length).toBe(rows.length);
		expect(missingTags).toEqual(['t-2']);
		expect(duplicateTags).toEqual([]);
	});

	it('names a driven tag that has two invocations', () => {
		const rows = classedRows(
			body([ev(5, 'fetch', { tag: 't-0' }), ev(6, 'fetch', { tag: 't-0' })])
		);
		expect(splitDriven(rows, ['t-0']).duplicateTags).toEqual(['t-0']);
	});

	it('tabulates count, p50 and max per class and omits an absent class', () => {
		const rows = classedRows(
			body([
				ev(10, 'fetch', { tag: 't' }),
				ev(30, 'fetch', { tag: 't' }),
				ev(20, 'fetch', { tag: 't' }),
				ev(5, 'alarm'),
				ev(9, 'alarm')
			])
		);
		const t = classTable(rows);
		expect(t.fetch).toEqual({ n: 3, p50: 20, max: 30 });
		expect(t.alarm).toEqual({ n: 2, p50: 7, max: 9 });
		expect(t.other).toBeUndefined();
		expect(formatClassTable(t)).toBe(
			'fetch n=3 p50 20 ms max 30 ms; alarm n=2 p50 7 ms max 9 ms'
		);
		expect(formatClassTable({})).toBe('no invocations');
	});

	it('judges an arm on the driven rows alone and reports alarms beside it', () => {
		const tags = ['a', 'b', 'c', 'd', 'e'];
		const rows = classedRows(
			body([
				...tags.map((t, i) => ev(i + 1, 'fetch', { tag: t })),
				ev(80, 'alarm'),
				ev(70, 'alarm'),
				ev(9, 'fetch')
			])
		);
		const s = splitDriven(rows, tags);
		expect(
			judgeArm({ driven: 5, valid: 5, observed: s.driven, others: s.others })
		).toMatchObject({ status: 'ok', reading: { n: 5, p50: 3 } });
	});

	it('is unresolved on a missing tag, a duplicate tag or an invocation with no readable type', () => {
		const tags = ['a', 'b', 'c', 'd', 'e'];
		const rows = classedRows(
			body([
				...tags.slice(0, 4).map((t, i) => ev(i + 1, 'fetch', { tag: t })),
				ev(5, 'fetch', { tag: 'a' }),
				ev(9)
			])
		);
		const s = splitDriven(rows, tags);
		const v = judgeArm({
			driven: 5,
			valid: 5,
			observed: s.driven,
			others: s.others,
			missingTags: s.missingTags,
			duplicateTags: s.duplicateTags
		});
		expect(v.status).toBe('unresolved');
		const why = (v as { reasons: string[] }).reasons.join(' | ');
		expect(why).toContain('1 driven tags have no invocation');
		expect(why).toContain('1 driven tags have more than one invocation');
		expect(why).toContain('event type could not be read');
	});

	it('pairs each driven fetch with the alarm that ended just after it, once', () => {
		const rows = classedRows(
			body([
				ev(400, 'fetch', { tag: 'a', at: 1000 }),
				ev(900, 'alarm', { at: 1020 }),
				ev(300, 'fetch', { tag: 'b', at: 5000 }),
				ev(7, 'alarm', { at: 9000 }),
				ev(500, 'fetch', { tag: 'c', at: 20000 }),
				ev(800, 'alarm', { at: 19990 })
			])
		);
		const { driven, others } = splitDriven(rows, ['a', 'b', 'c']);
		expect(chainedAlarmSums(driven, others)).toEqual({ sums: [1300], unpaired: 2 });
		expect(formatChain({ sums: [1300], unpaired: 2 })).toContain('n below');
		expect(formatChain(undefined)).toBeUndefined();
	});
});

describe('the events dump', () => {
	it('removes the secrets, client addresses, credential headers and the account subdomain', () => {
		const dump = {
			url: `https://cfw-headlines-a.my-sub.workers.dev/serve?site=hl&tok=${creds.token}`,
			note: `acct ${creds.id}`,
			events: [
				{
					$workers: {
						cpuTimeMs: 3,
						event: {
							request: {
								headers: {
									'cf-connecting-ip': '203.0.113.9',
									cookie: 'session=abc',
									accept: 'text/html'
								},
								ip: '198.51.100.7'
							}
						}
					}
				}
			]
		};
		const text = JSON.stringify(redactDump(dump, [creds.id, creds.token]));
		for (const leaked of [
			creds.id,
			creds.token,
			'my-sub',
			'203.0.113.9',
			'198.51.100.7',
			'session=abc'
		]) {
			expect(text).not.toContain(leaked);
		}
		expect(text).toContain('cfw-headlines-a.[subdomain].workers.dev');
		expect(text).toContain('"cpuTimeMs":3');
		expect(text).toContain('text/html');
	});

	it('takes --events-out on a deployed run only', () => {
		const opts = parseOptions([
			'--deployed',
			'--account=student',
			'--name=cfw-headlines-a1',
			'--events-out=/tmp/x/events.json'
		]);
		expect(opts.eventsOut).toBe('/tmp/x/events.json');
		expect(() => parseOptions(['--events-out=/tmp/x'])).toThrow(/belong to --deployed/);
		expect(() =>
			parseOptions([
				'--deployed',
				'--account=student',
				'--name=cfw-headlines-a1',
				'--events-out='
			])
		).toThrow(/needs a path/);
	});

	it('writes the dump before teardown and prints its path', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hl-dump-'));
		const out = join(dir, 'nested', 'events.json');
		const order: string[] = [];
		const logs: string[] = [];
		const events = {
			result: {
				events: {
					events: [{ $workers: { cpuTimeMs: 2, eventType: 'fetch', outcome: 'ok' } }]
				}
			}
		};
		const lists = structuredClone(KNOWN_BASELINE);
		const deps: Deps = {
			fetch: (async (url: string) => {
				if (url.includes('observability')) return new Response(JSON.stringify(events));
				if (url.includes('api.cloudflare.com')) {
					const rows = url.includes('scripts')
						? lists.workers.map((id) => ({ id }))
						: url.includes('durable')
							? lists.durableObjects.map((name) => ({ name }))
							: [];
					return new Response(JSON.stringify({ success: true, result: rows }));
				}
				if (url.includes('/migrate')) return new Response('{"done":true}');
				if (url.includes('/serve-stats')) return new Response('{"rowsToday":1}');
				return new Response('ok', { headers: { 'x-cfw-cache': 'HIT' } });
			}) as unknown as typeof fetch,
			run: async (_c, args) => {
				order.push(String(args[1]));
				return { code: 0, out: 'https://cfw-headlines-t1.sub.workers.dev' };
			},
			sleep: async () => {},
			log: (l) => logs.push(l),
			measure: async (ctx) => {
				order.push('measure');
				await measureArms(ctx);
				order.push(existsSync(out) ? 'dump-present' : 'dump-missing');
			}
		};
		const opts = parseOptions([
			'--deployed',
			'--account=student',
			'--name=cfw-headlines-t1',
			`--events-out=${out}`
		]);
		expect(await runDeployed(opts, env, deps, '/repo')).toBe(0);
		expect(order).toEqual(['deploy', 'measure', 'dump-present', 'delete']);
		expect(logs.join('\n')).toContain(out);
		const dump = JSON.parse(readFileSync(out, 'utf8'));
		expect(Object.keys(dump)).toEqual(
			expect.arrayContaining(['worker', 'windows', 'samples', 'armEvents', 'run'])
		);
		expect(JSON.stringify(dump)).not.toContain(creds.token);
	});
});

describe('the cold-bins arm', () => {
	const reply = (body: unknown, status = 200) => ({
		status,
		headers: new Headers(),
		text: JSON.stringify(body)
	});

	it('counts a sample only when the fill booted the interpreter and the dynamic cache missed', () => {
		expect(assembledCold(reply({ bootedInFill: true, dynamicCache: 'MISS' }))).toBe(true);
		expect(assembledCold(reply({ bootedInFill: true, dynamicCache: null }))).toBe(true);
		expect(assembledCold(reply({ bootedInFill: false, dynamicCache: 'MISS' }))).toBe(false);
		expect(assembledCold(reply({ bootedInFill: true, dynamicCache: 'HIT' }))).toBe(false);
		expect(assembledCold(reply({ bootedInFill: true }, 503))).toBe(false);
		expect(assembledCold({ status: 200, headers: new Headers(), text: 'not json' })).toBe(
			false
		);
	});

	it('counts a cold-boot sample only when /fill booted the interpreter and filled the given path', () => {
		expect(filledCold(reply({ bootedInFill: true, filled: '/?cold=t-0' }))).toBe(true);
		expect(filledCold(reply({ bootedInFill: false, filled: '/?cold=t-0' }))).toBe(false);
		expect(filledCold(reply({ bootedInFill: true, filled: '/other' }))).toBe(false);
		expect(filledCold(reply({ bootedInFill: true, filled: null }))).toBe(false);
		expect(filledCold(reply({ bootedInFill: true, filled: '/?cold=t-0' }, 503))).toBe(false);
		expect(filledCold({ status: 200, headers: new Headers(), text: 'x' })).toBe(false);
	});

	it('reads what the render paid for out of the answer', () => {
		expect(
			assembleFacts(
				JSON.stringify({
					bootedInFill: true,
					dynamicCache: 'MISS',
					pageCache: 'MISS',
					rowsWritten: 91,
					wallMs: 3
				})
			)
		).toEqual({
			bootedInFill: true,
			dynamicCache: 'MISS',
			pageCache: 'MISS',
			rowsWritten: 91,
			wallMs: 3
		});
		expect(assembleFacts('<html>')).toBeNull();
	});

	it('idles before each sample so the object hibernates, as the cold-boot arm does', () => {
		const text = HEADLINES.find((h) => h.id === 'render-cold-bins')?.arm ?? '';
		expect(text).toContain('idle');
	});

	it('keeps the headers the arms read and the answer facts in a sample record', () => {
		const s = sampleOf(
			'render-cold-bins',
			't-0',
			1,
			{
				status: 200,
				headers: new Headers({ 'x-cfw-cache': 'RENDER', 'set-cookie': 'a=b' }),
				text: JSON.stringify({ bootedInFill: true })
			},
			true
		);
		expect(s.headers).toEqual({ 'x-cfw-cache': 'RENDER' });
		expect(s.assemble?.bootedInFill).toBe(true);
	});
});
