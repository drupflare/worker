import { carriesAuthorization, cookieKind } from '../ops/auth-budget';
import { cmsOf } from '../util/cms';

/** the most distinct unclassified cookie names `/serve-stats` keeps; later ones count as `other` */
export const MAX_NAMED_COOKIES = 32;

/** what `/serve-stats` reports about cookies nobody has classified */
export type UnclassifiedCookieStats = {
	/** requests identified only by a cookie name no rule holds */
	requests: number;
	/** requests per cookie name, the first {@link MAX_NAMED_COOKIES} names seen */
	names: Record<string, number>;
	/** requests whose names did not fit in `names` */
	other: number;
};

const seen: UnclassifiedCookieStats = { requests: 0, names: Object.create(null), other: 0 };

/** one `name=value` pair per cookie, the raw text kept so the header can be rebuilt */
function pairsOf(header: string): { name: string; raw: string }[] {
	const out: { name: string; raw: string }[] = [];
	for (const part of header.split(';')) {
		const raw = part.trim();
		if (raw === '') continue;
		const eq = raw.indexOf('=');
		const name = (eq < 0 ? raw : raw.slice(0, eq)).trim();
		if (name !== '') out.push({ name, raw });
	}
	return out;
}

/**
 * The request a WordPress page render sees when its only cookies are analytics or consent ones.
 *
 * Those cookies never change what WordPress renders, so such a request is the anonymous one and
 * must read and fill the same stored page. The cookies are dropped here, before any tier is asked,
 * so every later check sees what a visitor with none would send. A request that also carries a
 * login, a personal or an unclassified cookie is returned as it came: its page is per visitor.
 * `wordpress_test_cookie` stays, because `wp-login.php` fails without it.
 *
 * @param request the inbound request
 * @param env the worker env, read for its CMS
 */
export function withoutTrackingCookies(request: Request, env: unknown): Request {
	if (cmsOf(env) !== 'wordpress') return request;
	const header = request.headers.get('cookie');
	if (header === null) return request;
	const pairs = pairsOf(header);
	let dropped = pairs.length === 0;
	const kept: string[] = [];
	for (const { name, raw } of pairs) {
		const kind = cookieKind(name, 'wordpress');
		if (kind === 'tracking') {
			dropped = true;
		} else if (kind === 'neutral') {
			kept.push(raw);
		} else {
			return request;
		}
	}
	if (!dropped) return request;
	const headers = new Headers(request.headers);
	if (kept.length === 0) headers.delete('cookie');
	else headers.set('cookie', kept.join('; '));
	return new Request(request, { headers });
}

/**
 * Counts a request that is identified only by cookie names nobody has classified, by name.
 *
 * A login, a personal cookie or an `Authorization` header already says why a request is
 * authenticated, so those are not counted here. Names are cut to a log-safe form and values are
 * never read.
 *
 * @param request the inbound request, as the object receives it
 */
export function noteUnclassifiedCookies(request: {
	headers: { get(name: string): string | null };
}): void {
	if (carriesAuthorization(request)) return;
	const header = request.headers.get('cookie');
	if (header === null) return;
	const unknown: string[] = [];
	for (const { name } of pairsOf(header)) {
		const kind = cookieKind(name, 'wordpress');
		if (kind === 'session' || kind === 'personal') return;
		if (kind === 'unknown') unknown.push(name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48));
	}
	if (unknown.length === 0) return;
	seen.requests += 1;
	let overflowed = false;
	for (const name of new Set(unknown)) {
		if (name in seen.names) seen.names[name] = (seen.names[name] ?? 0) + 1;
		else if (Object.keys(seen.names).length < MAX_NAMED_COOKIES) seen.names[name] = 1;
		else overflowed = true;
	}
	if (overflowed) seen.other += 1;
}

/** the counts since this isolate started, for `/serve-stats` */
export function unclassifiedCookieStats(): UnclassifiedCookieStats {
	return { requests: seen.requests, names: { ...seen.names }, other: seen.other };
}

/** @internal clears the counts, for a spec */
export function resetUnclassifiedCookies(): void {
	seen.requests = 0;
	seen.names = Object.create(null);
	seen.other = 0;
}
