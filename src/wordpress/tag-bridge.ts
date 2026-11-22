import { withMask } from '@drupflare/cartridge/mask';
import { decode, encode } from '@drupflare/durabledb/codec';
import type { MysqlBridge } from '../do/mysql-bridge';
import type { SiteBinary } from '../do/types';
import type { SitePhpDurableObject } from '../site-do';
import { cmsOf } from '../util/cms';
import {
	noteWrittenRows,
	parseAnnouncement,
	uncoveredWrites,
	writtenRows,
	writtenTables,
	type Announcement,
	type WrittenRows
} from './tags';

/** what `/serve-stats` reports about WordPress invalidation */
export type TagStats = {
	/** tags handed over by the emitter */
	announced: number;
	/** wholesale purges the emitter asked for */
	wholesale: number;
	/** the last wholesale reason, and when */
	lastWholesale?: { reason: string; at: number };
	/** wholesale purges the host raised itself for writes nobody announced */
	floorPurges: number;
	/** the tables behind the last floor purge, and when */
	lastFloor?: { tables: string[]; at: number };
	/** requests the host refused to act on */
	refused: number;
	/** runs that ended */
	settles: number;
};

/** one PHP run's share of the protocol, forgotten when the next run begins */
type Run = {
	tags: Set<string>;
	quiet: Set<string>;
	writes: Set<string>;
	/** the post ids each written table was written at, when every write to it named them */
	rows: WrittenRows;
	wholesaled: boolean;
	settled: boolean;
};

/** the MySQL bridge plus the end of a run, which a one-shot interpreter needs on its way out */
export interface TagBridge extends MysqlBridge {
	/** judges the run's writes and purges what it announced; the interpreter's last act */
	endRun(): void;
}

const blank = (): Run => ({
	tags: new Set(),
	quiet: new Set(),
	writes: new Set(),
	rows: new Map(),
	wholesaled: false,
	settled: false
});

/**
 * Purges everything for a change no tag scopes: the generation moves, every stored page goes
 * stale and the fill queue takes the busiest. Once per run, so a first-run burst of option writes
 * costs one purge.
 */
export function wholesalePurge(
	site: SitePhpDurableObject,
	run: { wholesaled: boolean },
	reason: string
): void {
	site.wordpressTags ??= emptyStats();
	site.wordpressTags.wholesale += 1;
	site.wordpressTags.lastWholesale = { reason, at: site.nowMs() };
	if (run.wholesaled) return;
	run.wholesaled = true;
	site.bumpGeneration(`wp-${reason}`);
}

/**
 * Records tags a write invalidated, durably and before the run ends, the way Drupal's `cachetags`
 * write does: the pending set survives an invocation that dies, and the boot drain purges it.
 */
export function announceTags(site: SitePhpDurableObject, tags: readonly string[]): void {
	site.wordpressTags ??= emptyStats();
	site.wordpressTags.announced += tags.length;
	for (const tag of tags) site.invalidatedTags.add(tag);
	site.notePendingTags(tags);
	if (!site.bumpCoalesced) {
		site.bumpCoalesced = true;
		// moves the generation, which this response must carry, and purges nothing: the tag set is
		// incomplete until the run ends
		site.bumpGeneration('cachetags', {
			invalidatedTags: [...site.invalidatedTags],
			scopedTo: []
		});
	}
	site.spoolVector().stamp([...tags], site.generation());
}

/**
 * Whether a statement's reply says it changed something. A failed statement changed nothing, and
 * neither did a write MySQL reports as affecting no rows (WordPress's own check for an unchanged
 * option reads that count), so neither owes a purge.
 */
export function changed(reply: string): boolean {
	const parsed = JSON.parse(reply) as { ok?: unknown; kind?: unknown; affected?: unknown };
	return parsed.ok === true && !(parsed.kind === 'write' && Number(parsed.affected) === 0);
}

/** a stats object with every counter at zero */
export function emptyStats(): TagStats {
	return { announced: 0, wholesale: 0, floorPurges: 0, refused: 0, settles: 0 };
}

/**
 * Ends a run: a write to a content table that no announcement accounts for becomes a wholesale
 * purge, then the announced tags purge their pages.
 */
export function settleRun(site: SitePhpDurableObject, run: Run): void {
	if (run.settled) return;
	run.settled = true;
	site.wordpressTags ??= emptyStats();
	site.wordpressTags.settles += 1;
	const gaps = uncoveredWrites(run.writes, run.tags, run.quiet, run.wholesaled, run.rows);
	if (gaps.length > 0) {
		site.wordpressTags.floorPurges += 1;
		site.wordpressTags.lastFloor = { tables: gaps, at: site.nowMs() };
		wholesalePurge(site, run, `floor:${gaps.join(',')}`.slice(0, 48));
	}
	if (site.invalidatedTags.size > 0) site.flushTagPurge();
}

/**
 * Installs `cfwWpTags`, which carries the emitter's announcements to the object, and for a
 * WordPress site wraps `cfwMysqlExec` to see which content tables each run wrote.
 *
 * Installed for every CMS, as the MySQL bridge is: Drupal never calls it. The write observation
 * only runs for WordPress, and it never changes a statement's reply. It sits outside the bridge,
 * on the function the bridge installed, so the translator and the bridge are untouched.
 */
export function installTagBridge(
	site: SitePhpDurableObject,
	binary: SiteBinary,
	mysql: MysqlBridge
): TagBridge {
	const wordpress = cmsOf(site.env) === 'wordpress';
	let run = blank();

	const handle = (request: Announcement): Record<string, unknown> => {
		if (request.op === 'settle') {
			settleRun(site, run);
			return { ok: true };
		}
		if (request.op === 'quiet') {
			run.quiet.add(request.table);
			return { ok: true };
		}
		// a replica cannot take a write, so it has nothing to invalidate
		if (!wordpress || site.isReplica()) {
			site.wordpressTags ??= emptyStats();
			site.wordpressTags.refused += 1;
			return { ok: false, error: 'this object takes no WordPress invalidation' };
		}
		if (request.op === 'wholesale') {
			wholesalePurge(site, run, request.reason);
			return { ok: true };
		}
		for (const tag of request.tags) run.tags.add(tag);
		announceTags(site, request.tags);
		return { ok: true };
	};

	binary.cfwWpTags = (json: string) =>
		withMask(() => {
			let reply: Record<string, unknown>;
			try {
				const request = parseAnnouncement(decode(JSON.parse(json)));
				if (request === undefined) {
					site.wordpressTags ??= emptyStats();
					site.wordpressTags.refused += 1;
					reply = { ok: false, error: 'cfwWpTags refused a malformed request' };
				} else {
					reply = handle(request);
				}
			} catch (e) {
				reply = { ok: false, error: String((e as Error)?.message ?? e) };
			}
			return JSON.stringify(encode(reply));
		});

	if (wordpress) {
		const inner = binary.cfwMysqlExec as ((json: string) => string) | undefined;
		if (typeof inner === 'function') {
			binary.cfwMysqlExec = (json: string) => {
				const reply = inner(json);
				try {
					const request = decode(JSON.parse(json)) as { sql?: unknown } | null;
					if (typeof request?.sql === 'string') {
						const tables = writtenTables(request.sql);
						if (tables.length > 0 && changed(reply)) {
							for (const table of tables) run.writes.add(table);
							noteWrittenRows(
								run.rows,
								tables,
								writtenRows(request.sql, JSON.parse(reply) as { insertId?: number })
							);
						}
					}
				} catch {
					// seeing a statement must never change its answer
				}
				return reply;
			};
		}
	}

	return {
		beginRun() {
			// a run the interpreter never ended (a trap, an exit) is judged before the next begins
			if (wordpress && !run.settled && (run.writes.size > 0 || run.tags.size > 0)) {
				settleRun(site, run);
			}
			run = blank();
			mysql.beginRun();
		},
		endRun() {
			if (wordpress) settleRun(site, run);
		},
		session: () => mysql.session()
	};
}
