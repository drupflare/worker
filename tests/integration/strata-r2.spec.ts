import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { SHIPPED_CAPABILITIES } from '../../src/ops/catalog';
import { PARK_PROBE, parkTrapInstall } from '../../src/ops/park';
import { drivePark, ParkSockets, type ParkRun } from '../../src/ops/park-drive';
import { enable, migrate, packedContrib, REQUEST_TIMEOUT } from '../helpers/contrib-pack';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * strata sealing to a local S3 store, read back from outside, and checked by its own drill and sweep.
 *
 * The store is SeaweedFS from `docker/compose.yml`, which answers S3 with no credentials checked, so
 * the access key below is a rig value and not a secret. The PHP runs in the interpreter and every S3
 * request leaves it through the parked fetch path with the outbound guard off for loopback.
 *
 * Needs the rig and the contrib fixture pack:
 *
 *   docker compose -f docker/compose.yml up -d --wait seaweedfs
 *   bun scripts/contrib-fixture.ts --mount
 *   bunx vitest run --project=workers tests/integration/strata-r2.spec.ts
 *
 * Not asserted here: the cron path. `CronCapture::onCron()` ran, but the PHP output stopped after it
 * on the rig, so no reading of the cron stages exists yet.
 */

const ENDPOINT = 'http://127.0.0.1:9000';
const BUCKET = 'strata-backups';
const MARK = '@@RIG@@';

type Interp = ServeDo & { run: (code: string) => Promise<string> };
type Stored = { key: string; size: number };

async function rigUp(): Promise<boolean> {
	try {
		return (await fetch(`${ENDPOINT}/`, { signal: AbortSignal.timeout(4000) })).ok;
	} catch {
		return false;
	}
}

/** the bucket as SeaweedFS lists it, read without strata in the path */
async function list(prefix: string): Promise<Stored[]> {
	const res = await fetch(
		`${ENDPOINT}/${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`
	);
	if (!res.ok) throw new Error(`list ${prefix} answered ${res.status}`);
	return [...(await res.text()).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => {
		const block = m[1] ?? '';
		return {
			key: /<Key>([^<]*)<\/Key>/.exec(block)?.[1] ?? '',
			size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0)
		};
	});
}

async function getObject(key: string): Promise<Uint8Array> {
	const res = await fetch(`${ENDPOINT}/${BUCKET}/${key}`);
	if (!res.ok) throw new Error(`get ${key} answered ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

async function putObject(key: string, body: Uint8Array): Promise<void> {
	const res = await fetch(`${ENDPOINT}/${BUCKET}/${key}`, { method: 'PUT', body });
	if (!res.ok) throw new Error(`put ${key} answered ${res.status}`);
}

async function deleteObject(key: string): Promise<void> {
	const res = await fetch(`${ENDPOINT}/${BUCKET}/${key}`, { method: 'DELETE' });
	if (!res.ok) throw new Error(`delete ${key} answered ${res.status}`);
}

/** the strata settings that point at the rig; the install defaults are written first so `capture` is set */
const SETTINGS = (
	siteId: string
) => String.raw`$base = \Drupal::service('extension.list.module')->getPath('strata') . '/config/install/strata.settings.yml';
\Drupal::configFactory()->getEditable('strata.settings')->setData(\Symfony\Component\Yaml\Yaml::parseFile($base))->save();
\Drupal::configFactory()->getEditable('strata.settings')
  ->set('enabled', TRUE)->set('site_id', '${siteId}')->set('provider', 's3')
  ->set('s3.endpoint', '${ENDPOINT}')->set('s3.bucket', '${BUCKET}')->set('s3.region', 'us-east-1')
  ->set('s3.access_key_id', 'strata')->set('s3.secret_access_key', 'stratatest')
  ->set('s3.path_style', TRUE)->save();
\Drupal::service('strata.capture_scope')->reset();`;

/** a fragment that boots the engine; the first one also mints the site key */
const prelude = (first: boolean) => String.raw`<?php
if (!defined('CSS_COMPONENT')) { require_once '/drupal/core/includes/common.inc'; }
\Drupal::service('request_stack')->push(\Symfony\Component\HttpFoundation\Request::create('/', 'GET'));
\Drupal::moduleHandler()->loadAll();
$e = \Drupal::service('strata.engine');
${first ? String.raw`\Drupal::configFactory()->getEditable('strata.settings')->set('key', \Drupal::service('strata.key_maker')->create())->save();` : ''}
$out = [];
$stage = function (string $name, callable $fn) use (&$out) {
  try { $r = $fn(); $out[$name] = $r instanceof \JsonSerializable ? $r->jsonSerialize() : $r; }
  catch (\Throwable $t) { $out[$name] = 'threw ' . get_class($t) . ': ' . substr($t->getMessage(), 0, 300); }
};`;

/** the drill and the sweep, the two checks strata runs on cron, read the same way in every drive */
const judge = String.raw`
$stage('drill', function () use ($e) {
  $d = $e->drillRunner()->run(NULL, 0);
  return ['verdict' => $d->verdict(), 'matched' => count($d->matched), 'differed' => count($d->differed),
    'unreadable' => count($d->unreadable), 'refused' => $d->refused];
});
$stage('sweep', function () use ($e) {
  $v = $e->verifier()->verify();
  return ['frames' => $v->frames, 'complete' => $v->complete,
    'codes' => array_values(array_unique(array_map(fn($f) => (string) $f->code, $v->findings)))];
});
echo "\n${MARK}" . json_encode($out, JSON_PARTIAL_OUTPUT_ON_ERROR);`;

type Verdict = {
	state: string;
	drill?: { verdict: string; matched: number; differed: number; unreadable: number };
	sweep?: { frames: number; complete: boolean; codes: string[] };
	'strata failures'?: string[];
	parseError?: boolean;
};

async function drive(
	site: ServeDo,
	body: string,
	first: boolean,
	siteId: string
): Promise<Verdict> {
	const one = site as Interp;
	const sockets = new ParkSockets();
	try {
		const run: ParkRun = await drivePark(
			{ runText: (c: string) => one.run(c) },
			sockets,
			{ OUTBOUND_GUARD: '0' },
			prelude(first) + body
		);
		const at = run.output.indexOf(MARK);
		if (at < 0) return { state: run.state, parseError: true };
		return { state: run.state, ...JSON.parse(run.output.slice(at + MARK.length)) };
	} finally {
		await sockets.closeAll();
	}
}

describe('strata against a local S3 store', () => {
	it(
		'seals to the store, and a drill and sweep catch a missing and a corrupt frame',
		async (ctx) => {
			const packed = await packedContrib();
			if (!packed.has('strata')) {
				ctx.skip(
					'strata is not in the mounted pack; `bun scripts/contrib-fixture.ts --mount` builds it'
				);
				return;
			}
			if (!(await rigUp())) {
				ctx.skip(
					`SeaweedFS is not answering on ${ENDPOINT}; start it with docker compose up -d --wait seaweedfs`
				);
				return;
			}
			expect(SHIPPED_CAPABILITIES.blockingOutbound).toBe(true);

			const siteId = `rig-${Date.now()}`;
			const prefix = `_strata/${siteId}/`;
			expect(await list(prefix), 'the rig prefix was not empty before the seal').toEqual([]);

			const result = await inObject(freshSite(), async (site) => {
				await migrate(site);
				await enable(site, 'strata');
				await enable(site, 'strata_s3');
				await site.runJson(BOOT_KERNEL);
				await site.runJson(`<?php\n${SETTINGS(siteId)}\necho json_encode(['ok' => true]);`);
				await site.runJson(BOOT_KERNEL);
				if ((await site.runJson(PARK_PROBE))['park'] !== true)
					return { build: 'absent' as const };
				await site.runJson(parkTrapInstall(['fetch']));

				const seal = String.raw`
for ($i = 0; $i < 4; $i++) {
  \Drupal\user\Entity\User::create(['name' => "rig-user-$i", 'mail' => "rig$i@example.test", 'status' => 1])->save();
}
$stage('reconcile', fn() => $e->reconciler()->reconcile());
$stage('flush', fn() => $e->flusher()->flush(true));
echo "\n${MARK}" . json_encode($out, JSON_PARTIAL_OUTPUT_ON_ERROR);`;

				/** read in a later drive: a log row written during a run is not visible to a read inside that run */
				const strataFailures = String.raw`
$out['strata failures'] = array_values(array_map(
  fn($r) => substr(strtr($r->message, @unserialize((string) $r->variables, ['allowed_classes' => false]) ?: []), 0, 200),
  \Drupal::database()->select('watchdog', 'w')->fields('w', ['message', 'variables'])
    ->condition('type', 'strata')->condition('message', 'Strata could not%', 'LIKE')
    ->execute()->fetchAll()
));
echo "\n${MARK}" . json_encode($out, JSON_PARTIAL_OUTPUT_ON_ERROR);`;
				const sealRun = await drive(site, seal, true, siteId);
				const stored = await list(prefix);
				const heads: string[] = [];
				for (const o of stored) {
					const head = (await getObject(o.key)).slice(0, 16);
					heads.push(
						`${o.key.slice(prefix.length)} ${o.size} ${Array.from(head, (b) => b.toString(16).padStart(2, '0')).join(' ')}`
					);
				}
				console.log(`[strata-r2] objects\n${heads.join('\n')}`);
				const victim = stored.find((o) => o.key.includes('/packs/'))?.key ?? '';
				const saved = victim ? await getObject(victim) : new Uint8Array();

				const steps: Record<string, Verdict> = { seal: sealRun };
				if (victim) await deleteObject(victim);
				steps.missing = await drive(site, judge, false, siteId);
				await putObject(victim, saved);
				steps.restored = await drive(site, judge, false, siteId);

				const flipped = new Uint8Array(saved);
				const at = Math.floor(flipped.length / 2);
				flipped[at] = (flipped[at] ?? 0) ^ 1;
				await putObject(victim, flipped);
				const control = await getObject(victim);
				steps.corrupt = await drive(site, judge, false, siteId);
				await putObject(victim, saved);
				steps.healed = await drive(site, judge, false, siteId);

				const cronRun = String.raw`
$cron = \Drupal::service('Drupal\strata\Hook\CronCapture');
$state = fn() => ['drill.ran' => \Drupal::state()->get('strata.drill.ran'), 'compaction.ran' => \Drupal::state()->get('strata.compaction.ran'), 'drillRows' => count($e->drillIndex()->verdicts(100)), 'objects' => count($e->provider()->list('_strata/', NULL, 1000))];
$out['cron before'] = $state();
$stage('cron', function () use ($cron) { $cron->onCron(); return 'ran'; });
$out['cron after'] = $state();
echo "\n${MARK}" . json_encode($out, JSON_PARTIAL_OUTPUT_ON_ERROR);`;
				steps.cron = await drive(site, cronRun, false, siteId);
				const strataLog = (await drive(site, strataFailures, false, siteId))[
					'strata failures'
				];

				const mutations: {
					label: string;
					pick: (k: string) => boolean;
					mutate: (b: Uint8Array) => Uint8Array | null;
				}[] = [
					{
						label: 'commit deleted',
						pick: (k) => k.includes('/commits/'),
						mutate: () => null
					},
					{ label: 'ref deleted', pick: (k) => k.includes('/refs/'), mutate: () => null },
					{
						label: 'segment truncated',
						pick: (k) => k.endsWith('.seg'),
						mutate: (b) => b.slice(0, Math.floor(b.length / 2))
					},
					{
						label: 'pack truncated',
						pick: (k) => k.includes('/packs/'),
						mutate: (b) => b.slice(0, Math.floor(b.length / 2))
					}
				];
				const tripwires: Record<string, unknown> = {};
				for (const m of mutations) {
					const key = stored.find((o) => m.pick(o.key))?.key ?? '';
					if (key === '') continue;
					const original = await getObject(key);
					const changed = m.mutate(original);
					if (changed === null) await deleteObject(key);
					else await putObject(key, changed);
					tripwires[m.label] = await drive(site, judge, false, siteId);
					await putObject(key, original);
					tripwires[`${m.label} (restored)`] = await drive(site, judge, false, siteId);
				}
				steps.tripwires = tripwires as unknown as Verdict;

				return {
					build: 'current' as const,
					strataLog,
					stored,
					victim,
					flipAt: at,
					control: control.every((b, i) => b === flipped[i]),
					steps
				};
			});

			if (result.build !== 'current') {
				expect(result.build).toBe('current');
				return;
			}
			console.log(`[strata-r2] ${JSON.stringify(result.steps)}`);
			const steps = result.steps as {
				[K in 'seal' | 'missing' | 'restored' | 'corrupt' | 'healed']: Verdict;
			};

			expect(steps.seal.state).toBe('done');
			expect(
				result.strataLog,
				'strata logged a failed seal or cron stage (watchdog, channel strata)'
			).toEqual([]);
			expect(result.stored.length, 'nothing reached the store').toBeGreaterThan(0);
			expect(result.control, 'the corrupted object did not reach the store').toBe(true);

			expect(steps.restored.drill?.verdict).toBe('pass');
			expect(steps.restored.sweep?.codes).toEqual([]);
			expect(steps.missing.drill?.verdict).toBe('fail');
			expect(steps.missing.sweep?.codes).toContain('frame.missing');
			expect(steps.corrupt.drill?.verdict).toBe('fail');
			expect(steps.corrupt.sweep?.codes).toContain('frame.aead_fail');
			expect(steps.healed.drill?.verdict).toBe('pass');
			expect(steps.healed.sweep?.codes).toEqual([]);
		},
		REQUEST_TIMEOUT
	);
});
