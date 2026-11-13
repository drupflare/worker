import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { dumpDatabase } from '../../src/db/export-sql';
import { ensureFileTables, putFile } from '../../src/db/file-store';
import { latestImport, storedImportLoader } from '../../src/db/import-sql';
import type { SqlLike, StorageLike } from '../../src/db/migrate-sql';
import { SqlMigrator } from '../../src/db/migrate-sql';
import {
	ASSEMBLE_BYTES_PER_CALL,
	RESTORE_UPLOAD_TTL_MS,
	commitUpload,
	purgeExpiredUploads,
	uploadStatus
} from '../../src/db/restore-parts';
import { readRestoreMark } from '../../src/db/write-mark';
import { offloaded, parseRange } from '../../src/do/routes/offloaded';
import { restore } from '../../src/do/routes/owner';
import { restoreParts } from '../../src/do/routes/restore-parts';
import { RESTORE_PART_MAX_BYTES } from '../../src/ops/body-limit';
import { auditedRoute } from '../../src/ops/owner-audit';
import type { SitePhpDurableObject } from '../../src/site-do';
import { bodyLimitFor, bodyTooLarge } from '../../src/site/guards';

/** a real SQLite behind the Durable Object storage surface, as `import-sql.spec.ts` builds it */
function storageOver(db: DatabaseSync): { sql: SqlLike; storage: StorageLike } {
	let depth = 0;
	const isRead = (t: string) =>
		/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(t) || /\bRETURNING\b/i.test(t);
	const sql: SqlLike = {
		exec(text, ...params) {
			const stmt = db.prepare(text);
			if (isRead(text)) {
				const rows = stmt.all(...params) as Record<string, unknown>[];
				return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
			}
			const r = stmt.run(...params);
			return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes ?? 0) };
		}
	};
	const storage: StorageLike = {
		transactionSync(cb) {
			const name = `sp${depth++}`;
			db.exec(`SAVEPOINT ${name}`);
			try {
				const out = cb();
				db.exec(`RELEASE ${name}`);
				depth--;
				return out;
			} catch (e) {
				db.exec(`ROLLBACK TO ${name}`);
				db.exec(`RELEASE ${name}`);
				depth--;
				throw e;
			}
		}
	};
	return { sql, storage };
}

type Bucket = {
	gets: { key: string; range?: { offset: number; length: number } }[];
	objects: Map<string, Uint8Array>;
};

/** the slice of the object these routes read, over a real database and a stand-in bucket */
function siteOver(db: DatabaseSync, env: Record<string, unknown> = {}) {
	const { sql, storage } = storageOver(db);
	const clock = { now: 1_700_000_000_000 };
	const alarms: number[] = [];
	const bucket: Bucket = { gets: [], objects: new Map() };
	const trusted = new Set<string>();
	const site = {
		sql,
		storage,
		env,
		nowMs: () => clock.now,
		siteName: () => 'mine',
		setAlarmAt: async (at: number) => {
			alarms.push(at);
		},
		noteError: () => undefined,
		fileBuckets: () => ({
			public: {
				put: async () => null,
				delete: async () => undefined,
				get: async (
					key: string,
					options?: { range?: { offset: number; length: number } }
				) => {
					bucket.gets.push({ key, range: options?.range });
					const whole = bucket.objects.get(key);
					if (whole === undefined) return null;
					const r = options?.range;
					const body =
						r === undefined ? whole : whole.slice(r.offset, r.offset + r.length);
					return {
						size: whole.length,
						body: new Response(body).body,
						arrayBuffer: async () => body.buffer
					};
				}
			}
		}),
		isReplica: () => false,
		trustedFileSources: async () => trusted as ReadonlySet<string>
	};
	return {
		site: site as unknown as SitePhpDurableObject,
		sql,
		storage,
		clock,
		alarms,
		bucket,
		trusted
	};
}

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const enc = (text: string) => new TextEncoder().encode(text);

/** a dump of `rows` inserts, one statement per line, with a semicolon inside every value */
function dumpOf(rows: number): string {
	const lines = ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);'];
	for (let i = 1; i <= rows; i++) {
		lines.push(`INSERT INTO t (id, v) VALUES (${i}, 'row ${i}; kept whole');`);
	}
	return `${lines.join('\n')}\n`;
}

/** cuts a dump into parts of about `target` bytes, always between lines */
function partsOf(dump: string, target: number): Uint8Array[] {
	const out: Uint8Array[] = [];
	let current = '';
	for (const line of dump.split('\n')) {
		if (line === '') continue;
		current += `${line}\n`;
		if (current.length >= target) {
			out.push(enc(current));
			current = '';
		}
	}
	if (current !== '') out.push(enc(current));
	return out;
}

const concat = (parts: Uint8Array[]) => enc(parts.map((p) => new TextDecoder().decode(p)).join(''));

type Fixture = ReturnType<typeof siteOver>;

const call = (
	f: Fixture,
	action: string,
	init: RequestInit = {},
	query = ''
): Promise<Response> => {
	const url = new URL(`https://do.local/__restore-parts?action=${action}${query}`);
	return restoreParts(f.site, new Request(url, init), url);
};

const json = async (res: Response) => (await res.json()) as Record<string, any>;

async function begin(f: Fixture, dump: string, parts: Uint8Array[], label = 'paged-1') {
	const body = concat(parts);
	const res = await call(f, 'begin', {
		method: 'POST',
		body: JSON.stringify({
			bytes: body.length,
			parts: parts.length,
			sha256: hex(body),
			label
		})
	});
	return { res, body: await json(res) };
}

async function put(f: Fixture, upload: string, part: number, bytes: Uint8Array, digest?: string) {
	return call(
		f,
		'put',
		{ method: 'PUT', body: bytes, headers: { 'x-part-sha256': digest ?? hex(bytes) } },
		`&upload=${upload}&part=${part}`
	);
}

async function commitAll(f: Fixture, upload: string) {
	for (let i = 0; i < 50; i++) {
		const out = await json(await call(f, 'commit', { method: 'POST' }, `&upload=${upload}`));
		if (out.done === true || out.ok === false) return out;
	}
	throw new Error('the commit did not converge');
}

async function replay(f: Fixture) {
	const point = latestImport(f.sql);
	expect(point, 'no complete import is stored').toBeDefined();
	const migrator = new SqlMigrator({
		sql: f.sql,
		storage: f.storage,
		...storedImportLoader(f.sql, (point as { id: number }).id)
	});
	for (let r = await migrator.step(); !r.done; r = await migrator.step()) {
		// a failed chunk throws out of step()
	}
}

describe('a paged restore', () => {
	let db: DatabaseSync;
	let f: Fixture;

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		f = siteOver(db);
	});

	const tableRows = () => db.prepare('SELECT id, v FROM t ORDER BY id').all();
	const staged = () =>
		Number((db.prepare('SELECT COUNT(*) AS n FROM cfw_restore_part').get() as { n: number }).n);

	it('declares a dump, takes parts out of order, and restores what a single body would', async () => {
		const dump = dumpOf(120);
		const parts = partsOf(dump, 700);
		expect(parts.length).toBeGreaterThan(3);
		const { body } = await begin(f, dump, parts);
		expect(body).toMatchObject({ ok: true, created: true, state: 'open', parts: parts.length });

		for (const n of [...parts.keys()].reverse()) {
			const res = await put(f, body.upload, n, parts[n] as Uint8Array);
			expect(res.status).toBe(200);
		}
		const status = await json(await call(f, 'status', {}, `&upload=${body.upload}`));
		expect(status.receivedParts).toEqual([...parts.keys()]);
		expect(status.bytesReceived).toBe(concat(parts).length);

		const done = await commitAll(f, body.upload);
		expect(done).toMatchObject({ ok: true, done: true, generation: 'paged-1' });
		expect(done.statements).toBe(121);
		expect(f.alarms.length).toBe(1);
		expect(staged()).toBe(0);
		expect(db.prepare('SELECT COUNT(*) AS n FROM cfw_restore_upload').get()).toEqual({ n: 0 });

		await replay(f);
		expect(tableRows()).toHaveLength(120);
		expect(tableRows()[41]).toEqual({ id: 42, v: 'row 42; kept whole' });
	});

	it('notes the mark a commit carries against the restore point, and echoes it', async () => {
		const parts = partsOf(dumpOf(30), 100_000);
		const { body } = await begin(f, '', parts);
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		let out: Record<string, any> = {};
		for (let i = 0; i < 50 && out.done !== true; i++) {
			out = await json(
				await call(f, 'commit', { method: 'POST' }, `&upload=${body.upload}&mark=op1`)
			);
		}
		expect(out).toMatchObject({ ok: true, done: true, generation: 'paged-1', mark: 'op1' });
		expect(readRestoreMark(f.sql, 'paged-1')).toBe('op1');
	});

	it('refuses a mark it cannot store before it assembles anything', async () => {
		const parts = partsOf(dumpOf(30), 100_000);
		const { body } = await begin(f, '', parts);
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		const res = await call(
			f,
			'commit',
			{ method: 'POST' },
			`&upload=${body.upload}&mark=a%20b`
		);
		expect(res.status).toBe(400);
		expect(latestImport(f.sql)).toBeUndefined();
	});

	it('leaves a commit with no mark with none noted', async () => {
		const parts = partsOf(dumpOf(30), 100_000);
		const { body } = await begin(f, '', parts);
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		const out = await commitAll(f, body.upload);
		expect(out).not.toHaveProperty('mark');
		expect(readRestoreMark(f.sql, 'paged-1')).toBeUndefined();
	});

	it('stores the same replay chunks a single-body restore stores for the same dump', async () => {
		const dump = dumpOf(90);
		const parts = partsOf(dump, 100_000);
		expect(parts).toHaveLength(1);
		const { body } = await begin(f, dump, parts);
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		await commitAll(f, body.upload);

		const other = siteOver(new DatabaseSync(':memory:'));
		const url = new URL('https://do.local/__restore?label=paged-1');
		const single = await restore(
			other.site,
			new Request(url, { method: 'POST', body: dump }),
			url
		);
		const chunksOf = (s: Fixture) =>
			s.sql.exec('SELECT seq, statements FROM cfw_import_chunk ORDER BY seq').toArray();
		expect(await json(single)).toMatchObject({ ok: true, chunks: 3, statements: 91 });
		expect(chunksOf(f)).toEqual(chunksOf(other));
	});

	it('reports the stored import on the same read the health route uses', async () => {
		const dump = dumpOf(10);
		const parts = partsOf(dump, 100_000);
		const { body } = await begin(f, dump, parts, 'health-1');
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		await commitAll(f, body.upload);
		expect(latestImport(f.sql)).toMatchObject({ generation: 'health-1', statements: 11 });
	});

	it('takes a repeated part once and counts it once', async () => {
		const parts = partsOf(dumpOf(30), 300);
		const { body } = await begin(f, '', parts);
		const first = await json(await put(f, body.upload, 0, parts[0] as Uint8Array));
		const again = await json(await put(f, body.upload, 0, parts[0] as Uint8Array));
		expect(first.stored).toBe(true);
		expect(again.stored).toBe(false);
		expect(again.bytesReceived).toBe((parts[0] as Uint8Array).length);
		expect(again.receivedParts).toEqual([0]);
	});

	it('refuses a part whose bytes do not match its digest, and stores nothing', async () => {
		const parts = partsOf(dumpOf(30), 300);
		const { body } = await begin(f, '', parts);
		const res = await put(
			f,
			body.upload,
			0,
			parts[0] as Uint8Array,
			hex(enc('something else'))
		);
		expect(res.status).toBe(422);
		expect(await json(res)).toMatchObject({ ok: false, code: 'digest', part: 0 });
		expect(staged()).toBe(0);
	});

	it('refuses a commit whose whole digest differs, and keeps the parts for a corrected resend', async () => {
		const parts = partsOf(dumpOf(30), 300);
		const whole = concat(parts);
		const res = await call(f, 'begin', {
			method: 'POST',
			body: JSON.stringify({
				bytes: whole.length,
				parts: parts.length,
				sha256: hex(enc('a different dump')),
				label: 'bad-whole'
			})
		});
		const { upload } = await json(res);
		for (const [n, p] of parts.entries()) await put(f, upload, n, p);
		const out = await commitAll(f, upload);
		expect(out).toMatchObject({ ok: false, code: 'whole_digest' });
		expect(staged()).toBe(parts.length);
		expect(latestImport(f.sql)).toBeUndefined();
		expect((await json(await call(f, 'status', {}, `&upload=${upload}`))).state).toBe('open');
	});

	it('names the missing parts when a commit comes early', async () => {
		const parts = partsOf(dumpOf(60), 300);
		const { body } = await begin(f, '', parts);
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		const out = await commitAll(f, body.upload);
		expect(out).toMatchObject({ ok: false, code: 'incomplete' });
		expect(out.missing).toEqual([...parts.keys()].slice(1));
		expect(latestImport(f.sql)).toBeUndefined();
	});

	it('refuses a part cut inside a statement, a statement too wide to run, and bytes that are not UTF-8', async () => {
		const cut = enc("INSERT INTO t VALUES (1, 'half");
		const wide = enc(`INSERT INTO t VALUES ('${'a'.repeat(100_000)}');`);
		const bad = new Uint8Array([0x49, 0xff, 0xfe, 0x3b]);
		for (const [bytes, code] of [
			[cut, 'not_aligned'],
			[wide, 'statement_too_long'],
			[bad, 'not_utf8']
		] as const) {
			const res = await call(f, 'begin', {
				method: 'POST',
				body: JSON.stringify({
					bytes: bytes.length,
					parts: 1,
					sha256: hex(bytes),
					label: `refuse-${code}`
				})
			});
			const { upload } = await json(res);
			const put1 = await put(f, upload, 0, bytes);
			expect(put1.status).toBe(422);
			expect((await json(put1)).code).toBe(code);
			await call(f, 'abort', { method: 'POST' }, `&upload=${upload}`);
		}
		expect(staged()).toBe(0);
	});

	it('refuses a part above the part limit, and a declaration it cannot carry', async () => {
		const big = new Uint8Array(RESTORE_PART_MAX_BYTES + 1).fill(0x20);
		const res = await call(f, 'begin', {
			method: 'POST',
			body: JSON.stringify({ bytes: big.length, parts: 2, sha256: hex(big), label: 'big' })
		});
		const { upload } = await json(res);
		const over = await put(f, upload, 0, big);
		expect(over.status).toBe(413);
		const cannot = await call(f, 'begin', {
			method: 'POST',
			body: JSON.stringify({
				bytes: RESTORE_PART_MAX_BYTES * 3,
				parts: 2,
				sha256: hex(big),
				label: 'cannot'
			})
		});
		expect(cannot.status).toBe(400);
		expect(await json(cannot)).toMatchObject({ code: 'bad_request' });
	});

	it('keeps one upload open: the same declaration resumes it, another is refused with its id', async () => {
		const parts = partsOf(dumpOf(40), 300);
		const first = await begin(f, '', parts, 'one');
		await put(f, first.body.upload, 1, parts[1] as Uint8Array);
		const again = await begin(f, '', parts, 'one');
		expect(again.body).toMatchObject({
			created: false,
			upload: first.body.upload,
			receivedParts: [1]
		});
		const other = await begin(f, '', partsOf(dumpOf(41), 300), 'two');
		expect(other.res.status).toBe(409);
		expect(other.body).toMatchObject({ code: 'busy', upload: first.body.upload });
		const found = await json(await call(f, 'status'));
		expect(found.upload).toBe(first.body.upload);
	});

	it('refuses a dump above the paged ceiling, which MAX_RESTORE_PAGED_BYTES lowers', async () => {
		const lowered = siteOver(new DatabaseSync(':memory:'), { MAX_RESTORE_PAGED_BYTES: 1000 });
		const body = enc(dumpOf(200));
		const res = await call(lowered, 'begin', {
			method: 'POST',
			body: JSON.stringify({ bytes: body.length, parts: 5, sha256: hex(body), label: 'x' })
		});
		expect(res.status).toBe(413);
		expect(await json(res)).toMatchObject({ code: 'too_large', limit: 1000 });
	});

	it('removes the parts and a half-built import on abort, and abort of nothing is harmless', async () => {
		const parts = partsOf(dumpOf(80), 300);
		const { body } = await begin(f, '', parts);
		for (const [n, p] of parts.entries()) await put(f, body.upload, n, p);
		const step = commitUpload(f.sql, f.storage, {
			id: body.upload,
			nowMs: f.clock.now,
			budgetBytes: 1
		});
		expect(step).toMatchObject({ done: false, state: 'assembling', assembledParts: 1 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM cfw_import').get()).toEqual({ n: 1 });

		const aborted = await json(
			await call(f, 'abort', { method: 'POST' }, `&upload=${body.upload}`)
		);
		expect(aborted).toMatchObject({ ok: true, aborted: true });
		expect(db.prepare('SELECT COUNT(*) AS n FROM cfw_import').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM cfw_import_chunk').get()).toEqual({ n: 0 });
		expect(staged()).toBe(0);
		const none = await json(
			await call(f, 'abort', { method: 'POST' }, `&upload=${body.upload}`)
		);
		expect(none).toMatchObject({ ok: true, aborted: false });
	});

	it('resumes assembly where a killed commit stopped, and offers no restore point until the end', async () => {
		const dump = dumpOf(100);
		const parts = partsOf(dump, 400);
		const { body } = await begin(f, dump, parts);
		for (const [n, p] of parts.entries()) await put(f, body.upload, n, p);

		let calls = 0;
		for (;;) {
			// each call is a fresh invocation: nothing but the database carries over
			const r = commitUpload(f.sql, f.storage, {
				id: body.upload,
				nowMs: f.clock.now,
				budgetBytes: 1
			});
			calls += 1;
			if (r.done) break;
			expect(
				latestImport(f.sql),
				'a half-built import was offered for replay'
			).toBeUndefined();
			expect(calls).toBeLessThan(100);
		}
		expect(calls).toBe(parts.length);
		expect(latestImport(f.sql)?.statements).toBe(101);
		await replay(f);
		expect(tableRows()).toHaveLength(100);
	});

	it('leaves the upload intact when a step fails after verification, so the commit can run again', async () => {
		const parts = partsOf(dumpOf(60), 300);
		const { body } = await begin(f, '', parts);
		for (const [n, p] of parts.entries()) await put(f, body.upload, n, p);
		commitUpload(f.sql, f.storage, { id: body.upload, nowMs: f.clock.now, budgetBytes: 1 });
		// a storage failure inside the next step's transaction
		db.exec(
			`CREATE TRIGGER fail_chunk BEFORE INSERT ON cfw_import_chunk
			 BEGIN SELECT RAISE(ABORT, 'database or disk is full: SQLITE_FULL'); END`
		);
		const failed = await call(f, 'commit', { method: 'POST' }, `&upload=${body.upload}`);
		expect(failed.status).toBe(507);
		expect(await json(failed)).toMatchObject({ code: 'storage_full' });
		const status = uploadStatus(f.sql, f.storage, f.clock.now, body.upload);
		expect(status).toMatchObject({ state: 'assembling', assembledParts: 1 });
		db.exec('DROP TRIGGER fail_chunk');
		const done = await commitAll(f, body.upload);
		expect(done).toMatchObject({ ok: true, done: true, statements: 61 });
	});

	it('expires an upload after its stated time, on a call and on the alarm sweep', async () => {
		const parts = partsOf(dumpOf(40), 300);
		const { body } = await begin(f, '', parts);
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		f.clock.now += RESTORE_UPLOAD_TTL_MS - 1;
		const live = await json(await call(f, 'status', {}, `&upload=${body.upload}`));
		expect(live.receivedParts).toEqual([0]);

		f.clock.now += RESTORE_UPLOAD_TTL_MS + 1;
		const late = await put(f, body.upload, 1, parts[1] as Uint8Array);
		expect(late.status).toBe(410);
		expect(staged()).toBe(0);

		const second = await begin(f, '', parts, 'again');
		await put(f, second.body.upload, 0, parts[0] as Uint8Array);
		f.clock.now += RESTORE_UPLOAD_TTL_MS + 1;
		expect(purgeExpiredUploads(f.sql, f.storage, f.clock.now)).toBe(1);
		expect(staged()).toBe(0);
		expect(db.prepare('SELECT COUNT(*) AS n FROM cfw_restore_upload').get()).toEqual({ n: 0 });
	});

	it('drops identity rows from a dump the way a single-body restore does', async () => {
		const dump = `INSERT INTO cfw_meta (k, v) VALUES ('site_name', 'source');\nSELECT 1;\n`;
		const parts = [enc(dump)];
		const { body } = await begin(f, dump, parts);
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		const done = await commitAll(f, body.upload);
		expect(done.statements).toBe(1);
	});

	it('does not carry its staging tables into an export', async () => {
		const parts = partsOf(dumpOf(10), 300);
		const { body } = await begin(f, '', parts);
		await put(f, body.upload, 0, parts[0] as Uint8Array);
		const out = dumpDatabase(f.sql).sql;
		expect(out).not.toContain('cfw_restore_part');
		expect(out).not.toContain('cfw_restore_upload');
	});

	it('rejects the wrong method and an unknown action', async () => {
		expect((await call(f, 'begin', { method: 'GET' })).status).toBe(405);
		expect((await call(f, 'commit', { method: 'GET' }, '&upload=x')).status).toBe(405);
		expect((await call(f, 'nope', { method: 'POST' })).status).toBe(400);
		expect((await call(f, 'status', {}, '&upload=missing')).status).toBe(404);
	});

	it('assembles at most a budget of raw bytes per call', () => {
		expect(ASSEMBLE_BYTES_PER_CALL).toBeGreaterThanOrEqual(RESTORE_PART_MAX_BYTES);
	});
});

describe('a dump above the single-body ceiling', () => {
	it('is refused as one body and restored in parts, with the ceiling lowered through MAX_RESTORE_BYTES', async () => {
		const dump = dumpOf(150);
		const env = { MAX_RESTORE_BYTES: 2000 };
		expect(dump.length).toBeGreaterThan(2000);

		const single = new Request('https://x.example/restore', {
			method: 'POST',
			headers: { 'content-length': String(dump.length) },
			body: dump
		});
		expect(bodyTooLarge(single, env)).toMatchObject({ limit: 2000 });

		const tooBig = new Request('https://x.example/restore-parts?action=put', {
			method: 'PUT',
			headers: { 'content-length': String(RESTORE_PART_MAX_BYTES + 1) }
		});
		expect(bodyTooLarge(tooBig, { MAX_RESTORE_BYTES: 0, MAX_BODY_BYTES: 0 })).toMatchObject({
			limit: RESTORE_PART_MAX_BYTES
		});

		const f = siteOver(new DatabaseSync(':memory:'));
		const parts = partsOf(dump, 900);
		for (const p of parts) {
			const part = new Request('https://x.example/restore-parts?action=put', {
				method: 'PUT',
				headers: { 'content-length': String(p.length) },
				body: p
			});
			expect(bodyTooLarge(part, env), 'a part was refused at the edge').toBeUndefined();
		}
		const { body } = await begin(f, dump, parts, 'over-ceiling');
		for (const [n, p] of parts.entries()) await put(f, body.upload, n, p);
		expect(await commitAll(f, body.upload)).toMatchObject({ ok: true, done: true });
		await replay(f);
		const rows = f.sql.exec('SELECT COUNT(*) AS n FROM t').toArray();
		expect(rows[0]).toEqual({ n: 150 });
	});

	it('leaves the single-body path and its ceiling as they were', async () => {
		expect(bodyLimitFor(new Request('https://x.example/restore', { method: 'POST' }))).toBe(
			16 * 1024 * 1024
		);
		expect(
			bodyLimitFor(new Request('https://x.example/restore', { method: 'POST' }), {
				MAX_RESTORE_BYTES: 5
			})
		).toBe(5);
		expect(
			bodyLimitFor(new Request('https://x.example/restore-parts', { method: 'PUT' }))
		).toBe(RESTORE_PART_MAX_BYTES);
		const f = siteOver(new DatabaseSync(':memory:'));
		const url = new URL('https://do.local/__restore?label=one');
		const res = await restore(
			f.site,
			new Request(url, {
				method: 'POST',
				body: 'CREATE TABLE a (x);\nINSERT INTO a (x) VALUES (1);'
			}),
			url
		);
		expect(await json(res)).toMatchObject({
			ok: true,
			chunks: 1,
			statements: 2,
			generation: 'one'
		});
		expect(f.alarms).toHaveLength(1);
	});

	it('records begin, commit and abort in the audit log and leaves parts out', () => {
		const label = (action: string, method = 'POST') =>
			auditedRoute('/__restore-parts', method, new URLSearchParams({ action }));
		expect(label('begin')).toBe('/__restore-parts?action=begin');
		expect(label('commit')).toBe('/__restore-parts?action=commit');
		expect(label('abort')).toBe('/__restore-parts?action=abort');
		expect(label('put', 'PUT')).toBeUndefined();
		expect(label('status', 'GET')).toBeUndefined();
	});
});

describe('files held only in R2', () => {
	let db: DatabaseSync;
	let f: Fixture;
	const bytesOf = (n: number, seed: number) =>
		Uint8Array.from({ length: n }, (_, i) => (i + seed) % 251);

	/** an evicted row: the object holds no chunks and R2 has the only copy */
	function evict(uri: string, bytes: Uint8Array, r2site = 'mine') {
		putFile(f.sql, uri, bytes, { nowMs: 5, mime: 'image/png' });
		f.sql.exec('DELETE FROM cfw_file_chunk WHERE uri = ?', uri);
		f.sql.exec(
			'UPDATE cfw_file SET evicted = 1, mirrored = 1, hash = ?, r2site = ? WHERE uri = ?',
			hex(bytes),
			r2site,
			uri
		);
		const path = uri.replace('://', '/');
		f.bucket.objects.set(`f/${encodeURIComponent(r2site)}/${path}`, bytes);
	}

	const get = (query: string, headers: Record<string, string> = {}, method = 'GET') => {
		const url = new URL(`https://do.local/__offloaded${query}`);
		return offloaded(f.site, new Request(url, { method, headers }), url);
	};

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		f = siteOver(db);
		ensureFileTables(f.sql);
	});

	it('lists only the evicted files, a page at a time, with the totals on the first page', async () => {
		for (const n of [1, 2, 3, 4, 5]) evict(`public://styles/f${n}.png`, bytesOf(100 + n, n));
		putFile(f.sql, 'public://resident.txt', enc('in the object'), { nowMs: 1 });

		const first = await json(await get('?limit=2'));
		expect(first.files.map((x: { uri: string }) => x.uri)).toEqual([
			'public://styles/f1.png',
			'public://styles/f2.png'
		]);
		expect(first.files[0]).toMatchObject({
			scheme: 'public',
			path: 'styles/f1.png',
			size: 101,
			contentType: 'image/png',
			sha256: hex(bytesOf(101, 1))
		});
		expect(first.next).toBe('public://styles/f2.png');
		expect(first.total).toEqual({ files: 5, bytes: 515 });

		const second = await json(await get(`?limit=2&after=${encodeURIComponent(first.next)}`));
		expect(second.files).toHaveLength(2);
		expect(second.total).toBeUndefined();
		const third = await json(await get(`?limit=2&after=${encodeURIComponent(second.next)}`));
		expect(third.files.map((x: { uri: string }) => x.uri)).toEqual(['public://styles/f5.png']);
		expect(third.next).toBeNull();
	});

	it('marks a row that names another site, and refuses to read it unless granted', async () => {
		evict('public://theirs.png', bytesOf(64, 9), 'source');
		const listed = await json(await get(''));
		expect(listed.files[0].foreign).toBe(true);

		const refused = await get('?uri=public://theirs.png');
		expect(refused.status).toBe(403);
		expect(f.bucket.gets).toHaveLength(0);

		f.trusted.add('source');
		const allowed = await get('?uri=public://theirs.png');
		expect(allowed.status).toBe(200);
		expect(f.bucket.gets[0]?.key).toBe('f/source/public/theirs.png');
	});

	it('streams one evicted file from R2 with its type, size and digest', async () => {
		const bytes = bytesOf(5000, 3);
		evict('public://a/b.png', bytes);
		const res = await get('?uri=public://a/b.png');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-length')).toBe('5000');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.headers.get('x-cfw-file-store')).toBe('r2');
		expect(res.headers.get('x-cfw-file-sha256')).toBe(hex(bytes));
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
	});

	it('answers a byte range from R2 as 206 with the span asked for', async () => {
		const bytes = bytesOf(1000, 7);
		evict('public://r.bin', bytes);
		const res = await get('?uri=public://r.bin', { range: 'bytes=100-199' });
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
		expect(res.headers.get('content-length')).toBe('100');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(100, 200));
		expect(f.bucket.gets[0]?.range).toEqual({ offset: 100, length: 100 });

		const tail = await get('?uri=public://r.bin', { range: 'bytes=-10' });
		expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(990));

		const none = await get('?uri=public://r.bin', { range: 'bytes=5000-' });
		expect(none.status).toBe(416);
		expect(none.headers.get('content-range')).toBe('bytes */1000');
	});

	it('streams a file that is resident chunk by chunk, with ranges across chunk edges', async () => {
		const bytes = bytesOf(1000, 11);
		putFile(f.sql, 'public://both.bin', bytes, { nowMs: 1, chunkSize: 300 });
		f.sql.exec(
			'UPDATE cfw_file SET mirrored = 1, hash = ?, r2site = ? WHERE uri = ?',
			hex(bytes),
			'mine',
			'public://both.bin'
		);
		const whole = await get('?uri=public://both.bin');
		expect(whole.headers.get('x-cfw-file-store')).toBe('object');
		expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);

		const span = await get('?uri=public://both.bin', { range: 'bytes=250-650' });
		expect(span.status).toBe(206);
		expect(new Uint8Array(await span.arrayBuffer())).toEqual(bytes.slice(250, 651));
		expect(f.bucket.gets).toHaveLength(0);
	});

	it('answers HEAD from the row without reading R2', async () => {
		evict('public://h.bin', bytesOf(10, 1));
		const res = await get('?uri=public://h.bin', {}, 'HEAD');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe('10');
		expect(await res.text()).toBe('');
		expect(f.bucket.gets).toHaveLength(0);
	});

	it('cannot be walked out of its prefix, and reads only rows that exist', async () => {
		evict('public://a.png', bytesOf(10, 1));
		f.bucket.objects.set('f/other/public/secret.png', bytesOf(10, 2));
		for (const raw of [
			'public://../other/secret.png',
			'public://a/../../other/secret.png',
			'public://x/..',
			'not a uri'
		]) {
			const res = await get(`?uri=${encodeURIComponent(raw)}`);
			expect(res.status, raw).toBe(400);
		}
		const absent = await get('?uri=public://other/secret.png');
		expect(absent.status).toBe(404);
		expect(f.bucket.gets).toHaveLength(0);
	});

	it('reports a missing object as a read failure and keeps its path to itself', async () => {
		evict('public://gone.png', bytesOf(10, 1));
		f.bucket.objects.clear();
		const res = await get('?uri=public://gone.png');
		expect(res.status).toBe(502);
		expect(JSON.stringify(await json(res))).not.toContain('f/mine');
	});

	it('records the listing once and a private read, never a public one', () => {
		const label = (params: Record<string, string>) =>
			auditedRoute('/__offloaded', 'GET', new URLSearchParams(params));
		expect(label({})).toBe('/__offloaded');
		expect(label({ after: 'public://a' })).toBeUndefined();
		expect(label({ uri: 'public://a' })).toBeUndefined();
		expect(label({ uri: 'private://a' })).toBe('/__offloaded');
	});

	it('rejects a write method', async () => {
		expect((await get('', {}, 'POST')).status).toBe(405);
	});

	it('parses a range header', () => {
		expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
		expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 });
		expect(parseRange('bytes=0-1,5-6', 100)).toBeUndefined();
		expect(parseRange('bytes=9-2', 100)).toBeUndefined();
		expect(parseRange('items=0-1', 100)).toBeUndefined();
		expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
		expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
		expect(parseRange(null, 100)).toBeUndefined();
		expect(parseRange('bytes=0-1', 0)).toBeUndefined();
	});
});
