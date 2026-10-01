/**
 * Whether this interpreter can park (`ext/cfwpark` in phasm) and which traps are armed.
 *
 * Everything here is inert without the extension: {@link installPark} probes for `cfw_park_run` and
 * answers `absent` on a build that lacks it. `park-drive.ts` answers a parked call.
 * @module
 */
import { PARK_FETCH_TRAPS, PARK_SOCKET_TRAPS } from './park-drive';

/**
 * The trap classes a site may arm.
 *
 * There is no `http` class: the shipping interpreter has no curl, so `cfw_park_trap('curl_exec')`
 * answers false. Trapping `fopen` cannot work either: `HttpsStreamWrapper` is userland called from
 * the internal `fopen`, so `park_refused()` declines (its C locals cannot survive the `longjmp`).
 * The `fetch` class instead gives the module's own userland handler a yield point.
 */
export const PARK_TRAPS = { socket: PARK_SOCKET_TRAPS, fetch: PARK_FETCH_TRAPS } as const;

/** a key of `PARK_TRAPS` */
export type ParkClassName = keyof typeof PARK_TRAPS;

/**
 * Whether the park may arm at all; an operator switch, on by default.
 *
 * Arming routes every render through `cfw_park_run`, so a render that calls nothing still pays the
 * wrapper (two ordinary renders report `runs=2 trips=0`). `PARK=0` turns it off for a site with no
 * module that needs it, and is the only paired arm for measuring that tax.
 */
export function parkEnabled(env?: { PARK?: unknown }): boolean {
	const set = env?.PARK;
	if (set !== undefined && set !== null && String(set) !== '') return String(set) === '1';
	return true;
}

/** the PHP that asks whether this interpreter can park at all */
export const PARK_PROBE = `<?php echo json_encode(['park' => function_exists('cfw_park_run')]);`;

/**
 * The PHP that arms the traps; it prints the names the engine accepted, not the list it was sent.
 *
 * `cfw_park_trap` answers false for a name that is not an internal function, so a rename cannot
 * fail silently.
 */
export function parkTrapInstall(classes: ReadonlyArray<ParkClassName>): string {
	const names = classes.flatMap((c) => [...PARK_TRAPS[c]]);
	const list = names.map((n) => `'${n}'`).join(', ');
	return (
		`<?php $armed = []; if (function_exists('cfw_park_trap')) { ` +
		`foreach ([${list}] as $fn) { if (cfw_park_trap($fn)) { $armed[] = $fn; } } } ` +
		`echo json_encode(['armed' => $armed]);`
	);
}

/**
 * The shape `installPark` needs of a PHP binary, so it can be driven from a test.
 *
 * It takes `runText` rather than `_run` because `_run`'s return value is not the output: php-wasm
 * delivers printed text through an `output` event, so reading the return reports `absent` always.
 */
export type ParkBinary = {
	/** runs a fragment and answers what it printed */
	runText: (code: string) => Promise<string>;
};

/** the result of `installPark` */
export type ParkInstall = {
	/**
	 * `absent`: the interpreter cannot park; `ready`: it can and nothing is diverted; `installed`:
	 * traps are live and a drive loop must exist; `failed`: the extension is there and arming did
	 * not take.
	 */
	state: 'installed' | 'ready' | 'absent' | 'failed';
	armed: string[];
	why?: string;
};

/**
 * Reports whether this interpreter can park, and arms only the classes it is asked for.
 *
 * `absent` is a state, not an error: a build without `ext/cfwpark` serves as before.
 *
 * It arms nothing by default (state `ready`), as a safety property: an armed trap diverts every
 * call to that name, so arming without a drive loop would hang the first socket write.
 * `drivePark()` is what may ask for a class.
 */
export async function installPark(
	binary: ParkBinary,
	classes: ReadonlyArray<ParkClassName> = []
): Promise<ParkInstall> {
	let probe: unknown;
	try {
		probe = await binary.runText(PARK_PROBE);
	} catch (e: unknown) {
		return { state: 'failed', armed: [], why: describe(e) };
	}
	if (!readFlag(probe, 'park')) return { state: 'absent', armed: [] };
	// present and asked to divert nothing: the capability is reportable without being live
	if (classes.length === 0) return { state: 'ready', armed: [] };

	try {
		const out = await binary.runText(parkTrapInstall(classes));
		const armed = readArmed(out);
		// an empty list with the extension present means every name failed to resolve, which is a
		// rename in php-src rather than a missing feature
		if (armed.length === 0) {
			return { state: 'failed', armed: [], why: 'the extension is present and no trap took' };
		}
		return { state: 'installed', armed };
	} catch (e: unknown) {
		return { state: 'failed', armed: [], why: describe(e) };
	}
}

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** the fragments above print one JSON object */
function parse(out: unknown): Record<string, unknown> | null {
	const text = typeof out === 'string' ? out : '';
	const start = text.indexOf('{');
	if (start < 0) return null;
	try {
		const value = JSON.parse(text.slice(start));
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function readFlag(out: unknown, key: string): boolean {
	return parse(out)?.[key] === true;
}

function readArmed(out: unknown): string[] {
	const value = parse(out)?.['armed'];
	return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : [];
}
