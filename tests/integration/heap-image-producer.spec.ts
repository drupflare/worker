import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dropAllSnapshots, ensureHeapTables } from '../../src/db/heap-store';
import { RECONCILE_STEPS } from '../../src/ops/reconcile';
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
	// THE PRODUCER IS OFF BY DEFAULT SINCE 2026-09-09, so a spec about the producer turns it on. A
	// deployed two-arm run put the imaged cold render at a median 1,912 ms of cpuTime against 1,264
	// unimaged with no overlap, so restoring costs more than booting; `HEAP_IMAGE=1` is the opt-in and
	// the default is pinned separately below
	// THE PRODUCER STAYS OFF WHILE THE SETUP RUNS, and it is armed at the end.
	//
	// It used to be enabled first, which made every setup step a candidate imaging pass. That was
	// invisible until reconciliation grew a step that boots a kernel: the chain settles before the
	// producer runs, so the last reconcile pass imaged and `latest` was already non-null before any
	// test had armed an alarm. Establish the state, then arm the thing under test.
	await inObject(stub, (site) => {
		(site as any).env = { ...(site as any).env, HEAP_IMAGE: '0' };
	});
	await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
	await inObject(stub, (site) => (site as any).fillOne('/'));
	// RECONCILED FIRST, because the alarm chain runs it before the image and a step that lands drops
	// every snapshot. Imaging ahead of it would pay a full heap read the next firing throws away, so
	// a real site reaches the producer's precondition with reconciliation already settled. Driven to
	// completion here rather than left to the alarms this spec counts
	await inObject(stub, async (site) => {
		// `* 3 + 2` rather than `+ 2`: a step whose apply fails is retried up to STEP_ATTEMPT_LIMIT
		// times and each attempt costs a pass, so a bound of one-pass-per-step leaves the chain
		// unfinished and the alarm this spec counts spends its firing reconciling instead of imaging
		for (let i = 0; i < RECONCILE_STEPS.length * 3 + 2; i++) {
			const res = await site.fetch(
				new Request('https://do.local/__reconcile', { method: 'POST' })
			);
			if (((await res.json()) as { ran: unknown }).ran === null) break;
		}
	});
	// THE PRECONDITION IS "NO IMAGE YET", AND RECONCILING ESTABLISHES THE OPPOSITE. The chain
	// settles first and the producer runs once nothing is owed, so the last pass of the loop above
	// is itself an imaging pass -- which left `latest` non-null before this spec had armed anything.
	// Dropped explicitly, the same way `php` is nulled to establish "no resident interpreter": the
	// subject here is the ALARM taking an image, so the state it starts from has to be stated.
	// DRIVEN TO QUIESCENCE ON THE ALARM, not only through the route.
	//
	// The route applies one step per call; the alarm is what a real site runs, and reconciliation
	// shares a firing with the producer. Left partly owed, the subject's own firing reconciles AND
	// images, so it does not end after imaging and the interpreter is still resident -- which is the
	// property one of these specs exists to assert. `HEAP_IMAGE` is still 0 here, so none of these
	// firings can take an image.
	await driveAlarms(stub, () => false, 6);
	await inObject(stub, (site) => {
		(site as any).env = { ...(site as any).env, HEAP_IMAGE: '1' };
	});
	const dropped = await inObject(stub, (site) => {
		ensureHeapTables((site as any).sql);
		const n = dropAllSnapshots((site as any).sql);
		(site as any).sql.exec('DELETE FROM cfw_meta WHERE k = ?', 'heap_image_gen');
		// the ATTEMPT counter as well, and it is a separate key. A spec asserting the producer did
		// not have to take an image reads this rather than the image itself, so a count left over
		// from the setup reads as an attempt the alarm made
		(site as any).sql.exec('DELETE FROM cfw_meta WHERE k = ?', 'heap_image_attempts');
		return {
			n,
			left: Number(
				(site as any).sql.exec('SELECT COUNT(*) AS n FROM cfw_heap_snapshot').toArray()[0]
					?.n ?? 0
			)
		};
	});
	if (dropped.left !== 0) {
		throw new Error(`setup left ${dropped.left} snapshots after dropping ${dropped.n}`);
	}
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
			// the heap generation, not the PACK generation. An image keyed on the pack alone
			// survives a module install that invalidated its kernel, class loader and container:
			// four separate symptoms, one disagreement between a restored heap and a current
			// database
			expect(status.imagedGeneration).toBe(status.heapGeneration);
			expect(String(status.heapGeneration).startsWith(String(status.packGeneration))).toBe(
				true
			);
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
			// the counter is per generation and is written as `<generation> <n>`; an image it did
			// not have to take leaves it unwritten
			expect(after.imageAttempts).toBe(null);
		},
		TIMEOUT
	);

	it(
		'images a site that has never rendered, now that the packed container row is readable',
		async () => {
			// The magnitude used to be asserted here as `storedBytes < 20_000_000`, guarding the
			// stale-container defect that imaged a never-rendered site at 36,634,624 bytes. It is a
			// PROPERTY now: elision is what makes the image smaller than the heap, and both sides come
			// from the same run so the assertion survives a feature that grows either one.
			// `container-cid.spec.ts` is what pins the stale-container regression, and the byte figure
			// belongs in a measurement script rather than in a ceiling somebody has to keep editing.
			const stub = freshSite();
			await inObject(stub, (site) => {
				(site as any).env = { ...(site as any).env, HEAP_IMAGE: '1' };
			});
			await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
			await inObject(stub, (site) => {
				(site as any).php = null;
			});
			const out = (await inObject(stub, (site) => (site as any).snapshotStep())) as Record<
				string,
				any
			> | null;
			const image = out?.heapImage;
			expect(image?.ok, JSON.stringify(out)).toBe(true);
			expect(Number(image?.heapBytes)).toBeGreaterThan(0);
			expect(Number(image?.storedBytes)).toBeLessThan(Number(image?.heapBytes));
			expect(Number(image?.keptPages)).toBeLessThan(
				Math.ceil(Number(image?.heapBytes) / 65_536)
			);
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

	/**
	 * The default is OFF, and this is the assertion that keeps it that way.
	 *
	 * Restoring an image costs more than booting: two deployed free workers differing only in
	 * `HEAP_IMAGE`/`HEAP_SNAPSHOT` put the imaged cold render at a median 1,912 ms of cpuTime (n=5,
	 * 1,561-2,020) against 1,264 unimaged (n=4, 1,113-1,343), ranges not overlapping. It costs storage
	 * against an account-wide cap on top of that. Every other test in this file opts the producer IN,
	 * so without this one nothing here would notice the default flipping back.
	 */
	it(
		'produces nothing when nobody asked, because the default is off',
		async () => {
			const stub = freshSite();
			await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
			await inObject(stub, (site) => (site as any).fillOne('/'));
			await inObject(stub, (site) => {
				(site as any).php = null;
			});
			// no `HEAP_IMAGE` assignment anywhere: this is the shipping configuration
			const out = await inObject(stub, (site) => (site as any).snapshotStep());
			expect(out).toBe(null);
			expect((await heapStatus(stub)).latest).toBe(null);
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
