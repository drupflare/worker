import { decode } from '@drupflare/durabledb/codec';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	FILE_CHUNK_BYTES,
	FileOffloadedError,
	MIRROR_STRIKES,
	chunkBytes,
	deleteFile,
	drainHydrates,
	drainMirrors,
	ensureFileTables,
	evictMirrored,
	fetchOffloaded,
	getFile,
	getFileChunk,
	hydrateFile,
	isMirrorable,
	listFiles,
	mirrorKey,
	nextEvictionAt,
	normaliseUri,
	pendingMirrors,
	privateUriForPath,
	putFile,
	queueBackfill,
	queueHydrate,
	queueRehydrateAll,
	readFile,
	recordMirror,
	renameFile,
	statFile,
	storedBytes,
	type FileBucket,
	type FileBuckets
} from '../../../src/db/file-store';
import { installCapabilities } from '../../../src/do/capabilities';
import { driveAlarms, freshSite, inObject, namedSite } from '../../helpers/serve-do';

/**
 * Durable storage for uploads, driven against REAL Durable Object SQL.
 *
 * Not a fake `sql` object. The behaviour this module exists for is what
 * survives an eviction, and every interesting failure is a SQL-level one: the 2,199,995-byte record
 * ceiling, blobs coming back as ArrayBuffer rather than Uint8Array, `LIKE` treating `_` as a
 * wildcard. A stand-in would agree with every assertion here and prove none of them.
 *
 * Deterministic bytes, so a reassembly error shows up as a wrong value rather than a wrong length.
 */
function bytes(n: number, seed = 0): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
	return out;
}

describe('normalising a stream uri, because one file must have one key', () => {
	it('collapses empty and dot segments', () => {
		expect(normaliseUri('public://a//b.png')).toBe('public://a/b.png');
		expect(normaliseUri('public://./a/./b.png')).toBe('public://a/b.png');
	});

	it('lower-cases the scheme but never the path', () => {
		// Drupal filenames are case-sensitive; folding them would merge two real files
		expect(normaliseUri('PUBLIC://Foo.PNG')).toBe('public://Foo.PNG');
	});

	it('REFUSES traversal rather than resolving it', () => {
		// resolving would let `public://../private/secret` address another scheme's bytes, and no
		// legitimate Drupal uri needs a parent segment
		expect(normaliseUri('public://../private/secret.txt')).toBeUndefined();
		expect(normaliseUri('public://a/../../b')).toBeUndefined();
	});

	it('refuses anything that is not a stream uri', () => {
		for (const bad of ['', 'public:/a', '/var/www/a.png', 'public', 'a.png']) {
			expect(normaliseUri(bad), bad).toBeUndefined();
		}
	});
});

describe('chunking', () => {
	it('yields one empty chunk for an empty file, so a read is uniform', () => {
		// a zero-chunk file would make `chunks` 0 and the read loop return early on a file that
		// legitimately exists and is empty
		expect(chunkBytes(new Uint8Array(0))).toHaveLength(1);
		expect(chunkBytes(new Uint8Array(0))[0]).toHaveLength(0);
	});

	it('splits on the boundary without dropping or duplicating a byte', () => {
		const chunks = chunkBytes(bytes(250), 100);
		expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
	});

	it('is exact at a whole multiple', () => {
		expect(chunkBytes(bytes(200), 100).map((c) => c.length)).toEqual([100, 100]);
	});

	it('stays well under the measured 2,199,995-byte record ceiling', () => {
		// the key and the integer columns count against the same record, so the margin is needed
		expect(FILE_CHUNK_BYTES).toBeLessThan(2_199_995 / 2);
	});
});

describe('storing and reading back, against real DO SQL', () => {
	let stub: ReturnType<typeof freshSite>;

	beforeEach(() => {
		stub = freshSite();
	});

	it('round-trips a small file byte for byte', async () => {
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://a.txt', bytes(64, 7), { nowMs: 1_000, mime: 'text/plain' });
			return Array.from(getFile(site.sql, 'public://a.txt') ?? []);
		});
		expect(new Uint8Array(got)).toEqual(bytes(64, 7));
	});

	it('round-trips a file that spans several chunks', async () => {
		// the case single-row storage cannot do at all
		const size = 3 * 1024;
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://big.bin', bytes(size, 3), { nowMs: 1, chunkSize: 1_000 });
			return {
				stat: statFile(site.sql, 'public://big.bin'),
				body: Array.from(getFile(site.sql, 'public://big.bin') ?? [])
			};
		});
		expect(got.stat?.chunks).toBe(4);
		expect(got.stat?.size).toBe(size);
		expect(new Uint8Array(got.body)).toEqual(bytes(size, 3));
	});

	it('round-trips an empty file as an empty file, not as absent', async () => {
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://empty.txt', new Uint8Array(0), { nowMs: 5 });
			const body = getFile(site.sql, 'public://empty.txt');
			return { present: body !== null, length: body?.length ?? -1 };
		});
		expect(got).toEqual({ present: true, length: 0 });
	});

	it('reads back through the normalised key, whichever form the caller used', async () => {
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://a//b.txt', bytes(8), { nowMs: 1 });
			return getFile(site.sql, 'public://a/b.txt')?.length ?? -1;
		});
		expect(got).toBe(8);
	});

	it('returns null for a file that was never stored', async () => {
		const got = await inObject(stub, async (site) => {
			ensureFileTables(site.sql);
			return {
				body: getFile(site.sql, 'public://nope.txt'),
				stat: statFile(site.sql, 'public://nope.txt')
			};
		});
		expect(got.body).toBeUndefined();
		expect(got.stat).toBeUndefined();
	});

	it('SHRINKING an overwrite leaves no orphan chunks behind', async () => {
		// the corruption this guards. Replacing a 4-chunk file with a 1-chunk one by INSERT OR
		// REPLACE alone leaves chunks 1..3, and a later grow back to 4 chunks would splice the new
		// chunk 0 onto the ORIGINAL tail -- a file that never existed, assembled from two versions.
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://x.bin', bytes(4_000, 1), { nowMs: 1, chunkSize: 1_000 });
			putFile(site.sql, 'public://x.bin', bytes(500, 2), { nowMs: 2, chunkSize: 1_000 });
			const orphans = site.sql
				.exec('SELECT COUNT(*) AS n FROM cfw_file_chunk WHERE uri = ?', 'public://x.bin')
				.toArray()[0] as { n: number };
			return {
				chunkRows: Number(orphans.n),
				stat: statFile(site.sql, 'public://x.bin'),
				body: Array.from(getFile(site.sql, 'public://x.bin') ?? [])
			};
		});
		expect(got.chunkRows).toBe(1);
		expect(got.stat?.size).toBe(500);
		expect(new Uint8Array(got.body)).toEqual(bytes(500, 2));
	});

	it('a grow-back-up overwrite reassembles only the new bytes', async () => {
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://y.bin', bytes(4_000, 1), { nowMs: 1, chunkSize: 1_000 });
			putFile(site.sql, 'public://y.bin', bytes(500, 2), { nowMs: 2, chunkSize: 1_000 });
			putFile(site.sql, 'public://y.bin', bytes(4_000, 9), { nowMs: 3, chunkSize: 1_000 });
			return Array.from(getFile(site.sql, 'public://y.bin') ?? []);
		});
		expect(new Uint8Array(got)).toEqual(bytes(4_000, 9));
	});

	it('serves one chunk at a time, for a read that must be divisible', async () => {
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://z.bin', bytes(2_500, 4), { nowMs: 1, chunkSize: 1_000 });
			const lengths: number[] = [];
			for (let seq = 0; ; seq++) {
				const chunk = getFileChunk(site.sql, 'public://z.bin', seq);
				if (chunk === undefined) break;
				lengths.push(chunk.length);
			}
			return lengths;
		});
		expect(got).toEqual([1_000, 1_000, 500]);
	});

	it('records the mime and the modified time a stat needs', async () => {
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://i.png', bytes(10), { nowMs: 12_345, mime: 'image/png' });
			return statFile(site.sql, 'public://i.png');
		});
		expect(got?.mime).toBe('image/png');
		expect(got?.modified).toBe(12_345);
	});

	it('refuses to store something that is not a stream uri', async () => {
		await expect(
			inObject(stub, async (site) => putFile(site.sql, '/etc/passwd', bytes(4), { nowMs: 1 }))
		).rejects.toThrow(/not a storable stream uri/);
	});
});

describe('deleting and moving', () => {
	it('deletes the metadata and every chunk, and says whether anything was there', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://d.bin', bytes(2_500), { nowMs: 1, chunkSize: 1_000 });
			const first = deleteFile(site.sql, 'public://d.bin', 2);
			const second = deleteFile(site.sql, 'public://d.bin', 3);
			const left = site.sql
				.exec('SELECT COUNT(*) AS n FROM cfw_file_chunk WHERE uri = ?', 'public://d.bin')
				.toArray()[0] as { n: number };
			return { first, second, chunkRows: Number(left.n) };
		});
		// the second call reports false rather than throwing: a delete of an absent file is a state
		expect(got).toEqual({ first: true, second: false, chunkRows: 0 });
	});

	it('moves a file by re-keying rather than copying its bytes', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://tmp/up.bin', bytes(2_500, 6), {
				nowMs: 1,
				chunkSize: 1_000
			});
			const moved = renameFile(site.sql, 'public://tmp/up.bin', 'public://final/up.bin', 2);
			return {
				moved,
				gone: statFile(site.sql, 'public://tmp/up.bin'),
				body: Array.from(getFile(site.sql, 'public://final/up.bin') ?? [])
			};
		});
		expect(got.moved).toBe(true);
		expect(got.gone).toBeUndefined();
		expect(new Uint8Array(got.body)).toEqual(bytes(2_500, 6));
	});

	it('refuses to clobber on a move unless asked, because file_move owns that decision', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(10, 1), { nowMs: 1 });
			putFile(site.sql, 'public://b.bin', bytes(20, 2), { nowMs: 1 });
			const refused = renameFile(site.sql, 'public://a.bin', 'public://b.bin', 2);
			const forced = renameFile(site.sql, 'public://a.bin', 'public://b.bin', 3, {
				overwrite: true
			});
			return { refused, forced, body: Array.from(getFile(site.sql, 'public://b.bin') ?? []) };
		});
		expect(got.refused).toBe(false);
		expect(got.forced).toBe(true);
		expect(new Uint8Array(got.body)).toEqual(bytes(10, 1));
	});

	it('treats a move onto itself as a success without touching anything', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://s.bin', bytes(10), { nowMs: 1 });
			return {
				same: renameFile(site.sql, 'public://s.bin', 'public://s.bin', 2),
				body: getFile(site.sql, 'public://s.bin')?.length ?? -1
			};
		});
		expect(got).toEqual({ same: true, body: 10 });
	});

	it('reports false for a move of a file that is not there', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			ensureFileTables(site.sql);
			return renameFile(site.sql, 'public://ghost.bin', 'public://x.bin', 1);
		});
		expect(got).toBe(false);
	});
});

describe('listing, where LIKE metacharacters are a real filename', () => {
	it('does not let an underscore in a prefix match a sibling directory', async () => {
		// `_` is a single-character wildcard in LIKE, and Drupal directory names contain it
		// constantly. Unescaped, a listing of `public://a_b/` also returns `public://axb/`, and a
		// delete-by-prefix built on that removes the wrong files.
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://a_b/one.txt', bytes(4), { nowMs: 1 });
			putFile(site.sql, 'public://axb/two.txt', bytes(4), { nowMs: 1 });
			return listFiles(site.sql, 'public://a_b/').map((f) => f.uri);
		});
		expect(got).toEqual(['public://a_b/one.txt']);
	});

	it('lists a directory in uri order', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			for (const name of ['c.txt', 'a.txt', 'b.txt']) {
				putFile(site.sql, `public://d/${name}`, bytes(4), { nowMs: 1 });
			}
			return listFiles(site.sql, 'public://d/').map((f) => f.uri);
		});
		expect(got).toEqual(['public://d/a.txt', 'public://d/b.txt', 'public://d/c.txt']);
	});

	it('still filters correctly when the prefix exceeds the 50-byte LIKE ceiling', async () => {
		// the measured platform limit: a LIKE pattern over 50 bytes is rejected, so a long prefix
		// has to be filtered in JS. Without the fallback this throws instead of listing.
		const deep = `public://${'nested/'.repeat(8)}`;
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, `${deep}in.txt`, bytes(4), { nowMs: 1 });
			putFile(site.sql, 'public://elsewhere.txt', bytes(4), { nowMs: 1 });
			return listFiles(site.sql, deep).map((f) => f.uri);
		});
		// the prefix itself is what exceeds the ceiling; the listing is the one matching file
		expect(deep.length).toBeGreaterThan(50);
		expect(got).toEqual([`${deep}in.txt`]);
	});

	it('totals what is stored, for a quota the UI can show before a user hits it', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(100), { nowMs: 1 });
			putFile(site.sql, 'public://b.bin', bytes(250), { nowMs: 1 });
			return storedBytes(site.sql);
		});
		expect(got).toEqual({ files: 2, bytes: 350, offloaded: { files: 0, bytes: 0 } });
	});

	it('totals zero rather than NaN on an empty store', async () => {
		// SUM() over no rows is NULL, and Number(null) is 0 only if it is not read as undefined
		const stub = freshSite();
		const got = await inObject(stub, async (site) => storedBytes(site.sql));
		expect(got).toEqual({ files: 0, bytes: 0, offloaded: { files: 0, bytes: 0 } });
	});
});

describe('the R2 mirror queue, which is an offload and not the durability', () => {
	it('queues a put on write and clears it on success, marking the file mirrored', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://m.bin', bytes(10), { nowMs: 1 });
			const queued = pendingMirrors(site.sql);
			recordMirror(site.sql, 'public://m.bin', { ok: true });
			return {
				queued,
				after: pendingMirrors(site.sql),
				stat: statFile(site.sql, 'public://m.bin')
			};
		});
		expect(got.queued).toEqual([{ uri: 'public://m.bin', op: 'put', attempts: 0 }]);
		expect(got.after).toEqual([]);
		expect(got.stat?.mirrored).toBe(true);
	});

	it('RE-QUEUES on overwrite, so R2 cannot keep serving the previous bytes', async () => {
		// mirrored resets to 0 on a put; without the queue row coming back too, the custom domain
		// serves the old file forever and it reads as a caching bug rather than a correctness one
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://o.bin', bytes(10, 1), { nowMs: 1 });
			recordMirror(site.sql, 'public://o.bin', { ok: true });
			putFile(site.sql, 'public://o.bin', bytes(10, 2), { nowMs: 2 });
			return {
				stat: statFile(site.sql, 'public://o.bin'),
				queued: pendingMirrors(site.sql)
			};
		});
		expect(got.stat?.mirrored).toBe(false);
		expect(got.queued).toEqual([{ uri: 'public://o.bin', op: 'put', attempts: 0 }]);
	});

	it('queues a delete even for a file that was never mirrored', async () => {
		// `mirrored` is what the DO believes; a mirror that raced the delete would otherwise leave
		// the object live in R2 after the file is gone. Deleting an absent object is a no-op.
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://q.bin', bytes(10), { nowMs: 1 });
			deleteFile(site.sql, 'public://q.bin', 2);
			return pendingMirrors(site.sql);
		});
		expect(got).toEqual([{ uri: 'public://q.bin', op: 'delete', attempts: 0 }]);
	});

	it('queues BOTH halves of a move: a put for the new key and a delete for the old', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://from.bin', bytes(10), { nowMs: 1 });
			recordMirror(site.sql, 'public://from.bin', { ok: true });
			renameFile(site.sql, 'public://from.bin', 'public://to.bin', 2);
			return pendingMirrors(site.sql).sort((a, b) => a.uri.localeCompare(b.uri));
		});
		expect(got).toEqual([
			{ uri: 'public://from.bin', op: 'delete', attempts: 0 },
			{ uri: 'public://to.bin', op: 'put', attempts: 0 }
		]);
	});

	it('DROPS a mirror after three failures rather than retrying forever', async () => {
		// the file is already durable and serves from the Durable Object, so an unmirrored file is
		// a lost optimisation. Retrying forever would spend the rows-written meter -- the one that
		// binds regeneration -- on a bucket that is not coming back.
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://f.bin', bytes(10), { nowMs: 1 });
			const outcomes = [];
			for (let i = 0; i < MIRROR_STRIKES; i++) {
				outcomes.push(
					recordMirror(site.sql, 'public://f.bin', { ok: false, error: 'no bucket' })
				);
			}
			return {
				outcomes,
				queued: pendingMirrors(site.sql),
				stat: statFile(site.sql, 'public://f.bin')
			};
		});
		expect(got.outcomes.map((o) => o.attempts)).toEqual([1, 2, 3]);
		expect(got.outcomes.at(-1)?.dropped).toBe(true);
		expect(got.queued).toEqual([]);
		// and the file is still there, unmirrored
		expect(got.stat?.size).toBe(10);
		expect(got.stat?.mirrored).toBe(false);
	});

	it('records the last error while it is still retrying', async () => {
		const stub = freshSite();
		const got = await inObject(stub, async (site) => {
			putFile(site.sql, 'public://e.bin', bytes(10), { nowMs: 1 });
			recordMirror(site.sql, 'public://e.bin', { ok: false, error: 'boom' });
			return site.sql
				.exec(
					'SELECT attempts, last_error FROM cfw_file_mirror_queue WHERE uri = ?',
					'public://e.bin'
				)
				.toArray()[0] as { attempts: number; last_error: string };
		});
		expect(Number(got.attempts)).toBe(1);
		expect(String(got.last_error)).toBe('boom');
	});
});

describe('surviving what it exists to survive', () => {
	it('a stored file is readable from a DIFFERENT object instance for the same site', async () => {
		// the actual deliverable. MEMFS loses the upload when the isolate dies, so this is the
		// assertion that would have failed for every version of the product until now. Two stubs
		// for the same id reach the same durable storage through separate JS instances.
		await inObject(namedSite('file-survives'), async (site) => {
			putFile(site.sql, 'public://survivor.txt', bytes(128, 11), { nowMs: 1 });
		});
		const got = await inObject(namedSite('file-survives'), async (site) =>
			Array.from(getFile(site.sql, 'public://survivor.txt') ?? [])
		);
		expect(new Uint8Array(got)).toEqual(bytes(128, 11));
	});
});

/**
 * The refusal that makes the R2 offload safe to turn on.
 *
 * Drupal's `private://` is an access-control boundary, not a naming convention: those files serve
 * through `/system/files/`, which access-checks per user. An R2 object has no user, so mirroring
 * one publishes it permanently to anyone holding the URL. That is the file-side of the same rule
 * `src/site.ts` enforces for renders, and it is worse than the page case because it does not
 * expire and cannot be invalidated after the fact.
 */
describe('what may leave the object, and what may never', () => {
	it('admits public:// and refuses private://', () => {
		expect(isMirrorable('public://a.png')).toBe(true);
		expect(isMirrorable('private://secret.pdf')).toBe(false);
	});

	it('refuses a scheme nobody has decided about, rather than admitting it', () => {
		// an allowlist, so a scheme added later fails CLOSED until someone chooses
		expect(isMirrorable('temporary://x')).toBe(false);
		expect(isMirrorable('s3://x')).toBe(false);
	});

	it('is not fooled by case or by a traversal', () => {
		expect(isMirrorable('PRIVATE://x')).toBe(false);
		expect(isMirrorable('public://../private/x')).toBe(false);
		expect(isMirrorable('not a uri')).toBe(false);
	});

	it('keeps the scheme in the R2 key, so two schemes cannot collide', () => {
		// stripping it would map public://a and private://a onto one object, which is the exact
		// failure this module is arranged to prevent
		expect(mirrorKey('public://a.png')).toBe('f/site/public/a.png');
		expect(mirrorKey('private://a.png')).toBe('f/site/private/a.png');
		expect(mirrorKey('nonsense')).toBeUndefined();
	});

	/**
	 * ONE DEPLOYMENT CAN SERVE MANY OBJECTS INTO ONE BUCKET, and this key had no site component at
	 * all: `public://logo.png` was `public/logo.png` for every one of them, so site B's upload
	 * overwrote site A's in the public mirror.
	 */
	it('scopes the key to the site, so two sites cannot overwrite each other', () => {
		expect(mirrorKey('public://logo.png', 'alpha')).toBe('f/alpha/public/logo.png');
		expect(mirrorKey('public://logo.png', 'beta')).toBe('f/beta/public/logo.png');
		expect(mirrorKey('public://logo.png', 'alpha')).not.toBe(
			mirrorKey('public://logo.png', 'beta')
		);
	});

	it('encodes a site name that would otherwise add a path segment', () => {
		expect(mirrorKey('public://a.png', 'a/b')).toBe('f/a%2Fb/public/a.png');
	});

	it('never QUEUES a private file in the first place', async () => {
		const queued = await inObject(freshSite(), (site) => {
			putFile(site.sql, 'private://secret.pdf', bytes(64), { nowMs: 1 });
			putFile(site.sql, 'public://fine.png', bytes(64), { nowMs: 2 });
			return pendingMirrors(site.sql).map((t) => t.uri);
		});
		expect(queued).toEqual(['public://fine.png']);
	});

	it('stores the private file even though it refuses to mirror it', async () => {
		// the refusal is about LEAVING the object, not about storing; a private upload must still
		// work, or the rule would break the feature instead of securing it
		const got = await inObject(freshSite(), (site) => {
			putFile(site.sql, 'private://secret.pdf', bytes(64, 3), { nowMs: 1 });
			return Array.from(getFile(site.sql, 'private://secret.pdf') ?? []);
		});
		expect(new Uint8Array(got)).toEqual(bytes(64, 3));
	});

	it('on a rename OUT of public, refuses the put and STILL queues the delete', async () => {
		// the case a single scheme check on the operation would get wrong. The old public object
		// has to leave R2; only the new private one is refused.
		const queued = await inObject(freshSite(), (site) => {
			putFile(site.sql, 'public://a.bin', bytes(32), { nowMs: 1 });
			recordMirror(site.sql, 'public://a.bin', { ok: true });
			renameFile(site.sql, 'public://a.bin', 'private://b.bin', 2);
			return pendingMirrors(site.sql).map((t) => `${t.op}:${t.uri}`);
		});
		expect(queued).toEqual(['delete:public://a.bin']);
	});
});

describe('draining the queue to R2', () => {
	/** a bucket that records what it was asked to do, and can be told to fail */
	function fakeBucket(fail: (key: string) => boolean = () => false) {
		const puts: string[] = [];
		const deletes: string[] = [];
		return {
			puts,
			deletes,
			async put(key: string, value: Uint8Array) {
				if (fail(key)) throw new Error('r2 down');
				puts.push(`${key}:${value.length}`);
			},
			async delete(key: string) {
				if (fail(key)) throw new Error('r2 down');
				deletes.push(key);
			}
		};
	}

	it('reports noBucket rather than throwing when nothing is bound', async () => {
		// the free-tier default: the object IS the durable copy, so an absent bucket is a
		// configuration state and not an error
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(16), { nowMs: 1 });
			return drainMirrors(site.sql, undefined);
		});
		expect(out.noBucket).toBe(true);
		expect(out.mirrored).toBe(0);
	});

	it('leaves the queue intact when there is no bucket, so nothing is lost', async () => {
		const left = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(16), { nowMs: 1 });
			await drainMirrors(site.sql, undefined);
			return pendingMirrors(site.sql).length;
		});
		expect(left).toBe(1);
	});

	it('pushes the bytes and marks the file mirrored', async () => {
		const bucket = fakeBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(300), { nowMs: 1 });
			const drained = await drainMirrors(site.sql, bucket);
			return {
				drained,
				queued: pendingMirrors(site.sql).length,
				mirrored: statFile(site.sql, 'public://a.bin')?.mirrored
			};
		});
		expect(bucket.puts).toEqual(['f/site/public/a.bin:300']);
		expect(out.drained.mirrored).toBe(1);
		expect(out.queued).toBe(0);
		expect(out.mirrored).toBe(true);
	});

	it('reassembles a MULTI-CHUNK file before pushing it', async () => {
		// the bytes in R2 must be the whole file, not the first 200,000-byte chunk
		const bucket = fakeBucket();
		await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://big.bin', bytes(FILE_CHUNK_BYTES + 1234), { nowMs: 1 });
			await drainMirrors(site.sql, bucket);
		});
		expect(bucket.puts).toEqual([`f/site/public/big.bin:${FILE_CHUNK_BYTES + 1234}`]);
	});

	it('removes the object for a queued delete', async () => {
		const bucket = fakeBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://gone.bin', bytes(16), { nowMs: 1 });
			await drainMirrors(site.sql, bucket);
			deleteFile(site.sql, 'public://gone.bin', 2);
			return drainMirrors(site.sql, bucket);
		});
		expect(bucket.deletes).toEqual(['f/site/public/gone.bin']);
		expect(out.deleted).toBe(1);
	});

	it('RE-CHECKS the refusal at the bucket, not only at the queue', async () => {
		// the boundary rule: a queue row can outlive the state that admitted it, so the only
		// check that guards the bucket is the one next to the put. Written directly into the
		// queue to model exactly that -- a row from an older version, or a scheme that stopped
		// being publishable.
		const bucket = fakeBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'private://leak.pdf', bytes(64), { nowMs: 1 });
			site.sql.exec(
				`INSERT INTO cfw_file_mirror_queue (uri, op, queued_at, attempts)
				 VALUES ('private://leak.pdf', 'put', 1, 0)`
			);
			return drainMirrors(site.sql, bucket);
		});
		expect(bucket.puts).toEqual([]);
		expect(out.refused).toBe(1);
		expect(out.mirrored).toBe(0);
	});

	it('drops a refused row rather than re-reading it every pass', async () => {
		// it can never become sendable, so holding it would keep the queue permanently non-empty
		// and starve the rows that can be sent
		const bucket = fakeBucket();
		const left = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'private://leak.pdf', bytes(16), { nowMs: 1 });
			site.sql.exec(
				`INSERT INTO cfw_file_mirror_queue (uri, op, queued_at, attempts)
				 VALUES ('private://leak.pdf', 'put', 1, 0)`
			);
			await drainMirrors(site.sql, bucket);
			return pendingMirrors(site.sql).length;
		});
		expect(left).toBe(0);
	});

	it('retries a failure and gives up after MIRROR_STRIKES', async () => {
		const bucket = fakeBucket(() => true);
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://flaky.bin', bytes(16), { nowMs: 1 });
			const passes = [];
			for (let i = 0; i < MIRROR_STRIKES; i++) {
				passes.push(await drainMirrors(site.sql, bucket));
			}
			return { passes, queued: pendingMirrors(site.sql).length };
		});
		expect(out.passes.slice(0, MIRROR_STRIKES - 1).every((p) => p.failed === 1)).toBe(true);
		expect(out.passes[MIRROR_STRIKES - 1]!.droppedAfterStrikes).toBe(1);
		// the file is still durable in the object; only the offload was abandoned
		expect(out.queued).toBe(0);
	});

	it('does not let one failure stop the rest of the pass', async () => {
		const bucket = fakeBucket((key) => key === 'f/site/public/bad.bin');
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://bad.bin', bytes(16), { nowMs: 1 });
			putFile(site.sql, 'public://good.bin', bytes(16), { nowMs: 2 });
			return drainMirrors(site.sql, bucket);
		});
		expect(bucket.puts).toEqual(['f/site/public/good.bin:16']);
		expect(out.mirrored).toBe(1);
		expect(out.failed).toBe(1);
	});

	it('skips a file deleted between enqueue and drain without counting a failure', async () => {
		const bucket = fakeBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://vanish.bin', bytes(16), { nowMs: 1 });
			// remove the rows the way an eviction race would, leaving the queue entry behind
			site.sql.exec('DELETE FROM cfw_file_chunk WHERE uri = ?', 'public://vanish.bin');
			site.sql.exec('DELETE FROM cfw_file WHERE uri = ?', 'public://vanish.bin');
			return {
				drained: await drainMirrors(site.sql, bucket),
				left: pendingMirrors(site.sql)
			};
		});
		expect(bucket.puts).toEqual([]);
		expect(out.drained.failed).toBe(0);
		expect(out.left).toEqual([]);
	});

	it('honours the limit, so one pass cannot run away with the invocation', async () => {
		const bucket = fakeBucket();
		const out = await inObject(freshSite(), async (site) => {
			for (let i = 0; i < 5; i++) {
				putFile(site.sql, `public://f${i}.bin`, bytes(16), { nowMs: i + 1 });
			}
			return drainMirrors(site.sql, bucket, { limit: 2 });
		});
		expect(out.mirrored).toBe(2);
		expect(bucket.puts).toHaveLength(2);
	});

	it('carries the content type across, so R2 serves it correctly', async () => {
		const seen: unknown[] = [];
		const bucket = {
			async put(_k: string, _v: Uint8Array, options?: unknown) {
				seen.push(options);
			},
			async delete() {}
		};
		await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.png', bytes(16), { nowMs: 1, mime: 'image/png' });
			await drainMirrors(site.sql, bucket);
		});
		expect(seen[0]).toEqual({ httpMetadata: { contentType: 'image/png' } });
	});
});

/**
 * The drain runs UNATTENDED, which is the difference between designed and delivered.
 *
 * The queue and its bookkeeping existed for a while and nothing called them, so the report
 * correctly described the off-Worker serving path as "designed, not delivered". A queue nothing
 * drains is not a slow offload, it is no offload -- and the serving ceiling, which R2 is the only
 * lever on, stayed saturated the whole time.
 */
describe('the alarm drains it, with no diagnostic route poked', () => {
	it('mirrors a queued file on an ordinary firing', async () => {
		const puts: string[] = [];
		const stub = freshSite();
		await inObject(stub, (site) => {
			// the accessor is overridden per INSTANCE rather than `FILES` being set. `env` is
			// shared across every object in this pool, so writing a binding onto it leaks into the
			// next spec -- which is exactly what the sibling test below caught when it did.
			(site as unknown as { mirrorBucket: () => unknown }).mirrorBucket = () => ({
				async put(key: string, value: Uint8Array) {
					puts.push(`${key}:${value.length}`);
				},
				async delete() {}
			});
			putFile(site.sql, 'public://alarm.bin', bytes(48), { nowMs: 1 });
		});

		await inObject(stub, (site) => site.ctx.storage.setAlarm(Date.now() - 1));
		await driveAlarms(stub, (site) => pendingMirrors(site.sql).length === 0, 6);

		expect(puts).toEqual(['f/site/public/alarm.bin:48']);
	});

	it('under FILE_STORE=r2, verifies the put, evicts the chunks, and still serves from R2', async () => {
		const objects = new Map<string, Uint8Array>();
		const bucket: FileBucket = {
			async put(key, value) {
				objects.set(key, new Uint8Array(value));
				return { size: value.length };
			},
			async delete(key) {
				objects.delete(key);
			},
			async get(key) {
				const found = objects.get(key);
				return found === undefined
					? null
					: {
							size: found.length,
							body: null,
							arrayBuffer: async () => found.slice().buffer as ArrayBuffer
						};
			}
		};
		const stub = freshSite();
		await inObject(stub, (site) => {
			const patched = site as unknown as Record<string, unknown>;
			patched.mirrorBucket = () => bucket;
			patched.fileStoreR2 = () => true;
			patched.fileBuckets = () => ({ public: bucket });
			patched.fileSchemes = () => ['public'];
			patched.env = { ...(site as unknown as { env: object }).env, FILE_EVICT_AFTER_MS: '0' };
			putFile(site.sql, 'public://alarm.bin', bytes(48, 7), { nowMs: Date.now() });
		});

		await inObject(stub, (site) => site.ctx.storage.setAlarm(Date.now() - 1));
		await driveAlarms(
			stub,
			(site) => statFile(site.sql, 'public://alarm.bin')?.evicted === true,
			8
		);

		const after = await inObject(stub, async (site) => ({
			stat: statFile(site.sql, 'public://alarm.bin'),
			chunkRows: site.sql.exec('SELECT COUNT(*) AS n FROM cfw_file_chunk').toArray()[0]?.n,
			back: await readFile(site.sql, { public: bucket }, 'public://alarm.bin'),
			backfilled: site.metaGet('file_backfill:public')
		}));
		expect(after.stat).toMatchObject({ mirrored: true, evicted: true });
		expect(after.chunkRows).toBe(0);
		expect(after.back).toEqual(bytes(48, 7));
		expect(after.backfilled).not.toBeNull();
	});

	it('does not disturb a site with no bucket bound', async () => {
		// the free-tier default has to be a quiet no-op, not an error on every firing.
		//
		// UNBOUND EXPLICITLY. This used to rely on `wrangler.jsonc` declaring no `FILES` bucket,
		// which stopped being true the moment the binding was added -- and the whole R2 tier had
		// been unreachable until then precisely because nobody had declared it. A spec about an
		// ABSENT binding has to remove it rather than assume the config does
		const stub = freshSite();
		await inObject(stub, (site) => {
			(site as unknown as { env: Record<string, unknown> }).env = {
				...(site as unknown as { env: Record<string, unknown> }).env,
				FILES: undefined
			};
			putFile(site.sql, 'public://quiet.bin', bytes(16), { nowMs: 1 });
		});
		await inObject(stub, (site) => site.ctx.storage.setAlarm(Date.now() - 1));
		await driveAlarms(stub, () => false, 3);
		const state = await inObject(stub, (site) => ({
			queued: pendingMirrors(site.sql).length,
			drain: (site as unknown as { lastMirrorDrain?: unknown }).lastMirrorDrain ?? null
		}));
		// still queued for whenever a bucket appears, and nothing recorded as an error
		expect(state.queued).toBe(1);
		expect(state.drain).toBeNull();
	});
});

/**
 * `FILE_STORE=r2`: R2 holds the bytes and the object keeps metadata.
 *
 * PHP cannot wait for R2, so the order is write-behind: the object takes the chunks, a verified put
 * follows, and the chunks leave only after a grace window. Every test here is a way that order
 * could lose bytes or serve the wrong ones.
 */
describe('R2 as the file store', () => {
	/** an in-memory R2 that keeps what it was given and can run a hook inside a put */
	function memoryBucket(opts: { onPut?: () => void; lie?: boolean } = {}) {
		const objects = new Map<string, Uint8Array>();
		const puts: { key: string; options: Record<string, unknown> }[] = [];
		const bucket: FileBucket & {
			objects: Map<string, Uint8Array>;
			puts: typeof puts;
			gets: string[];
		} = {
			objects,
			puts,
			gets: [],
			async put(key, value, options) {
				opts.onPut?.();
				puts.push({ key, options: (options ?? {}) as Record<string, unknown> });
				objects.set(key, new Uint8Array(value));
				return { size: opts.lie ? value.length - 1 : value.length };
			},
			async delete(key) {
				objects.delete(key);
			},
			async get(key) {
				bucket.gets.push(key);
				const found = objects.get(key);
				if (found === undefined) return null;
				return {
					size: found.length,
					body: new Blob([found]).stream(),
					arrayBuffer: async () => found.slice().buffer as ArrayBuffer
				};
			}
		};
		return bucket;
	}

	const GRACE = 1_000;

	/** stores, verifies and evicts one public file; returns what the object holds after */
	async function offloaded(
		site: Parameters<Parameters<typeof inObject>[1]>[0],
		bucket: FileBucket
	) {
		putFile(site.sql, 'public://a.bin', bytes(300, 5), {
			nowMs: 1,
			mime: 'application/x-test'
		});
		await drainMirrors(site.sql, bucket, { verify: true });
		return evictMirrored(site.sql, {
			nowMs: 1 + GRACE,
			graceMs: GRACE,
			limit: 10,
			schemes: ['public']
		});
	}

	it('migrates a table written before the new columns existed', async () => {
		const got = await inObject(freshSite(), (site) => {
			site.sql.exec(
				`CREATE TABLE cfw_file (uri TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL,
				 mime TEXT, chunks INTEGER NOT NULL, mirrored INTEGER NOT NULL DEFAULT 0)`
			);
			site.sql.exec("INSERT INTO cfw_file VALUES ('public://old.bin', 4, 1, NULL, 1, 1)");
			return statFile(site.sql, 'public://old.bin');
		});
		expect(got).toMatchObject({ size: 4, mirrored: true, evicted: false, rev: 0 });
	});

	it('bumps rev on every write and clears the verified state', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const bucket = memoryBucket();
			putFile(site.sql, 'public://a.bin', bytes(8), { nowMs: 1 });
			const first = statFile(site.sql, 'public://a.bin')?.rev;
			await drainMirrors(site.sql, bucket, { verify: true });
			putFile(site.sql, 'public://a.bin', bytes(8, 1), { nowMs: 2 });
			return { first, second: statFile(site.sql, 'public://a.bin') };
		});
		expect(out.first).toBe(1);
		expect(out.second).toMatchObject({ rev: 2, mirrored: false, evicted: false });
	});

	it('sends a sha256 R2 can check, confirms the size, and records the hash', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(300, 5), { nowMs: 1 });
			const drained = await drainMirrors(site.sql, bucket, { verify: true });
			return {
				drained,
				hash: site.sql.exec('SELECT hash FROM cfw_file').toArray()[0]?.hash
			};
		});
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(300, 5)));
		const expected = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
		expect(bucket.puts[0]?.options.sha256).toBe(expected);
		expect(out.hash).toBe(expected);
		expect(out.drained.mirrored).toBe(1);
	});

	it('does not evict a file whose stored size disagrees', async () => {
		const bucket = memoryBucket({ lie: true });
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(64), { nowMs: 1 });
			const drained = await drainMirrors(site.sql, bucket, { verify: true });
			const evicted = evictMirrored(site.sql, {
				nowMs: 10 * GRACE,
				graceMs: GRACE,
				limit: 10,
				schemes: ['public']
			});
			return { drained, evicted, stat: statFile(site.sql, 'public://a.bin') };
		});
		expect(out.drained.failed).toBe(1);
		expect(out.evicted.evicted).toBe(0);
		expect(out.stat).toMatchObject({ mirrored: false, evicted: false });
	});

	it('keeps the chunks through the grace window and drops them after', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(300, 5), { nowMs: 1 });
			await drainMirrors(site.sql, bucket, { verify: true });
			const early = evictMirrored(site.sql, {
				nowMs: GRACE,
				graceMs: GRACE,
				limit: 10,
				schemes: ['public']
			});
			const due = nextEvictionAt(site.sql, GRACE);
			const late = evictMirrored(site.sql, {
				nowMs: 1 + GRACE,
				graceMs: GRACE,
				limit: 10,
				schemes: ['public']
			});
			return {
				early,
				due,
				late,
				chunkRows: site.sql.exec('SELECT COUNT(*) AS n FROM cfw_file_chunk').toArray()[0]
					?.n,
				stats: storedBytes(site.sql),
				next: nextEvictionAt(site.sql, GRACE)
			};
		});
		expect(out.early.evicted).toBe(0);
		expect(out.due).toBe(1 + GRACE);
		expect(out.late).toEqual({ evicted: 1, bytes: 300 });
		expect(out.chunkRows).toBe(0);
		expect(out.stats).toEqual({ files: 1, bytes: 300, offloaded: { files: 1, bytes: 300 } });
		expect(out.next).toBeUndefined();
	});

	it('never evicts a file that was mirrored without verification', async () => {
		// the legacy mirror sends no hash; those bytes are not trusted enough to delete the copy
		const bucket = memoryBucket();
		const evicted = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(16), { nowMs: 1 });
			await drainMirrors(site.sql, bucket);
			return evictMirrored(site.sql, {
				nowMs: 10 * GRACE,
				graceMs: GRACE,
				limit: 10,
				schemes: ['public']
			});
		});
		expect(evicted.evicted).toBe(0);
	});

	it('leaves a file alone when it is rewritten while its put is in flight', async () => {
		// the put is awaited and other requests run meanwhile; marking the new bytes mirrored would
		// hide them from the drain and evict a file whose R2 copy is the OLD one
		let rewrite: () => void = () => {};
		const bucket = memoryBucket({ onPut: () => rewrite() });
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(32, 1), { nowMs: 1 });
			rewrite = () => putFile(site.sql, 'public://a.bin', bytes(32, 2), { nowMs: 2 });
			const first = await drainMirrors(site.sql, bucket, { verify: true });
			rewrite = () => {};
			const mid = {
				stat: statFile(site.sql, 'public://a.bin'),
				queued: pendingMirrors(site.sql).length
			};
			const second = await drainMirrors(site.sql, bucket, { verify: true });
			return { first, mid, second };
		});
		expect(out.first).toMatchObject({ mirrored: 0, superseded: 1 });
		expect(out.mid.stat?.mirrored).toBe(false);
		expect(out.mid.queued).toBe(1);
		expect(out.second.mirrored).toBe(1);
		expect(bucket.objects.get('f/site/public/a.bin')).toEqual(bytes(32, 2));
	});

	it('refuses a synchronous read of an evicted file instead of answering empty', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			await offloaded(site, bucket);
			const whole = (() => {
				try {
					return getFile(site.sql, 'public://a.bin');
				} catch (e) {
					return e;
				}
			})();
			const chunk = (() => {
				try {
					return getFileChunk(site.sql, 'public://a.bin', 0);
				} catch (e) {
					return e;
				}
			})();
			return { whole, chunk };
		});
		expect(out.whole).toBeInstanceOf(FileOffloadedError);
		expect(out.chunk).toBeInstanceOf(FileOffloadedError);
	});

	it('reads an evicted file back from R2 byte for byte', async () => {
		const bucket = memoryBucket();
		const got = await inObject(freshSite(), async (site) => {
			await offloaded(site, bucket);
			return readFile(site.sql, { public: bucket }, 'public://a.bin');
		});
		expect(got).toEqual(bytes(300, 5));
		expect(bucket.gets).toEqual(['f/site/public/a.bin']);
	});

	it('throws, not empty, when the bucket is gone or the object is wrong', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			await offloaded(site, bucket);
			const meta = statFile(site.sql, 'public://a.bin')!;
			const unbound = await fetchOffloaded({}, meta).catch((e: Error) => e.message);
			const short = memoryBucket();
			short.objects.set('f/site/public/a.bin', bytes(10));
			const wrongSize = await fetchOffloaded({ public: short }, meta).catch(
				(e: Error) => e.message
			);
			const missing = await fetchOffloaded({ public: memoryBucket() }, meta).catch(
				(e: Error) => e.message
			);
			return { unbound, wrongSize, missing };
		});
		expect(out.unbound).toContain('not bound');
		expect(out.wrongSize).toContain('10 bytes in R2, expected 300');
		expect(out.missing).toContain('missing from R2');
	});

	it('restores an evicted file into the object and restarts its grace window', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			await offloaded(site, bucket);
			const restored = await hydrateFile(site.sql, { public: bucket }, 'public://a.bin', {
				nowMs: 5_000
			});
			const reEvict = evictMirrored(site.sql, {
				nowMs: 5_000 + GRACE - 1,
				graceMs: GRACE,
				limit: 10,
				schemes: ['public']
			});
			return {
				restored,
				body: getFile(site.sql, 'public://a.bin'),
				stat: statFile(site.sql, 'public://a.bin'),
				reEvict
			};
		});
		expect(out.restored).toBe(true);
		expect(out.body).toEqual(bytes(300, 5));
		expect(out.stat).toMatchObject({ evicted: false, mirrored: true });
		expect(out.reEvict.evicted).toBe(0);
	});

	it('writes nothing back when the file was rewritten while the restore read R2', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			await offloaded(site, bucket);
			const slow: FileBucket = {
				...bucket,
				get: async (key) => {
					const object = await bucket.get(key);
					putFile(site.sql, 'public://a.bin', bytes(7, 9), { nowMs: 9 });
					return object;
				}
			};
			const restored = await hydrateFile(site.sql, { public: slow }, 'public://a.bin', {
				nowMs: 10
			});
			return { restored, body: getFile(site.sql, 'public://a.bin') };
		});
		expect(out.restored).toBe(false);
		expect(out.body).toEqual(bytes(7, 9));
	});

	it('refuses to rename an evicted file and queues its restore', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			await offloaded(site, bucket);
			const moved = renameFile(site.sql, 'public://a.bin', 'public://b.bin', 5_000);
			return {
				moved,
				queued: pendingMirrors(site.sql).map((t) => `${t.op}:${t.uri}`),
				still: statFile(site.sql, 'public://a.bin')?.evicted
			};
		});
		expect(out.moved).toBe(false);
		expect(out.queued).toEqual(['hydrate:public://a.bin']);
		expect(out.still).toBe(true);
	});

	it('deleting an evicted file removes its R2 object', async () => {
		const bucket = memoryBucket();
		await inObject(freshSite(), async (site) => {
			await offloaded(site, bucket);
			expect(bucket.objects.size).toBe(1);
			deleteFile(site.sql, 'public://a.bin', 5_000);
			await drainMirrors(site.sql, bucket, { verify: true });
		});
		expect(bucket.objects.size).toBe(0);
	});

	it('sends private files to the private bucket only, and only when one is bound', async () => {
		const pub = memoryBucket();
		const priv = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'private://s.pdf', bytes(40), {
				nowMs: 1,
				schemes: ['public', 'private']
			});
			putFile(site.sql, 'public://p.png', bytes(40), { nowMs: 1 });
			const drained = await drainMirrors(site.sql, pub, {
				verify: true,
				privateBucket: priv
			});
			return drained;
		});
		expect([...priv.objects.keys()]).toEqual(['f/site/private/s.pdf']);
		expect([...pub.objects.keys()]).toEqual(['f/site/public/p.png']);
		expect(out.mirrored).toBe(2);
	});

	it('does not queue a private write unless the caller says private may leave', async () => {
		const queued = await inObject(freshSite(), (site) => {
			putFile(site.sql, 'private://s.pdf', bytes(8), { nowMs: 1 });
			return pendingMirrors(site.sql).length;
		});
		expect(queued).toBe(0);
	});

	it('only evicts schemes the caller lists', async () => {
		const pub = memoryBucket();
		const priv = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'private://s.pdf', bytes(8), {
				nowMs: 1,
				schemes: ['public', 'private']
			});
			await drainMirrors(site.sql, pub, { verify: true, privateBucket: priv });
			return evictMirrored(site.sql, {
				nowMs: 10 * GRACE,
				graceMs: GRACE,
				limit: 10,
				schemes: ['public']
			});
		});
		expect(out.evicted).toBe(0);
	});

	it('backfills what the object already holds, once, and skips what is done', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://new.bin', bytes(8), { nowMs: 1 });
			putFile(site.sql, 'public://legacy.bin', bytes(8, 1), { nowMs: 1 });
			recordMirror(site.sql, 'public://legacy.bin', { ok: true });
			putFile(site.sql, 'private://s.pdf', bytes(8), { nowMs: 1 });
			site.sql.exec('DELETE FROM cfw_file_mirror_queue');
			const first = queueBackfill(site.sql, 2, ['public']);
			const again = queueBackfill(site.sql, 3, ['public']);
			await drainMirrors(site.sql, bucket, { verify: true });
			const afterDrain = queueBackfill(site.sql, 4, ['public']);
			return {
				first,
				again,
				afterDrain,
				queued: pendingMirrors(site.sql).length
			};
		});
		expect(out.first).toBe(2);
		expect(out.again).toBe(2);
		expect(out.afterDrain).toBe(0);
		expect(out.queued).toBe(0);
		expect([...bucket.objects.keys()].sort()).toEqual([
			'f/site/public/legacy.bin',
			'f/site/public/new.bin'
		]);
	});

	it('restores every evicted file on request, so a site can leave the bucket', async () => {
		const bucket = memoryBucket();
		const out = await inObject(freshSite(), async (site) => {
			await offloaded(site, bucket);
			const queued = queueRehydrateAll(site.sql, 5_000);
			const drained = await drainHydrates(site.sql, { public: bucket }, { nowMs: 5_000 });
			return {
				queued,
				drained,
				stats: storedBytes(site.sql),
				body: getFile(site.sql, 'public://a.bin')
			};
		});
		expect(out.queued).toBe(1);
		expect(out.drained.hydrated).toBe(1);
		expect(out.stats.offloaded).toEqual({ files: 0, bytes: 0 });
		expect(out.body).toEqual(bytes(300, 5));
	});

	it('counts a failed restore as a strike and drops it at the limit', async () => {
		const out = await inObject(freshSite(), async (site) => {
			await offloaded(site, memoryBucket());
			queueHydrate(site.sql, 'public://a.bin', 5_000);
			const empty: FileBuckets = { public: memoryBucket() };
			const passes = [];
			for (let i = 0; i < MIRROR_STRIKES; i++) {
				passes.push(await drainHydrates(site.sql, empty, { nowMs: 5_000 }));
			}
			return { passes, left: pendingMirrors(site.sql).length };
		});
		expect(out.passes[0]).toMatchObject({ failed: 1, hydrated: 0 });
		expect(out.passes[MIRROR_STRIKES - 1]).toMatchObject({ droppedAfterStrikes: 1 });
		expect(out.left).toBe(0);
	});

	it('names the private uri behind a download path, and nothing else', () => {
		expect(privateUriForPath('/system/files/reports/q3%20final.pdf?download=1')).toBe(
			'private://reports/q3 final.pdf'
		);
		expect(privateUriForPath('/sites/default/files/a.png')).toBeUndefined();
		expect(privateUriForPath('/system/files/../x')).toBeUndefined();
		expect(privateUriForPath('/system/files/%E0%A4%A')).toBeUndefined();
	});

	it('exports the schemes a private bucket opens', () => {
		expect(isMirrorable('private://a', ['public', 'private'])).toBe(true);
		expect(isMirrorable('private://a')).toBe(false);
	});
});

describe('the host answers PHP honestly about an evicted file', () => {
	it('replies offloaded, queues the restore, and never answers an empty file', async () => {
		const bucket = {
			objects: new Map<string, Uint8Array>(),
			async put(key: string, value: Uint8Array) {
				this.objects.set(key, value);
				return { size: value.length };
			},
			async delete() {},
			async get() {
				return null;
			}
		};
		const reply = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(50), { nowMs: 1 });
			await drainMirrors(site.sql, bucket, { verify: true });
			evictMirrored(site.sql, { nowMs: 1e9, graceMs: 1, limit: 5, schemes: ['public'] });
			const binary = installCapabilities(site as never, {} as never) as unknown as Record<
				string,
				(json: string) => string
			>;
			const read = decode(
				JSON.parse(binary.cfwFileRead!(JSON.stringify({ uri: 'public://a.bin' })))
			);
			const chunk = decode(
				JSON.parse(binary.cfwFileRead!(JSON.stringify({ uri: 'public://a.bin', seq: 0 })))
			);
			const rename = decode(
				JSON.parse(
					binary.cfwFileRename!(
						JSON.stringify({ from: 'public://a.bin', to: 'public://b.bin' })
					)
				)
			);
			const stat = decode(
				JSON.parse(binary.cfwFileStat!(JSON.stringify({ uri: 'public://a.bin' })))
			);
			return {
				read,
				chunk,
				rename,
				stat,
				queued: pendingMirrors(site.sql).map((t) => `${t.op}:${t.uri}`)
			};
		});
		expect(reply.read).toMatchObject({ ok: false, offloaded: true });
		expect(reply.chunk).toMatchObject({ ok: false, offloaded: true });
		expect(reply.rename).toMatchObject({ ok: false });
		expect(reply.stat).toMatchObject({ ok: true, evicted: true, mirrored: true, size: 50 });
		expect(reply.queued).toEqual(['hydrate:public://a.bin']);
	});
});

/** the test pool binds `FILES` though the canonical config does not declare it */
const FILES = (env as unknown as { FILES: R2Bucket }).FILES;

describe('R2 itself, through the local binding', () => {
	it('accepts a matching sha256 and rejects a wrong one, which is what verification relies on', async () => {
		const body = bytes(2048, 3);
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
		const good = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
		const stored = await FILES.put('spec/sha-good', body, { sha256: good });
		expect(stored?.size).toBe(2048);
		await expect(
			FILES.put('spec/sha-bad', body, { sha256: 'ab'.repeat(32) })
		).rejects.toThrow();
		expect(await FILES.get('spec/sha-bad')).toBeNull();
		await FILES.delete('spec/sha-good');
	});

	it('round-trips a multi-chunk file through verify, evict and a read from the real bucket', async () => {
		const size = FILE_CHUNK_BYTES * 2 + 17;
		const got = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://big.bin', bytes(size, 4), {
				nowMs: 1,
				mime: 'application/x-big'
			});
			const drained = await drainMirrors(site.sql, FILES, {
				verify: true,
				site: 'spec-real'
			});
			evictMirrored(site.sql, { nowMs: 1e9, graceMs: 1, limit: 5, schemes: ['public'] });
			const back = await readFile(
				site.sql,
				{ public: FILES as unknown as FileBucket },
				'public://big.bin',
				'spec-real'
			);
			return {
				drained,
				chunkRows: site.sql.exec('SELECT COUNT(*) AS n FROM cfw_file_chunk').toArray()[0]
					?.n,
				back
			};
		});
		expect(got.drained.mirrored).toBe(1);
		expect(got.chunkRows).toBe(0);
		expect(got.back).toEqual(bytes(size, 4));
		const head = await FILES.head('f/spec-real/public/big.bin');
		expect(head?.httpMetadata?.contentType).toBe('application/x-big');
		await FILES.delete('f/spec-real/public/big.bin');
	});
});
