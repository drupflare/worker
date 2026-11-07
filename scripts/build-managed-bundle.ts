import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { readJsonc, shippedPaths } from './release-payload';

/**
 * Builds the managed worker bundle the dashboard's engine reads from the CDN.
 *
 * ```sh
 * bunx wrangler deploy --dry-run --outdir=<dir> -c wrangler.managed.jsonc
 * bun scripts/build-managed-bundle.ts --outdir=<dir> --release=v1.0.5 --commit=<40 hex> --out=<dir>
 * ```
 *
 * The layout and manifest follow `engine/src/bundle.ts` in drupflare/dashboard, whose reader this
 * feeds: `releases/<id>/{manifest.json,metadata.json,modules/<name>,assets/<hash>}`. A module is
 * named by what wrangler wrote, so its name already carries a content hash. An asset is keyed by the
 * first 32 hex characters of its sha-256.
 *
 * The asset list comes from `assets/.assetsignore` through `shippedPaths()`, never from a walk of
 * `assets/`, which holds build inputs the edge does not receive.
 */

const MODULE_TYPES: Record<string, string> = {
	js: 'application/javascript+module',
	mjs: 'application/javascript+module',
	cjs: 'application/javascript',
	wasm: 'application/wasm',
	txt: 'text/plain',
	lock: 'text/plain'
};

const SKIPPED = new Set(['README.md']);

/** the manifest shape the dashboard validates; `v` is its BUNDLE_VERSION */
export type BundleManifest = {
	v: 1;
	releaseId: string;
	workerCommit: string;
	mainModule: string;
	modules: { name: string; contentType: string; sha256: string; size: number }[];
	metadata: { sha256: string; size: number };
	assets: { path: string; hash: string; size: number }[];
	counts: { modules: number; assets: number };
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** the content type the dashboard's module list accepts for a file name */
export function moduleContentType(name: string): string {
	const dot = name.lastIndexOf('.');
	return (
		(dot === -1 ? undefined : MODULE_TYPES[name.slice(dot + 1).toLowerCase()]) ??
		'application/octet-stream'
	);
}

/** every file under `dir`, relative and slash-separated, sorted */
function walk(dir: string, base = dir): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(dir, entry.name);
			return entry.isDirectory()
				? walk(path, base)
				: [relative(base, path).split(sep).join('/')];
		})
		.sort();
}

/** what wrangler wrote, minus its README and source maps */
export function readModules(outdir: string): Map<string, Uint8Array> {
	const modules = new Map<string, Uint8Array>();
	for (const name of walk(outdir)) {
		if (SKIPPED.has(name) || name.endsWith('.map')) continue;
		modules.set(name, new Uint8Array(readFileSync(join(outdir, name))));
	}
	return modules;
}

/** the files `assets/.assetsignore` ships, as `/path` against their bytes */
export function readShippedAssets(root: string): Map<string, Uint8Array> {
	const assetsDir = join(root, 'assets');
	const ignoreSource = readFileSync(join(assetsDir, '.assetsignore'), 'utf8');
	const found = new Map<string, Uint8Array>();
	const add = (rel: string) => {
		found.set(`/${rel}`, new Uint8Array(readFileSync(join(assetsDir, rel))));
	};
	for (const path of shippedPaths(ignoreSource)) {
		const rel = posix.normalize(path.replace(/^\/+/, ''));
		const abs = resolve(assetsDir, rel);
		if (rel.startsWith('..') || !abs.startsWith(resolve(assetsDir) + sep)) {
			throw new Error(`${path} leaves the assets directory`);
		}
		if (!existsSync(abs)) continue;
		if (statSync(abs).isDirectory()) for (const file of walk(abs)) add(posix.join(rel, file));
		else add(rel);
	}
	return found;
}

/** the upload metadata, read from the config the bundle is built for so it cannot drift from it */
export function uploadMetadata(root: string, config: string, mainModule: string): Uint8Array {
	const parsed = readJsonc(join(root, config));
	return new TextEncoder().encode(
		JSON.stringify({
			main_module: mainModule,
			compatibility_date: parsed['compatibility_date'],
			compatibility_flags: parsed['compatibility_flags']
		})
	);
}

export type BundleInput = {
	releaseId: string;
	workerCommit: string;
	mainModule: string;
	modules: Map<string, Uint8Array>;
	metadata: Uint8Array;
	assets: Map<string, Uint8Array>;
};

/** the manifest and every file keyed by its path under the output directory */
export function buildBundle(input: BundleInput): {
	manifest: BundleManifest;
	files: Map<string, Uint8Array>;
} {
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.releaseId)) {
		throw new Error(`release id ${input.releaseId} must be 1 to 64 of A-Z a-z 0-9 . _ -`);
	}
	if (!/^[0-9a-f]{40}$/.test(input.workerCommit)) {
		throw new Error('the commit must be a full 40 character sha');
	}
	if (!input.modules.has(input.mainModule)) {
		throw new Error(`${input.mainModule} is not among the modules wrangler wrote`);
	}
	const base = `releases/${input.releaseId}`;
	const files = new Map<string, Uint8Array>();
	const byName = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

	const modules = [...input.modules].sort(byName).map(([name, bytes]) => {
		files.set(`${base}/modules/${name}`, bytes);
		return {
			name,
			contentType: moduleContentType(name),
			sha256: sha256(bytes),
			size: bytes.byteLength
		};
	});
	files.set(`${base}/metadata.json`, input.metadata);
	const assets = [...input.assets].sort(byName).map(([path, bytes]) => {
		const hash = sha256(bytes).slice(0, 32);
		files.set(`${base}/assets/${hash}`, bytes);
		return { path, hash, size: bytes.byteLength };
	});

	const manifest: BundleManifest = {
		v: 1,
		releaseId: input.releaseId,
		workerCommit: input.workerCommit,
		mainModule: input.mainModule,
		modules,
		metadata: { sha256: sha256(input.metadata), size: input.metadata.byteLength },
		assets,
		counts: { modules: modules.length, assets: assets.length }
	};
	files.set(`${base}/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)));
	return { manifest, files };
}

function arg(name: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	const value = hit?.slice(name.length + 3);
	if (!value) throw new Error(`--${name}= is required`);
	return value;
}

function main(): void {
	const root = process.cwd();
	const outdir = resolve(arg('outdir'));
	const out = resolve(arg('out'));
	const releaseId = arg('release');
	const config =
		process.argv.find((a) => a.startsWith('--config='))?.slice(9) ?? 'wrangler.managed.jsonc';
	const entry = String(readJsonc(join(root, config))['main']);
	const mainModule = `${posix.basename(entry).replace(/\.[cm]?[tj]s$/, '')}.js`;

	const target = join(out, 'releases', releaseId);
	if (existsSync(target) && readdirSync(target).length > 0) {
		throw new Error(`${target} already has files; choose an empty --out`);
	}
	const { manifest, files } = buildBundle({
		releaseId,
		workerCommit: arg('commit'),
		mainModule,
		modules: readModules(outdir),
		metadata: uploadMetadata(root, config, mainModule),
		assets: readShippedAssets(root)
	});
	for (const [key, bytes] of files) {
		const path = join(out, key);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes);
	}
	const bytes = [...manifest.assets.map((a) => a.size), ...manifest.modules.map((m) => m.size)];
	console.log(
		`${releaseId}: ${manifest.counts.modules} modules, ${manifest.counts.assets} assets ` +
			`(${files.size} objects, ${bytes.reduce((a, b) => a + b, 0)} bytes referenced) -> ${target}`
	);
}

if (import.meta.main) main();
