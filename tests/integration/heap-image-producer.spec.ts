import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { driveAlarms, freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The producer, which did not exist: `HEAP_SNAPSHOT` gated the restore and nothing wrote an image,
 * so every boot on every site refused with `no snapshot for this pack generation`.
 *
 * IT DRIVES THE REAL ALARM rather than calling `snapshotStep()` directly, and that is the whole
 * value of this file. Two earlier versions passed a hand-called step and failed on the chain: one
 * ran after the fill loop, which boots the interpreter on every firing, so it dropped the
 * interpreter forever and never imaged.
 */

const TIMEOUT = 1_800_000;

const call = (site: ServeDo, path: string) => site.fetch(new Request(`https://do.local${path}`));

/**
 * A site in the state the producer waits for: migrated, rendered once so it has its OWN
 * `cache_container` row, and holding no interpreter -- which is what `/__migrate` and `/__firstrun`
 * both leave behind on a real site.
 */
async function provisioned(): Promise<DurableObjectStub> {
	const stub = freshSite();
	await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
	await inObject(stub, (site) => (site as any).fillOne('/'));
	await inObject(stub, (site) => {
		(site as any).php = null;
	});
	return stub;
}

const heapStatus = async (stub: DurableObjectStub) =>
	(await (
		await stub.fetch('https://do.local/__heap', { headers: { 'x-cfw-owner': 'test' } })
	).json()) as Record<string, any>;

const arm = (stub: DurableObjectStub) =>
	inObject(stub, (site) => site.storage.setAlarm(Date.now() + 1));

describe('the alarm produces this site one heap image', () => {
	it(
		'images on a firing that arrives with no interpreter, and a cold boot then restores it',
		async () => {
			const stub = await provisioned();
			expect((await heapStatus(stub)).latest).toBe(null);

			await arm(stub);
			await driveAlarms(stub, (site) => (site as any).metaGet('heap_image_gen') !== null, 6);

			const status = await heapStatus(stub);
			expect(status.latest, JSON.stringify(status.lastHeapImage)).not.toBe(null);
			expect(status.imagedGeneration).toBe(status.packGeneration);
			expect(status.latest.keptPages).toBeGreaterThan(0);

			// the point of all of it -- a cold boot now restores instead of refusing
			const restored = await inObject(stub, async (site) => {
				(site as any).php = null;
				(site as any).heapRestoreCursor = null;
				await (site as any).fillOne('/');
				return (site as any).heapRestore;
			});
			expect(restored.restored, JSON.stringify(restored)).toBe(true);
			expect(restored.bytes).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'never takes the interpreter away from whoever is using it',
		async () => {
			// `snapshot-delta.spec.ts` images the LIVE heap after two renders; a producer that
			// dropped the interpreter to get a clean one moved its differing share 0.7 -> 0.534
			const stub = await provisioned();
			await inObject(stub, (site) => (site as any).fillOne('/'));
			const before = await inObject(stub, (site) => (site as any).php !== null);
			expect(before).toBe(true);

			await arm(stub);
			await runDurableObjectAlarm(stub);

			expect(await inObject(stub, (site) => (site as any).php !== null)).toBe(true);
			expect((await heapStatus(stub)).latest).toBe(null);
		},
		TIMEOUT
	);

	it(
		'takes exactly one image and stops asking',
		async () => {
			const stub = await provisioned();
			await arm(stub);
			await driveAlarms(stub, (site) => (site as any).metaGet('heap_image_gen') !== null, 6);
			const first = await heapStatus(stub);
			expect(first.latest).not.toBe(null);

			await inObject(stub, (site) => {
				(site as any).php = null;
			});
			await arm(stub);
			await driveAlarms(stub, () => false, 4);
			const after = await heapStatus(stub);
			expect(after.imageAttempts).toBe(first.imageAttempts);
			expect(after.latest.id).toBe(first.latest.id);
		},
		TIMEOUT
	);

	it(
		'refuses to write over an image somebody else took',
		async () => {
			// `gcHeapSnapshots()` keeps exactly one, so imaging here would replace an operator's
			// operator-taken `/heap?op=snapshot` without saying so
			const stub = await provisioned();
			const res = await stub.fetch('https://do.local/__heap?op=snapshot&fresh=1', {
				headers: { 'x-cfw-owner': 'test' }
			});
			expect(res.status).toBe(200);
			const mine = (await heapStatus(stub)).latest.id;

			await inObject(stub, (site) => {
				(site as any).php = null;
			});
			await arm(stub);
			await driveAlarms(stub, () => false, 4);

			const after = await heapStatus(stub);
			expect(after.latest.id).toBe(mine);
			expect(after.imageAttempts).toBe(0);
		},
		TIMEOUT
	);

	it(
		'images a site that has never rendered, now that the packed container row is readable',
		async () => {
			// the size the removed `cache_container >= 2` guard existed for: a never-rendered site
			// imaged at 36,634,624 bytes while the packed row was keyed to a stale dependency hash,
			// and at 10,420,224 once the boot could read it
			const stub = freshSite();
			await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
			await inObject(stub, (site) => {
				(site as any).php = null;
			});
			const out = (await inObject(stub, (site) => (site as any).snapshotStep())) as Record<
				string,
				any
			> | null;
			expect(out?.heapImage?.ok, JSON.stringify(out)).toBe(true);
			expect(out?.heapImage?.storedBytes).toBeLessThan(20_000_000);
		},
		TIMEOUT
	);

	it(
		'stays off when HEAP_SNAPSHOT is 0',
		async () => {
			const stub = await provisioned();
			const out = await inObject(stub, (site) => {
				(site as any).env = { ...(site as any).env, HEAP_SNAPSHOT: '0' };
				return (site as any).snapshotStep();
			});
			expect(out).toBe(null);
		},
		TIMEOUT
	);

	it(
		'stays off when HEAP_IMAGE is 0',
		async () => {
			const stub = await provisioned();
			const out = await inObject(stub, (site) => {
				(site as any).env = { ...(site as any).env, HEAP_IMAGE: '0' };
				return (site as any).snapshotStep();
			});
			expect(out).toBe(null);
		},
		TIMEOUT
	);

	it(
		'ends the firing after imaging, so the fill loop never stacks on top of it',
		async () => {
			// imaging is a kernel boot plus a full heap read; a fill loop in the same incarnation is
			// N more workloads and the recycle runs only BETWEEN invocations. At `fillBatchSize` 25
			// that shape reset four freshly provisioned sites on paid
			const stub = await provisioned();
			await inObject(stub, (site) =>
				site.sql.exec(
					'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
					'/',
					Date.now()
				)
			);
			await arm(stub);
			await runDurableObjectAlarm(stub);

			const after = await inObject(stub, (site) => ({
				php: (site as any).php !== null,
				outcome: (site as any).lastAlarmOutcome,
				imaged: (site as any).metaGet('heap_image_gen')
			}));
			expect(after.imaged).not.toBe(null);
			expect(after.php).toBe(false);
			expect(after.outcome?.heapImage?.ok).toBe(true);
			// the queued page is still queued -- it did not get rendered on the imaging firing
			expect(await inObject(stub, (site) => (site as any).queueDepth())).toBeGreaterThan(0);
		},
		TIMEOUT
	);
});
