import type { PhpInstance, SitePhpDurableObject } from '../site-do';
import { firstRow } from '../util/sql';
import type { RetentionHost } from './host';
import {
	isolateResidency,
	keepSpareMemory,
	retainInterpreterEnabled,
	spareMemoryBytes
} from './isolate';
import { COMMIT_SEQ_KEY } from './keys';
import type { Row } from './types';

/**
 * Interpreters kept across the eviction of the instance that booted them, by object id.
 *
 * Module scope lives with the isolate, so the next instance of the object can adopt the
 * interpreter.
 * Host closures resolve `this` through `owner` so an adoption repoints handles PHP already holds. A
 * `commitSeq` that differs on adoption means the object wrote elsewhere, so the interpreter is
 * dropped.
 */
type RetainedInterpreter = {
	php: PhpInstance;
	owner: { current: RetentionHost };
	commitSeq: number;
	at: number;
};

const retainedInterpreters = new Map<string, RetainedInterpreter>();

// the state an adoption hands from one instance to the next; each must exist on the adopter
const INTERPRETER_FIELDS = [
	'out',
	'bootDiag',
	'bootMs',
	'phpBootedAt',
	'bootLinear',
	'mountInfo',
	'heapRestore',
	'crossings',
	'crossingNames',
	'replicaGuard',
	'pinnedHandles',
	'installedModuleFiles',
	'moduleIntegrity',
	'heapIntegrity',
	// data about traps already armed in this interpreter; arming again could read as failed
	'parkInstall'
] as const satisfies readonly (keyof SitePhpDurableObject)[];

/** drops an object's retained copy when it still holds the interpreter given */
export function forgetRetained(id: string, php: PhpInstance): void {
	if (retainedInterpreters.get(id)?.php === php) retainedInterpreters.delete(id);
}

/** keeps this object's interpreter in module scope, stamped with the commit it has seen */
export function retainInterpreter(host: RetentionHost): void {
	const id = host.ctx.id.toString();
	if (!host.php?.binary || !host.phpOwner || !retainInterpreterEnabled(host.env)) {
		retainedInterpreters.delete(id);
		return;
	}
	retainedInterpreters.set(id, {
		php: host.php,
		owner: host.phpOwner,
		commitSeq: host.commitSeq(),
		at: host.nowMs()
	});
}

/**
 * Takes over the interpreter a previous instance left in module scope.
 *
 * Refused when the commit sequence moved (the object wrote elsewhere) or the previous instance
 * held park sockets (they belong to its own I/O context).
 */
export function adoptRetained(host: RetentionHost): void {
	if (host.php || !retainInterpreterEnabled(host.env)) return;
	const id = host.ctx.id.toString();
	// another object's entry is either gone or still held by its own live instance
	for (const key of retainedInterpreters.keys()) if (key !== id) retainedInterpreters.delete(key);
	const kept = retainedInterpreters.get(id);
	if (!kept || kept.owner.current === host) return;
	const prev = kept.owner.current;
	const at = host.nowMs();
	let reason: string | undefined;
	try {
		// plain read, not `commitSeq()`: its `metaGet()` runs `ensureServeTables()`, which must
		// not run before the gate
		const row = firstRow(
			host.sql.exec<Row<{ v: string }>>('SELECT v FROM cfw_meta WHERE k = ?', COMMIT_SEQ_KEY)
		);
		if (kept.commitSeq !== Number(row?.v ?? 0)) reason = 'stale';
	} catch {
		reason = 'unreadable';
	}
	if (!reason && (prev.parkSockets?.size ?? 0) > 0) reason = 'sockets';
	if (reason) {
		retainedInterpreters.delete(id);
		// its instance is gone, so its heap is garbage; the boot that follows takes it instead
		keepSpareMemory(kept.php);
		host.lastRetention = { at, adopted: false, reason };
		return;
	}
	for (const key of INTERPRETER_FIELDS) Object.assign(host, { [key]: prev[key] });
	host.phpOwner = kept.owner;
	kept.owner.current = host;
	host.php = kept.php;
	host.retentionAdoptions += 1;
	host.lastRetention = { at, adopted: true, idleMs: at - kept.at };
}

/**
 * Drops the interpreter and the copy an earlier instance left in module scope, so the next boot
 * reads the database again (a retained one is adopted when the commit sequence matches).
 */
export function resetPhp(host: RetentionHost): void {
	host.dropInterpreter();
	const id = host.ctx.id.toString();
	const kept = retainedInterpreters.get(id);
	if (!kept) return;
	retainedInterpreters.delete(id);
	keepSpareMemory(kept.php);
}

/**
 * Wipes this object: its alarm, its storage, its interpreter and any retained one. The flag
 * goes first so nothing in flight can arm an alarm between the two deletes.
 */
export async function retire(host: RetentionHost): Promise<void> {
	host.retired = true;
	host.dropInterpreter();
	retainedInterpreters.delete(host.ctx.id.toString());
	await host.storage.deleteAlarm();
	await host.storage.deleteAll();
}

/**
 * One log line of memory readings when `MEMORY_TRACE=1` (the platform only reports that the
 * isolate was reset).
 */
export function traceMemory(host: RetentionHost, at: string): void {
	if (host.env?.MEMORY_TRACE !== '1') return;
	const resident = isolateResidency();
	console.log(
		JSON.stringify({
			cfw: 'memory',
			at,
			linear: host.heapNow(),
			isolate: host.isolateNow(),
			residents: resident.interpreters,
			residentLinear: resident.linearBytes,
			retained: retainedInterpreters.size,
			spare: spareMemoryBytes(),
			booted: host.php?.binary ? 1 : 0
		})
	);
}
