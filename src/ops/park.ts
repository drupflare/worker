import { PARK_FETCH_TRAPS, PARK_SOCKET_TRAPS } from './park-drive.js';

/**
 * Whether this interpreter can park, and which traps are armed.
 *
 * The interpreter half is `ext/cfwpark` in phasm: a trapped blocking call freezes its Zend
 * continuation, `longjmp`s out of `pib_run` and returns `PARKED`. `park-drive.ts` is the half that
 * answers one. What the pair buys is `drupal/redis` unmodified -- a cache get has to answer inside
 * the render that asked, which is the one shape the deferred tier cannot serve.
 *
 * **EVERYTHING HERE IS INERT WITHOUT THE EXTENSION, on purpose.** {@link installPark} probes for
 * `cfw_park_run` and answers `absent` on a build that predates it, which keeps the capability a
 * runtime fact rather than a build-time assumption -- the same shape as `hasImplementations()` for a
 * cron hook.
 */

/**
 * The trap classes a site may arm.
 *
 * TWO, and the one that is NOT here is worth recording. An `http` class trapping `curl_exec` was
 * written and removed: **the shipping interpreter has no curl at all**, measured 2026-09-08 by
 * booting it and reading the extension list, so `cfw_park_trap('curl_exec')` answers false. The
 * earlier "Guzzle parks at `curl_exec`" reading came from a NATIVE php that has ext-curl, which is
 * the wrong instrument. `curl_exec` also takes a `CurlHandle` rather than a URL, so its pending
 * descriptor would carry an object the host cannot route on.
 *
 * Trapping `fopen` instead cannot work either, and the reason is the safety predicate rather than an
 * omission: `HttpsStreamWrapper` is userland called from the INTERNAL `fopen`, so `park_refused()`
 * counts that frame and declines -- correctly, since `fopen`'s C locals cannot survive the
 * `longjmp`. So the `fetch` class does not trap Guzzle's transport at all. It gives the module's own
 * handler a yield point, and that handler is plain userland, which is what makes the park safe
 * there.
 */
export const PARK_TRAPS = { socket: PARK_SOCKET_TRAPS, fetch: PARK_FETCH_TRAPS } as const;

export type ParkClassName = keyof typeof PARK_TRAPS;

/** the PHP that asks whether this interpreter can park at all */
export const PARK_PROBE = `<?php echo json_encode(['park' => function_exists('cfw_park_run')]);`;

/**
 * The PHP that arms the traps; returns which names took, so a rename cannot fail silently.
 *
 * Reports the names the ENGINE accepted rather than the list it was sent. `cfw_park_trap` answers
 * false for a name that is not an internal function, so a build without one of these arms the rest
 * and says so.
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
 * `runText` rather than `_run`, because **`_run`'s return value is not the output.** php-wasm
 * delivers printed text through an `output` EVENT, so a probe that reads what `_run` returned sees
 * nothing and every build reports `absent` -- including one that carries the extension. That is what
 * driving this against the real interpreter caught, and a mock returning the string directly could
 * not.
 */
export type ParkBinary = {
	/** runs a fragment and answers what it PRINTED */
	runText: (code: string) => Promise<string>;
};

export type ParkInstall = {
	/**
	 * `absent` -- the interpreter cannot park; `ready` -- it can and nothing is diverted;
	 * `installed` -- traps are live and a drive loop must exist; `failed` -- the extension is there
	 * and arming did not take.
	 */
	state: 'installed' | 'ready' | 'absent' | 'failed';
	armed: string[];
	why?: string;
};

/**
 * Reports whether this interpreter can park, and arms only the classes it is asked for.
 *
 * `absent` is the expected answer on every build that predates `ext/cfwpark`, and it is a state
 * rather than an error: the site serves exactly as it does today.
 *
 * **ARMS NOTHING BY DEFAULT, and that is a safety property rather than a stub.** An armed trap
 * diverts every call to that name for the duration of a parked run, so arming without a loop behind
 * it would hang the first socket write on the site. The default is therefore `ready`: the extension
 * is present and no call site has been diverted. `drivePark()` is what may ask for a class.
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
