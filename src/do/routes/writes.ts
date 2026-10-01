import { DO_MAX_RECORD_BYTES, DO_MAX_STATEMENT_CHARS } from '../../db/export-sql';
import { drainMirrors, pendingMirrors } from '../../db/file-store';
import {
	amplification,
	chargeFactorsFromSchema,
	emptyTally,
	overheadShare,
	rankTally,
	splitChargedRows
} from '../../db/write-tally';
import {
	saveNode,
	WRITE_WORKLOADS,
	writeWorkload,
	type WriteWorkload
} from '../../drupal/site-php';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';
import { firstRow } from '../../util/sql';
import { mirrorLimit } from '../levers';
import type { Row } from '../types';

/**
 * Rows written per table: `?op=on` arms the tally, `?op=off` clears it, a bare call reports it.
 * Off by default because it allocates.
 */
export async function writes(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const op = url.searchParams.get('op');
	// widest value per table vs the record (2,199,995 bytes) and statement (100,000 chars) caps;
	// `length(hex(col)) / 2` because `length()` under-reports multi-byte TEXT
	if (op === 'widest') {
		const tables = site.sql
			.exec<Row<{ name: string }>>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			)
			.toArray()
			.map((r) => String(r.name));
		const widest: { table: string; column: string; bytes: number }[] = [];
		for (const table of tables) {
			const cols = site.sql
				.exec<Row<{ name: string }>>(`PRAGMA table_info("${table}")`)
				.toArray()
				.map((r) => String(r.name));
			for (const col of cols) {
				try {
					const row = firstRow(
						site.sql.exec<Row<{ n: number }>>(
							`SELECT max(length(hex("${col}")) / 2) AS n FROM "${table}"`
						)
					);
					const bytes = Number(row?.n ?? 0);
					if (bytes > 0) widest.push({ table, column: col, bytes });
				} catch {
					// a virtual or shadow table that refuses the scan is skipped
				}
			}
		}
		widest.sort((a, b) => b.bytes - a.bytes);
		const top = widest[0];
		return Response.json({
			ok: true,
			recordCap: DO_MAX_RECORD_BYTES,
			statementCap: DO_MAX_STATEMENT_CHARS,
			widest: widest.slice(0, 20),
			// a value is inlined as two hex chars per byte, so the statement ceiling bites at about
			// half the record ceiling
			exportable: (top?.bytes ?? 0) * 2 < DO_MAX_STATEMENT_CHARS,
			note: top
				? `widest value is ${top.table}.${top.column} at ${top.bytes} bytes`
				: 'no rows'
		});
	}
	if (op === 'on') {
		site.writeTally = emptyTally();
		return Response.json({ ok: true, tally: 'armed' });
	}
	if (op === 'off') {
		site.writeTally = undefined;
		return Response.json({ ok: true, tally: 'cleared' });
	}
	if (!site.writeTally) {
		return Response.json({
			ok: true,
			tally: 'not armed',
			how: 'GET /writes?op=on, drive a fill, then GET /writes'
		});
	}
	return Response.json({
		ok: true,
		statements: site.writeTally.statements,
		rowsWritten: site.writeTally.rowsWritten,
		ranked: rankTally(site.writeTally),
		statementsByTable: site.writeTally.statementsByTable,
		// names which statement made a route stateful, which no ratio of the other two counters can
		shapes: site.writeTally.shapes ?? {},
		amplification: amplification(site.writeTally),
		overheadShare: overheadShare(site.writeTally),
		// against this object's schema, not the pack's: a module enable creates tables no pack
		// contains
		indexSplit: splitChargedRows(
			site.writeTally.byTable,
			chargeFactorsFromSchema(site.sql, Object.keys(site.writeTally.byTable))
		),
		note: 'an ?unattributed share means writeTargetTable() is missing a form and the breakdown is not trustworthy'
	});
}

/**
 * Drives the R2 file offload by hand (the alarm also runs the drain).
 * `refused` counts queue rows the drain would not send (how the private-file rule is checked).
 */
export async function mirror(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const bucket = site.mirrorBucket();
	const limit = Number(url.searchParams.get('limit') ?? mirrorLimit(site.env));
	const left = bucket ? site.r2Allowance().left : 0;
	if (bucket && left === 0) {
		return Response.json({
			ok: true,
			budgetSpent: true,
			r2: site.r2Allowance(),
			pending: pendingMirrors(site.sql, 25),
			how: 'the R2 write budget is spent for this month; files serve from the object'
		});
	}
	const drained = await drainMirrors(site.sql, bucket, {
		limit: bucket ? Math.min(limit, left) : limit,
		site: site.siteName()
	});
	site.chargeR2(
		drained.mirrored + drained.deleted + drained.failed + drained.droppedAfterStrikes
	);
	return Response.json({
		ok: true,
		...drained,
		r2: bucket ? site.r2Allowance() : null,
		pending: pendingMirrors(site.sql, 25),
		how: bucket
			? 'bound; a pass ran'
			: 'no FILES bucket bound, which is the free-tier default -- the object is the durable copy'
	});
}

/**
 * The write-refresh loop: save a node, then re-render. Reports the generation either side: a
 * content save must bump it with nothing here calling `bumpGeneration()`.
 */
export async function savenode(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const genBefore = site.generation();
	const cachedBefore = Number(
		firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_page'))?.c ?? 0
	);
	const before = site.queryCount;
	const txnBefore = site.txnCount ?? 0;
	const txnStmtBefore = site.txnStatements ?? 0;
	const specBefore = site.txnSpeculative ?? 0;
	const skipBefore = site.txnSkippable ?? 0;
	const skipStmtBefore = site.txnSkippableStatements ?? 0;
	const t0 = Date.now();
	const php = await site.runJson(
		saveNode({
			title: url.searchParams.get('title') ?? undefined,
			type: url.searchParams.get('type') ?? undefined,
			body: url.searchParams.get('body') ?? undefined
		})
	);
	return Response.json({
		...php,
		wallMs: Date.now() - t0,
		hostStatementsTotal: site.queryCount - before,
		transactions: (site.txnCount ?? 0) - txnBefore,
		transactionStatements: (site.txnStatements ?? 0) - txnStmtBefore,
		speculativeReplays: (site.txnSpeculative ?? 0) - specBefore,
		skippableReplays: (site.txnSkippable ?? 0) - skipBefore,
		skippableStatements: (site.txnSkippableStatements ?? 0) - skipStmtBefore,
		generationBefore: genBefore,
		generationAfter: site.generation(),
		cfwPageRowsBefore: cachedBefore,
		cfwPageRowsAfter: Number(
			firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_page'))?.c ??
				0
		)
	});
}

/** one entity write priced on its own: statements, transactions and charged rows */
export async function writeworkload(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const op = String(url.searchParams.get('op') ?? 'node-create');
	if (!(WRITE_WORKLOADS as readonly string[]).includes(op)) {
		return jsonError(`unknown op ${op}`, 400, { known: WRITE_WORKLOADS });
	}
	const before = site.queryCount;
	const txnBefore = site.txnCount ?? 0;
	const specBefore = site.txnSpeculative ?? 0;
	// rows and bytes here; CPU comes from the platform meter, which is per-object
	const rowsBefore = site.dailyRows();
	const bytesBefore = Number(site.sql.databaseSize);
	const t0 = Date.now();
	const php = await site.runJson(
		writeWorkload(op as WriteWorkload, {
			seq: Number(url.searchParams.get('seq') ?? 0),
			nid: Number(url.searchParams.get('nid') ?? 0)
		})
	);
	const bytesAfter = Number(site.sql.databaseSize);
	return Response.json({
		...php,
		op,
		wallMs: Date.now() - t0,
		hostStatementsTotal: site.queryCount - before,
		transactions: (site.txnCount ?? 0) - txnBefore,
		speculativeReplays: (site.txnSpeculative ?? 0) - specBefore,
		chargedRows: site.dailyRows() - rowsBefore,
		databaseSizeBefore: bytesBefore,
		databaseSizeAfter: bytesAfter,
		databaseSizeDelta: bytesAfter - bytesBefore
	});
}

/** writes `rows` blobs of `size` bytes (and `spec` rolled-back speculations) and reads them back */
export async function txnprobe(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const rows = Math.max(1, Number(url.searchParams.get('rows') ?? 100));
	const size = Math.max(1, Number(url.searchParams.get('size') ?? 1024));
	if (rows * size > 512 * 1_048_576) {
		return jsonError('refusing to attempt over 512 MiB', 400);
	}
	const blob = 'x'.repeat(size);
	site.sql.exec('CREATE TABLE IF NOT EXISTS cfw_txn_probe (id INTEGER PRIMARY KEY, data TEXT)');
	site.sql.exec('DELETE FROM cfw_txn_probe');

	// `cfw_do_sqlite` answers a read against uncommitted writes by replaying them in
	// `transactionSync()` and throwing (an enable does 34 per event)
	const speculations = Math.max(0, Number(url.searchParams.get('spec') ?? 0));
	let rolledBack = 0;
	for (let i = 0; i < speculations; i++) {
		try {
			site.storage.transactionSync(() => {
				site.sql.exec('INSERT INTO cfw_txn_probe (data) VALUES (?)', `spec-${i}`);
				throw new Error('cfw speculative rollback');
			});
		} catch {
			rolledBack++;
		}
	}

	let written = 0;
	for (let i = 0; i < rows; i++) {
		site.sql.exec('INSERT INTO cfw_txn_probe (data) VALUES (?)', blob);
		written += size;
	}
	// read back inside the same event, so a silently-dropped write is not counted
	const seen = Number(
		firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_txn_probe'))?.c ??
			0
	);
	return Response.json({ ok: true, rows, size, written, seen, rolledBack });
}
