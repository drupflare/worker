/**
 * Response headers and redirects the front worker applies for a site, from two levers.
 *
 * A migrated project carries both in its old web server or CDN rules. They run in the front worker
 * so a redirect costs no Durable Object request, and they read `RESPONSE_HEADERS` and `REDIRECTS`
 * as a JSON string (KV, `--var`) or as the array itself (a wrangler `vars` entry).
 *
 * `RESPONSE_HEADERS` is `[{ "path": "/prefix*" | "/exact", "set": { "Name": "value" } }]`.
 * `REDIRECTS` is `[{ "from": "/old" | "/old/*", "to": "/new" | "/new/*" | "https://...", "status": 301 }]`.
 */

const MAX_RULES = 100;
const MAX_HEADERS_PER_RULE = 20;
const MAX_VALUE = 4096;
const MAX_DOCUMENT = 64 * 1024;
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const STATUSES = [301, 302, 307, 308] as const;

/** names a rule may not set: cookies, this project's own headers, and the ones that frame the body */
const FORBIDDEN = new Set([
	'set-cookie',
	'content-length',
	'content-encoding',
	'transfer-encoding',
	'connection',
	'host'
]);

export type HeaderRule = { path: string; set: Record<string, string> };
export type RedirectRule = { from: string; to: string; status: (typeof STATUSES)[number] };

type Parsed<T> = { rules: T[]; problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function document(raw: unknown, name: string): { list: unknown[] | null; problems: string[] } {
	if (raw === undefined || raw === null || raw === '') return { list: null, problems: [] };
	let value: unknown = raw;
	if (typeof raw === 'string') {
		if (raw.length > MAX_DOCUMENT) {
			return {
				list: null,
				problems: [`${name}: longer than ${MAX_DOCUMENT} bytes, ignored`]
			};
		}
		try {
			value = JSON.parse(raw);
		} catch {
			return { list: null, problems: [`${name}: not valid JSON, ignored`] };
		}
	}
	if (!Array.isArray(value)) {
		return { list: null, problems: [`${name}: not a JSON array, ignored`] };
	}
	const problems =
		value.length > MAX_RULES
			? [`${name}: more than ${MAX_RULES} rules, the rest are ignored`]
			: [];
	return { list: value.slice(0, MAX_RULES), problems };
}

const pathShape = (p: unknown): p is string =>
	typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !/[\s\\]/.test(p);

/** parses `RESPONSE_HEADERS`; a bad rule or header is dropped and named, the rest stay */
export function parseResponseHeaders(raw: unknown): Parsed<HeaderRule> {
	const { list, problems } = document(raw, 'RESPONSE_HEADERS');
	const rules: HeaderRule[] = [];
	(list ?? []).forEach((entry, i) => {
		const at = `RESPONSE_HEADERS[${i}]`;
		if (!isObject(entry) || !pathShape(entry.path) || !isObject(entry.set)) {
			problems.push(`${at}: needs a path starting with / and a set object, ignored`);
			return;
		}
		const set: Record<string, string> = {};
		for (const [name, value] of Object.entries(entry.set)) {
			const key = name.toLowerCase();
			if (Object.keys(set).length >= MAX_HEADERS_PER_RULE) {
				problems.push(
					`${at}: more than ${MAX_HEADERS_PER_RULE} headers, the rest are ignored`
				);
				break;
			}
			if (!TOKEN.test(name)) problems.push(`${at}: ${name} is not a header name, ignored`);
			else if (FORBIDDEN.has(key) || key.startsWith('x-cfw-'))
				problems.push(`${at}: ${name} cannot be set here, ignored`);
			else if (
				typeof value !== 'string' ||
				/[\r\n\0]/.test(value) ||
				value.length > MAX_VALUE
			)
				problems.push(`${at}: the value of ${name} is not a plain string, ignored`);
			else set[name] = value;
		}
		if (Object.keys(set).length > 0) rules.push({ path: entry.path, set });
	});
	return { rules, problems };
}

/** parses `REDIRECTS`; a bad rule is dropped and named, the rest stay */
export function parseRedirects(raw: unknown): Parsed<RedirectRule> {
	const { list, problems } = document(raw, 'REDIRECTS');
	const rules: RedirectRule[] = [];
	(list ?? []).forEach((entry, i) => {
		const at = `REDIRECTS[${i}]`;
		if (!isObject(entry) || !pathShape(entry.from) || typeof entry.to !== 'string') {
			problems.push(`${at}: needs a from path starting with / and a to target, ignored`);
			return;
		}
		const status = entry.status === undefined ? 301 : Number(entry.status);
		const to = entry.to;
		const absolute = /^https?:\/\/[^\s/]+/.test(to);
		if (!STATUSES.includes(status as never)) {
			problems.push(`${at}: status must be one of ${STATUSES.join(', ')}, ignored`);
		} else if (!absolute && !pathShape(to)) {
			problems.push(`${at}: to must be a path starting with / or an http(s) URL, ignored`);
		} else if (/[\r\n\0]/.test(to) || to.length > MAX_VALUE) {
			problems.push(`${at}: to is not a plain string, ignored`);
		} else if (entry.from === to) {
			problems.push(`${at}: from and to are the same, ignored`);
		} else if (!/^[^*]*\*?$/.test(entry.from)) {
			problems.push(`${at}: from may end in one * and carry no other, ignored`);
		} else {
			rules.push({ from: entry.from, to, status: status as RedirectRule['status'] });
		}
	});
	return { rules, problems };
}

/** why a lever value is refused as a whole, or null; the writer uses it so a bad document is never stored */
export function ruleDocumentRefusal(
	name: 'RESPONSE_HEADERS' | 'REDIRECTS',
	value: unknown
): string | null {
	const parsed = name === 'REDIRECTS' ? parseRedirects(value) : parseResponseHeaders(value);
	if (parsed.problems.length === 0) return null;
	return `${name} has ${parsed.problems.length} problem(s): ${parsed.problems[0]}`;
}

const trimSlash = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

/** the first matching rule's target and status for a URL, or null */
export function redirectMatch(
	rules: readonly RedirectRule[],
	url: URL
): { to: string; status: RedirectRule['status'] } | null {
	for (const rule of rules) {
		let to: string | null = null;
		if (rule.from.endsWith('*')) {
			const prefix = rule.from.slice(0, -1);
			if (url.pathname.startsWith(prefix)) {
				to = rule.to.replace('*', () => url.pathname.slice(prefix.length));
			}
		} else if (trimSlash(url.pathname) === trimSlash(rule.from)) {
			to = rule.to;
		}
		if (to !== null) {
			return {
				to: to.includes('?') || url.search === '' ? to : to + url.search,
				status: rule.status
			};
		}
	}
	return null;
}

const headerMatches = (rule: HeaderRule, pathname: string): boolean =>
	rule.path.endsWith('*') ? pathname.startsWith(rule.path.slice(0, -1)) : pathname === rule.path;

export type EdgeRules = {
	/** the redirect response for this URL, or null */
	redirect(url: URL): Response | null;
	/** the response with every matching rule's headers set, later rules winning */
	decorate(pathname: string, res: Response): Response;
};

/** paths a redirect never applies to: this worker's own routes and the object's `__` routes */
export type Reserved = (pathname: string) => boolean;

/** builds the two appliers from a worker env; parsed on every call, which is a few microseconds */
export function edgeRules(
	env: { RESPONSE_HEADERS?: unknown; REDIRECTS?: unknown } | null | undefined,
	reserved: Reserved = () => false
): EdgeRules {
	const headers = parseResponseHeaders(env?.RESPONSE_HEADERS).rules;
	const redirects = parseRedirects(env?.REDIRECTS).rules;
	return {
		redirect(url) {
			if (redirects.length === 0 || reserved(url.pathname)) return null;
			const hit = redirectMatch(redirects, url);
			if (hit === null) return null;
			return new Response(null, {
				status: hit.status,
				headers: { location: new URL(hit.to, url.origin).toString(), 'x-cfw-redirect': '1' }
			});
		},
		decorate(pathname, res) {
			if (headers.length === 0 || res.status === 101) return res;
			const matched = headers.filter((r) => headerMatches(r, pathname));
			if (matched.length === 0) return res;
			const out = new Response(res.body, res);
			for (const rule of matched) {
				for (const [name, value] of Object.entries(rule.set)) out.headers.set(name, value);
			}
			return out;
		}
	};
}
