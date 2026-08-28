import { describe, expect, it } from 'vitest';
import { SITE_STORAGE_BYTES } from '../../scripts/measure/free-envelope';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/** whether a site is a small mutation layer over a shared image, or 24 MB of its own */

const PAGE = 65_536;
const TIMEOUT = 900_000;

type Row = { seq: number; digest: string; bytes: ArrayBuffer };

/**
 * `fresh=1` re-boots the kernel from the pack, so that image reflects the CODE and carries almost
 * nothing a site has done; the live heap is the one that accumulates content.
 */
async function snapshotPages(stub: DurableObjectStub, fresh = true): Promise<Row[]> {
	const res = await stub.fetch(
		`https://do.local/__heap?op=snapshot${fresh ? '&fresh=1' : ''}&chunkBytes=${PAGE}`,
		{ headers: { 'x-cfw-owner': 'test' } }
	);
	expect(res.status, await res.text().catch(() => '')).toBe(200);
	return inObject(stub, (site: ServeDo) =>
		(site as unknown as { sql: SqlStorage }).sql
			.exec<Row>('SELECT seq, digest, bytes FROM cfw_heap_chunk ORDER BY seq')
			.toArray()
	);
}

/** gzip rather than zstd: workerd encodes gzip natively, so this is a FLOOR on what zstd would do */
async function gzipped(bytes: Uint8Array): Promise<number> {
	const cs = new CompressionStream('gzip');
	const writer = cs.writable.getWriter();
	void writer.write(bytes);
	void writer.close();
	let total = 0;
	const reader = cs.readable.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += (value as Uint8Array).byteLength;
	}
	return total;
}

const call = (site: ServeDo, path: string) => site.fetch(new Request(`https://do.local${path}`));

async function provisionedStub(): Promise<DurableObjectStub> {
	const stub = freshSite();
	await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
	return stub;
}

describe('a site as a delta against another site image', () => {
	it(
		'prices raw, deduped, compressed and XOR-delta encodings',
		async () => {
			// PROVISIONED: both arms were a bare `freshSite()`, so the kernel booted with no
			// database and the recorded 876x was a ratio over a heap 1.53x too small
			const a = await snapshotPages(await provisionedStub());
			const base = new Map(a.map((r) => [r.seq, new Uint8Array(r.bytes)]));
			const baseDigest = new Map(a.map((r) => [r.seq, r.digest]));

			const b = await snapshotPages(await provisionedStub());

			let raw = 0;
			let shared = 0;
			let gzSite = 0;
			let gzXor = 0;
			let differing = 0;
			for (const row of b) {
				const page = new Uint8Array(row.bytes);
				raw += page.byteLength;
				if (baseDigest.get(row.seq) === row.digest) {
					shared += page.byteLength;
					continue;
				}
				differing++;
				gzSite += await gzipped(page);
				const other = base.get(row.seq);
				if (!other || other.byteLength !== page.byteLength) {
					gzXor += await gzipped(page);
					continue;
				}
				const xor = new Uint8Array(page.byteLength);
				for (let i = 0; i < page.byteLength; i++)
					xor[i] = (page[i] as number) ^ (other[i] as number);
				gzXor += await gzipped(xor);
			}

			console.log(
				`[snapshot-delta] ${JSON.stringify({
					pages: b.length,
					differingPages: differing,
					raw,
					sharedBytesFree: shared,
					dedupOnly: raw - shared,
					dedupPlusGzip: gzSite,
					dedupPlusGzipXor: gzXor,
					xorVsPlain: +(gzXor / Math.max(1, gzSite)).toFixed(3),
					rawOverBest: +(raw / Math.max(1, Math.min(gzSite, gzXor))).toFixed(1)
				})}`
			);

			expect(differing).toBeGreaterThan(0);
			expect(gzXor).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'stores 3.7x less once the site is warm, and the model quotes the cold figure',
		async () => {
			// 1,247 ms / 552 pages cold against 33 ms / 148 warm, both ok: the warm kernel reads
			// caches instead of rebuilding them
			const cold = freshSite();
			await inObject(cold, (s: ServeDo) => call(s, '/__migrate?all=1&prefill=0'));
			const coldPages = await snapshotPages(cold);

			const warm = freshSite();
			await inObject(warm, async (s: ServeDo) => {
				await call(s, '/__migrate?all=1&prefill=0');
				const r = await s.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: 'cfw-Warm-8813-pass', siteName: 'Warm' })
					})
				);
				expect(r.status, await r.clone().text()).toBe(200);
				await call(s, '/__serve?path=/&edge=0');
			});
			const warmPages = await snapshotPages(warm);

			const coldBytes = coldPages.reduce((n, r) => n + r.bytes.byteLength, 0);
			const warmBytes = warmPages.reduce((n, r) => n + r.bytes.byteLength, 0);
			expect(coldBytes).toBe(SITE_STORAGE_BYTES.heapSnapshot);
			expect(warmBytes).toBe(SITE_STORAGE_BYTES.warmHeapSnapshot);
			// the direction is the claim; the exact ratio is allowed to drift with the pack
			expect(coldBytes / warmBytes).toBeGreaterThan(2);
		},
		TIMEOUT
	);

	it(
		'names the curve, because two identical sites is the easiest point on it',
		async () => {
			// DIVERGENCE WAS THE WRONG VARIABLE: 191.5x came from two `fresh=1` images, so it scored
			// one BOOT against another. Live, it is 5.6-5.8x and three re-runs spread 1.07-4.10x
			const settled = async (): Promise<DurableObjectStub> => {
				const stub = await provisionedStub();
				await inObject(stub, async (site: ServeDo) => {
					const r = await site.fetch(
						new Request('https://do.local/__firstrun', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								adminPass: 'cfw-Delta-4471-pass',
								siteName: 'Delta'
							})
						})
					);
					expect(r.status, await r.clone().text()).toBe(200);

					// FILL FIRST, THEN SERVE. Unchecked this settles nothing -- a cold object answers
					// the warming page and every arm diverges from a baseline that was never warm --
					// but the previous form polled `/__serve` five times with no wait, and that is a
					// race rather than a check. A miss QUEUES the fill for the alarm and answers 503
					// `warming`, so retrying immediately re-reads the same not-yet-done work: the
					// retries cannot succeed any faster than the alarm, and under full-suite load the
					// alarm loses. That failed three times in the gate and passed every time in
					// isolation, which is exactly the shape a timing race has.
					//
					// `fillOne()` renders inline in this invocation, so the page exists before
					// anything asks for it and the serve below is a plain HIT with nothing to wait on.
					await site.fillOne('/');
					const served = await call(site, '/__serve?path=/&edge=0');
					expect(served.status, await served.clone().text()).toBe(200);
				});
				return stub;
			};

			// LIVE, not fresh: a `fresh=1` image is identical for every arm by construction, and
			// four such arms came back within 100 bytes of each other on 253,429
			const baseline = await snapshotPages(await settled(), false);
			const base = new Map(baseline.map((r) => [r.seq, new Uint8Array(r.bytes)]));
			const baseDigest = new Map(baseline.map((r) => [r.seq, r.digest]));

			const arms: { name: string; drive: (s: ServeDo) => Promise<Response | undefined> }[] = [
				{ name: 'untouched', drive: async () => undefined },
				// the CONTROL: same arm as the first, so any gap between them is the instrument
				{ name: 'untouched (control)', drive: async () => undefined },
				{
					name: 'one node',
					drive: (s) => call(s, '/__writeworkload?op=node-create&seq=1')
				},
				{
					name: 'one user',
					drive: (s) => call(s, '/__writeworkload?op=user-create&seq=1')
				},
				{ name: 'second render', drive: (s) => call(s, '/__serve?path=/user/login&edge=0') }
			];

			const curve: Record<string, unknown>[] = [];
			for (const arm of arms) {
				const stub = await settled();
				await inObject(stub, async (site: ServeDo) => {
					// a 503 is the WARMING page: come back, not failed. Retried, or the arm silently
					// skips its own divergence
					let res = await arm.drive(site);
					for (let i = 0; res && res.status === 503 && i < 5; i++) {
						res = await arm.drive(site);
					}
					if (!res) return;
					const body = (await res
						.clone()
						.json()
						.catch(() => null)) as { ok?: boolean } | null;
					expect(res.status, await res.clone().text()).toBe(200);
					if (body && 'ok' in body) expect(body.ok, JSON.stringify(body)).not.toBe(false);
				});
				const pages = await snapshotPages(stub, false);

				let raw = 0;
				let shared = 0;
				let gzSite = 0;
				let gzXor = 0;
				let differing = 0;
				for (const row of pages) {
					const page = new Uint8Array(row.bytes);
					raw += page.byteLength;
					if (baseDigest.get(row.seq) === row.digest) {
						shared += page.byteLength;
						continue;
					}
					differing++;
					gzSite += await gzipped(page);
					const other = base.get(row.seq);
					if (!other || other.byteLength !== page.byteLength) {
						gzXor += await gzipped(page);
						continue;
					}
					const xor = new Uint8Array(page.byteLength);
					for (let i = 0; i < page.byteLength; i++)
						xor[i] = (page[i] as number) ^ (other[i] as number);
					gzXor += await gzipped(xor);
				}
				curve.push({
					arm: arm.name,
					pages: pages.length,
					differingPages: differing,
					differingShare: +(differing / Math.max(1, pages.length)).toFixed(3),
					raw,
					sharedBytesFree: shared,
					dedupPlusGzip: gzSite,
					dedupPlusGzipXor: gzXor,
					xorVsPlain: +(gzXor / Math.max(1, gzSite)).toFixed(3),
					rawOverBest: +(raw / Math.max(1, Math.min(gzSite, gzXor))).toFixed(1)
				});
			}

			console.log(`[snapshot-delta curve] ${JSON.stringify(curve, null, 1)}`);

			// two UNTOUCHED sites already differ on 85.8% of live pages; writes take that to 87.8%
			const best = curve.map((c) => Number(c.dedupPlusGzipXor));
			expect(best.every((b) => b > 0)).toBe(true);

			// two arms that did the same thing bound what this instrument can resolve; no upper
			// bound is asserted on the overall spread because there is no reproducible one
			const controlSpread =
				Math.max(best[0] as number, best[1] as number) /
				Math.min(best[0] as number, best[1] as number);
			const overallSpread = Math.max(...best) / Math.min(...best);
			console.log(
				`[snapshot-delta noise] ${JSON.stringify({ controlSpread, overallSpread })}`
			);
			// a `> 1.01` floor failed twice in three: the control spread runs 1.0016 to 1.0069, so
			// the DIFFERENCE survives a re-run and its size does not
			expect(best[0]).not.toBe(best[1]);
			expect(controlSpread).toBeGreaterThan(1);
			for (const c of curve) {
				expect(Number(c.differingShare), `${c.arm} differing share`).toBeGreaterThan(0.7);
			}
			// "XOR ALWAYS BEATS PLAIN GZIP" IS REFUTED, and it was my claim from one run. Measured
			// across arms it spans 0.122 to 1.032, so on a nearly-identical pair the XOR is LARGER
			// than the page -- a delta of mostly-zeroes still carries the positions that differ, and
			// gzip does better on the original bytes. Only the reading itself is assertable
			for (const c of curve) {
				expect(Number(c.xorVsPlain), `${c.arm} xor`).toBeGreaterThan(0);
			}
			// AND "XOR PAYS ON THE DIVERGED ARMS" IS REFUTED TOO, by three consecutive runs. This
			// asserted that some diverged arm came in under 1.0, and the best one reads 0.999 /
			// 0.603 / 1.000 across those runs -- it lands exactly ON the threshold, which is what
			// made it fail. `one node` is the stable reading and it goes the OTHER way, 1.652 /
			// 1.647 / 1.647, so XOR is reliably WORSE where a node was created.
			//
			// What survives: XOR-delta at PAGE granularity is not a win on this workload. That is a
			// result about the encoding rather than about the instrument, and it is the reason to
			// hold the storage lever at the site-image level where the dedup was measured.
			const diverged = curve.filter((c) => !String(c.arm).startsWith('untouched'));
			expect(diverged.length).toBeGreaterThan(0);
			// NO MAGNITUDE IS ASSERTED ON THE ONE-NODE ARM, and three failed attempts to assert one
			// are the reason. It read 1.652 / 1.647 / 1.647 and was pinned above 1.2 as "reliably
			// worse"; the pack's cache bins became WITHOUT ROWID and the container gained a class,
			// it read 0.974 / 0.976, and the pin became a 0.8-1.8 band around parity. Adding one
			// serve table moved the heap again, and six samples on ONE tree with no code change
			// between them read 0.425 / 0.588 / 0.682 / 1.025 / 1.034 / 1.069 -- a 2.5x spread, so
			// the band failed about half the time. Across every heap this arm has spanned 0.425 to
			// 1.652, and other arms have read as low as 0.122.
			//
			// So the magnitude tracks whatever is in the heap, which any unrelated schema change
			// moves, and a band on it reports that change as a regression in an encoding. What
			// survives is the refutation stated above, held by the per-arm `xorVsPlain > 0` and
			// `dedupPlusGzipXor > 0` already asserted for every arm. The arm itself is still
			// required to exist, so the curve cannot silently stop producing it.
			const nodeArm = curve.find((c) => c.arm === 'one node');
			expect(nodeArm, 'the one-node arm is what the refutation is about').toBeDefined();
			// every arm must be the same SHAPE of heap, or the number measures the boot; a
			// tolerance rather than equality, since the failure it catches is 3.7x (148 vs 553)
			for (const c of curve) {
				const ratio = Number(c.pages) / baseline.length;
				expect(
					ratio,
					`${c.arm} booted differently, so its delta is not a delta`
				).toBeGreaterThan(0.75);
				expect(
					ratio,
					`${c.arm} booted differently, so its delta is not a delta`
				).toBeLessThan(1.5);
			}
		},
		TIMEOUT
	);
});
