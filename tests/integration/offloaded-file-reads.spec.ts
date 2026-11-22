import { describe, expect, it } from 'vitest';
import {
	bytesToBase64,
	drainHydrates,
	drainMirrors,
	evictMirrored,
	listOffloaded,
	readFile,
	recordedHash,
	statFile,
	type FileBucket
} from '../../src/db/file-store';
import { file } from '../../src/do/routes/file';
import { drupalOp } from '../../src/drupal/site-php';
import type { SitePhpDurableObject } from '../../src/site-do';
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

describe('PUT /file', () => {
	const digest = async (bytes: Uint8Array) =>
		[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

	/** an R2 that reads the stream it is given and refuses a digest that does not match */
	function checkingBucket(truncateBy = 0) {
		const objects = new Map<string, Uint8Array>();
		const bucket: FileBucket = {
			async put(key, value, options) {
				const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
				const wanted = (options as { sha256?: string } | undefined)?.sha256;
				if (wanted !== undefined && wanted !== (await digest(bytes))) {
					throw new Error(
						'put: the SHA-256 checksum you specified did not match (10037)'
					);
				}
				objects.set(key, bytes);
				return { size: bytes.length - truncateBy };
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
		return { bucket, objects };
	}

	const put = async (
		site: ServeDo,
		bytes: Uint8Array,
		query = 'uri=public://imports/logo.png',
		headers: Record<string, string> = {}
	) => {
		const res = await file(
			site as unknown as SitePhpDurableObject,
			new Request(`https://cfw.local/file?${query}`, {
				method: 'PUT',
				headers: {
					'x-file-sha256': await digest(bytes),
					// a constructed request sets no length of its own
					'content-length': String(bytes.length),
					'content-type': 'image/png',
					...headers
				},
				body: bytes
			}),
			new URL(`https://cfw.local/file?${query}`)
		);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};

	const armed = (site: ServeDo, bucket: FileBucket, r2 = true) => {
		const patched = site as unknown as Record<string, unknown>;
		patched.fileStoreR2 = () => r2;
		patched.fileBuckets = () => ({ public: bucket, private: undefined });
		patched.fileSchemes = () => ['public'];
	};

	it(
		'streams the bytes to this site prefix and records an evicted row with no chunks',
		async () => {
			await inObject(freshSite(), async (site: ServeDo) => {
				site.ensureServeTables();
				const { bucket, objects } = checkingBucket();
				armed(site, bucket);
				const png = druplicon();
				const out = await put(site, png);
				expect(out.status).toBe(200);
				expect(out.body).toMatchObject({
					ok: true,
					uri: 'public://imports/logo.png',
					size: png.length,
					store: 'r2',
					replaced: false
				});
				expect([...objects.keys()]).toEqual([
					`f/${encodeURIComponent(site.siteName())}/public/imports/logo.png`
				]);
				const stat = statFile(site.sql, 'public://imports/logo.png');
				expect(stat).toMatchObject({
					evicted: true,
					mirrored: true,
					chunks: 0,
					size: png.length
				});
				expect(
					site.sql.exec('SELECT count(*) AS n FROM cfw_file_chunk').toArray()[0]?.['n']
				).toBe(0);
				expect(recordedHash(site.sql, 'public://imports/logo.png')).toBe(await digest(png));
				expect(listOffloaded(site.sql, { limit: 10, site: site.siteName() })).toEqual([
					expect.objectContaining({ uri: 'public://imports/logo.png', foreign: false })
				]);
				const read = await readFile(
					site.sql,
					{ public: bucket },
					'public://imports/logo.png'
				);
				expect(read).toEqual(png);
				// a second put replaces the row and says so
				const again = await put(site, new Uint8Array([1, 2, 3]));
				expect(again.body).toMatchObject({ replaced: true, size: 3 });
			});
		},
		TIMEOUT
	);

	it(
		'refuses a digest that does not match and records nothing',
		async () => {
			await inObject(freshSite(), async (site: ServeDo) => {
				site.ensureServeTables();
				const { bucket, objects } = checkingBucket();
				armed(site, bucket);
				const out = await put(site, new Uint8Array([9, 9, 9]), undefined, {
					'x-file-sha256': 'a'.repeat(64)
				});
				expect(out.status).toBe(422);
				expect(out.body['code']).toBe('digest');
				expect(objects.size).toBe(0);
				expect(statFile(site.sql, 'public://imports/logo.png')).toBeUndefined();
			});
		},
		TIMEOUT
	);

	it(
		'removes the object and writes no row when R2 stored a different size',
		async () => {
			await inObject(freshSite(), async (site: ServeDo) => {
				site.ensureServeTables();
				const { bucket, objects } = checkingBucket(1);
				armed(site, bucket);
				const out = await put(site, new Uint8Array([1, 2, 3, 4]));
				expect(out.status).toBe(422);
				expect(out.body['code']).toBe('size');
				expect(objects.size).toBe(0);
				expect(statFile(site.sql, 'public://imports/logo.png')).toBeUndefined();
			});
		},
		TIMEOUT
	);

	it(
		'refuses a missing sha256, a bad uri, a scheme with no bucket, a wrong method and a site with no R2 store',
		async () => {
			await inObject(freshSite(), async (site: ServeDo) => {
				site.ensureServeTables();
				const { bucket } = checkingBucket();
				armed(site, bucket);
				const bytes = new Uint8Array([1]);
				expect(
					(await put(site, bytes, undefined, { 'x-file-sha256': 'nope' })).body['code']
				).toBe('sha256_required');
				expect((await put(site, bytes, 'uri=public://a/../../b')).body['code']).toBe(
					'bad_uri'
				);
				expect((await put(site, bytes, 'uri=temporary://a.png')).body['code']).toBe(
					'bad_uri'
				);
				expect((await put(site, bytes, 'uri=private://a.txt')).body['code']).toBe(
					'bad_uri'
				);
				expect((await put(site, bytes, '')).body['code']).toBe('bad_uri');
				const get = await file(
					site as unknown as SitePhpDurableObject,
					new Request('https://cfw.local/file?uri=public://a.png'),
					new URL('https://cfw.local/file?uri=public://a.png')
				);
				expect(get.status).toBe(405);
				armed(site, bucket, false);
				const none = await put(site, bytes);
				expect(none.status).toBe(501);
				expect(none.body['code']).toBe('no_r2_store');
				expect(statFile(site.sql, 'public://imports/logo.png')).toBeUndefined();
			});
		},
		TIMEOUT
	);
});
