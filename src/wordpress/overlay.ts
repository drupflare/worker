import { type LazyFS, mkdirp } from '@drupflare/cartridge/fs';
import { withMask } from '@drupflare/cartridge/mask';
import type { LazyInstalledNode } from '../do/lazy-mount';
import { trustsModuleFiles } from '../do/replica/role';
import type { SiteBinary } from '../do/types';
import {
	digestBytes,
	emptyIntegrityStats,
	noteRefusal,
	readPackageRecords,
	recordMatches,
	writePackageRecords
} from '../ops/module/integrity';
import { OWNER_HASH_KEY } from '../ops/site/secrets';
import type { SitePhpDurableObject } from '../site-do';
import { firstRow } from '../util/sql';
import { contentFolder, type WpKind } from './registry';
import type { ZipFile } from './zip';

/** `cfw_meta` key holding the manifest of delivered packages */
export const OVERLAY_KEY = 'wp_overlay';

/** one stored version of a package: its rows share `gen`, and its files are listed by size */
export interface WpGeneration {
	gen: number;
	version: string;
	/** the digest of the archive it came from */
	digest: string;
	at: number;
	files: [path: string, bytes: number][];
}

/** what a package holds: the version the tree mounts, and the one a rollback restores */
export interface WpPackageState {
	active?: WpGeneration;
	previous?: WpGeneration;
	/** the generation number the next delivery takes */
	next: number;
}

/** every package the host delivered, by `kind:slug` */
export interface WpOverlayManifest {
	v: 1;
	packages: Record<string, WpPackageState>;
}

/** the operations that leave a receipt */
export type WpOp = 'install' | 'update' | 'rollback' | 'delete';

/** the record an operation leaves: what changed, from which digest, to which */
export interface WpReceipt {
	id: number;
	at: number;
	op: WpOp;
	kind: WpKind;
	slug: string;
	fromVersion: string | null;
	fromDigest: string | null;
	toVersion: string | null;
	toDigest: string | null;
	files: number;
	detail: string;
}

/** the manifest key of a package */
export const overlayKey = (kind: WpKind, slug: string): string => `${kind}:${slug}`;

const recordName = (kind: WpKind, slug: string): string => `wp:${overlayKey(kind, slug)}`;

/** a copy of the bytes as the ArrayBuffer a Durable Object binds */
function buffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** the manifest, empty when nothing was ever delivered */
export function readOverlay(site: SitePhpDurableObject): WpOverlayManifest {
	const raw = site.metaRowGet(OVERLAY_KEY);
	if (raw === null) return { v: 1, packages: {} };
	try {
		const parsed = JSON.parse(raw) as WpOverlayManifest;
		if (parsed.v === 1 && parsed.packages !== undefined) return parsed;
	} catch {
		// a manifest that does not parse delivers nothing, which is the safe reading
	}
	return { v: 1, packages: {} };
}

function ensureTables(site: SitePhpDurableObject): void {
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_wp_file (
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        gen INTEGER NOT NULL,
        path TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (kind, slug, gen, path)
      ) WITHOUT ROWID`
	);
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_wp_receipt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        op TEXT NOT NULL,
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        from_version TEXT,
        from_digest TEXT,
        to_version TEXT,
        to_digest TEXT,
        files INTEGER NOT NULL,
        detail TEXT NOT NULL
      )`
	);
}

function writeReceipt(site: SitePhpDurableObject, r: Omit<WpReceipt, 'id'>): WpReceipt {
	site.sql.exec(
		`INSERT INTO cfw_wp_receipt
       (at, op, kind, slug, from_version, from_digest, to_version, to_digest, files, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.at,
		r.op,
		r.kind,
		r.slug,
		r.fromVersion,
		r.fromDigest,
		r.toVersion,
		r.toDigest,
		r.files,
		r.detail
	);
	const id = firstRow(site.sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id'));
	return { id: Number(id?.id ?? 0), ...r };
}

/** the receipts, newest first; empty before the first operation */
export function readReceipts(site: SitePhpDurableObject, limit = 50): WpReceipt[] {
	try {
		return site.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT id, at, op, kind, slug, from_version, from_digest, to_version, to_digest, files, detail
         FROM cfw_wp_receipt ORDER BY id DESC LIMIT ?`,
				limit
			)
			.toArray()
			.map((row) => ({
				id: Number(row.id),
				at: Number(row.at),
				op: String(row.op) as WpOp,
				kind: String(row.kind) as WpKind,
				slug: String(row.slug),
				fromVersion: row.from_version === null ? null : String(row.from_version),
				fromDigest: row.from_digest === null ? null : String(row.from_digest),
				toVersion: row.to_version === null ? null : String(row.to_version),
				toDigest: row.to_digest === null ? null : String(row.to_digest),
				files: Number(row.files),
				detail: String(row.detail)
			}));
	} catch (e) {
		if (/no such table/i.test(String((e as Error).message))) return [];
		throw e;
	}
}

/** the sealed records of one package, rewritten to hold exactly the given generations */
function sealGenerations(
	site: SitePhpDurableObject,
	kind: WpKind,
	slug: string,
	held: readonly WpGeneration[],
	added?: { gen: number; files: readonly ZipFile[] }
): void {
	const store = site.secretStore().sealed;
	const keep = new Set(held.map((g) => `${g.gen}/`));
	const records = new Map<string, string>();
	for (const [path, hash] of readPackageRecords(store, recordName(kind, slug))) {
		if (keep.has(`${path.split('/')[0]}/`)) records.set(path, hash);
	}
	for (const file of added?.files ?? []) {
		records.set(`${added?.gen}/${file.path}`, digestBytes(file.bytes));
	}
	writePackageRecords(store, recordName(kind, slug), records);
}

/** the generations a state still holds, newest first */
const heldGenerations = (state: WpPackageState): WpGeneration[] =>
	[state.active, state.previous].filter((g): g is WpGeneration => g !== undefined);

/** what a delivery needs to commit: the verified files and where they came from */
export interface Delivery {
	kind: WpKind;
	slug: string;
	version: string;
	digest: string;
	files: readonly ZipFile[];
	now: number;
}

/**
 * Stores a verified package as a new generation and makes it the active one, in one transaction.
 *
 * The rows, the sealed records, the manifest and the receipt commit together or not at all, so a
 * failure at any point leaves the old version mounted and no row of the new one that anything
 * reads. The generation that was active becomes the previous one, and the one before that is
 * dropped. Rows of a generation the manifest does not name are removed first, which is how a
 * crashed earlier attempt is cleaned up.
 */
export function commitDelivery(site: SitePhpDurableObject, d: Delivery): WpReceipt {
	return site.storage.transactionSync(() => {
		ensureTables(site);
		const manifest = readOverlay(site);
		const key = overlayKey(d.kind, d.slug);
		const state = manifest.packages[key] ?? { next: 1 };
		const live = heldGenerations(state).map((g) => g.gen);
		site.sql.exec(
			`DELETE FROM cfw_wp_file WHERE kind = ? AND slug = ? AND gen NOT IN (${['-1', ...live].join(',')})`,
			d.kind,
			d.slug
		);
		const gen = state.next;
		for (const file of d.files) {
			site.sql.exec(
				'INSERT INTO cfw_wp_file (kind, slug, gen, path, bytes) VALUES (?, ?, ?, ?, ?)',
				d.kind,
				d.slug,
				gen,
				file.path,
				buffer(file.bytes)
			);
		}
		const fresh: WpGeneration = {
			gen,
			version: d.version,
			digest: d.digest,
			at: d.now,
			files: d.files.map((f) => [f.path, f.bytes.length])
		};
		if (state.previous !== undefined) {
			site.sql.exec(
				'DELETE FROM cfw_wp_file WHERE kind = ? AND slug = ? AND gen = ?',
				d.kind,
				d.slug,
				state.previous.gen
			);
		}
		const after: WpPackageState = { active: fresh, previous: state.active, next: gen + 1 };
		sealGenerations(site, d.kind, d.slug, heldGenerations(after), { gen, files: d.files });
		manifest.packages[key] = after;
		site.metaRowSet(OVERLAY_KEY, JSON.stringify(manifest));
		return writeReceipt(site, {
			at: d.now,
			op: state.active === undefined ? 'install' : 'update',
			kind: d.kind,
			slug: d.slug,
			fromVersion: state.active?.version ?? null,
			fromDigest: state.active?.digest ?? null,
			toVersion: d.version,
			toDigest: d.digest,
			files: d.files.length,
			detail: ''
		});
	});
}

/**
 * Swaps the active and previous generations, which is one write. After a delete there is no active
 * generation, so a rollback brings the deleted version back. A second rollback undoes the first.
 */
export function rollbackDelivery(
	site: SitePhpDurableObject,
	kind: WpKind,
	slug: string,
	now: number
): WpReceipt | { error: string } {
	return site.storage.transactionSync(() => {
		const manifest = readOverlay(site);
		const key = overlayKey(kind, slug);
		const state = manifest.packages[key];
		if (state?.previous === undefined) {
			return { error: `${slug} has no earlier version to restore` };
		}
		const after: WpPackageState = {
			active: state.previous,
			previous: state.active,
			next: state.next
		};
		manifest.packages[key] = after;
		site.metaRowSet(OVERLAY_KEY, JSON.stringify(manifest));
		return writeReceipt(site, {
			at: now,
			op: 'rollback',
			kind,
			slug,
			fromVersion: state.active?.version ?? null,
			fromDigest: state.active?.digest ?? null,
			toVersion: state.previous.version,
			toDigest: state.previous.digest,
			files: state.previous.files.length,
			detail: ''
		});
	});
}

/**
 * Takes the active generation out of the tree and keeps it as the previous one, so a rollback
 * restores it. Nothing is deleted: the data a plugin keeps in WordPress tables stays too.
 */
export function retireDelivery(
	site: SitePhpDurableObject,
	kind: WpKind,
	slug: string,
	now: number,
	detail: string
): WpReceipt | { error: string } {
	return site.storage.transactionSync(() => {
		const manifest = readOverlay(site);
		const key = overlayKey(kind, slug);
		const state = manifest.packages[key];
		if (state?.active === undefined) return { error: `${slug} was not delivered by the host` };
		if (state.previous !== undefined) {
			site.sql.exec(
				'DELETE FROM cfw_wp_file WHERE kind = ? AND slug = ? AND gen = ?',
				kind,
				slug,
				state.previous.gen
			);
		}
		const after: WpPackageState = { previous: state.active, next: state.next };
		sealGenerations(site, kind, slug, heldGenerations(after));
		manifest.packages[key] = after;
		site.metaRowSet(OVERLAY_KEY, JSON.stringify(manifest));
		return writeReceipt(site, {
			at: now,
			op: 'delete',
			kind,
			slug,
			fromVersion: state.active.version,
			fromDigest: state.active.digest,
			toVersion: null,
			toDigest: null,
			files: state.active.files.length,
			detail
		});
	});
}

/** removes a directory and everything under it from the interpreter's filesystem */
function removeTree(FS: LazyFS, path: string): void {
	const fs = FS as unknown as {
		readdir(p: string): string[];
		stat(p: string): { mode: number };
		unlink(p: string): void;
		rmdir(p: string): void;
	};
	let names: string[];
	try {
		names = fs.readdir(path);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === '.' || name === '..') continue;
		const child = `${path}/${name}`;
		if ((fs.stat(child).mode & 0o170000) === 0o040000) removeTree(FS, child);
		else fs.unlink(child);
	}
	fs.rmdir(path);
}

/**
 * Mounts every active delivered package over the base tree, each file read from its row on first
 * open. A package that shares its folder with one in the pack replaces it whole, so a file the new
 * version dropped is gone too.
 *
 * Only the manifest is read at boot: one row, however many files. On a claimed site each file is
 * hashed when first opened and compared with its sealed record, and one that does not match reads
 * as empty, which is the check `mountInstalledModules` makes for the Drupal tree. Nodes stay
 * resident for the request, since a WordPress interpreter serves one request.
 *
 * @returns the number of files mounted
 */
export function mountOverlay(site: SitePhpDurableObject, binary: SiteBinary, root: string): number {
	const manifest = readOverlay(site);
	const active = Object.entries(manifest.packages).filter(([, s]) => s.active !== undefined);
	if (active.length === 0) return 0;
	const FS = binary.FS as unknown as LazyFS;
	const store = site.secretStore().sealed;
	const stats = (site.moduleIntegrity ??= emptyIntegrityStats());
	const claimed = (store.get(OWNER_HASH_KEY) ?? '') !== '';
	const enforcing = claimed && !trustsModuleFiles(site);
	const records = new Map<string, Map<string, string>>();
	// read through the current owner, since the instance that mounted may be evicted by first open
	const owner = site.phpOwner ?? { current: site };

	mkdirp(binary.FS, root);
	FS.writeFile(`${root}/.cfw-overlay-probe`, new Uint8Array(1));
	const probe = FS.lookupPath(`${root}/.cfw-overlay-probe`).node as unknown as LazyInstalledNode;
	const base = probe.stream_ops;
	const nodeOps = probe.node_ops;
	FS.unlink(`${root}/.cfw-overlay-probe`);

	type Node = LazyInstalledNode & { cfwKind: WpKind; cfwSlug: string; cfwGen: number };
	const load = (node: Node): void => {
		if (node.cfwLoaded) return;
		withMask(() => {
			const row = firstRow(
				owner.current.sql.exec<{ bytes: ArrayBuffer }>(
					'SELECT bytes FROM cfw_wp_file WHERE kind = ? AND slug = ? AND gen = ? AND path = ?',
					node.cfwKind,
					node.cfwSlug,
					node.cfwGen,
					node.cfwRow
				)
			);
			const bytes = row === undefined ? new Uint8Array(0) : new Uint8Array(row.bytes);
			let allowed = true;
			if (enforcing) {
				const name = recordName(node.cfwKind, node.cfwSlug);
				let held = records.get(name);
				if (held === undefined) records.set(name, (held = readPackageRecords(store, name)));
				stats.checked++;
				allowed = recordMatches(
					held.get(`${node.cfwGen}/${node.cfwRow}`),
					digestBytes(bytes)
				);
				if (!allowed) {
					noteRefusal(
						stats,
						`${name}/${node.cfwRow}`,
						held.has(`${node.cfwGen}/${node.cfwRow}`)
							? 'bytes differ from the record'
							: 'no record'
					);
				}
			}
			node.contents = allowed ? bytes : new Uint8Array(0);
			node.usedBytes = node.contents.length;
			node.cfwLoaded = true;
		});
	};
	const ops = {
		...base,
		llseek(stream: { node: Node }, ...rest: unknown[]) {
			load(stream.node);
			return (base.llseek as (...a: unknown[]) => number)(stream, ...rest);
		},
		read(stream: { node: Node }, ...rest: unknown[]) {
			load(stream.node);
			return (base.read as (...a: unknown[]) => number)(stream, ...rest);
		},
		mmap(stream: { node: Node }, ...rest: unknown[]) {
			load(stream.node);
			return (base.mmap as (...a: unknown[]) => unknown)(stream, ...rest);
		}
	};

	let mounted = 0;
	for (const [key, state] of active) {
		const [kind, slug] = key.split(':') as [WpKind, string];
		const generation = state.active as WpGeneration;
		const folder = `${root}/wp-content/${contentFolder(kind)}/${slug}`;
		removeTree(FS, folder);
		for (const [path, size] of generation.files) {
			const target = `${folder}/${path}`;
			try {
				mkdirp(binary.FS, target.slice(0, target.lastIndexOf('/')));
				const node = FS.create(target, 0o100000 | 0o444) as unknown as Node;
				node.node_ops = nodeOps;
				node.stream_ops = ops;
				node.cfwRow = path;
				node.cfwKind = kind;
				node.cfwSlug = slug;
				node.cfwGen = generation.gen;
				node.cfwLoaded = false;
				node.usedBytes = size;
				node.contents = null;
				node.timestamp = generation.at;
				mounted++;
			} catch {
				// one unmountable file must not take the boot down; WordPress names what is missing
			}
		}
	}
	return mounted;
}
