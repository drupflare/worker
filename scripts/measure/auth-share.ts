/**
 * The authenticated share of a Drupal application's traffic, classified from its source.
 *
 * An access log cannot answer this for an API-shaped module: one that reads `Authorization: Bearer`
 * inside its controllers declares `_access: 'TRUE'` on every route, and combined-log format carries
 * no such header. So the classification is static, keyed on which auth funnel each controller calls.
 *
 * Usage:
 *   bun scripts/measure/auth-share.ts --routes=<routing.yml> --src=<src> --log=<aggregate>
 *
 * The aggregate is `count|file|method|path|status|ua`, which is what `uniq -c` over the log gives.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// #region route table

export interface RouteRow {
	id: string;
	path: string;
	methods: string[];
	controller: string;
}

/** every route in a Drupal `*.routing.yml`, flattened to what the classification needs */
export function readRoutes(yamlText: string): RouteRow[] {
	const doc = parseYaml(yamlText) as Record<string, Record<string, unknown>>;
	const rows: RouteRow[] = [];
	for (const [id, def] of Object.entries(doc ?? {})) {
		if (def === null || typeof def !== 'object') continue;
		const path = typeof def.path === 'string' ? def.path : null;
		if (path === null) continue;
		const defaults = (def.defaults ?? {}) as Record<string, unknown>;
		const controller = typeof defaults._controller === 'string' ? defaults._controller : '';
		const methods = Array.isArray(def.methods) ? def.methods.map(String) : ['GET'];
		rows.push({ id, path, methods, controller });
	}
	return rows;
}

/** `{param}` matches one segment; unmatched paths are counted rather than assumed away */
export function patternToRegExp(path: string): RegExp {
	const escaped = path
		.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '{' || c === '}' ? c : `\\${c}`))
		.replace(/\{[^}]+\}/g, '[^/]+');
	return new RegExp(`^${escaped}/?$`);
}

// #endregion

// #region which controller methods resolve a token

/**
 * How a controller method treats the bearer token. `optional` is the tier authenticated shells are
 * scored against: it serves anonymous callers and personalises for authenticated ones, never 401s.
 */
export type AuthTier = 'required' | 'optional' | 'none';

/** resolves a token and REFUSES without one */
const AUTH_REQUIRED_CALL = 'findByRequest';

/** resolves a token and serves anonymous callers anyway */
const AUTH_OPTIONAL_CALL = 'getOwnerOfRequest';

// ResponseCacheSubscriber resolves the requester on EVERY request to key the cache, so counting it
// would classify the whole log as authenticated
const EXCLUDED_DIRS = new Set(['EventSubscriber']);

function phpFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (!EXCLUDED_DIRS.has(entry)) phpFiles(full, out);
		} else if (entry.endsWith('.php')) {
			out.push(full);
		}
	}
	return out;
}

/** the class name a `\Drupal\<module>\Controller\X::y` reference names, and the method */
export function splitController(ref: string): { class: string; method: string } | null {
	const m = /^\\?([\w\\]+)::(\w+)$/.exec(ref.trim());
	if (m === null) return null;
	const parts = m[1].split('\\');
	return { class: parts[parts.length - 1], method: m[2] };
}

/**
 * Extracts one method body by brace balance. A file-level grep would mark every route in
 * `UsersController` protected, `/v2/users/login` included.
 */
export function methodBody(source: string, method: string): string | null {
	const sig = new RegExp(`function\\s+${method}\\s*\\(`, 'g');
	const at = sig.exec(source);
	if (at === null) return null;
	const open = source.indexOf('{', at.index);
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return source.slice(open, i + 1);
		}
	}
	return null;
}

export interface AuthIndex {
	/** `Class::method` -> how it treats the bearer token */
	tier: Map<string, AuthTier>;
	/** methods named by a route that no source file declares */
	missing: string[];
}

export function tierOf(body: string): AuthTier {
	if (body.includes(AUTH_REQUIRED_CALL)) return 'required';
	if (body.includes(AUTH_OPTIONAL_CALL)) return 'optional';
	return 'none';
}

export function indexAuth(srcDir: string, routes: RouteRow[]): AuthIndex {
	const byClass = new Map<string, string>();
	for (const file of phpFiles(srcDir)) {
		const name = file.slice(file.lastIndexOf('/') + 1, -4);
		byClass.set(name, readFileSync(file, 'utf8'));
	}

	const tier = new Map<string, AuthTier>();
	const missing: string[] = [];
	for (const route of routes) {
		const ref = splitController(route.controller);
		if (ref === null) continue;
		const key = `${ref.class}::${ref.method}`;
		if (tier.has(key)) continue;
		const source = byClass.get(ref.class);
		if (source === undefined) {
			missing.push(key);
			continue;
		}
		const body = methodBody(source, ref.method);
		if (body === null) {
			missing.push(key);
			continue;
		}
		tier.set(key, tierOf(body));
	}
	return { tier, missing };
}

// #endregion

// #region the log

export interface LogRow {
	count: number;
	file: string;
	method: string;
	path: string;
	status: number;
	ua: string;
}

export function readAggregate(text: string): LogRow[] {
	const rows: LogRow[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		const space = trimmed.indexOf(' ');
		const count = Number(trimmed.slice(0, space));
		const parts = trimmed.slice(space + 1).split('|');
		if (parts.length < 5 || !Number.isFinite(count)) continue;
		rows.push({
			count,
			file: parts[0],
			method: parts[1],
			path: parts[2],
			status: Number(parts[3]),
			ua: parts.slice(4).join('|')
		});
	}
	return rows;
}

export type Verdict = 'authenticated' | 'personalisable' | 'anonymous' | 'unrouted';

export interface Classified {
	verdict: Verdict;
	route: RouteRow | null;
}

/**
 * Which route a logged path belongs to, and how it treats a token. A 401 counts as anonymous:
 * the envelope charges a request either way and no user-varying render happens.
 */
export function classify(row: LogRow, routes: RouteRow[], auth: AuthIndex): Classified {
	for (const route of routes) {
		if (!route.methods.includes(row.method)) continue;
		if (!patternToRegExp(route.path).test(row.path)) continue;
		const ref = splitController(route.controller);
		const key = ref === null ? '' : `${ref.class}::${ref.method}`;
		const tier = auth.tier.get(key) ?? 'none';
		if (row.status === 401) return { verdict: 'anonymous', route };
		if (tier === 'required') return { verdict: 'authenticated', route };
		if (tier === 'optional') return { verdict: 'personalisable', route };
		return { verdict: 'anonymous', route };
	}
	return { verdict: 'unrouted', route: null };
}

// #endregion

export interface Tally {
	authenticated: number;
	personalisable: number;
	anonymous: number;
	unrouted: number;
	total: number;
	/** the LOWER bound: a token was required, so the response cannot be a shared cache entry */
	share: number;
	/** the UPPER bound: everything whose response may vary by user */
	varyingShare: number;
}

export function tally(rows: LogRow[], routes: RouteRow[], auth: AuthIndex): Tally {
	let authenticated = 0;
	let personalisable = 0;
	let anonymous = 0;
	let unrouted = 0;
	for (const row of rows) {
		const { verdict } = classify(row, routes, auth);
		if (verdict === 'authenticated') authenticated += row.count;
		else if (verdict === 'personalisable') personalisable += row.count;
		else if (verdict === 'anonymous') anonymous += row.count;
		else unrouted += row.count;
	}
	// unrouted is scanner noise and static files, so the share is taken against the ROUTED total
	const total = authenticated + personalisable + anonymous;
	return {
		authenticated,
		personalisable,
		anonymous,
		unrouted,
		total,
		share: total === 0 ? 0 : authenticated / total,
		varyingShare: total === 0 ? 0 : (authenticated + personalisable) / total
	};
}

function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function main(): Promise<void> {
	const routesPath = arg('routes', '');
	const srcDir = arg('src', '');
	const logPath = arg('log', '');
	if (logPath === '') {
		console.error('usage: auth-share.ts --routes=<routing.yml> --src=<src> --log=<aggregate>');
		process.exit(2);
	}

	const routes = readRoutes(readFileSync(routesPath, 'utf8'));
	const auth = indexAuth(srcDir, routes);
	const allRows = readAggregate(readFileSync(logPath, 'utf8'));
	// a monitor is billed traffic but does not scale with users, so leaving it in understates the
	// share of HUMAN traffic that varies by user
	const excludeUa = arg('exclude-ua', '');
	const rows = excludeUa === '' ? allRows : allRows.filter((r) => !r.ua.includes(excludeUa));
	if (excludeUa !== '') {
		const dropped = allRows
			.filter((r) => r.ua.includes(excludeUa))
			.reduce((s, r) => s + r.count, 0);
		console.log(
			`excluding user agents containing "${excludeUa}": ${dropped} request(s) dropped`
		);
	}

	const tiers = [...auth.tier.values()];
	const count = (t: AuthTier): number => tiers.filter((x) => x === t).length;
	console.log(`routes: ${routes.length}, distinct controller methods: ${auth.tier.size}`);
	console.log(
		`  ${count('required')} require a token, ${count('optional')} personalise for one, ` +
			`${count('none')} never read it`
	);
	if (auth.missing.length > 0) {
		console.log(
			`  ${auth.missing.length} named by a route but not found in src/: ${auth.missing.slice(0, 5).join(', ')}`
		);
	}

	// per DAY, because an n of one day is not a measurement and the traffic here is bursty
	const byFile = new Map<string, LogRow[]>();
	for (const row of rows) {
		const list = byFile.get(row.file) ?? [];
		list.push(row);
		byFile.set(row.file, list);
	}

	console.log('\nper day (routed requests only; scanner noise reported separately)');
	console.log('| log | token required | personalisable | anonymous | required % | may vary % |');
	console.log('| --- | --- | --- | --- | --- | --- |');
	const shares: number[] = [];
	const varying: number[] = [];
	for (const [file, list] of [...byFile.entries()].sort()) {
		const t = tally(list, routes, auth);
		if (t.total > 0) {
			shares.push(t.share);
			varying.push(t.varyingShare);
		}
		const name = file.slice(file.lastIndexOf('/') + 1);
		console.log(
			`| ${name} | ${t.authenticated} | ${t.personalisable} | ${t.anonymous} | ` +
				`${(t.share * 100).toFixed(1)}% | ${(t.varyingShare * 100).toFixed(1)}% |`
		);
	}

	const all = tally(rows, routes, auth);
	const span = (xs: number[]): string => {
		const sorted = [...xs].sort((a, b) => a - b);
		if (sorted.length === 0) return 'n/a';
		return `${(sorted[0] * 100).toFixed(1)}%-${(sorted[sorted.length - 1] * 100).toFixed(1)}%`;
	};

	console.log(`\nn=${shares.length} days`);
	console.log(
		`  token REQUIRED:  ${(all.share * 100).toFixed(1)}% overall, ${span(shares)} per day ` +
			`(${all.authenticated} requests)`
	);
	console.log(
		`  MAY VARY by user: ${(all.varyingShare * 100).toFixed(1)}% overall, ${span(varying)} per day ` +
			`(${all.authenticated + all.personalisable} requests)`
	);
	console.log(
		`  anonymous: ${all.anonymous}, unrouted: ${all.unrouted} (scanners, static files)`
	);

	const unauthorized = rows.filter((r) => r.status === 401).reduce((sum, r) => sum + r.count, 0);
	console.log(`control: ${unauthorized} request(s) answered 401 across the whole window`);
}

if (import.meta.main) await main();
