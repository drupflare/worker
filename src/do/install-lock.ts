import {
	LOCK_TABLE_SQL,
	type LockEntry,
	readLock,
	sessionId,
	skipReason,
	zipComment
} from '../ops/lock-install';
import {
	checkArchiveDigest,
	distOf,
	INSTALL_BATCH,
	type PackageAutoload,
	unpackZip
} from '../ops/package-install';
import { SHIPPED_CORE_VERSION, SHIPPED_LOCK_VERSIONS, SHIPPED_PROVIDES } from '../ops/shipped-lock';
import type { SitePhpDurableObject } from '../site-do';
import { BodyLimitExceeded, bodyLimitFor, readBounded } from '../site/guards';
import { errorMessage } from '../util/errors';
import { jsonError } from '../util/reply';
import { firstRow } from '../util/sql';
import { changeModuleFiles, trustedEntries } from './module-files';
import { storePackageFiles } from './packages';

type Session = {
	id: string;
	profile: string | null;
	total: number;
	state: string;
	cursor: number;
	extensions: number;
	cache: string | null;
};

type Ledger = {
	seq: number;
	package: string;
	version: string;
	state: string;
	detail: string;
	files: number;
	owned: number;
	prior_autoload: string | null;
};

const SHIPPED = {
	versions: SHIPPED_LOCK_VERSIONS,
	provides: SHIPPED_PROVIDES,
	core: SHIPPED_CORE_VERSION
};

function ensureTables(site: SitePhpDurableObject): void {
	for (const statement of LOCK_TABLE_SQL) site.sql.exec(statement);
}

function readSession(site: SitePhpDurableObject, id: string): Session | undefined {
	return firstRow(
		site.sql.exec<Session>(
			'SELECT id, profile, total, state, cursor, extensions, cache FROM cfw_lock_session WHERE id = ?',
			id
		)
	);
}

function ledgerRows(site: SitePhpDurableObject, id: string): Ledger[] {
	return site.sql
		.exec<Ledger>(
			`SELECT seq, package, version, state, detail, files, owned, prior_autoload
         FROM cfw_lock_package WHERE session = ? ORDER BY seq`,
			id
		)
		.toArray();
}

/** the answer a caller loops on: everything the session holds, so a repeat reads the same */
function report(site: SitePhpDurableObject, id: string, reached: number): Response {
	const session = readSession(site, id) as Session;
	const rows = ledgerRows(site, id);
	const installed = rows
		.filter((r) => r.state === 'installed' || r.state === 'reused')
		.map((r) => ({
			name: r.package,
			version: r.version,
			files: r.files,
			reused: r.state === 'reused',
			verified: r.detail
		}));
	const skipped = rows
		.filter((r) => r.state === 'skipped')
		.map((r) => ({ name: r.package, version: r.version, reason: r.detail }));
	const failed = rows
		.filter((r) => r.state === 'failed')
		.map((r) => ({ name: r.package, version: r.version, error: r.detail }));
	const done = session.state === 'done';
	return Response.json(
		{
			ok: failed.length === 0,
			session: id,
			done,
			cursor: reached,
			total: session.total,
			profile: session.profile,
			installed,
			skipped,
			failed,
			patches: 'not applied',
			cache: session.cache
		},
		{ status: failed.length === 0 ? 200 : 502 }
	);
}

/** fetches, verifies and stores one package; the session row and ledger move with the files */
async function fetchOne(
	site: SitePhpDurableObject,
	id: string,
	seq: number,
	entry: LockEntry
): Promise<{ ok: true } | { ok: false; error: string }> {
	const dist = distOf(entry.raw, entry.name);
	if (dist === undefined)
		return { ok: false, error: `${entry.name} has no downloadable archive` };
	if (dist.type !== 'zip') {
		return { ok: false, error: `${entry.name} ships a ${dist.type}, which is not read here` };
	}
	const archive = await fetch(dist.url, { headers: { 'user-agent': 'drupflare' } });
	if (!archive.ok) return { ok: false, error: `archive ${archive.status} from ${dist.url}` };
	const bytes = new Uint8Array(await archive.arrayBuffer());
	const checked = await checkArchiveDigest(dist, bytes);
	if (!checked.ok) return { ok: false, error: checked.error };
	let label = checked.verified ? (checked.digest ?? 'verified') : 'unverified';
	const reference = String(
		((entry.raw['dist'] ?? {}) as { reference?: unknown }).reference ?? ''
	).toLowerCase();
	if (!checked.verified && /^[0-9a-f]{40}$/.test(reference)) {
		const recorded = zipComment(bytes)?.trim().toLowerCase();
		if (recorded !== undefined && /^[0-9a-f]{40}$/.test(recorded)) {
			if (recorded !== reference) {
				return {
					ok: false,
					error: `${entry.name} archive is commit ${recorded} and the lock names ${reference}, so it is not installed`
				};
			}
			label = `commit:${reference}`;
		}
	}
	const unpacked = unpackZip(bytes, dist.mount);
	if (unpacked.files.some((f) => f.path.split('/').includes('..'))) {
		return { ok: false, error: `${entry.name} archive holds a path that leaves its mount` };
	}
	const autoload = (entry.raw['autoload'] ?? {}) as PackageAutoload['autoload'];
	const extension = /^(modules|themes|profiles)\//.test(dist.mount);
	site.storage.transactionSync(() => {
		const prior = new Map<
			string,
			{ path: string; package: string; version: string; source: string }
		>();
		const held = site.sql
			.exec<{ path: string; package: string; version: string; source: string }>(
				'SELECT path, package, version, source FROM cfw_module_file WHERE package = ?',
				entry.name
			)
			.toArray();
		for (const row of held) prior.set(String(row.path), row);
		for (const file of unpacked.files) {
			const row = firstRow(
				site.sql.exec<{ path: string; package: string; version: string; source: string }>(
					'SELECT path, package, version, source FROM cfw_module_file WHERE path = ?',
					file.path
				)
			);
			if (row !== undefined) prior.set(String(row.path), row);
		}
		const trusted = new Set(
			trustedEntries(
				site,
				[...prior.values()].map((r) => [String(r.path), String(r.source)] as const)
			).map(([path]) => path)
		);
		for (const row of prior.values()) {
			if (!trusted.has(String(row.path))) continue;
			site.sql.exec(
				`INSERT OR IGNORE INTO cfw_lock_undo (session, path, package, version, source)
           VALUES (?, ?, ?, ?, ?)`,
				id,
				row.path,
				row.package,
				row.version,
				row.source
			);
		}
		const priorAutoload = firstRow(
			site.sql.exec<{
				package: string;
				version: string;
				mount: string;
				autoload: string;
				classmap: string;
			}>(
				'SELECT package, version, mount, autoload, classmap FROM cfw_package_autoload WHERE package = ?',
				entry.name
			)
		);
		storePackageFiles(site, entry.name, dist, autoload, unpacked, false);
		site.sql.exec(
			`INSERT OR REPLACE INTO cfw_lock_package
           (session, seq, package, version, digest, state, detail, files, owned, prior_autoload)
         VALUES (?, ?, ?, ?, ?, 'installed', ?, ?, 1, ?)`,
			id,
			seq,
			entry.name,
			entry.version,
			entry.digest,
			label,
			unpacked.files.length,
			priorAutoload === undefined ? null : JSON.stringify(priorAutoload)
		);
		if (extension) {
			site.sql.exec('UPDATE cfw_lock_session SET extensions = 1 WHERE id = ?', id);
		}
		site.rowsSinceFlush = (site.rowsSinceFlush ?? 0) + prior.size + 2;
	});
	return { ok: true };
}

function note(
	site: SitePhpDurableObject,
	id: string,
	seq: number,
	entry: LockEntry,
	state: 'skipped' | 'reused' | 'failed',
	detail: string,
	files = 0
): void {
	site.sql.exec(
		`INSERT OR REPLACE INTO cfw_lock_package
         (session, seq, package, version, digest, state, detail, files, owned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id,
		seq,
		entry.name,
		entry.version,
		entry.digest,
		state,
		detail,
		files
	);
	site.rowsSinceFlush = (site.rowsSinceFlush ?? 0) + 1;
}

/** a package this site already holds at the locked version and digest, by an earlier ledger row */
function alreadyHeld(site: SitePhpDurableObject, entry: LockEntry): number | undefined {
	const hit = firstRow(
		site.sql.exec<{ files: number }>(
			`SELECT files FROM cfw_lock_package
         WHERE package = ? AND version = ? AND digest = ? AND state = 'installed' AND owned = 1
         LIMIT 1`,
			entry.name,
			entry.version,
			entry.digest
		)
	);
	if (hit === undefined) return undefined;
	const files = Number(hit.files);
	if (files === 0) return 0;
	const rows = firstRow(
		site.sql.exec<{ n: number }>(
			'SELECT 1 AS n FROM cfw_module_file WHERE package = ? AND version = ? LIMIT 1',
			entry.name,
			entry.version
		)
	);
	return rows === undefined ? undefined : files;
}

/** drops the compiled container once, after the last package, and records that it did */
function finish(site: SitePhpDurableObject, id: string): void {
	const session = readSession(site, id) as Session;
	if (session.cache !== null) return;
	const cache = session.extensions === 1 ? 'compiled container dropped' : 'nothing to drop';
	if (session.extensions === 1) site.dropCompiledContainer();
	site.php = undefined;
	site.sql.exec(
		"UPDATE cfw_lock_session SET state = 'done', cache = ?, updated_at = ? WHERE id = ?",
		cache,
		site.nowMs(),
		id
	);
}

/** installs one window of a lock and answers with the session's state */
export async function installLockPost(
	site: SitePhpDurableObject,
	request: Request
): Promise<Response> {
	let body: unknown;
	try {
		const raw = await readBounded(request, bodyLimitFor(request, site.env));
		body = JSON.parse(new TextDecoder().decode(raw));
	} catch (e) {
		if (e instanceof BodyLimitExceeded) return jsonError(e.message, 413);
		return jsonError('the body is not JSON', 400);
	}
	const lock = readLock(body, SHIPPED);
	if (!lock.ok) return jsonError(lock.error, lock.status, lock.extra);
	site.ensureServeTables();
	ensureTables(site);
	const id = await sessionId(lock.packages);
	let session = readSession(site, id);
	if (session !== undefined && session.state === 'rolled-back') {
		site.sql.exec('DELETE FROM cfw_lock_session WHERE id = ?', id);
		session = undefined;
	}
	if (session === undefined) {
		const now = site.nowMs();
		site.sql.exec(
			`INSERT INTO cfw_lock_session (id, profile, total, state, cursor, created_at, updated_at)
         VALUES (?, ?, ?, 'open', 0, ?, ?)`,
			id,
			lock.profile,
			lock.packages.length,
			now,
			now
		);
		session = readSession(site, id) as Session;
	}
	if (lock.cursor > session.cursor) {
		return jsonError(
			`cursor ${lock.cursor} is ahead of the session, which is at ${session.cursor}`,
			409,
			{
				session: id,
				cursor: session.cursor
			}
		);
	}
	const end = Math.min(lock.cursor + INSTALL_BATCH, lock.packages.length);
	const held = new Map(ledgerRows(site, id).map((r) => [r.seq, r]));
	let reached = end;
	for (let seq = lock.cursor; seq < end; seq++) {
		const entry = lock.packages[seq] as LockEntry;
		const prior = held.get(seq);
		if (prior !== undefined && prior.state !== 'failed') continue;
		const skip = skipReason(entry, SHIPPED);
		if (skip !== undefined) {
			note(site, id, seq, entry, 'skipped', skip);
			continue;
		}
		const files = alreadyHeld(site, entry);
		if (files !== undefined) {
			note(site, id, seq, entry, 'reused', 'already installed at the locked version', files);
			continue;
		}
		let outcome: { ok: true } | { ok: false; error: string };
		try {
			outcome = await fetchOne(site, id, seq, entry);
		} catch (e) {
			outcome = { ok: false, error: errorMessage(e) };
		}
		if (!outcome.ok) {
			note(site, id, seq, entry, 'failed', outcome.error);
			site.sql.exec("UPDATE cfw_lock_session SET state = 'failed' WHERE id = ?", id);
			reached = seq;
			break;
		}
	}
	site.php = undefined;
	const next = Math.max(session.cursor, reached);
	const failed = reached < end;
	site.sql.exec(
		`UPDATE cfw_lock_session SET cursor = ?, updated_at = ?${failed ? '' : ", state = CASE WHEN state = 'done' THEN state ELSE 'open' END"}
       WHERE id = ?`,
		next,
		site.nowMs(),
		id
	);
	if (!failed && next >= lock.packages.length) finish(site, id);
	return report(site, id, reached);
}

/** removes what a session wrote and puts back the rows it replaced */
export function installLockRollback(site: SitePhpDurableObject, id: string): Response {
	site.ensureServeTables();
	ensureTables(site);
	const session = readSession(site, id);
	if (session === undefined) return jsonError('no such session', 404, { session: id });
	if (session.state === 'rolled-back') {
		return Response.json({ ok: true, session: id, rolledBack: true, removed: 0, restored: 0 });
	}
	const owned = ledgerRows(site, id).filter((r) => r.owned === 1);
	const undo = site.sql
		.exec<{ path: string; package: string; version: string; source: string }>(
			'SELECT path, package, version, source FROM cfw_lock_undo WHERE session = ?',
			id
		)
		.toArray();
	const now = site.nowMs();
	site.storage.transactionSync(() => {
		for (const row of owned.reverse()) {
			changeModuleFiles(site, row.package, { clear: true, installedAt: now });
			site.sql.exec('DELETE FROM cfw_package_autoload WHERE package = ?', row.package);
			if (row.prior_autoload !== null) {
				const a = JSON.parse(row.prior_autoload) as Record<string, string>;
				site.sql.exec(
					`INSERT INTO cfw_package_autoload (package, version, mount, autoload, classmap)
             VALUES (?, ?, ?, ?, ?)`,
					a['package'],
					a['version'],
					a['mount'],
					a['autoload'],
					a['classmap']
				);
			}
		}
		const byOwner = new Map<string, { path: string; version: string; source: string }[]>();
		for (const row of undo) {
			const list = byOwner.get(String(row.package)) ?? [];
			list.push({
				path: String(row.path),
				version: String(row.version),
				source: String(row.source)
			});
			byOwner.set(String(row.package), list);
		}
		for (const [owner, put] of byOwner)
			changeModuleFiles(site, owner, { put, installedAt: now });
		site.sql.exec('DELETE FROM cfw_lock_package WHERE session = ?', id);
		site.sql.exec('DELETE FROM cfw_lock_undo WHERE session = ?', id);
		site.sql.exec(
			"UPDATE cfw_lock_session SET state = 'rolled-back', cursor = 0, cache = NULL, updated_at = ? WHERE id = ?",
			now,
			id
		);
		site.rowsSinceFlush = (site.rowsSinceFlush ?? 0) + owned.length + undo.length + 3;
	});
	if (session.extensions === 1) site.dropCompiledContainer();
	site.php = undefined;
	return Response.json({
		ok: true,
		session: id,
		rolledBack: true,
		removed: owned.length,
		restored: undo.length
	});
}
