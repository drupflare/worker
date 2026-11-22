import { keepSpareMemory, noteResident } from '../do/isolate';
import type { PhpInstance } from '../site-do';
import { errorMessage } from '../util/errors';

export type RefreshRecord = { at: number; ok: boolean; ms: number; reason?: string };

/** what a refresh reads and writes on the object */
export type RefreshHost = {
	env: { REFRESH_INSTANCE?: string; MEMORY_TRACE?: string } | undefined;
	ctx: { id: { toString(): string } };
	restartBlocked: boolean;
	pendingRefresh?: PhpInstance;
	instancesRefreshed?: number;
	lastRefresh?: RefreshRecord;
	nowMs(): number;
};

/** the tree release and remount a refresh relies on are written for Drupal's `/drupal` only */
function drupalOnly(env: object | undefined): boolean {
	const cms = (env as { CMS?: string } | undefined)?.CMS;
	return cms === undefined || cms === '' || cms === 'drupal';
}

/**
 * Keeps a dropped interpreter for the next boot to restart in place, when the flag is on and the
 * drop is not the result of a fault. False leaves the drop to `keepSpareMemory()`.
 */
export function parkForRefresh(host: RefreshHost, was: PhpInstance): boolean {
	if (host.env?.REFRESH_INSTANCE !== '1' || host.restartBlocked) return false;
	if (!was.binary || !drupalOnly(host.env)) return false;
	// two drops with no boot between: the older one only has its memory to give
	if (host.pendingRefresh) keepSpareMemory(host.pendingRefresh);
	host.pendingRefresh = was;
	// parked for reuse, so a boot that finds it is not a boot beside a resident
	noteResident(host.ctx.id.toString(), undefined);
	return true;
}

/** marks the drop that follows as a fault, whose interpreter must not be restarted */
export function blockRefresh(host: Pick<RefreshHost, 'env' | 'restartBlocked'>): void {
	if (host.env?.REFRESH_INSTANCE === '1') host.restartBlocked = true;
}

/**
 * Restarts PHP inside a parked interpreter with `pib_refresh`, which re-runs module shutdown and
 * startup, so user classes, statics, globals and constants are gone and the wasm instance, its
 * memory and its filesystem are kept.
 *
 * False when the restart threw or returned nonzero; the interpreter is then only good for its
 * memory.
 */
export async function refreshParked(host: RefreshHost, parked: PhpInstance): Promise<boolean> {
	const t0 = Date.now();
	let reason: string | undefined;
	try {
		// ini discovery reads the working directory, and a request can leave it anywhere
		parked.binary.FS.chdir('/');
		const code = await parked.php.refresh();
		if (code !== 0) reason = `pib_refresh returned ${String(code)}`;
	} catch (e) {
		reason = errorMessage(e);
	}
	const ok = reason === undefined;
	if (!ok) keepSpareMemory(parked);
	host.lastRefresh = { at: host.nowMs(), ok, ms: Date.now() - t0, ...(ok ? {} : { reason }) };
	if (ok) host.instancesRefreshed = (host.instancesRefreshed ?? 0) + 1;
	if (host.env?.MEMORY_TRACE === '1') {
		console.log(JSON.stringify({ cfw: 'refresh', ...host.lastRefresh }));
	}
	return ok;
}
