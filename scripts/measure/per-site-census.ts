import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What TWO fresh sites cost each other: the seed database, the mounted file tree, and the strings.
 *
 * `bun scripts/measure/per-site-census.ts` (add `--keep` to leave the emitted probe in place)
 *
 * Both questions need the same expensive thing, a real booted site twice. Rows and MEMFS nodes are
 * compared as multisets the way `snapshot-dedup.spec.ts` compares pages.
 *
 * The probe is EMITTED into `experiments/` rather than committed to `tests/`: a two-site boot is
 * minutes of wall clock and nothing here is a gate assertion. Every number is a count, never a
 * duration.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const PROBE = resolve(ROOT, 'experiments/per-site-census.probe.spec.ts');
const CONFIG = resolve(ROOT, 'experiments/per-site-census.vitest.config.ts');

const CONFIG_SOURCE = `import base from '../vitest.config.js';

const cfg = base as unknown as { test: { projects: Array<Record<string, any>> } };
const workers = cfg.test.projects[0]!;
workers.test.include = ['experiments/*.probe.spec.ts'];
workers.test.exclude = [];
workers.test.maxWorkers = 1;
workers.test.testTimeout = 1_800_000;

export default { root: '${ROOT}', test: { projects: [workers] } };
`;

const PROBE_SOURCE = String.raw`import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../src/drupal/site-php';
import { freshSite, inObject, queuePath, type ServeDo } from '../tests/helpers/serve-do';
import {
	STRING_LAYOUTS,
	censusStrings,
	pageCensus,
	printableRunBytes,
	type StringCensus
} from '../scripts/measure/heap-strings';

// the DO surface this probe reaches past ServeDo for; every member is real on SitePhpDurableObject
type Deep = ServeDo & {
	php: { binary: Record<string, any> } | null;
	mountInfo: Record<string, any> | null;
	heapBytes: (binary: unknown) => Uint8Array | null;
	installedModuleFiles?: unknown;
};

type RowIndex = { digests: Map<number, number>; rows: number; bytes: number; tables: number };

function fnv(seed: number, bytes: ArrayLike<number>, len: number): number {
	let h = seed >>> 0;
	for (let i = 0; i < len; i++) h = Math.imul(h ^ (bytes[i] as number), 0x01000193) >>> 0;
	return h >>> 0;
}

function textBytes(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

/** one row as a 53-bit key over its table name and every column value */
function rowKey(table: string, row: Record<string, unknown>): { key: number; bytes: number } {
	let a = fnv(0x811c9dc5, textBytes(table), table.length);
	let b = 0x01000193;
	let bytes = 0;
	for (const name of Object.keys(row).sort()) {
		const nb = textBytes(name);
		a = fnv(a, nb, nb.length);
		const v = row[name];
		if (v === null || v === undefined) {
			a = Math.imul(a ^ 0x9e, 0x01000193) >>> 0;
		} else if (typeof v === 'string') {
			const sb = textBytes(v);
			bytes += sb.length;
			a = fnv(a, sb, sb.length);
			b = Math.imul(b ^ sb.length, 0x85ebca6b) >>> 0;
		} else if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
			const u = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array((v as any).buffer, (v as any).byteOffset, (v as any).byteLength);
			bytes += u.length;
			a = fnv(a, u, u.length);
			b = Math.imul(b ^ u.length, 0x85ebca6b) >>> 0;
		} else {
			const sb = textBytes(String(v));
			bytes += 8;
			a = fnv(a, sb, sb.length);
		}
	}
	return { key: (a >>> 5) * 0x4000000 + (b >>> 6), bytes };
}

/** every row in every non-platform table, as a digest multiset */
function dbCensus(site: Deep): RowIndex & { size: number; perTable: Record<string, [number, number]> } {
	const names = site.sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.toArray()
		.map((r) => String(r.name))
		// _cf_* is the platform's own bookkeeping and is not a property of the site
		.filter((n) => !n.startsWith('_cf_'));

	const digests = new Map<number, number>();
	const byTable = new Map<string, Map<number, number>>();
	let rows = 0;
	let bytes = 0;
	const perTable: Record<string, [number, number]> = {};
	for (const t of names) {
		let tRows = 0;
		let tBytes = 0;
		const tDigests = new Map<number, number>();
		for (const row of site.sql.exec('SELECT * FROM "' + t + '"').toArray()) {
			const { key, bytes: rb } = rowKey(t, row);
			digests.set(key, (digests.get(key) ?? 0) + 1);
			tDigests.set(key, (tDigests.get(key) ?? 0) + 1);
			tRows++;
			tBytes += rb;
		}
		byTable.set(t, tDigests);
		rows += tRows;
		bytes += tBytes;
		perTable[t] = [tRows, tBytes];
	}
	return {
		digests,
		byTable,
		rows,
		bytes,
		tables: names.length,
		size: Number((site.sql as unknown as { databaseSize: number }).databaseSize ?? 0),
		perTable
	};
}

type FileEntry = { path: string; size: number; packLen: number | null; dirty: boolean; loaded: boolean };

/**
 * The mounted tree as NODES, never as contents: reading a file inflates it, and walking 12k of
 * them would materialise 39 MB inside a 128 MiB isolate and measure the walk rather than the site.
 */
function fileCensus(site: Deep): { files: FileEntry[]; totalBytes: number; divergent: FileEntry[] } {
	const FS = (site.php as any).binary.FS;
	const files: FileEntry[] = [];
	const visit = (node: any, path: string): void => {
		if (FS.isDir(node.mode)) {
			for (const name of Object.keys(node.contents ?? {})) {
				visit(node.contents[name], path + '/' + name);
			}
			return;
		}
		const entry = node.cfwEntry as { l?: number } | undefined;
		files.push({
			path,
			size: Number(node.usedBytes ?? 0),
			packLen: entry?.l ?? null,
			dirty: node.cfwDirty === true,
			loaded: node.contents !== null && node.contents !== undefined
		});
	};
	visit(FS.lookupPath('/drupal').node, '/drupal');
	let totalBytes = 0;
	for (const f of files) totalBytes += f.size;
	// a node the pack did not put there, or one PHP has written, is what this site does not share
	const divergent = files.filter((f) => f.dirty || f.packLen === null);
	return { files, totalBytes, divergent };
}

/** digests only the files that already diverged, which is a handful rather than the tree */
function divergentDigests(site: Deep, entries: FileEntry[]): Record<string, number> {
	const FS = (site.php as any).binary.FS;
	const out: Record<string, number> = {};
	for (const e of entries) {
		try {
			const bytes = FS.readFile(e.path) as Uint8Array;
			out[e.path] = fnv(0x811c9dc5, bytes, bytes.length);
		} catch {
			out[e.path] = -1;
		}
	}
	return out;
}

type Reading = {
	label: string;
	seedDb: ReturnType<typeof dbCensus>;
	warmDb: ReturnType<typeof dbCensus>;
	tree: ReturnType<typeof fileCensus>;
	divergentDigest: Record<string, number>;
	mount: Record<string, unknown>;
	heap: Record<string, HeapReading>;
};

type HeapReading = {
	pages: ReturnType<typeof pageCensus>;
	runs: ReturnType<typeof printableRunBytes>;
	arms: StringCensus[];
};

function heapReading(site: Deep): HeapReading {
	const bytes = site.heapBytes((site.php as any).binary);
	if (!bytes) throw new Error('no linear memory on this binary');
	return {
		pages: pageCensus(bytes),
		runs: printableRunBytes(bytes, 4),
		arms: STRING_LAYOUTS.map((l) => censusStrings(bytes, l, { samples: 12 }))
	};
}

async function readSite(label: string): Promise<Reading> {
	return inObject(freshSite(), async (raw) => {
		const site = raw as Deep;
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const seedDb = dbCensus(site);

		// TWO lifecycle points, because they are different heaps and the report's 362-page snapshot
		// figure is the first one: booted is the interpreter plus the Drupal kernel and no request,
		// served is after one anonymous front-page render
		await site.fetch(new Request('https://do.local/__php'));
		await site.runJson(BOOT_KERNEL);
		const booted = heapReading(site);

		queuePath(site, '/', { arm: false });
		await site.fetch(new Request('https://do.local/__fill'));
		const served = heapReading(site);

		const warmDb = dbCensus(site);
		const tree = fileCensus(site);
		const divergentDigest = divergentDigests(site, tree.divergent);
		const mount = JSON.parse(JSON.stringify(site.mountInfo ?? {})) as Record<string, unknown>;

		return { label, seedDb, warmDb, tree, divergentDigest, mount, heap: { booted, served } };
	});
}

/** shared fraction of B against A, as a multiset intersection */
function sharedRows(a: Map<number, number>, b: Map<number, number>): number {
	let shared = 0;
	for (const [key, n] of b) shared += Math.min(n, a.get(key) ?? 0);
	return shared;
}

function emit(name: string, value: unknown): void {
	console.log('[' + name + '] ' + JSON.stringify(value));
}

describe('two fresh sites, censused for what they share', () => {
	it('reports the seed database, the file tree and the string share of the heap', async () => {
		const a = await readSite('A');
		const b = await readSite('B');

		for (const r of [a, b]) {
			const best = r.heap.served.arms.reduce((x, y) =>
				y.verified.strings > x.verified.strings ? y : x
			);
			emit('site', {
				label: r.label,
				seedDbBytes: r.seedDb.size,
				seedRows: r.seedDb.rows,
				seedPayloadBytes: r.seedDb.bytes,
				seedTables: r.seedDb.tables,
				warmDbBytes: r.warmDb.size,
				warmRows: r.warmDb.rows,
				warmPayloadBytes: r.warmDb.bytes,
				warmTables: r.warmDb.tables,
				treeFiles: r.tree.files.length,
				treeBytes: r.tree.totalBytes,
				treeLoaded: r.tree.files.filter((f) => f.loaded).length,
				divergentFiles: r.tree.divergent.length,
				divergentBytes: r.tree.divergent.reduce((n, f) => n + f.size, 0),
				divergentPaths: r.tree.divergent.map((f) => f.path).slice(0, 24),
				mount: r.mount,
				stages: Object.fromEntries(
					Object.entries(r.heap).map(([stage, h]) => [
						stage,
						{
							heapBytes: h.pages.heapBytes,
							nonZeroBytes: h.pages.nonZeroBytes,
							nonZeroPages: h.pages.nonZeroPages,
							totalPages: h.pages.totalPages,
							printableBytes: h.runs.bytes,
							printableRuns: h.runs.runs,
							arms: h.arms
						}
					])
				),
				samples: best.samples
			});
		}

		const seedShared = sharedRows(a.seedDb.digests, b.seedDb.digests);
		const warmShared = sharedRows(a.warmDb.digests, b.warmDb.digests);
		const treeA = new Map(a.tree.files.map((f) => [f.path, f.size]));
		let treeShared = 0;
		let treeSharedBytes = 0;
		for (const f of b.tree.files) {
			if (treeA.get(f.path) === f.size) {
				treeShared++;
				treeSharedBytes += f.size;
			}
		}
		const divergentSame: string[] = [];
		const divergentDiffer: string[] = [];
		for (const [path, digest] of Object.entries(b.divergentDigest)) {
			(a.divergentDigest[path] === digest ? divergentSame : divergentDiffer).push(path);
		}

		emit('shared', {
			seedRowsA: a.seedDb.rows,
			seedRowsB: b.seedDb.rows,
			seedSharedRows: seedShared,
			seedSharedFraction: +(seedShared / Math.max(1, b.seedDb.rows)).toFixed(4),
			warmRowsA: a.warmDb.rows,
			warmRowsB: b.warmDb.rows,
			warmSharedRows: warmShared,
			warmSharedFraction: +(warmShared / Math.max(1, b.warmDb.rows)).toFixed(4),
			treeFilesA: a.tree.files.length,
			treeFilesB: b.tree.files.length,
			treeSharedFiles: treeShared,
			treeSharedBytes,
			treeSharedFraction: +(treeSharedBytes / Math.max(1, b.tree.totalBytes)).toFixed(6),
			divergentSame,
			divergentDiffer
		});

		// WHICH table holds a row site B has and site A does not; a count-only drift check reports
		// nothing when the row count matches and the CONTENT does not, which is this seed's case
		const rowDrift = (
			x: ReturnType<typeof dbCensus>,
			y: ReturnType<typeof dbCensus>
		): Record<string, number> => {
			const out: Record<string, number> = {};
			for (const [t, yd] of y.byTable) {
				const xd = x.byTable.get(t) ?? new Map<number, number>();
				let unmatched = 0;
				for (const [k, n] of yd) unmatched += Math.max(0, n - (xd.get(k) ?? 0));
				if (unmatched > 0) out[t] = unmatched;
			}
			return out;
		};
		emit('row-drift', { seed: rowDrift(a.seedDb, b.seedDb), warm: rowDrift(a.warmDb, b.warmDb) });

		const biggest = Object.entries(a.seedDb.perTable)
			.sort((x, y) => y[1][1] - x[1][1])
			.slice(0, 12);
		emit('seed-tables', Object.fromEntries(biggest));

		// tables per site that differ in row count, which is where a shared seed would break
		const drift: Record<string, [number, number]> = {};
		for (const t of new Set([...Object.keys(a.warmDb.perTable), ...Object.keys(b.warmDb.perTable)])) {
			const ra = a.warmDb.perTable[t]?.[0] ?? -1;
			const rb = b.warmDb.perTable[t]?.[0] ?? -1;
			if (ra !== rb) drift[t] = [ra, rb];
		}
		emit('table-drift', drift);

		expect(a.heap.served.pages.heapBytes).toBeGreaterThan(0);
		expect(a.seedDb.rows).toBeGreaterThan(0);
	}, 1_800_000);
});
`;

type Population = {
	strings: number;
	payloadBytes: number;
	structBytes: number;
	interned: number;
	internedPayloadBytes: number;
	internedStructBytes: number;
	persistent: number;
	permanent: number;
	longest: number;
};

type Arm = {
	layout: string;
	verified: Population;
	unhashed: Population;
	hashSignedCharOnly: number;
	hashPlain: number;
	rejectedByHash: number;
	distinctContents: number;
	duplicateInstances: number;
	duplicatePayloadBytes: number;
};

type SiteLine = {
	label: string;
	seedDbBytes: number;
	seedRows: number;
	seedPayloadBytes: number;
	seedTables: number;
	warmDbBytes: number;
	warmRows: number;
	warmPayloadBytes: number;
	warmTables: number;
	treeFiles: number;
	treeBytes: number;
	treeLoaded: number;
	divergentFiles: number;
	divergentBytes: number;
	divergentPaths: string[];
	mount: Record<string, unknown>;
	stages: Record<string, Stage>;
	samples: string[];
};

type Stage = {
	heapBytes: number;
	nonZeroBytes: number;
	nonZeroPages: number;
	totalPages: number;
	printableBytes: number;
	printableRuns: number;
	arms: Arm[];
};

function markers<T>(lines: string[], name: string): T[] {
	const tag = `[${name}]`;
	const out: T[] = [];
	for (const line of lines) {
		const at = line.indexOf(tag);
		if (at < 0) continue;
		const brace = line.indexOf('{', at);
		if (brace < 0) continue;
		try {
			out.push(JSON.parse(line.slice(brace)) as T);
		} catch {
			/* a wrapped or truncated line is not a reading */
		}
	}
	return out;
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(2)}%`);
const mib = (n: number) => (n / 1_048_576).toFixed(2);

function main(): void {
	mkdirSync(resolve(ROOT, 'experiments'), { recursive: true });
	writeFileSync(PROBE, PROBE_SOURCE);
	writeFileSync(CONFIG, CONFIG_SOURCE);

	const proc = spawnSync(
		'bunx',
		['vitest', 'run', '--config', CONFIG, '--disable-console-intercept'],
		{ cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
	);
	const lines = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.split('\n');

	if (!process.argv.includes('--keep')) {
		rmSync(PROBE, { force: true });
		rmSync(CONFIG, { force: true });
	}

	const sites = markers<SiteLine>(lines, 'site');
	const shared = markers<Record<string, unknown>>(lines, 'shared')[0];
	const drift = markers<Record<string, [number, number]>>(lines, 'table-drift')[0];
	const rowDrift = markers<Record<string, unknown>>(lines, 'row-drift')[0];
	const seedTables = markers<Record<string, [number, number]>>(lines, 'seed-tables')[0];

	if (sites.length === 0) {
		console.error('no [site] reading; the probe did not run.\n');
		console.error(lines.slice(-40).join('\n'));
		process.exit(1);
	}

	console.log('\n=== what share of the post-boot heap is string data ===\n');
	console.log(
		'| site | stage | linear memory | non-zero (live) | verified struct | + unhashed | interned struct | floor of live | ceiling of live | interned of live |'
	);
	console.log(
		'| ---- | ----- | ------------- | --------------- | --------------- | ---------- | --------------- | ------------- | --------------- | ---------------- |'
	);
	for (const s of sites) {
		for (const [stage, g] of Object.entries(s.stages)) {
			const a = g.arms.reduce((x, y) => (y.verified.strings > x.verified.strings ? y : x));
			const both = a.verified.structBytes + a.unhashed.structBytes;
			console.log(
				`| ${s.label} | ${stage} | ${mib(g.heapBytes)} | ${mib(g.nonZeroBytes)} | ` +
					`${mib(a.verified.structBytes)} | ${mib(both)} | ` +
					`${mib(a.verified.internedStructBytes)} | ` +
					`${pct(a.verified.structBytes, g.nonZeroBytes)} | ${pct(both, g.nonZeroBytes)} | ` +
					`${pct(a.verified.internedStructBytes, g.nonZeroBytes)} |`
			);
		}
	}

	console.log(
		'\n| site | stage | layout | verified | unhashed | rejected | distinct | duplicates | interned | longest | printable |'
	);
	console.log(
		'| ---- | ----- | ------ | -------- | -------- | -------- | -------- | ---------- | -------- | ------- | --------- |'
	);
	for (const s of sites) {
		for (const [stage, g] of Object.entries(s.stages)) {
			for (const a of g.arms) {
				console.log(
					`| ${s.label} | ${stage} | ${a.layout} | ${a.verified.strings} (${a.verified.payloadBytes} B) | ` +
						`${a.unhashed.strings} (${a.unhashed.payloadBytes} B) | ${a.rejectedByHash} | ` +
						`${a.distinctContents} | ${a.duplicateInstances} (${a.duplicatePayloadBytes} B) | ` +
						`${a.verified.interned} (${a.verified.internedPayloadBytes} B) | ` +
						`${a.verified.longest} | ${g.printableBytes} |`
				);
			}
		}
	}
	for (const s of sites) {
		const g = s.stages.served ?? Object.values(s.stages)[0]!;
		const a = g.arms.reduce((x, y) => (y.verified.strings > x.verified.strings ? y : x));
		console.log(
			`\n${s.label} hash reproduced: ${a.hashPlain} ascii-or-unsigned, ` +
				`${a.hashSignedCharOnly} signed-char only (non-zero means char is SIGNED here)`
		);
		console.log(`${s.label} samples: ${s.samples.slice(0, 8).join(' | ')}`);
	}

	console.log('\n=== what two sites share ===\n');
	console.log(
		'| site | seed db | seed rows | warm db | warm rows | tree files | tree bytes | resident | divergent |'
	);
	console.log(
		'| ---- | ------- | --------- | ------- | --------- | ---------- | ---------- | -------- | --------- |'
	);
	for (const s of sites) {
		console.log(
			`| ${s.label} | ${s.seedDbBytes} | ${s.seedRows} | ${s.warmDbBytes} | ${s.warmRows} | ` +
				`${s.treeFiles} | ${s.treeBytes} | ${s.treeLoaded} | ${s.divergentFiles} (${s.divergentBytes} B) |`
		);
	}
	if (shared) console.log(`\n[shared] ${JSON.stringify(shared, null, '\t')}`);
	if (drift) console.log(`\n[table-drift] ${JSON.stringify(drift)}`);
	if (rowDrift) console.log(`[row-drift] ${JSON.stringify(rowDrift)}`);
	if (seedTables) console.log(`[seed-tables rows,bytes] ${JSON.stringify(seedTables)}`);
	for (const s of sites) {
		console.log(`\n${s.label} mount: ${JSON.stringify(s.mount)}`);
		console.log(`${s.label} divergent paths: ${s.divergentPaths.join(', ')}`);
	}

	if (proc.status !== 0) console.error(`\nvitest exited ${proc.status}`);
}

if (import.meta.main) main();
