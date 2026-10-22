import { describe, expect, it, vi } from 'vitest';
import {
	digestSource,
	emptyIntegrityStats,
	FINDING_PATHS,
	integrityReport,
	isAdopted,
	markAdopted,
	MODSUM_ADOPTED_KEY,
	MODSUM_CHUNK_BYTES,
	noteRefusal,
	readAllRecords,
	readPackageRecords,
	recordMatches,
	writePackageRecords
} from '../../../src/ops/module-integrity';
import { memorySecretStore } from '../../helpers/secret-store';

const freshStore = () => memorySecretStore().sealed;

/** a package of `count` files, each path mapped to the digest of a distinct source */
function package1000(count = 1000): Map<string, string> {
	const out = new Map<string, string>();
	for (let i = 0; i < count; i++) {
		out.set(
			`modules/contrib/big_module/src/Plugin/Deeply/Nested/Directory/Thing${i}.php`,
			digestSource(`<?php // file ${i}`)
		);
	}
	return out;
}

describe('the digest', () => {
	it('is sha256 of the UTF-8 bytes, which is what a mount reads back', async () => {
		const source = 'café <?php // über';
		const subtle = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
		const expected = [...new Uint8Array(subtle)]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(digestSource(source)).toBe(expected);
		// a golden vector, so a swapped hash function cannot agree with itself
		expect(digestSource('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('matches only a well formed record that holds the same digest', () => {
		const digest = digestSource('x');
		expect(recordMatches(digest, digest)).toBe(true);
		expect(recordMatches(undefined, digest)).toBe(false);
		expect(recordMatches('', digest)).toBe(false);
		expect(recordMatches(digest.slice(0, 63), digest)).toBe(false);
		expect(recordMatches(digest.toUpperCase(), digest)).toBe(false);
		expect(recordMatches(digestSource('y'), digest)).toBe(false);
	});
});

describe('sealed chunks', () => {
	it('round-trips a 1,000-file package across several chunks, none over the limit', () => {
		const store = freshStore();
		const records = package1000();
		writePackageRecords(store, 'drupal/big_module', records);
		const chunks = store.list('modsum:');
		expect(chunks.length).toBeGreaterThan(1);
		for (const [, value] of chunks) {
			expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(MODSUM_CHUNK_BYTES);
		}
		expect(readPackageRecords(store, 'drupal/big_module')).toEqual(records);
		expect(readAllRecords(store)).toEqual(records);
	});

	it('writes only the chunks that changed, and a removal deletes what it no longer fills', () => {
		const store = freshStore();
		const records = package1000();
		const first = writePackageRecords(store, 'p', records);
		expect(first).toBe(store.list('modsum:').length);
		expect(writePackageRecords(store, 'p', records), 'an identical write is free').toBe(0);
		const kept = new Map([...records].slice(0, 3));
		const shrunk = writePackageRecords(store, 'p', kept);
		expect(shrunk).toBeGreaterThan(0);
		expect(store.list('modsum:')).toHaveLength(1);
		expect(readPackageRecords(store, 'p')).toEqual(kept);
		writePackageRecords(store, 'p', new Map());
		expect(store.list('modsum:')).toHaveLength(0);
	});

	it('keeps packages apart, including names that hold a colon or a slash', () => {
		const store = freshStore();
		writePackageRecords(store, 'a', new Map([['one.php', digestSource('1')]]));
		writePackageRecords(store, 'a:b', new Map([['two.php', digestSource('2')]]));
		writePackageRecords(store, 'drupal/a', new Map([['three.php', digestSource('3')]]));
		expect([...readPackageRecords(store, 'a').keys()]).toEqual(['one.php']);
		expect([...readPackageRecords(store, 'a:b').keys()]).toEqual(['two.php']);
		expect([...readPackageRecords(store, 'drupal/a').keys()]).toEqual(['three.php']);
		writePackageRecords(store, 'a', new Map());
		expect([...readPackageRecords(store, 'a:b').keys()], 'a delete reached a sibling').toEqual([
			'two.php'
		]);
	});

	it('does not read the adoption marker as a chunk', () => {
		const store = freshStore();
		markAdopted(store);
		expect(isAdopted(store)).toBe(true);
		expect(store.get(MODSUM_ADOPTED_KEY)).toBeDefined();
		expect(readAllRecords(store).size).toBe(0);
		writePackageRecords(store, 'adopted', new Map([['x.php', digestSource('x')]]));
		expect([...readAllRecords(store).keys()]).toEqual(['x.php']);
	});
});

describe('hostile record content fails closed', () => {
	const good = digestSource('good');

	it('reads a chunk that is not JSON, or not an object, as no records', () => {
		const store = freshStore();
		for (const [index, value] of ['not json', '[]', 'null', '"text"', '42', '{'].entries()) {
			store.put(`modsum:p:${String(index).padStart(4, '0')}`, value);
		}
		expect(readAllRecords(store).size).toBe(0);
		expect(readPackageRecords(store, 'p').size).toBe(0);
	});

	it('drops an entry whose hash is not 64 lowercase hex digits, and keeps its neighbours', () => {
		const store = freshStore();
		store.put(
			'modsum:p:0000',
			JSON.stringify({
				'ok.php': good,
				'short.php': good.slice(0, 63),
				'long.php': good + '0',
				'upper.php': good.toUpperCase(),
				'number.php': 7,
				'null.php': null
			})
		);
		expect([...readAllRecords(store).keys()]).toEqual(['ok.php']);
	});

	it('gives a path two chunks disagree about a record that matches nothing', () => {
		const store = freshStore();
		const other = digestSource('other');
		store.put('modsum:p:0000', JSON.stringify({ 'x.php': good }));
		store.put('modsum:q:0000', JSON.stringify({ 'x.php': other }));
		const read = readAllRecords(store).get('x.php');
		expect(read).toBe('');
		expect(recordMatches(read, good)).toBe(false);
		expect(recordMatches(read, other)).toBe(false);
	});

	it('ignores a key that only looks like a chunk', () => {
		const store = freshStore();
		store.put('modsum:p', JSON.stringify({ 'x.php': good }));
		store.put('modsum:p:1', JSON.stringify({ 'x.php': good }));
		store.put('modsum:p:0000:extra', JSON.stringify({ 'x.php': good }));
		expect(readAllRecords(store).size).toBe(0);
	});
});

describe('findings', () => {
	it('counts every refusal, keeps the first few paths and warns once per path', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const stats = emptyIntegrityStats();
		for (let i = 0; i < FINDING_PATHS + 5; i++) noteRefusal(stats, `p${i}.php`, 'no record');
		noteRefusal(stats, 'p0.php', 'no record');
		expect(stats.refused).toBe(FINDING_PATHS + 6);
		expect(stats.paths).toHaveLength(FINDING_PATHS);
		expect(warn).toHaveBeenCalledTimes(FINDING_PATHS + 5);
		expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
			moduleIntegrity: { path: 'p0.php', reason: 'no record' }
		});
		warn.mockRestore();
	});

	it('reports without the warned set, so a stats response stays small', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const stats = emptyIntegrityStats();
		noteRefusal(stats, 'x.php', 'no record');
		expect(Object.keys(integrityReport(stats)).sort()).toEqual([
			'adopted',
			'checked',
			'mode',
			'paths',
			'records',
			'refused'
		]);
		expect(integrityReport(undefined).mode).toBe('unclaimed');
	});
});
