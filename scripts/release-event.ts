import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes the manifest a release carries and posts the signed event that announces it.
 *
 * ```sh
 * bun scripts/release-event.ts manifest --dist=dist --tag=v1.1.0 --repo=drupflare/worker
 * bun scripts/release-event.ts post --dist=dist --tag=v1.1.0 --repo=drupflare/worker
 * ```
 *
 * `manifest` lists every file in `dist/SHA256SUMS` with its release URL and digest, and states the
 * data schema from `package.json`. `post` sends one `release.published` event to the dashboard's
 * release hook with an HMAC-SHA256 signature over the exact body. The dashboard fetches the manifest
 * from the URL in the event and compares its digest, so `post` reads the manifest back from that
 * URL first and refuses to announce one that differs.
 *
 * The secret and the hook URL come from the environment and are never printed. A missing one stops
 * the run before any request is made.
 */

/** the largest body the hook accepts */
export const RELEASE_EVENT_MAX_BYTES = 64 * 1024;

/** the environment names the post reads */
export const RELEASE_HOOK_URL_ENV = 'DASHBOARD_RELEASE_URL';
export const RELEASE_HOOK_SECRET_ENV = 'DASHBOARD_RELEASE_SECRET';

/** the header the dashboard reads the signature from */
export const SIGNATURE_HEADER = 'x-drupflare-signature';

/** the data schema a release declares in `package.json` */
export type PackageSchema = { version: number; accepts: number };

/** one file of the release, as the manifest lists it */
export type ManifestAsset = { name: string; url: string; digest: string };

/** what the dashboard parses at the manifest URL */
export type ReleaseManifest = {
	kind: 'worker';
	version: string;
	schemaVersion: number;
	acceptsSchema: number;
	assets: ManifestAsset[];
};

/** what the dashboard parses from the hook body */
export type ReleaseEvent = {
	v: 1;
	id: string;
	type: 'release.published';
	kind: 'worker';
	version: string;
	manifestDigest: string;
	manifestUrl: string;
	schemaVersion: number;
	acceptsSchema: number;
	publishedAt: string;
	advisoryAt: null;
};

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** `drupflare-release-manifest-<version>.json`, the version being the tag without its `v` */
export function manifestFileName(version: string): string {
	return `drupflare-release-manifest-${version}.json`;
}

/** the URL GitHub serves a release asset from */
export function assetUrl(repo: string, tag: string, name: string): string {
	return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

/** the files and digests a `sha256sum` list names, in the order it names them */
export function readSumsList(text: string): { name: string; sha256: string }[] {
	const found: { name: string; sha256: string }[] = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		const match = /^([0-9a-f]{64}) [ *](\S.*)$/.exec(line);
		if (match === null) throw new Error(`not a sha256sum line: ${line.slice(0, 80)}`);
		found.push({ sha256: match[1] as string, name: match[2] as string });
	}
	return found;
}

/** reads `schema` from a parsed `package.json`, refusing anything but two whole numbers */
export function packageSchema(pkg: unknown): PackageSchema {
	const schema = (pkg as { schema?: Record<string, unknown> } | null)?.schema;
	const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
	if (!whole(schema?.['version']) || !whole(schema?.['accepts'])) {
		throw new Error('package.json needs schema: { version, accepts } as whole numbers');
	}
	if (schema['accepts'] > schema['version']) {
		throw new Error(
			'schema.accepts is the oldest schema accepted and cannot exceed schema.version'
		);
	}
	return { version: schema['version'], accepts: schema['accepts'] };
}

/** the manifest for a release; every asset URL names this tag */
export function releaseManifest(input: {
	version: string;
	tag: string;
	repo: string;
	schema: PackageSchema;
	sums: { name: string; sha256: string }[];
}): ReleaseManifest {
	if (input.version.length < 1 || input.version.length > 64) {
		throw new Error('the version must be 1 to 64 characters');
	}
	if (input.sums.length === 0) throw new Error('SHA256SUMS lists no file');
	return {
		kind: 'worker',
		version: input.version,
		schemaVersion: input.schema.version,
		acceptsSchema: input.schema.accepts,
		assets: input.sums.map((entry) => {
			if (entry.name.length > 200)
				throw new Error(`${entry.name} is longer than 200 characters`);
			return {
				name: entry.name,
				url: assetUrl(input.repo, input.tag, entry.name),
				digest: `sha256:${entry.sha256}`
			};
		})
	};
}

/** the manifest as the bytes the release carries; the event's digest is taken over these */
export function manifestBytes(manifest: ReleaseManifest): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(manifest) + '\n');
}

/** the event for a release whose manifest bytes and URL are known */
export function releaseEvent(input: {
	tag: string;
	version: string;
	manifest: Uint8Array;
	manifestUrl: string;
	schema: PackageSchema;
	at: Date;
}): ReleaseEvent {
	const id = `release-${input.tag}`;
	if (id.length < 8 || id.length > 64)
		throw new Error(`event id ${id} must be 8 to 64 characters`);
	return {
		v: 1,
		id,
		type: 'release.published',
		kind: 'worker',
		version: input.version,
		manifestDigest: `sha256:${sha256(input.manifest)}`,
		manifestUrl: input.manifestUrl,
		schemaVersion: input.schema.version,
		acceptsSchema: input.schema.accepts,
		publishedAt: input.at.toISOString(),
		advisoryAt: null
	};
}

/** the exact body to send; refuses one over the hook's ceiling */
export function eventBody(event: ReleaseEvent): string {
	const body = JSON.stringify(event);
	if (new TextEncoder().encode(body).byteLength > RELEASE_EVENT_MAX_BYTES) {
		throw new Error(`the event body is over ${RELEASE_EVENT_MAX_BYTES} bytes`);
	}
	return body;
}

/** `sha256=<hex>`: HMAC-SHA256 of the raw body under the secret */
export function sign(body: string, secret: string): string {
	return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** a fetch the caller can replace, and a sleep that tests skip */
export type Io = {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	sleep: (ms: number) => Promise<void>;
};

/** the hook URL and secret, refusing an unset one and a URL that is not https */
export function hookConfig(env: Record<string, string | undefined>): {
	url: string;
	secret: string;
} {
	const url = (env[RELEASE_HOOK_URL_ENV] ?? '').trim();
	const secret = env[RELEASE_HOOK_SECRET_ENV] ?? '';
	if (url === '')
		throw new Error(`${RELEASE_HOOK_URL_ENV} is not set; the release is not announced`);
	if (secret === '') {
		throw new Error(`${RELEASE_HOOK_SECRET_ENV} is not set; the release is not announced`);
	}
	if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(url))
		throw new Error(`${RELEASE_HOOK_URL_ENV} must be an https URL`);
	return { url, secret };
}

/**
 * Waits until the manifest URL serves the bytes the event will name, so the dashboard's fetch
 * finds what was signed. Throws when it never does.
 */
export async function waitForManifest(
	url: string,
	expected: Uint8Array,
	io: Io,
	tries = 20,
	gapMs = 15_000
): Promise<void> {
	let last = 'no attempt';
	for (let i = 0; i < tries; i++) {
		try {
			const res = await io.fetch(url, { redirect: 'follow' });
			if (res.status === 200) {
				const got = new Uint8Array(await res.arrayBuffer());
				if (sha256(got) === sha256(expected)) return;
				last = 'the served manifest differs from the one built';
			} else {
				last = `answered ${res.status}`;
			}
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
		}
		if (i < tries - 1) await io.sleep(gapMs);
	}
	throw new Error(`${url} never served the manifest (${last})`);
}

/** posts the signed body once; anything but a 200 that says it was received is a failure */
export async function postEvent(
	hook: { url: string; secret: string },
	body: string,
	io: Io
): Promise<{ duplicate: boolean; releaseId: string | null }> {
	const res = await io.fetch(hook.url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			[SIGNATURE_HEADER]: sign(body, hook.secret)
		},
		body
	});
	const text = await res.text();
	let parsed: { received?: unknown; duplicate?: unknown; releaseId?: unknown } = {};
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = {};
	}
	if (res.status !== 200 || parsed.received !== true) {
		throw new Error(`the hook answered ${res.status}: ${text.slice(0, 200)}`);
	}
	return {
		duplicate: parsed.duplicate === true,
		releaseId: typeof parsed.releaseId === 'string' ? parsed.releaseId : null
	};
}

function arg(name: string): string | undefined {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
}

function required(name: string): string {
	const value = arg(name);
	if (!value) throw new Error(`--${name}= is required`);
	return value;
}

async function main(): Promise<void> {
	const command = process.argv[2];
	const dist = required('dist');
	const tag = required('tag');
	const repo = required('repo');
	const version = tag.replace(/^v/, '');
	const root = arg('root') ?? process.cwd();
	const schema = packageSchema(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
	const file = join(dist, manifestFileName(version));

	if (command === 'manifest') {
		const sums = readSumsList(readFileSync(join(dist, 'SHA256SUMS'), 'utf8'));
		const manifest = releaseManifest({ version, tag, repo, schema, sums });
		writeFileSync(file, manifestBytes(manifest));
		console.log(
			`${manifestFileName(version)}: ${manifest.assets.length} assets, schema ${schema.version}`
		);
		return;
	}
	if (command !== 'post') throw new Error('the command is manifest or post');

	const manifest = new Uint8Array(readFileSync(file));
	const event = releaseEvent({
		tag,
		version,
		manifest,
		manifestUrl: assetUrl(repo, tag, manifestFileName(version)),
		schema,
		at: new Date()
	});
	const body = eventBody(event);
	if (process.argv.includes('--dry-run')) {
		console.log(`dry run, nothing sent: ${body}`);
		return;
	}
	const hook = hookConfig(process.env);
	const io: Io = {
		fetch: (url, init) => fetch(url, init),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	};
	await waitForManifest(event.manifestUrl, manifest, io);
	const result = await postEvent(hook, body, io);
	console.log(
		`announced ${event.id}: ${result.duplicate ? 'already known' : 'registered'}` +
			(result.releaseId === null ? '' : ` as ${result.releaseId}`)
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
