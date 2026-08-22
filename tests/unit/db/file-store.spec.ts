import { beforeEach, describe, expect, it } from 'vitest';
import {
	FILE_CHUNK_BYTES,
	MIRROR_STRIKES,
	chunkBytes,
	deleteFile,
	drainMirrors,
	ensureFileTables,
	getFile,
	getFileChunk,
	isMirrorable,
	listFiles,
	mirrorKey,
	normaliseUri,
	pendingMirrors,
	putFile,
	recordMirror,
	renameFile,
	statFile,
	storedBytes
} from '../../../src/db/file-store';
import { driveAlarms, freshSite, inObject, namedSite } from '../../helpers/serve-do';

/**
 * Durable storage for uploads, driven against REAL Durable Object SQL.
 *
 * Not a fake `sql` object. The behaviour this module exists for is what
 * survives an eviction, and every interesting failure is a SQL-level one: the 2,199,995-byte record
 * ceiling, blobs coming back as ArrayBuffer rather than Uint8Array, `LIKE` treating `_` as a
 * wildcard. A stand-in would agree with every assertion here and prove none of them.
 */

/** deterministic bytes, so a reassembly error shows up as a wrong value rather than a wrong length */
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
		expect(normaliseUri('public://../private/secret.txt')).toBeNull();
		expect(normaliseUri('public://a/../../b')).toBeNull();
	});

	it('refuses anything that is not a stream uri', () => {
		for (const bad of ['', 'public:/a', '/var/www/a.png', 'public', 'a.png']) {
			expect(normaliseUri(bad), bad).toBeNull();
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
		expect(got.body).toBeNull();
		expect(got.stat).toBeNull();
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
				if (chunk === null) break;
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
		expect(got.gone).toBeNull();
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
		expect(got).toEqual({ files: 2, bytes: 350 });
	});

	it('totals zero rather than NaN on an empty store', async () => {
		// SUM() over no rows is NULL, and Number(null) is 0 only if it is not read as undefined
		const stub = freshSite();
		const got = await inObject(stub, async (site) => storedBytes(site.sql));
		expect(got).toEqual({ files: 0, bytes: 0 });
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
		expect(mirrorKey('nonsense')).toBeNull();
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
			return drainMirrors(site.sql, null);
		});
		expect(out.noBucket).toBe(true);
		expect(out.mirrored).toBe(0);
	});

	it('leaves the queue intact when there is no bucket, so nothing is lost', async () => {
		const left = await inObject(freshSite(), async (site) => {
			putFile(site.sql, 'public://a.bin', bytes(16), { nowMs: 1 });
			await drainMirrors(site.sql, null);
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
			// the accessor is overridden per INSTANCE rather than `env.FILES` being set. `env` is
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

	it('does not disturb a site with no bucket bound', async () => {
		// the free-tier default has to be a quiet no-op, not an error on every firing
		const stub = freshSite();
		await inObject(stub, (site) => {
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
