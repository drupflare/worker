import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Diffs a Drupal tree against a prior manifest and plans the objects a rollout has to move.
 *
 *   node scripts/tree-diff.mjs plan     <tree> [--against=<manifest.json>] [--fleet=<url>]
 *   node scripts/tree-diff.mjs manifest <tree> [--out=<manifest.json>]
 *
 * `plan` exits 3 when the plan DELETES a file and 0 otherwise, so a pipeline that uploads only
 * `objectsToUpload` has to stop and handle it: a removal moves no bytes, so it is invisible in
 * every count a bandwidth-shaped plan would report.
 *
 * IT DOES NOT READ ADVISORIES, and was named `security-update.mjs` as though it did. There is no
 * feed, no `composer audit` and no security query anywhere in it -- the tree handed to `plan` must
 * ALREADY be patched, by a human who already knew about the advisory. `scripts/README.md` claimed
 * it "reaches the network for SA-CORE advisories", and that false line was the recorded reason it
 * had never been ported: an offline test was believed impossible for a script whose only `fetch()`
 * is of the operator's own `--fleet=` URL.
 *
 * The detection half is unbuilt. What is here is the deterministic half and it is worth having:
 * hash the tree, diff it, emit exactly what a rollout has to move.
 *
 * This is tractable because the PHP tree is baked into a versioned asset pack,
 * so a core patch would naively mean re-packing and re-deploying every site. But
 * Cloudflare's direct-upload manifest is content-addressed and "unmodified files
 * will not be returned in the buckets field" -- so a site re-uploads only the pack
 * objects that changed. A core security patch touches a handful of files, which
 * makes fleet patching a loop bounded by API rate limits rather than by bandwidth.
 *
 * The fleet inventory and the staged `deployments.create` percentage call are the operator's half,
 * and the plan output is shaped to be fed straight into them.
 */

const [, , command, treeArg, ...flags] = process.argv;
const flag = (name, fallback = null) => {
	const hit = flags.find((f) => f.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

if (!command || !treeArg) {
	console.error(
		'usage: tree-diff.mjs <plan|manifest> <drupal-tree> [--against=manifest.json] [--out=manifest.json]'
	);
	process.exit(2);
}

// Only what actually ships. Tests and VCS metadata are excluded because they are
// excluded from the pack, and a diff that reports them would overstate the rollout.
const SKIP_NAMES = new Set(['tests', 'Tests', '.git', 'node_modules']);
// tree-relative, and separate from SKIP_NAMES because a multi-segment path can never equal the
// single segment `entry.name` -- as one entry in that set it silently matched nothing
const SKIP_PATHS = new Set(['sites/default/files']);
const SHIPPED = /\.(php|inc|module|install|theme|engine|profile|yml|twig|svg|json)$/;

async function walk(dir, root, out = new Map()) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (SKIP_NAMES.has(entry.name)) continue;
		const full = join(dir, entry.name);
		const rel = relative(root, full);
		if (SKIP_PATHS.has(rel)) continue;
		if (entry.isDirectory()) {
			await walk(full, root, out);
		} else if (SHIPPED.test(entry.name)) {
			const body = await readFile(full);
			// 32-hex, matching the shape Cloudflare's asset manifest uses
			out.set(rel, createHash('blake2b512').update(body).digest('hex').slice(0, 32));
		}
	}
	return out;
}

/** Reads the core version out of Drupal's own constant, not a guess. */
async function coreVersion(tree) {
	try {
		const src = await readFile(join(tree, 'core/lib/Drupal.php'), 'utf8');
		return src.match(/const VERSION = '([^']+)'/)?.[1] ?? 'unknown';
	} catch {
		return 'unknown';
	}
}

const tree = treeArg;
try {
	await stat(tree);
} catch {
	console.error(`no such tree: ${tree}`);
	process.exit(2);
}

const files = await walk(tree, tree);
const version = await coreVersion(tree);

if (command === 'manifest') {
	const manifest = {
		generatedFor: version,
		fileCount: files.size,
		files: Object.fromEntries([...files.entries()].sort())
	};
	const out = flag('out', 'core-manifest.json');
	await writeFile(out, JSON.stringify(manifest, null, 2));
	console.log(JSON.stringify({ wrote: out, version, files: files.size }, null, 2));
	process.exit(0);
}

if (command === 'plan') {
	const against = flag('against');
	if (!against) {
		console.error('plan needs --against=<manifest.json> from before the patch');
		process.exit(2);
	}
	const previous = JSON.parse(await readFile(against, 'utf8'));

	// the fleet is fetched rather than assumed: a plan that invents its own denominator is the
	// failure this whole endpoint exists to prevent
	const fleetUrl = flag('fleet');
	let fleet = null;
	if (fleetUrl) {
		try {
			const res = await fetch(fleetUrl);
			if (res.ok) fleet = await res.json();
			else process.stderr.write(`fleet read failed: HTTP ${res.status}\n`);
		} catch (e) {
			process.stderr.write(`fleet read failed: ${e?.message ?? e}\n`);
		}
	}
	const before = new Map(Object.entries(previous.files ?? {}));

	const changed = [];
	const added = [];
	for (const [path, hash] of files) {
		if (!before.has(path)) added.push(path);
		else if (before.get(path) !== hash) changed.push(path);
	}
	const removed = [...before.keys()].filter((p) => !files.has(p));
	// readdir order is not sorted, so two runs over the same tree could disagree on order alone
	changed.sort();
	added.sort();
	removed.sort();

	const moved = changed.length + added.length;
	const plan = {
		from: previous.generatedFor ?? 'unknown',
		to: version,
		fileCount: files.size,
		changed,
		added,
		removed,
		// the number that decides whether a fleet patch is minutes or hours
		objectsToUpload: moved,
		// a deleted file uploads nothing, so it can only be counted separately
		objectsToDelete: removed.length,
		// the upload manifest is the whole tree rather than the delta; deletion is by omission
		manifestEntries: files.size,
		fractionOfTree: files.size ? Number((moved / files.size).toFixed(5)) : 0,
		rollout: {
			note: 'assets bind to a Worker version, so blob and index ship atomically; a version has both or neither',
			// the list the steps below iterate. `/fleet` answers it from D1 without touching a
			// single object; before that existed, "for each site" named a set nobody could
			// enumerate and time-to-patch was unmeasurable rather than merely slow
			sites: fleet
				? {
						source: fleetUrl,
						total: fleet.sites,
						onTarget: fleet.rollout ?? null,
						byPackGeneration: fleet.byPackGeneration,
						// reported separately: a site that has not checked in is evidence of
						// nothing, and counting it as unpatched would make "100% done" a claim
						// about sites nobody has heard from
						stale: fleet.stale
					}
				: {
						source: null,
						note: 'no --fleet=<url> given, so this plan names no sites; GET /fleet on a deployment that has the D1 binding'
					},
			steps: [
				"for each site in rollout.sites: open an upload session with a manifest of ALL manifestEntries paths, omitting the plan's removed paths -- the session requests only the changed objects, and a path the manifest leaves out is absent from the version, which is the only way a rollout deletes a file",
				'versions.create against that session; a manifest of just the objectsToUpload paths would carry every removed path forward onto every site',
				'deployments.create at 10 percent, watch exceededCpu / exceededMemory / 5xx in Workers Logs',
				'deployments.create at 100 percent, or roll back to the previous version id'
			],
			constraint:
				'upload JWTs are valid one hour, so a fleet patch must finish inside that window or re-authenticate per batch'
		}
	};
	console.log(JSON.stringify(plan, null, 2));
	// 3 rather than 0: an upload-shaped caller has to opt in to a plan that deletes
	process.exit(removed.length > 0 ? 3 : 0);
}

console.error(`unknown command: ${command}`);
process.exit(2);
