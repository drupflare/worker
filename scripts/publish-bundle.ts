import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BUCKET, ORIGIN } from './backup-cdn';
import type { BundleManifest } from './build-managed-bundle';
import { managedKeyBase } from './payload-cdn';

/**
 * Publishes the tree `build-managed-bundle.ts` wrote to the CDN bucket.
 *
 * ```sh
 * bun scripts/publish-bundle.ts --out=<dir> --release=v1.0.5            # upload, then verify from the CDN
 * bun scripts/publish-bundle.ts --out=<dir> --release=v1.0.5 --dry-run  # check the files, print the plan
 * ```
 *
 * A RELEASE PREFIX IS WRITTEN ONCE, and the manifest goes up last: the dashboard reads `manifest.json`
 * to learn what exists, so a run that dies partway leaves objects nothing points at and a rerun
 * finishes it. A prefix whose manifest is already on the CDN is refused unless `--force`.
 *
 * The assets go up through `wrangler r2 bulk put`, the one write path that reaches thousands of
 * objects without one API call each; a release has 4,346 objects and single puts hit the platform's
 * rate limit. Bulk put takes one content type for the whole list, so the five modules, the metadata
 * and the manifest go up one at a time with their own.
 */

const root = process.cwd();
const WRANGLER = join(root, 'node_modules/.bin/wrangler');

type Upload = { key: string; file: string; contentType: string };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function arg(name: string): string | undefined {
	return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/**
 * Checks the files on disk against the manifest and returns what to upload, in upload order.
 * Throws on a file the manifest does not describe or one whose bytes disagree with it.
 */
export function plan(
	out: string,
	release: string
): { manifest: BundleManifest; assets: Upload[]; singles: Upload[] } {
	const dir = join(out, 'releases', release);
	const manifestPath = join(dir, 'manifest.json');
	if (!existsSync(manifestPath)) throw new Error(`${manifestPath} does not exist`);
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest;
	if (manifest.releaseId !== release) {
		throw new Error(`the manifest is for ${manifest.releaseId}, not ${release}`);
	}
	const keyBase = managedKeyBase(release);
	const check = (file: string, sha: string | undefined, size: number, what: string) => {
		const bytes = readFileSync(file);
		if (bytes.byteLength !== size)
			throw new Error(`${what} is ${bytes.byteLength} bytes, not ${size}`);
		if (sha !== undefined && !sha256(bytes).startsWith(sha)) {
			throw new Error(`${what} does not match the hash the manifest records`);
		}
	};

	const singles: Upload[] = [];
	for (const m of manifest.modules) {
		const file = join(dir, 'modules', m.name);
		check(file, m.sha256, m.size, `module ${m.name}`);
		singles.push({ key: `${keyBase}/modules/${m.name}`, file, contentType: m.contentType });
	}
	const metadata = join(dir, 'metadata.json');
	check(metadata, manifest.metadata.sha256, manifest.metadata.size, 'metadata.json');
	singles.push({
		key: `${keyBase}/metadata.json`,
		file: metadata,
		contentType: 'application/json'
	});
	singles.push({
		key: `${keyBase}/manifest.json`,
		file: manifestPath,
		contentType: 'application/json'
	});

	const seen = new Set<string>();
	const assets: Upload[] = [];
	for (const a of manifest.assets) {
		if (seen.has(a.hash)) continue;
		seen.add(a.hash);
		const file = join(dir, 'assets', a.hash);
		check(file, a.hash, a.size, `asset ${a.path}`);
		assets.push({
			key: `${keyBase}/assets/${a.hash}`,
			file,
			contentType: 'application/octet-stream'
		});
	}
	return { manifest, assets, singles };
}

function wrangler(args: string[]): void {
	execFileSync(WRANGLER, args, { cwd: root, stdio: 'inherit' });
}

function putOne(item: Upload): void {
	wrangler([
		'r2',
		'object',
		'put',
		`${BUCKET}/${item.key}`,
		`--file=${item.file}`,
		`--content-type=${item.contentType}`,
		'--remote'
	]);
}

/**
 * The bucket's S3-compatible endpoint, when a key pair is in the environment. It has no per-request
 * REST limit, which `wrangler r2 bulk put` runs into: measured at 1.7 objects a second against this
 * bucket, and one transient `fetch failed` ends the whole run with nothing to resume from.
 */
function s3Client(): Bun.S3Client | undefined {
	const accessKeyId = process.env['CLOUDFLARE_R2_KEY_ID'];
	const secretAccessKey = process.env['CLOUDFLARE_R2_SECRET_ACCESS_KEY'];
	const account = process.env['CLOUDFLARE_ACCOUNT_ID'];
	if (!accessKeyId || !secretAccessKey || !account) return undefined;
	return new Bun.S3Client({
		accessKeyId,
		secretAccessKey,
		bucket: BUCKET,
		endpoint: `https://${account}.r2.cloudflarestorage.com`,
		region: 'auto'
	});
}

/** puts `items` with a bounded number in flight, retrying each one a few times */
async function putAll(client: Bun.S3Client, items: Upload[], concurrency: number): Promise<void> {
	let next = 0;
	let done = 0;
	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) {
			const item = items[i]!;
			for (let attempt = 1; ; attempt++) {
				try {
					await client.write(item.key, Bun.file(item.file), { type: item.contentType });
					break;
				} catch (error) {
					if (attempt === 5) throw new Error(`${item.key}: ${(error as Error).message}`);
					await new Promise((r) => setTimeout(r, 500 * attempt));
				}
			}
			if (++done % 500 === 0) console.log(`put ${done} of ${items.length}`);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function manifestIsLive(keyBase: string): Promise<boolean> {
	const res = await fetch(`${ORIGIN}/${keyBase}/manifest.json`, { method: 'HEAD' });
	return res.status === 200;
}

/** reads every object back from the CDN and compares it with what the manifest says */
async function verifyLive(manifest: BundleManifest, keyBase: string): Promise<void> {
	const get = async (key: string): Promise<Uint8Array> => {
		for (let attempt = 1; ; attempt++) {
			const res = await fetch(`${ORIGIN}/${key}`);
			if (res.ok) return new Uint8Array(await res.arrayBuffer());
			if (attempt === 4) throw new Error(`${ORIGIN}/${key} answered ${res.status}`);
			await new Promise((r) => setTimeout(r, 1000 * attempt));
		}
	};
	for (const m of manifest.modules) {
		const bytes = await get(`${keyBase}/modules/${m.name}`);
		if (bytes.byteLength !== m.size || sha256(bytes) !== m.sha256) {
			throw new Error(`${m.name} on the CDN does not match the manifest`);
		}
	}
	const unique = [...new Map(manifest.assets.map((a) => [a.hash, a])).values()];
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < unique.length; i = next++) {
			const a = unique[i]!;
			const bytes = await get(`${keyBase}/assets/${a.hash}`);
			if (bytes.byteLength !== a.size || !sha256(bytes).startsWith(a.hash)) {
				throw new Error(`asset ${a.path} on the CDN does not match the manifest`);
			}
		}
	};
	await Promise.all(Array.from({ length: 16 }, worker));
	console.log(
		`verified ${manifest.modules.length} modules and ${unique.length} assets on the CDN`
	);
}

async function main(): Promise<void> {
	const release = arg('release');
	const out = arg('out');
	if (!release || !out) throw new Error('--release= and --out= are required');
	const dryRun = process.argv.includes('--dry-run');
	const keyBase = managedKeyBase(release);
	const { manifest, assets, singles } = plan(resolve(out), release);
	console.log(
		`${release}: ${singles.length} single puts, ${assets.length} assets in bulk -> ${BUCKET}/${keyBase}`
	);
	if (dryRun) return;

	if (!process.argv.includes('--force') && (await manifestIsLive(keyBase))) {
		throw new Error(
			`${ORIGIN}/${keyBase}/manifest.json already exists; a release is written once`
		);
	}
	const started = Date.now();
	const client = s3Client();
	if (client) {
		await putAll(client, assets, Number(arg('concurrency') ?? '32'));
		console.log(`assets uploaded in ${Math.round((Date.now() - started) / 1000)} s over S3`);
		// the manifest is the last single, so nothing reads a release that is still being written
		for (const item of singles) await putAll(client, [item], 1);
	} else {
		const tmp = mkdtempSync(join(tmpdir(), 'drupflare-bundle-'));
		const list = join(tmp, 'assets.json');
		writeFileSync(list, JSON.stringify(assets.map(({ key, file }) => ({ key, file }))));
		wrangler([
			'r2',
			'bulk',
			'put',
			BUCKET,
			`--filename=${list}`,
			'--content-type=application/octet-stream',
			`--concurrency=${arg('concurrency') ?? '20'}`,
			'--remote'
		]);
		console.log(`assets uploaded in ${Math.round((Date.now() - started) / 1000)} s`);
		for (const item of singles) putOne(item);
	}
	await verifyLive(manifest, keyBase);
	console.log(`published ${ORIGIN}/${keyBase}/manifest.json`);
}

if (import.meta.main) await main();
