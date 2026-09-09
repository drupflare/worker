import { describe, expect, it } from 'vitest';
import { driveAlarms, freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A heap image keyed on the PACK survives a change to the SITE, and every consequence of that is a
 * different-looking bug.
 *
 * Installing a module rewrites `core.extension`, the service container and the class loader while
 * the pack stays where it was, so a restore put a kernel that predates the install against a
 * database that does not. It surfaced four ways: `access() on null` in a block handler whose plugin
 * provider was not in the restored module handler, a class whose file is present and whose
 * namespace is not, an absent config sync directory, and `/user/1` failing while `/user/1/edit`
 * rendered because only one of the two themes carries the affected blocks.
 *
 * BOTH HALVES, because a check that asserts only the first passes with the class loader still
 * stale: the restore has to refuse AND the module set has to be what moved it.
 */

const TIMEOUT = 1_800_000;

const call = (site: ServeDo, path: string) => site.fetch(new Request(`https://do.local${path}`));

async function provisioned(): Promise<DurableObjectStub> {
	const stub = freshSite();
	await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
	await inObject(stub, (site) => (site as any).fillOne('/'));
	// `HEAP_IMAGE` is off by default -- a deployed A/B put the imaged cold render at a median
	// 1,912 ms of cpuTime (n=5) against 1,264 unimaged (n=4), with no overlap. What this file
	// checks is the KEYING, so it opts in; without the flag the producer answers null and every
	// assertion below fails on a missing image rather than on a stale one
	await inObject(stub, (site) => {
		(site as any).env = { ...(site as any).env, HEAP_IMAGE: '1' };
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

/** what an install does to the row the fingerprint reads, without running one */
async function addModule(stub: DurableObjectStub, name: string): Promise<void> {
	await inObject(stub, (site) => {
		const sql = (site as any).sql;
		const row = sql
			.exec("SELECT data FROM config WHERE collection = '' AND name = 'core.extension'")
			.toArray()[0];
		const data = row?.data;
		const text = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
		sql.exec(
			"UPDATE config SET data = ? WHERE collection = '' AND name = 'core.extension'",
			`${text}${name}`
		);
	});
}

describe('a heap image is keyed on the site as well as the pack', () => {
	it(
		'refuses a restore once the module set has moved, and drops the dead image',
		async () => {
			const stub = await provisioned();
			await arm(stub);
			await driveAlarms(stub, (site) => (site as any).metaGet('heap_image_gen') !== null, 6);

			const before = await heapStatus(stub);
			expect(before.latest, JSON.stringify(before.lastHeapImage)).not.toBe(null);
			const packGeneration = String(before.packGeneration);
			expect(String(before.heapGeneration).startsWith(packGeneration)).toBe(true);

			await addModule(stub, 'search');

			// the pack has not moved and the heap identity has
			const after = await heapStatus(stub);
			expect(String(after.packGeneration)).toBe(packGeneration);
			expect(after.heapGeneration).not.toBe(before.heapGeneration);

			// a boot now refuses rather than restoring a kernel that predates the install
			const restored = await inObject(stub, async (site) => {
				(site as any).php = null;
				(site as any).heapRestoreCursor = null;
				const { binary } = await (site as any).ensurePhp();
				return (site as any).tryRestoreHeap(binary);
			});
			expect(restored.restored).toBe(false);
			expect(String(restored.reason)).toContain('no snapshot');
			// the image that can never restore again is gone rather than left in storage. Asserted
			// as the STATE and not as this call's own count: `ensurePhp()` boots, the boot path
			// calls `tryRestoreHeap` itself, and that first call is the one that did the dropping
			expect(restored.droppedStale).toBe(0);
			expect((await heapStatus(stub)).latest).toBe(null);
		},
		TIMEOUT
	);

	it(
		'still images the site under its new identity, so a changed module set is not a permanent stop',
		async () => {
			const stub = await provisioned();
			await arm(stub);
			await driveAlarms(stub, (site) => (site as any).metaGet('heap_image_gen') !== null, 6);
			const first = String((await heapStatus(stub)).heapGeneration);

			await addModule(stub, 'search');
			await inObject(stub, (site) => {
				(site as any).php = null;
			});
			await arm(stub);
			await driveAlarms(stub, (site) => (site as any).metaGet('heap_image_gen') !== first, 8);

			const after = await heapStatus(stub);
			expect(after.imagedGeneration).toBe(after.heapGeneration);
			expect(after.imagedGeneration).not.toBe(first);
			expect(after.latest).not.toBe(null);
		},
		TIMEOUT
	);

	it(
		'creates the config sync directory at MOUNT time, where a restored boot can still see it',
		async () => {
			// `settings.php` is evaluated during a kernel boot and a restored kernel never boots, so
			// the `@mkdir()` there never ran on the one path that needed it. The mount runs always
			const stub = freshSite();
			const present = await inObject(stub, async (site) => {
				const { binary } = await (site as any).ensurePhp();
				try {
					return (
						binary.FS.analyzePath('/drupal/sites/default/files/config/sync').exists ===
						true
					);
				} catch {
					return false;
				}
			});
			expect(present).toBe(true);
		},
		TIMEOUT
	);
});
