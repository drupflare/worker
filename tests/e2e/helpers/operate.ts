import type { Transport } from './lifecycle';

/**
 * The operation half of the lifecycle: content, modules, files, config.
 *
 * `lifecycle.ts` covers getting a site to exist. Everything here is what an owner does to a site
 * that already exists, which is where the interesting defects are -- a site is provisioned once and
 * operated for years.
 */

const json = async <T>(res: Response): Promise<T> => {
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`not JSON (${res.status}): ${text.slice(0, 400)}`);
	}
};

export interface SaveNodeReply {
	ok: boolean;
	nid?: number;
	title?: string;
	url?: string;
	error?: string;
	generationBefore?: number;
	generationAfter?: number;
	cfwPageRowsBefore?: number;
	cfwPageRowsAfter?: number;
	hostStatementsTotal?: number;
	/** the uid put back after the save; 0 proves the currentUser switch was undone */
	restoredUid?: number;
}

/** Creates a node through Drupal's own entity API. */
export function saveNode(
	t: Transport,
	options: { title?: string; type?: string; body?: string } = {}
): Promise<SaveNodeReply> {
	const params = new URLSearchParams();
	if (options.title !== undefined) params.set('title', options.title);
	if (options.type !== undefined) params.set('type', options.type);
	if (options.body !== undefined) params.set('body', options.body);
	return t(`/savenode?${params.toString()}`).then((r) => json<SaveNodeReply>(r));
}

export interface EnableReply {
	ok: boolean;
	module?: string;
	discoverable?: boolean;
	alreadyEnabled?: boolean;
	/**
	 * A failed enable reports through THREE different fields and never through `ok` alone.
	 *
	 * `requirementsError` carries `hook_requirements` and the "does not exist" refusal;
	 * `throwMessage` carries the `MissingDependencyException`; `error` is used by earlier failures
	 * such as a kernel boot. A caller reading only `error` sees `undefined` for the most common
	 * refusal there is, which is what made the first version of this spec assert the wrong field.
	 */
	error?: string;
	requirementsError?: string;
	throwMessage?: string;
	throwClass?: string;
	rowsWritten?: number;
	writeStatements?: number;
	routes?: number;
	moduleCountBefore?: number;
	moduleCountAfter?: number;
}

/** Enables a packed module; `dry` reports discoverability without installing. */
export function enableModule(
	t: Transport,
	module: string,
	opts: { dry?: boolean } = {}
): Promise<EnableReply> {
	return t(`/enable?module=${encodeURIComponent(module)}${opts.dry ? '&dry=1' : ''}`).then((r) =>
		json<EnableReply>(r)
	);
}

/**
 * Discards the interpreter and re-verifies the kernel.
 *
 * **This is a PROXY for hibernation, and calling it one is the honest framing.** Real hibernation
 * is the platform evicting the object after an idle period; what it does that matters to these
 * tests is discard the interpreter, and `/enable?verify=1` sets `this.php = null` before it runs.
 * So this reproduces hibernation's OBSERVABLE consequence -- a second lifetime with a cold
 * interpreter and a warm database -- without waiting on a timer that `wrangler dev` does not
 * guarantee.
 *
 * What it does NOT reproduce: eviction of in-memory JS state on the Durable Object instance itself.
 * A defect that needs `this.migrated` or `this.lastGc` to be forgotten will not show up here, and
 * that limit is why this is named for what it does rather than for what it stands in for.
 */
export function dropInterpreter(t: Transport): Promise<Record<string, unknown>> {
	return t('/enable?verify=1').then((r) => json<Record<string, unknown>>(r));
}

export interface FilesReply {
	ok: boolean;
	op?: string;
	uri?: string;
	bytes?: number;
	bytesWritten?: number;
	body?: string;
	error?: string;
	realpath?: string;
	exists?: boolean;
	/** the stream wrapper class registered for each scheme; measured identical for both */
	publicClass?: string;
	privateClass?: string;
}

/** Drives Drupal's file API over the durable store. `drop=1` discards the interpreter first. */
export function files(
	t: Transport,
	opts: { op?: string; uri?: string; body?: string; drop?: boolean } = {}
): Promise<FilesReply> {
	const params = new URLSearchParams();
	if (opts.op !== undefined) params.set('op', opts.op);
	if (opts.uri !== undefined) params.set('uri', opts.uri);
	if (opts.body !== undefined) params.set('body', opts.body);
	if (opts.drop) params.set('drop', '1');
	return t(`/files?${params.toString()}`).then((r) => json<FilesReply>(r));
}

/**
 * A session cookie the Worker's own predicate accepts as a login.
 *
 * `SESSION_COOKIE_RE` in `src/ops/auth-budget.ts` is `/^S?SESS[0-9a-f]{32}$/`, so the name has to be
 * `SESS` plus exactly 32 hex characters. A cookie shaped any other way is classified anonymous and
 * the request being made is not the request intended.
 *
 * **What this can and cannot establish.** It makes the WORKER treat the request as authenticated --
 * budget charged, `x-cfw-auth-mode` set, the personalised branch taken. It does NOT make Drupal
 * believe a user is logged in, because the value is not a real session record. So a leak
 * differential built on it tests the host's identity plumbing, which is where the uid-1 poisoning
 * actually lived, and cannot test Drupal's own per-user rendering.
 */
export function sessionCookie(seed: string): string {
	const hex = Array.from(seed)
		.map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
		.join('')
		.padEnd(32, '0')
		.slice(0, 32);
	return `SESS${hex}=session-${seed}`;
}

export interface IdentityShot {
	identity: string;
	status: number;
	cache: string | null;
	authMode: string | null;
	authReason: string | null;
	generation: string | null;
	sha1: string;
	byteLength: number;
	body: string;
}

/** One `/serve` as a named identity, recording what the tiers said about it. */
export async function serveAs(
	t: Transport,
	identity: string,
	cookie: string | null,
	path = '/'
): Promise<IdentityShot> {
	const res = await t(
		`/serve?path=${encodeURIComponent(path)}&edge=0`,
		cookie === null ? {} : { headers: { cookie } }
	);
	const buf = new Uint8Array(await res.arrayBuffer());
	const body = new TextDecoder().decode(buf);
	const { createHash } = await import('node:crypto');
	return {
		identity,
		status: res.status,
		cache: res.headers.get('x-cfw-cache'),
		authMode: res.headers.get('x-cfw-auth-mode'),
		authReason: res.headers.get('x-cfw-auth-reason'),
		generation: res.headers.get('x-cfw-generation'),
		sha1: createHash('sha1').update(buf).digest('hex'),
		byteLength: buf.byteLength,
		body
	};
}

/**
 * Marker strings that must never cross an identity boundary.
 *
 * A leak is only detectable if the identities produced DIFFERENT content in the first place, so the
 * differential seeds a node per identity and then looks for one identity's title in another's
 * response. Without the seeding step, every response is identical and the test passes vacuously --
 * which is the failure mode `cache-poison.ts` in `scripts/qa/` correctly reported as INCONCLUSIVE.
 */
export function identityMarker(identity: string, run: string): string {
	return `cfw-leak-${identity}-${run}`;
}
