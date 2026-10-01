import { MAX_MAIL_ATTEMPTS, MAX_OUTBOUND_BODY_BYTES } from './limits';

export { forwardTo } from '../util/forward';

/**
 * A render's cache tags, as the one string a page row carries.
 *
 * `[]` rather than NULL for a page that declares none, so a scoped purge can tell "depends on
 * nothing" from "stored before the column existed" (only the latter is unsafe to scope against).
 */
export function pageTagList(tags: unknown): string {
	const list = Array.isArray(tags)
		? [...new Set(tags.map((t) => String(t)).filter((t) => t !== ''))]
		: [];
	return JSON.stringify(list);
}

/**
 * The response headers a render is allowed to set on the way out.
 *
 * `x-drupal-*` only: browser-facing headers such as `X-Drupal-Ajax-Token` (ajax.js discards a
 * response without it). The prefix is a boundary: arbitrary headers could set `set-cookie`,
 * `location` or CORS.
 *
 * @param raw
 *   Whatever the render fragment reported, which is unvalidated JSON.
 *
 * @returns
 *   Header name to value, lowercased, with anything outside the prefix dropped.
 */
export function passThroughHeaders(raw: unknown): Record<string, string> {
	if (raw === null || typeof raw !== 'object') return {};
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		const key = String(name).toLowerCase();
		if (!key.startsWith('x-drupal-')) continue;
		// a newline would split the response
		if (/[\r\n]/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) continue;
		out[key] = value;
	}
	return out;
}

/**
 * The gated lane's queueing, reduced to what a pool sizer reads.
 *
 * The two duration means are floors (see `noteLaneTiming()`), and named so.
 */
export function laneTimingSummary(
	samples: readonly { ahead: number; queueMs: number; serviceMs: number }[]
): {
	samples: number;
	aheadMean: number;
	aheadMax: number;
	queuedFraction: number;
	queueMsFloorMean: number;
	serviceMsFloorMean: number;
} {
	if (samples.length === 0) {
		return {
			samples: 0,
			aheadMean: 0,
			aheadMax: 0,
			queuedFraction: 0,
			queueMsFloorMean: 0,
			serviceMsFloorMean: 0
		};
	}
	const mean = (pick: (s: (typeof samples)[number]) => number) =>
		Number((samples.reduce((a, s) => a + pick(s), 0) / samples.length).toFixed(2));
	return {
		samples: samples.length,
		aheadMean: mean((s) => s.ahead),
		aheadMax: Math.max(...samples.map((s) => s.ahead)),
		// the share that waited on another request (what a second lane removes)
		queuedFraction: Number(
			(samples.filter((s) => s.ahead > 0).length / samples.length).toFixed(3)
		),
		queueMsFloorMean: mean((s) => s.queueMs),
		serviceMsFloorMean: mean((s) => s.serviceMs)
	};
}

/**
 * Bounds the mail-attempt log in place (entries are small, bodies are never held).
 */
export function trimMails(mails: Array<unknown>): void {
	while (mails.length > MAX_MAIL_ATTEMPTS) mails.shift();
}

/**
 * A response body read up to a cap. Truncates rather than throws: a refusal would lose an answer
 * the site is waiting on and be retried forever.
 */
export async function boundedText(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > MAX_OUTBOUND_BODY_BYTES) {
			await reader.cancel();
			chunks.push(value.subarray(0, value.byteLength - (total - MAX_OUTBOUND_BODY_BYTES)));
			break;
		}
		chunks.push(value);
	}
	const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
	let at = 0;
	for (const c of chunks) {
		joined.set(c, at);
		at += c.byteLength;
	}
	return new TextDecoder().decode(joined);
}

/**
 * Cache tag names among a statement's bound parameters.
 *
 * `Connection::merge('cachetags')` binds the tag, so the name is in `params`, not the SQL text. An
 * empty result makes the caller purge everything.
 *
 * Both binding shapes must be read: `INSERT` binds positionally (`[1, 'node_list']`) and the
 * update by name (`{':db_condition_placeholder_0': 'node_list'}`), so reading only the array
 * missed every invalidation after a tag's first.
 */
export function cacheTagsIn(params: unknown): string[] {
	const list = Array.isArray(params)
		? params
		: params !== null && typeof params === 'object'
			? Object.values(params as Record<string, unknown>)
			: params == null
				? []
				: [params];
	return list
		.filter((p): p is string => typeof p === 'string')
		.filter((p) => p.length > 0 && p.length <= 40 && /^[A-Za-z0-9_.:-]+$/.test(p));
}
