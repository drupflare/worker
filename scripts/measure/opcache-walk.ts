/**
 * Walks the opcache file cache of a DEPLOYED site and reports what is in it.
 *
 * WHY A SCRIPT. `src/site-do.ts` sets `opcache.file_cache=/tmp` and nothing in this repo had ever
 * looked at that directory on the edge, so "the file cache is on" was config rather than an
 * observation. The only reachable instrument is `/files?op=dir`, which lists ONE directory per
 * invocation, and the cache mirrors the source tree -- so the count is a walk, not a lookup.
 *
 * `dirname()` is what the probe lists, so every uri here carries a trailing `/x` sentinel: asking
 * for `/tmp/<id>/drupal/x` lists `/tmp/<id>/drupal`.
 *
 * Requests are issued one at a time on purpose. A Durable Object is single-threaded, so
 * concurrency buys nothing here and costs the ability to say what any one invocation measured.
 *
 * This reports COUNTS and NAMES, never a duration. Every timing in this project comes from
 * `cpuTime` on a deployed worker (RULE 0), and nothing below is a clock.
 */

type Args = Record<string, string | undefined>;

function parseArgs(argv: string[]): Args {
	const out: Args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[key] = next;
			i++;
		} else out[key] = '1';
	}
	return out;
}

export type DirListing = { entries: string[]; isDir: boolean };

/** Splits a listing into real child names, dropping the `.`/`..` MEMFS always reports. */
export function childNames(entries: string[]): string[] {
	return entries.filter((e) => e !== '.' && e !== '..');
}

export type WalkTotals = {
	dirs: number;
	binFiles: number;
	otherFiles: number;
	deepest: number;
	truncated: boolean;
};

/**
 * A `.bin` name is a cached script and anything else at a leaf is a directory we could not open.
 *
 * The probe cannot stat, so "is this a directory" is answered by trying to list it. A name with no
 * `.bin` suffix that lists successfully is a directory; one that does not is counted as a file.
 */
export function classify(name: string): 'bin' | 'other' {
	return name.endsWith('.bin') ? 'bin' : 'other';
}

async function listDir(base: string, site: string, path: string): Promise<DirListing | null> {
	const uri = `${path.replace(/\/$/, '')}/x`;
	const res = await fetch(
		`${base}/files?site=${encodeURIComponent(site)}&op=dir&uri=${encodeURIComponent(uri)}`
	);
	const text = await res.text();
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(body?.entries)) return null;
	return { entries: body.entries as string[], isDir: body.isDir === true };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const base = (args.base ?? '').replace(/\/$/, '');
	const site = args.site ?? 'opc';
	const root = args.root;
	const maxDirs = Number(args['max-dirs'] ?? 400);
	if (!base) throw new Error('--base <https://worker.example.workers.dev> is required');
	if (!root) throw new Error('--root </tmp/<system_id>> is required');

	const totals: WalkTotals = {
		dirs: 0,
		binFiles: 0,
		otherFiles: 0,
		deepest: 0,
		truncated: false
	};
	const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
	const binsByTop = new Map<string, number>();

	while (queue.length > 0) {
		if (totals.dirs >= maxDirs) {
			totals.truncated = true;
			break;
		}
		const next = queue.shift() as { path: string; depth: number };
		const listing = await listDir(base, site, next.path);
		if (!listing || !listing.isDir) {
			totals.otherFiles++;
			continue;
		}
		totals.dirs++;
		totals.deepest = Math.max(totals.deepest, next.depth);
		const top = next.path.slice(root.length).split('/').filter(Boolean)[0] ?? '(root)';
		for (const name of childNames(listing.entries)) {
			if (classify(name) === 'bin') {
				totals.binFiles++;
				binsByTop.set(top, (binsByTop.get(top) ?? 0) + 1);
			} else {
				queue.push({ path: `${next.path}/${name}`, depth: next.depth + 1 });
			}
		}
		if (totals.dirs % 20 === 0) {
			console.log(
				`  ... ${totals.dirs} dirs listed, ${totals.binFiles} .bin found, ${queue.length} queued`
			);
		}
	}

	console.log(JSON.stringify({ root, site, totals, queued: queue.length }, null, 2));
	console.log('.bin per top-level subtree:');
	for (const [k, v] of [...binsByTop.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${k.padEnd(20)} ${v}`);
	}
}

if (import.meta.main) await main();
