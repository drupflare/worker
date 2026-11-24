import type { SiteEnv } from '../../env';
import { growthLedger, type GrowthRefusal } from './cap';

/** the table the durable refusal log lives in; created by the first refusal, never by a request */
export const GROWTH_LOG_TABLE = 'cfw_growth_log';

/** newest rows kept; each refusal deletes the older ones in the same batch */
export const GROWTH_LOG_KEEP = 20;

/** one refusal as stored */
export interface GrowthLogRow {
	id: number;
	at: number;
	fromBytes: number;
	toBytes: number;
	capBytes: number;
	jsSideBytes: number;
	route: string;
	rolledBack: boolean;
	/** 1 for the first try, 2 for the front worker's repeat under the fresh-attempt allowance */
	attempt: number;
}

/** what the logger reads off the object */
export interface GrowthLogHost {
	sql: SqlStorage;
	env?: SiteEnv;
	mountInfo?: Parameters<typeof growthLedger>[0];
	/** the route of the request in flight, set by `fetchRequest()`; unset for an alarm or an owner call */
	growthRoute?: string;
	/** whether the request in flight is the front worker's repeat of a refusal */
	growthRetry?: boolean;
	nowMs(): number;
}

/**
 * The route a refusal is filed under: method and path, no query, and a segment longer than 24
 * characters (a token in a reset link, a hash) reads as `*`.
 */
export function growthRouteOf(method: string, pathname: string, pagePath?: string | null): string {
	const clean = (p: string) =>
		(p.split(/[?#]/, 1)[0] ?? '')
			.split('/')
			.map((s) => (s.length > 24 ? '*' : s))
			.join('/');
	const page = pagePath ? ` ${clean(pagePath)}` : '';
	return `${method.toUpperCase()} ${clean(pathname)}${page}`.slice(0, 160);
}

function tableExists(sql: SqlStorage): boolean {
	return (
		sql
			.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", GROWTH_LOG_TABLE)
			.toArray().length > 0
	);
}

/**
 * Writes one row for a refused run and trims the log to the newest {@link GROWTH_LOG_KEEP}.
 *
 * Called after the run's slice has rolled back and the interpreter is dropped, never inside the
 * refused slice, so the row survives the rollback. The first refusal creates the table; a normal
 * request writes nothing. A refusal costs one row written, two once the log is full.
 */
export function recordGrowthRefusal(
	host: GrowthLogHost,
	info: GrowthRefusal | undefined,
	rolledBack: boolean
): void {
	if (!tableExists(host.sql)) {
		host.sql.exec(
			`CREATE TABLE ${GROWTH_LOG_TABLE} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at INTEGER NOT NULL,
				from_bytes INTEGER NOT NULL,
				to_bytes INTEGER NOT NULL,
				cap_bytes INTEGER NOT NULL,
				js_side_bytes INTEGER NOT NULL,
				route TEXT NOT NULL,
				rolled_back INTEGER NOT NULL,
				attempt INTEGER NOT NULL DEFAULT 1
			)`
		);
	} else if (
		host.sql
			.exec(
				`SELECT name FROM pragma_table_info('${GROWTH_LOG_TABLE}') WHERE name = 'attempt'`
			)
			.toArray().length === 0
	) {
		// a table made before the column existed gets it once, after a look at its columns
		host.sql.exec(
			`ALTER TABLE ${GROWTH_LOG_TABLE} ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`
		);
	}
	host.sql.exec(
		`INSERT INTO ${GROWTH_LOG_TABLE}
			(at, from_bytes, to_bytes, cap_bytes, js_side_bytes, route, rolled_back, attempt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		host.nowMs(),
		info?.fromBytes ?? 0,
		info?.toBytes ?? 0,
		info?.capBytes ?? 0,
		growthLedger(host.mountInfo).jsSideBytes,
		host.growthRoute ?? 'none',
		rolledBack ? 1 : 0,
		host.growthRetry ? 2 : 1
	);
	host.sql.exec(
		`DELETE FROM ${GROWTH_LOG_TABLE}
		 WHERE id NOT IN (SELECT id FROM ${GROWTH_LOG_TABLE} ORDER BY id DESC LIMIT ?)`,
		GROWTH_LOG_KEEP
	);
}

/** the stored refusals, newest first; empty when none was ever written, and it creates nothing */
export function readGrowthLog(sql: SqlStorage): GrowthLogRow[] {
	if (!tableExists(sql)) return [];
	return sql
		.exec<Record<string, number | string>>(
			`SELECT id, at, from_bytes, to_bytes, cap_bytes, js_side_bytes, route,
				rolled_back, attempt FROM ${GROWTH_LOG_TABLE} ORDER BY id DESC`
		)
		.toArray()
		.map((r) => ({
			id: Number(r.id),
			at: Number(r.at),
			fromBytes: Number(r.from_bytes),
			toBytes: Number(r.to_bytes),
			capBytes: Number(r.cap_bytes),
			jsSideBytes: Number(r.js_side_bytes),
			route: String(r.route),
			rolledBack: Number(r.rolled_back) === 1,
			attempt: Number(r.attempt)
		}));
}
