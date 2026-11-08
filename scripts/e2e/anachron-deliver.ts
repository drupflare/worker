import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** where the library is mounted on the site, under the root the class loader registers from */
export const ANACHRON_MOUNT = 'vendor/drupflare/anachron';

/** the `package` the site files the revision under; the route keeps the last segment of the name */
export const ANACHRON_PACKAGE = 'anachron';

/** the opt-in switches the rig turns on before anything else loads */
export const RIG_SETTINGS_PATH = `${ANACHRON_MOUNT}/rig-settings.php`;
export const RIG_SETTINGS_SOURCE =
	"<?php\n$GLOBALS['conf']['anachron_ignore_core_requirement'] = true;\n$GLOBALS['conf']['anachron_legacy_field_access'] = true;\n";

/** autoload `files`, mount-relative, in the order the site requires them */
const AUTOLOAD_FILES = [
	'rig-settings.php',
	'src/Php/polyfills.php',
	'src/Drupal/constants.php',
	'src/Drupal/functions.php',
	'src/Drupal/bootstrap.php'
];

const EXTENSIONS = /\.(php|yml|twig|json)$/;

/** a request body the edge forwards is capped at 2 MiB; blobs are batched under this */
export const BLOB_BATCH_BYTES = 1_500_000;

/** one file as `/modify` takes it: a site-relative path and its text */
export type BundleFile = { path: string; source: string; bytes: number };

/** what the site registers with the class loader when the commit lands */
export type AnachronDeclaration = {
	name: string;
	version: string;
	mount: string;
	autoload: { 'psr-4': Record<string, string>; files: string[] };
};

export type Bundle = { files: BundleFile[]; declaration: AnachronDeclaration };

/** the text a revision hashes: sha256 hex over its UTF-8 bytes, which is what the site recomputes */
export function sha256(source: string): string {
	return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** the short commit of a checkout, or undefined when it is not one */
export function gitShortSha(dir: string): string | undefined {
	const r = spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
	const sha = r.status === 0 ? r.stdout.trim() : '';
	return sha === '' ? undefined : sha;
}

/** every file under a directory, as paths relative to it */
function walk(root: string, prefix = ''): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(root, rel));
		else if (entry.isFile()) out.push(rel);
	}
	return out;
}

/** the files and the autoload declaration the site needs to load an anachron checkout */
export function buildBundle(dir: string): Bundle {
	const src = join(dir, 'src');
	if (!existsSync(join(src, 'Drupal', 'bootstrap.php')))
		throw new Error(
			`${join(src, 'Drupal', 'bootstrap.php')} is missing; is ${dir} an anachron checkout?`
		);
	const pkgPath = join(dir, 'package.json');
	if (!existsSync(pkgPath)) throw new Error(`${pkgPath} is missing, so the version is unknown`);
	const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version;
	if (typeof version !== 'string' || version === '') throw new Error(`${pkgPath} has no version`);
	const sha = gitShortSha(dir);

	const files: BundleFile[] = walk(src)
		.filter((rel) => EXTENSIONS.test(rel))
		.map((rel) => {
			const source = readFileSync(join(src, rel), 'utf8');
			return {
				path: `${ANACHRON_MOUNT}/src/${rel}`,
				source,
				bytes: Buffer.byteLength(source, 'utf8')
			};
		});
	files.push({
		path: RIG_SETTINGS_PATH,
		source: RIG_SETTINGS_SOURCE,
		bytes: Buffer.byteLength(RIG_SETTINGS_SOURCE, 'utf8')
	});
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const present = new Set(files.map((f) => f.path));
	return {
		files,
		declaration: {
			name: 'drupflare/anachron',
			version: sha === undefined ? version : `${version}+${sha}`,
			mount: ANACHRON_MOUNT,
			autoload: {
				'psr-4': { 'Drupflare\\Anachron\\': 'src/' },
				files: AUTOLOAD_FILES.filter((f) => present.has(`${ANACHRON_MOUNT}/${f}`))
			}
		}
	};
}

/** blobs split into requests whose encoded size stays under the budget, in the order given */
export function batchBlobs<T extends { hash: string; source: string }>(
	blobs: readonly T[],
	budget = BLOB_BATCH_BYTES
): T[][] {
	const batches: T[][] = [];
	let current: T[] = [];
	let size = 0;
	for (const blob of blobs) {
		const encoded = Buffer.byteLength(JSON.stringify(blob), 'utf8') + 1;
		if (current.length > 0 && size + encoded > budget) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(blob);
		size += encoded;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

type Reply = { status: number; body: Record<string, unknown> };

/** one `/modify` call with the owner token in the Authorization header, as drangler sends it */
async function modify(
	fetcher: typeof fetch,
	origin: string,
	token: string,
	params: Record<string, string>,
	body: unknown,
	timeoutMs: number
): Promise<Reply> {
	const url = new URL('/modify', origin);
	url.searchParams.set('package', ANACHRON_PACKAGE);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const res = await fetcher(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const text = await res.text();
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
			return { status: res.status, body: parsed as Record<string, unknown> };
	} catch {
		// a route that answered something other than JSON reports its text
	}
	return { status: res.status, body: { error: text.slice(0, 300) } };
}

const failure = (what: string, reply: Reply) =>
	`${what} answered ${reply.status}: ${String(reply.body['error'] ?? JSON.stringify(reply.body)).slice(0, 300)}`;

/**
 * Plans, uploads and commits an anachron checkout as one revision, so its autoload is registered
 * before the site boots anything else.
 */
export async function deliverAnachron(
	origin: string,
	token: string,
	dir: string,
	fetcher: typeof fetch = fetch
): Promise<{ ok: boolean; rev?: string; error?: string }> {
	let bundle: Bundle;
	try {
		bundle = buildBundle(dir);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	try {
		const declared = bundle.files.map((f) => ({
			path: f.path,
			hash: sha256(f.source),
			bytes: f.bytes
		}));
		const label = `anachron ${bundle.declaration.version}`.slice(0, 200);
		const planned = await modify(
			fetcher,
			origin,
			token,
			{ action: 'plan' },
			{ files: declared },
			120_000
		);
		if (planned.status >= 400) return { ok: false, error: failure('plan', planned) };
		const want = new Set(
			Array.isArray(planned.body['want'])
				? planned.body['want'].filter((h): h is string => typeof h === 'string')
				: []
		);
		const sources = new Map(declared.map((d, i) => [d.hash, bundle.files[i]!.source]));
		const outgoing = [...want].flatMap((hash) => {
			const source = sources.get(hash);
			return source === undefined ? [] : [{ hash, source }];
		});
		for (const batch of batchBlobs(outgoing)) {
			const sent = await modify(
				fetcher,
				origin,
				token,
				{ action: 'blobs' },
				{ blobs: batch },
				120_000
			);
			if (sent.status >= 400) return { ok: false, error: failure('blobs', sent) };
		}
		const committed = await modify(
			fetcher,
			origin,
			token,
			{ action: 'commit', label, origin: dir },
			{
				files: declared.map((d) => ({ path: d.path, hash: d.hash })),
				autoload: [bundle.declaration]
			},
			600_000
		);
		if (committed.status >= 400 || committed.body['ok'] !== true)
			return { ok: false, error: failure('commit', committed) };
		const rev = committed.body['rev'];
		return typeof rev === 'string' ? { ok: true, rev } : { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
