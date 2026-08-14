/**
 * The host half of the capability API.
 *
 * vrzno_env($name) resolves to Module[$name], so everything here is reachable
 * from PHP as a plain object with callable methods. This is the seam that
 * replaces compiled C libraries with platform primitives:
 *
 *   curl/openssl  -> fetch()
 *   SMTP          -> an email binding
 *   libsqlite3    -> ctx.storage.sql   (synchronous, so no suspension needed)
 *   zlib          -> CompressionStream
 *   hashing       -> crypto.subtle
 *
 * Sync vs async matters here. Measured on the ASYNCIFY=0 build, PHP can call a
 * JS function and read its return value, but cannot await a promise --
 * vrzno_await is compiled against Asyncify. Anything returning a promise below
 * therefore requires a JSPI build; anything returning a value works today.
 */

/**
 * 32-bit marshalling guard.
 *
 * The wasm build is 32-bit (PHP_INT_SIZE 4), so any JS number at or above 2^31
 * wraps silently when it crosses into PHP -- Date.now() came back as
 * -397708726 rather than ~1.78e12. It corrupts rather than errors, which makes
 * it a correctness landmine for node IDs, file sizes and timestamps.
 *
 * This is applied at the boundary by marshal() below rather than per call site,
 * because opt-in guarding is exactly how one of these gets missed.
 */
const INT32_MAX = 2 ** 31 - 1;

const safeInt = (n: number): number | string =>
	Number.isInteger(n) && Math.abs(n) <= INT32_MAX ? n : String(n);

/**
 * Recursively converts anything unsafe to cross a 32-bit boundary into a
 * string. Applied to every value returned to PHP.
 */
function marshal(value: unknown, depth = 0): unknown {
	if (depth > 12) return value;
	const t = typeof value;
	if (t === 'number') return safeInt(value as number);
	if (t === 'bigint') return String(value);
	if (value === null || t !== 'object') return value;
	if (Array.isArray(value)) return value.map((v) => marshal(v, depth + 1));
	if (value instanceof Uint8Array) return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as object)) out[k] = marshal(v, depth + 1);
	return out;
}

/**
 * Wraps every method so its return value is marshalled. Async methods are
 * marshalled after resolution.
 */
function guard(host: Record<string, unknown>): Record<string, unknown> {
	const wrapped: Record<string, unknown> = {};
	for (const [name, fn] of Object.entries(host)) {
		if (typeof fn !== 'function') {
			wrapped[name] = marshal(fn);
			continue;
		}
		wrapped[name] = (...args: unknown[]) => {
			const r: unknown = fn(...args);
			return isThenable(r) ? r.then((v) => marshal(v)) : marshal(r);
		};
	}
	return wrapped;
}

/** the `r && typeof r.then === 'function'` test above, as a narrowing guard */
function isThenable(r: unknown): r is PromiseLike<unknown> {
	return !!r && typeof (r as PromiseLike<unknown>).then === 'function';
}

/**
 * The Durable Object state a capability reaches, narrowed to the one store it uses.
 *
 * Optional all the way down because the synchronous branches check for it: `sqlExec` throws
 * `no DO SQLite in this context` and `sqlSize` answers 0, which is what makes the host usable
 * from a plain Worker isolate as well.
 */
export interface CapabilityCtx {
	storage?: { sql?: SqlStorage };
}

/** what PHP may hand the fetch capability as its second argument, JSON-encoded or plain */
export interface CapabilityFetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string | null;
	redirect?: string;
}

export function createHost(env: unknown, ctx?: CapabilityCtx): Record<string, unknown> {
	// guard() marshals every return value; see the 32-bit note above
	return guard({
		// --- synchronous: works on the current build ---

		/** ms since epoch, as a string because it exceeds 32-bit */
		now: () => String(Date.now()),

		/** random bytes as hex; PHP's CSPRNG is fine, this is for parity testing */
		randomHex: (n?: unknown) => {
			const b = new Uint8Array(Math.min(Number(n) || 16, 1024));
			crypto.getRandomValues(b);
			return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
		},

		/**
		 * Durable Object SQLite.
		 *
		 * ctx.storage.sql.exec() is synchronous -- it returns a cursor, not a
		 * promise -- which is why the database capability needs no suspension.
		 *
		 * NOTE: this cannot host Drupal's SQLite driver unmodified. That driver
		 * registers ~14 user-defined SQL functions plus a NOCASE_UTF8 collation,
		 * and SqlStorage exposes no createFunction/createCollation. See FINDINGS.
		 * Kept here because it is correct for any query that avoids them.
		 */
		sqlExec: (query: string, params?: string) => {
			if (!ctx?.storage?.sql) throw new Error('no DO SQLite in this context');
			const args = params ? JSON.parse(params) : [];
			const cursor = ctx.storage.sql.exec(query, ...args);
			// marshal BEFORE stringifying: the boundary guard cannot see inside a
			// string, and PHP's json_decode on a 32-bit build silently turns an
			// oversized integer into a float. Row ids are exactly the values that
			// would be corrupted.
			return JSON.stringify(
				marshal({
					rows: cursor.toArray(),
					columnNames: cursor.columnNames,
					rowsRead: cursor.rowsRead,
					rowsWritten: cursor.rowsWritten
				})
			);
		},

		/** database size in bytes, as a string for the same 32-bit reason */
		sqlSize: () => String(ctx?.storage?.sql?.databaseSize ?? 0),

		// --- asynchronous: requires a JSPI build ---

		/**
		 * Outbound HTTP, replacing curl and the missing https stream wrapper.
		 *
		 * Returns a promise, so PHP reaches it through vrzno_await() and this
		 * only functions on a build with a suspension mechanism.
		 *
		 * Every field is read here rather than handing PHP a live Response,
		 * because the body must be drained while the promise is still resolvable.
		 */
		fetch: async (url: string, init?: string | CapabilityFetchInit) => {
			const opts: CapabilityFetchInit =
				typeof init === 'string' ? JSON.parse(init) : init || {};
			const res = await fetch(url, {
				method: opts.method || 'GET',
				headers: opts.headers || {},
				body: opts.body ?? undefined,
				redirect: opts.redirect || 'follow'
			});
			const headers: Record<string, string> = {};
			for (const [k, v] of res.headers) headers[k] = v;
			return {
				status: res.status,
				headers,
				body: await res.text()
			};
		}
	});
}
