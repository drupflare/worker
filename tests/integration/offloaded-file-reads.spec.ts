import { describe, expect, it } from 'vitest';
import {
	bytesToBase64,
	drainHydrates,
	drainMirrors,
	evictMirrored,
	statFile,
	type FileBucket
} from '../../src/db/file-store';
import { drupalOp } from '../../src/drupal/site-php';
import { druplicon } from '../fixtures/png';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What real Drupal does with a file whose bytes live only in R2.
 *
 * PHP's file host calls are synchronous and R2 is not, so every PHP-side read of an evicted file
 * fails and queues a restore. The unit specs prove the host answers honestly; this one drives the
 * flows Drupal actually runs (stat, copy, image dimensions, append, move, an overwrite, a private download)
 * through the real kernel and the real stream wrapper, to say which of them care.
 */

const TIMEOUT = 900_000;
const PUBLIC = 'public://offload/logo.png';
const PRIVATE = 'private://offload/report.txt';

type Bag = Record<string, (json: string) => string>;
type Flows = Record<string, unknown>;

/** an in-memory R2 that keeps what it is given */
function memoryBucket(): FileBucket {
	const objects = new Map<string, Uint8Array>();
	return {
		async put(key, value) {
			objects.set(key, new Uint8Array(value));
			return { size: value.length };
		},
		async delete(key) {
			objects.delete(key);
		},
		async get(key) {
			const found = objects.get(key);
			if (found === undefined) return null;
			return {
				size: found.length,
				body: new Blob([found]).stream(),
				arrayBuffer: async () => found.slice().buffer as ArrayBuffer
			};
		}
	};
}

/** boots a site, stores one public image and one private text file, mirrors and evicts both */
async function evicted(site: ServeDo): Promise<{ pub: FileBucket; priv: FileBucket }> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	const pub = memoryBucket();
	const priv = memoryBucket();
	const patched = site as unknown as Record<string, unknown>;
	patched.fileBuckets = () => ({ public: pub, private: priv });
	patched.fileSchemes = () => ['public', 'private'];
	const bag: Bag = {};
	site.installCapabilities(bag);
	bag.cfwFileWrite!(
		JSON.stringify({ uri: PUBLIC, b64: bytesToBase64(druplicon()), mime: 'image/png' })
	);
	bag.cfwFileWrite!(
		JSON.stringify({
			uri: PRIVATE,
			b64: bytesToBase64(new TextEncoder().encode('quarterly numbers')),
			mime: 'text/plain'
		})
	);
	await drainMirrors(site.sql, pub, { verify: true, privateBucket: priv });
	evictMirrored(site.sql, {
		nowMs: Date.now() + 1e9,
		graceMs: 0,
		limit: 10,
		schemes: ['public', 'private']
	});
	return { pub, priv };
}

/** a bare run has no request to register the scheme, so do what kernel boot does */
const REGISTER = `\\Drupal::service('stream_wrapper_manager')->register();\n`;

/** the flows, as PHP runs them; each records whether it worked and never throws out */
const FLOWS = `${REGISTER}
$try = static function (callable $fn) {
  try { return $fn(); } catch (\\Throwable $e) { return 'threw: ' . get_class($e); }
};
$uri = ${JSON.stringify(PUBLIC)};
$fs = \\Drupal::service('file_system');
$out['flows'] = [
  'file_exists' => @file_exists($uri),
  'filesize' => @filesize($uri) > 0,
  'file_get_contents' => @file_get_contents($uri) !== false,
  'getimagesize' => @getimagesize($uri) !== false,
  'image_factory' => $try(fn () => \\Drupal::service('image.factory')->get($uri)->isValid()),
  'file_system_copy' => $try(fn () => (bool) $fs->copy($uri, 'public://offload/copy.png', \\Drupal\\Core\\File\\FileExists::Replace)),
  'fopen_append' => @fopen($uri, 'a') !== false,
  'file_system_move' => $try(fn () => (bool) $fs->move($uri, 'public://offload/moved.png', \\Drupal\\Core\\File\\FileExists::Replace)),
];
`;

async function flows(site: ServeDo): Promise<Flows> {
	const reply = (await site.runJson(drupalOp(FLOWS))) as { flows?: Flows; error?: string };
	return reply.flows ?? { error: reply.error ?? 'no flows' };
}

describe('real Drupal over a file that lives only in R2', () => {
	it(
		'reports which flows fail, then which pass once the restore ran',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const { pub } = await evicted(site);
				const stat = statFile(site.sql, PUBLIC);
				const first = await flows(site);
				const queued = site.sql
					.exec("SELECT uri, op FROM cfw_file_mirror_queue WHERE op = 'hydrate'")
					.toArray();
				await drainHydrates(site.sql, { public: pub }, { nowMs: Date.now() });
				const second = await flows(site);
				return { stat, first, queued, second };
			});
			// printed, because which flows fail is the finding
			console.log(`evicted, first pass: ${JSON.stringify(out.first)}`);
			console.log(`after the restore:   ${JSON.stringify(out.second)}`);

			// the control: the file was evicted, so the failures are about R2 and not a missing file
			expect(out.stat).toMatchObject({ evicted: true, mirrored: true });
			// metadata never needs the bytes
			expect(out.first).toMatchObject({ file_exists: true, filesize: true });
			// every flow that reads the bytes fails, and the ones that copy or move throw out of Drupal
			expect(out.first).toMatchObject({
				file_get_contents: false,
				getimagesize: false,
				image_factory: false,
				fopen_append: false,
				file_system_copy: expect.stringContaining('threw'),
				file_system_move: expect.stringContaining('threw')
			});
			// the restore was queued by the failed reads
			expect(out.queued).toEqual([{ uri: PUBLIC, op: 'hydrate' }]);
			// and once restored every flow works, including the ones that failed
			expect(out.second).toEqual({
				file_exists: true,
				filesize: true,
				file_get_contents: true,
				getimagesize: true,
				image_factory: true,
				file_system_copy: true,
				fopen_append: true,
				file_system_move: true
			});
		},
		TIMEOUT
	);

	it(
		'overwriting an evicted file replaces it and never reads R2',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const { pub } = await evicted(site);
				const reply = (await site.runJson(
					drupalOp(
						`${REGISTER}$out['wrote'] = @file_put_contents(${JSON.stringify(PUBLIC)}, 'fresh');`
					)
				)) as { wrote?: number };
				return { reply, stat: statFile(site.sql, PUBLIC), pub };
			});
			expect(out.reply.wrote).toBe(5);
			expect(out.stat).toMatchObject({ evicted: false, mirrored: false });
		},
		TIMEOUT
	);

	it(
		'a private download restores its file before PHP reads it',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await evicted(site);
				const before = (await site.runJson(
					drupalOp(
						`${REGISTER}$out['got'] = @file_get_contents(${JSON.stringify(PRIVATE)});`
					)
				)) as { got?: unknown };
				// the object's own pre-run step for `/system/files/...`
				await (
					site as unknown as { hydrateForRequest(u: URL): Promise<void> }
				).hydrateForRequest(
					new URL('https://do.local/__serve?path=/system/files/offload/report.txt')
				);
				const after = (await site.runJson(
					drupalOp(
						`${REGISTER}$out['got'] = @file_get_contents(${JSON.stringify(PRIVATE)});`
					)
				)) as { got?: unknown };
				return { before, after };
			});
			expect(out.before.got).toBe(false);
			expect(out.after.got).toBe('quarterly numbers');
		},
		TIMEOUT
	);
});
