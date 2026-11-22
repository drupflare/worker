import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	base64ToBytes,
	BINARY_MARK,
	blobBytes,
	bytesToBase64,
	bytesToSource,
	isBinarySource,
	sourceBytes,
	STORED_BYTES_BINDINGS,
	STORED_BYTES_SQL
} from '../../src/ops/module-bytes';
import { digestBytes, digestSource } from '../../src/ops/module-integrity';

/** the bytes of a one-pixel PNG header, which is not UTF-8 and carries a NUL */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff]);

describe('a delivered file is held as the text it is, or as marked base64', () => {
	it('keeps UTF-8 text as the same string, so a text delivery looks as it always did', () => {
		const text = 'café <?php // über\n';
		const bytes = new TextEncoder().encode(text);
		expect(bytesToSource(bytes)).toBe(text);
		expect(sourceBytes(text)).toEqual(bytes);
		expect(isBinarySource(text)).toBe(false);
	});

	it('keeps a byte order mark, which a lenient decode would strip', () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
		expect(sourceBytes(bytesToSource(bytes))).toEqual(bytes);
	});

	it('marks bytes that are not UTF-8, and gives the same bytes back', () => {
		const source = bytesToSource(PNG);
		expect(source.startsWith(BINARY_MARK)).toBe(true);
		expect(isBinarySource(source)).toBe(true);
		expect(sourceBytes(source)).toEqual(PNG);
	});

	it('marks text that holds a NUL, which SQLite would cut at the first one', () => {
		const bytes = new TextEncoder().encode('a\0b');
		const source = bytesToSource(bytes);
		expect(isBinarySource(source)).toBe(true);
		expect(sourceBytes(source)).toEqual(bytes);
	});

	it('marks text that opens with the mark, so it is not read as base64 later', () => {
		const bytes = new TextEncoder().encode(`${BINARY_MARK}not base64 at all`);
		const source = bytesToSource(bytes);
		expect(source.startsWith(BINARY_MARK)).toBe(true);
		expect(sourceBytes(source)).toEqual(bytes);
	});

	it('reads a marked string that is not base64 as empty, which no record matches', () => {
		const damaged = `${BINARY_MARK}***`;
		expect(sourceBytes(damaged)).toEqual(new Uint8Array(0));
		expect(digestSource(damaged)).toBe(digestBytes(new Uint8Array(0)));
	});

	it('round trips a file larger than one base64 chunk', () => {
		const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
		expect(sourceBytes(bytesToSource(bytes))).toEqual(bytes);
	});
});

describe('the digest covers the bytes the mount hands to PHP', () => {
	it('is the digest of the decoded bytes for a binary file', () => {
		expect(digestSource(bytesToSource(PNG))).toBe(digestBytes(PNG));
	});
});

describe('a client blob', () => {
	it('reads text by default and base64 when it says so', () => {
		expect(blobBytes('abc', undefined)).toEqual(new TextEncoder().encode('abc'));
		expect(blobBytes('abc', 'utf8')).toEqual(new TextEncoder().encode('abc'));
		expect(blobBytes(bytesToBase64(PNG), 'base64')).toEqual(PNG);
	});

	it('refuses an encoding it does not read, base64 that is not, and a source that is not a string', () => {
		expect(blobBytes('abc', 'hex')).toBeUndefined();
		expect(blobBytes('abc', 'BASE64')).toBeUndefined();
		expect(blobBytes('%%%', 'base64')).toBeUndefined();
		expect(blobBytes(7, undefined)).toBeUndefined();
		expect(blobBytes(null, 'base64')).toBeUndefined();
	});
});

describe('the stored length without loading the row', () => {
	/** every size around a base64 padding boundary, text and binary, against real SQLite */
	it('answers the byte count for text, for NUL-free binary and for each padding length', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('CREATE TABLE t (path TEXT, source TEXT)');
		const insert = db.prepare('INSERT INTO t (path, source) VALUES (?, ?)');
		const expected = new Map<string, number>();
		for (let length = 0; length <= 9; length++) {
			const bytes = new Uint8Array(length).map((_, i) => 0x80 + i);
			insert.run(`bin${length}`, bytesToSource(bytes));
			expected.set(`bin${length}`, length);
		}
		const text = 'café first';
		insert.run('text', text);
		expected.set('text', new TextEncoder().encode(text).length);
		const rows = db
			.prepare(`SELECT path, ${STORED_BYTES_SQL} AS bytes FROM t`)
			.all(...(STORED_BYTES_BINDINGS as unknown as never[])) as {
			path: string;
			bytes: number;
		}[];
		expect(rows).toHaveLength(expected.size);
		for (const row of rows) expect(row.bytes, row.path).toBe(expected.get(row.path));
		db.close();
	});
});
