import { beforeAll, describe, expect, it } from 'vitest';
import {
	digestBytes,
	hashStoredSnapshot,
	packChunk,
	toStorableBytes,
	unpackChunk
} from '../../src/db/heap-store';
import { restoreStepOnce } from '../../src/do/heap-image';
import { sealHeapSnapshot } from '../../src/ops/heap-integrity';
import { HOST_HELPERS_PHP } from '../../src/site/generated/assets';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A restored heap must not turn the autoloader into the boolean `true`.
 *
 * **`require_once` RETURNS TRUE WHEN THE FILE IS ALREADY INCLUDED**, so
 * `$GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php'` yields the boolean rather than
 * the ClassLoader whenever `autoload.php` is in the included-files table and that global is not.
 *
 * A heap restore reaches exactly that state. It brings back linear memory and the included-files
 * table, and `$GLOBALS['__pw_site_booted']` with them, but not every global beside it -- so the guard
 * `!isset($GLOBALS['__pw_autoloader'])` opens, `require_once` answers `true`, and the next
 * `$autoloader->addPsr4(...)` fatals with **`Call to a member function addPsr4() on true`**. Measured
 * on a site holding a heap image, on every sample.
 *
 * The fix is `require` rather than `require_once`, plus a guard on the VALUE rather than the key.
 * Composer's `getLoader()` memoizes, so a plain `require` hands back the same loader and re-registers
 * nothing.
 *
 * The serving path was never broken by this, which is why 4,760 gate tests were green through it: a
 * render reaches the autoloader through a different fragment, and on the ordinary path
 * `$GLOBALS['__pw_kernel']` comes back with `__pw_site_booted` so the bad value is never
 * dereferenced. What it broke is every probe that boots explicitly on an imaged site -- which is the
 * instrument the cold-boot measurement needs.
 */

const ORIGIN = 'https://do.local';
const TIMEOUT = 900_000;

type Json = Record<string, never>;

// a bare `runJson` fragment defines no `cfw_sql`, so a catch around it would pass without PHP
// ever reaching SQL
const BRIDGE = `<?php\nif (!function_exists('cfw_host')) {${HOST_HELPERS_PHP}}\n`;

async function imagedSite(site: ServeDo): Promise<{ id: number | null; restored: unknown }> {
	await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
	await site.fetch(new Request(`${ORIGIN}/__heap?op=snapshot`, { method: 'POST' }));
	const heap = (await (await site.fetch(new Request(`${ORIGIN}/__heap`))).json()) as Json;
	const latest = heap['latest'] as unknown as { id: number } | null;
	return { id: latest?.id ?? null, restored: heap['heapRestore'] };
}

describe('a boot on a site holding a heap image', () => {
	it(
		'renders instead of fataling on an autoloader that came back as a boolean',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const image = await imagedSite(site);
				// `/__bootphase` drops the interpreter AND the restore cursor, so this boot is the
				// one that lands on a restored heap
				const res = await site.fetch(new Request(`${ORIGIN}/__bootphase?phase=render`));
				const body = (await res.json()) as Json;
				return { image, body };
			});
			console.log(`[heap-autoload] ${JSON.stringify(seen.body['result'])}`);

			// THE CONTROL: without an image the restore never runs and this spec proves nothing
			expect(seen.image.id, 'no heap image was taken, so no restore happens').not.toBeNull();

			const result = seen.body['result'] as unknown as {
				ok: boolean;
				error?: string;
				renderStatus?: number;
				renderBytes?: number;
				alreadyBooted?: number;
			};
			expect(result.error ?? '', 'the boot fataled on a restored heap').not.toContain(
				'addPsr4'
			);
			expect(result.ok).toBe(true);
			expect(result.renderStatus).toBe(200);
			expect(Number(result.renderBytes)).toBeGreaterThan(1000);

			// and the restore really did bring booted state back, which is what made the guard open
			expect(result.alreadyBooted).toBe(1);
		},
		TIMEOUT
	);
});

/**
 * A heap image is memory that runs, and its rows are SQL, which PHP with a database write can
 * write. The record of each image the host wrote is sealed in key-value storage, so these plant
 * images the way that writer would and watch what the next boot does.
 *
 * Each case takes its own image with `fresh=1` (a restored boot mints no handles, so an image of
 * one would look fine and carry none) and drives the boot through `/__bootphase`, which is the
 * path every cold boot takes through `tryRestoreHeap()`.
 */
describe('a heap image is restored only when the host sealed it', () => {
	type Obj = Record<string, any>;
	type Boot = { restore: Obj | null; stats: Obj; render: Obj; rows: number; records: string[] };

	let stub: DurableObjectStub;

	beforeAll(async () => {
		stub = freshSite();
		await inObject(stub, async (site: ServeDo) => {
			// a reconcile step that lands on a scheduled alarm drops every image, which would take
			// the subject out from under a case; the producer spec settles it the long way
			const s = site as unknown as Obj;
			s.env = { ...s.env, RECONCILE: '0' };
			await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
		});
	}, TIMEOUT);

	/** takes an image through the host, as the producer and `/heap?op=snapshot` do */
	const image = (): Promise<{ id: number; sealed: boolean }> =>
		inObject(stub, async (site: ServeDo) => {
			const s = site as unknown as Obj;
			s.env = { ...s.env, HEAP_SNAPSHOT: undefined, HEAP_RESTORE_CHUNKS: undefined };
			const res = await site.fetch(
				new Request(`${ORIGIN}/__heap?op=snapshot&fresh=1`, { method: 'POST' })
			);
			const body = (await res.json()) as Obj;
			if (body['snapshot']?.ok !== true) throw new Error(JSON.stringify(body));
			const id = Number(body['snapshot'].id);
			return { id, sealed: s.ctx.storage.kv.get(`heapsum:${id}`) !== undefined };
		});

	/** a cold boot and a render, then what the boot decided */
	const boot = (env: Record<string, string> = {}): Promise<Boot> =>
		inObject(stub, async (site: ServeDo) => {
			const s = site as unknown as Obj;
			const before = s.env;
			s.env = { ...before, ...env };
			try {
				s.heapRestore = undefined;
				const res = await site.fetch(new Request(`${ORIGIN}/__bootphase?phase=render`));
				const body = (await res.json()) as Obj;
				const stats = await (
					await site.fetch(new Request(`${ORIGIN}/__serve-stats`))
				).json();
				return {
					restore: s.heapRestore ?? null,
					stats: (stats as Obj)['heapIntegrity'],
					render: body['result'],
					rows: Number(
						s.sql.exec('SELECT COUNT(*) AS n FROM cfw_heap_snapshot').toArray()[0].n
					),
					records: [...s.ctx.storage.kv.list({ prefix: 'heapsum:' })].map(
						([key]: [string]) => key
					)
				};
			} finally {
				s.env = before;
			}
		});

	/** what an author with SQL write does: every row of the newest image under another id, no record */
	const plant = (): Promise<number> =>
		inObject(stub, (site: ServeDo) => {
			const s = site as unknown as Obj;
			const from = Number(
				s.sql.exec('SELECT id FROM cfw_heap_snapshot ORDER BY id DESC LIMIT 1').toArray()[0]
					.id
			);
			const to = from + 1000;
			s.sql.exec(
				`INSERT INTO cfw_heap_snapshot SELECT ?, created_at, byte_length, page_bytes, total_pages,
					kept_pages, page_index, chunk_bytes, digest, generation, fd_table, handle_table
				 FROM cfw_heap_snapshot WHERE id = ?`,
				to,
				from
			);
			s.sql.exec(
				`INSERT INTO cfw_heap_chunk SELECT ?, seq, bytes, digest, raw_bytes
				 FROM cfw_heap_chunk WHERE snapshot_id = ?`,
				to,
				from
			);
			s.sql.exec('DELETE FROM cfw_heap_chunk WHERE snapshot_id = ?', from);
			s.sql.exec('DELETE FROM cfw_heap_snapshot WHERE id = ?', from);
			s.ctx.storage.kv.delete(`heapsum:${from}`);
			return to;
		});

	const sqlRun = (statement: string, ...bindings: unknown[]) =>
		inObject(stub, (site: ServeDo) => {
			(site as unknown as Obj).sql.exec(statement, ...bindings);
		});

	/** changes one byte of one chunk and rewrites the row digest to agree, as SQL write allows */
	const rewriteChunk = (s: Obj, id: number, seq: number): void => {
		const row = s.sql
			.exec(
				'SELECT bytes, raw_bytes FROM cfw_heap_chunk WHERE snapshot_id = ? AND seq = ?',
				id,
				seq
			)
			.toArray()[0];
		const raw = unpackChunk(
			toStorableBytes(row.bytes as ArrayBufferLike),
			Number(row.raw_bytes)
		);
		raw[0] = (raw[0] as number) ^ 0xff;
		const packed = packChunk(raw);
		s.sql.exec(
			'UPDATE cfw_heap_chunk SET bytes = ?, raw_bytes = ?, digest = ? WHERE snapshot_id = ? AND seq = ?',
			packed.stored,
			packed.rawBytes,
			digestBytes(raw),
			id,
			seq
		);
	};

	const renderedOk = (b: Boot) => {
		expect(b.render['ok'], JSON.stringify(b.render)).toBe(true);
		expect(b.render['renderStatus']).toBe(200);
	};

	it(
		'restores an image the host sealed, and counts it as verified',
		async () => {
			const taken = await image();
			expect(taken.sealed).toBe(true);
			const b = await boot();
			console.log(
				`[heap-integrity] verified restore, local workerd: verifyMs=${b.restore?.['verifyMs']} memcpyMs=${b.restore?.['memcpyMs']}`
			);
			expect(b.restore?.['restored'], JSON.stringify(b.restore)).toBe(true);
			expect(b.stats['verified']).toBeGreaterThan(0);
			expect(b.stats['refused']).toBe(0);
			expect(b.records).toEqual([`heapsum:${taken.id}`]);
			renderedOk(b);
		},
		TIMEOUT
	);

	it(
		'refuses a planted image under the default configuration, deletes it, and boots and serves',
		async () => {
			await image();
			const planted = await plant();
			// no HEAP_IMAGE and no HEAP_SNAPSHOT: the shipping configuration
			const b = await boot();
			expect(b.restore?.['restored']).toBe(false);
			expect(String(b.restore?.['reason'])).toContain('no sealed record');
			expect(b.stats['refused']).toBeGreaterThan(0);
			expect(b.stats['lastReason']).toBe('no sealed record');
			expect(b.rows, `snapshot ${planted} should be deleted`).toBe(0);
			expect(b.records).toEqual([]);
			renderedOk(b);
		},
		TIMEOUT
	);

	it(
		'never attempts a restore under HEAP_SNAPSHOT=0, or on a site with a deployment environment',
		async () => {
			// where a restore cannot run, a planted row is inert for the other reason, and stays put
			await image();
			await plant();
			const off = await boot({ HEAP_SNAPSHOT: '0' });
			expect(off.restore).toBe(null);
			expect(off.rows).toBe(1);
			const deployed = await boot({ DRUPAL_ENV_SITE_NAME: 'planted' });
			expect(deployed.restore).toBe(null);
			expect(deployed.rows).toBe(1);
			renderedOk(deployed);
		},
		TIMEOUT
	);

	it(
		'refuses a record that is not 64 lower-case hex digits',
		async () => {
			const taken = await image();
			await inObject(stub, (site: ServeDo) => {
				(site as unknown as Obj).ctx.storage.kv.put(`heapsum:${taken.id}`, 'A'.repeat(64));
			});
			const b = await boot();
			expect(String(b.restore?.['reason'])).toContain('malformed sealed record');
			expect(b.rows).toBe(0);
			renderedOk(b);
		},
		TIMEOUT
	);

	it.each([
		[
			'a chunk shortened by a byte with its row digest left alone',
			(id: number) =>
				`UPDATE cfw_heap_chunk SET bytes = substr(bytes, 2) WHERE snapshot_id = ${id} AND seq = 0`
		],
		[
			'the handle table changed with every byte untouched',
			(id: number) =>
				`UPDATE cfw_heap_snapshot SET handle_table = '[{"id":2,"name":"FS"}]' WHERE id = ${id}`
		],
		[
			'a descriptor added to the fd table with every byte untouched',
			(id: number) =>
				`UPDATE cfw_heap_snapshot SET fd_table = '[{"fd":9,"path":"/dev/urandom","flags":0,"position":0}]' WHERE id = ${id}`
		],
		[
			'the page index changed with every byte untouched',
			(id: number) => `UPDATE cfw_heap_snapshot SET page_index = '[0]' WHERE id = ${id}`
		]
	])(
		'refuses an image with %s, and the site boots and serves',
		async (_name, statement) => {
			const taken = await image();
			await sqlRun(statement(taken.id));
			const b = await boot();
			expect(b.restore?.['restored']).toBe(false);
			expect(String(b.restore?.['reason'])).toContain('digest mismatch');
			expect(b.rows).toBe(0);
			expect(b.records).toEqual([]);
			renderedOk(b);
		},
		TIMEOUT
	);

	it(
		'refuses a chunk rewritten with its row digest recomputed, which the row digest alone accepts',
		async () => {
			const taken = await image();
			await inObject(stub, (site: ServeDo) =>
				rewriteChunk(site as unknown as Obj, taken.id, 0)
			);
			const b = await boot();
			expect(b.restore?.['restored']).toBe(false);
			expect(String(b.restore?.['reason'])).toContain('digest mismatch');
			renderedOk(b);
		},
		TIMEOUT
	);

	it(
		'still refuses, by the vrzno handle check, an image the host sealed with a handle the closed bridge cannot issue',
		async () => {
			// the other order: the digest is right (the host wrote and sealed it), so it is the
			// glue's own limit on handle names that stops the restore
			const taken = await image();
			await sqlRun(
				`UPDATE cfw_heap_snapshot SET handle_table = '[{"id":2,"name":"FS"}]' WHERE id = ?`,
				taken.id
			);
			await inObject(stub, (site: ServeDo) => {
				const s = site as unknown as Obj;
				const hashed = hashStoredSnapshot(s.sql, taken.id);
				sealHeapSnapshot(s.secretStore().sealed, taken.id, hashed!.root);
			});
			const b = await boot();
			expect(b.restore?.['restored']).toBe(false);
			expect(String(b.restore?.['reason'])).toContain('vrzno handle replay failed');
			expect(b.stats['verified']).toBeGreaterThan(0);
			renderedOk(b);
		},
		TIMEOUT
	);

	it(
		'cannot be read or written through the SQL bridge or from PHP, while PHP can write the image rows',
		async () => {
			const taken = await image();
			const key = `heapsum:${taken.id}`;
			const out = await inObject(stub, async (site: ServeDo) => {
				const s = site as unknown as Obj;
				const record = s.ctx.storage.kv.get(key);
				const attempt = (statement: string) => {
					try {
						s.sql.exec(statement).toArray();
						return 'ran';
					} catch (e) {
						return String((e as Error).message);
					}
				};
				const viaSql = [
					'SELECT * FROM _cf_KV',
					"UPDATE _cf_KV SET value = 'x'",
					'DELETE FROM _cf_KV',
					'DROP TABLE _cf_KV'
				].map(attempt);
				const php = await site.runJson(
					`${BRIDGE}$out = [];
					try { $out['control'] = json_encode(cfw_sql('SELECT 1 AS one', [])); } catch (\\Throwable $e) { $out['control'] = 'threw: ' . $e->getMessage(); }
					try {
						cfw_sql("INSERT INTO cfw_heap_snapshot (id, created_at, byte_length, page_bytes, total_pages, kept_pages, page_index, chunk_bytes, digest, generation, fd_table, handle_table) VALUES (777000, 0, 1, 1, 1, 1, '[0]', 1, 'x', 'planted', '[]', '[]')", []);
						$out['plant'] = 'written';
					} catch (\\Throwable $e) { $out['plant'] = 'threw: ' . $e->getMessage(); }
					$out['sealed'] = [];
					foreach (['SELECT * FROM _cf_KV', "UPDATE _cf_KV SET value = 'x'", 'DELETE FROM _cf_KV'] as $q) {
						try { $out['sealed'][] = json_encode(cfw_sql($q, [])); } catch (\\Throwable $e) { $out['sealed'][] = 'threw: ' . $e->getMessage(); }
					}
					echo json_encode($out);`
				);
				const planted = s.sql
					.exec('SELECT COUNT(*) AS n FROM cfw_heap_snapshot WHERE id = 777000')
					.toArray()[0].n;
				s.sql.exec('DELETE FROM cfw_heap_snapshot WHERE id = 777000');
				return { record, viaSql, php, planted, after: s.ctx.storage.kv.get(key) };
			});
			expect(out.record).toMatch(/^[0-9a-f]{64}$/);
			for (const result of out.viaSql) expect(result).not.toBe('ran');
			// the bridge is loaded, and PHP really did write the image table
			expect(JSON.stringify(out.php), 'cfw_sql control').toContain('"control":"{');
			expect(out.php).toMatchObject({ plant: 'written' });
			expect(out.planted).toBe(1);
			for (const result of (out.php as { sealed: string[] }).sealed) {
				// the bridge answers a refusal as `{"ok":false,"error":...}` rather than throwing
				expect(result).toMatch(/"ok":false/);
			}
			expect(JSON.stringify(out.php)).not.toContain(String(out.record));
			expect(out.after).toBe(out.record);
		},
		TIMEOUT
	);

	it(
		'drops the record of an image the next image replaces',
		async () => {
			await image();
			const second = await image();
			const b = await boot();
			expect(b.records).toEqual([`heapsum:${second.id}`]);
			expect(b.restore?.['restored']).toBe(true);
		},
		TIMEOUT
	);

	it(
		'refuses a legacy image that has rows and no record once, and the next image the producer takes restores',
		async () => {
			const taken = await image();
			await inObject(stub, (site: ServeDo) => {
				(site as unknown as Obj).ctx.storage.kv.delete(`heapsum:${taken.id}`);
			});
			const first = await boot();
			expect(String(first.restore?.['reason'])).toContain('no sealed record');
			expect(first.rows).toBe(0);

			// the producer is on and believes the generation is imaged, which is what a site that
			// had an image before this change records
			const produced = await inObject(stub, async (site: ServeDo) => {
				const s = site as unknown as Obj;
				s.env = { ...s.env, HEAP_IMAGE: '1' };
				s.metaSet('heap_image_gen', s.heapGeneration());
				s.php = undefined;
				const out = await s.snapshotStep();
				return out?.heapImage;
			});
			expect(produced?.ok, JSON.stringify(produced)).toBe(true);
			const second = await boot();
			expect(second.restore?.['restored'], JSON.stringify(second.restore)).toBe(true);
			expect(second.records).toHaveLength(1);
		},
		TIMEOUT
	);

	describe('sliced across alarm firings', () => {
		const sliced = (tamper?: (s: Obj, id: number) => void) =>
			inObject(stub, async (site: ServeDo) => {
				const s = site as unknown as Obj;
				const taken = Number(
					s.sql
						.exec('SELECT id FROM cfw_heap_snapshot ORDER BY id DESC LIMIT 1')
						.toArray()[0].id
				);
				s.env = { ...s.env, HEAP_RESTORE_CHUNKS: '2' };
				s.php = undefined;
				s.heapRestoreCursor = undefined;
				s.heapRestore = undefined;
				let started = '';
				try {
					await s.ensurePhp();
				} catch (e) {
					started = String((e as Error).name);
				}
				const cursor = s.heapRestoreCursor;
				tamper?.(s, taken);
				const steps: Obj[] = [];
				for (let i = 0; i < 400 && s.heapRestoreCursor; i++) {
					steps.push((await restoreStepOnce(s as never)) ?? {});
				}
				s.env = { ...s.env, HEAP_RESTORE_CHUNKS: undefined };
				return {
					started,
					verifiedChunks: cursor?.verified?.chunkDigests?.length ?? 0,
					totalChunks: cursor?.totalChunks ?? 0,
					steps: steps.length,
					restore: s.heapRestore ?? null,
					php: s.php !== undefined
				};
			});

		it(
			'verifies once, carries the digests on the cursor, and completes',
			async () => {
				await image();
				const out = await sliced();
				expect(out.started).toBe('HeapRestoreIncomplete');
				expect(out.verifiedChunks).toBe(out.totalChunks);
				expect(out.totalChunks).toBeGreaterThan(2);
				expect(out.steps).toBeGreaterThan(0);
				expect(out.restore?.['restored'], JSON.stringify(out.restore)).toBe(true);
			},
			TIMEOUT
		);

		it(
			'drops the heap when a chunk is changed between firings',
			async () => {
				await image();
				const out = await sliced((s, id) => rewriteChunk(s, id, 3));
				expect(out.restore?.['restored']).toBe(false);
				expect(out.restore?.['discardedHeap']).toBe(true);
				expect(out.php).toBe(false);
			},
			TIMEOUT
		);

		it(
			'refuses a firing whose cursor carries no verified image',
			async () => {
				await image();
				const out = await inObject(stub, async (site: ServeDo) => {
					const s = site as unknown as Obj;
					s.env = { ...s.env, HEAP_RESTORE_CHUNKS: '2' };
					s.php = undefined;
					s.heapRestoreCursor = undefined;
					try {
						await s.ensurePhp();
					} catch {
						// the first slice leaves the restore open on purpose
					}
					s.heapRestoreCursor = { ...s.heapRestoreCursor, verified: undefined };
					const step = await restoreStepOnce(s as never);
					s.env = { ...s.env, HEAP_RESTORE_CHUNKS: undefined };
					return { step, cursor: s.heapRestoreCursor ?? null, php: s.php !== undefined };
				});
				expect(String(out.step?.['heapRestore']?.reason)).toContain('no verified image');
				expect(out.cursor).toBe(null);
				expect(out.php).toBe(false);
			},
			TIMEOUT
		);
	});
});
