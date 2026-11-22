import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assetUrl,
	eventBody,
	hookConfig,
	manifestBytes,
	manifestFileName,
	packageSchema,
	postEvent,
	readSumsList,
	RELEASE_EVENT_MAX_BYTES,
	releaseEvent,
	releaseManifest,
	sign,
	SIGNATURE_HEADER,
	waitForManifest,
	type Io
} from '../../scripts/release-event';

const ROOT = resolve(import.meta.dirname, '../..');
const SECRET = 'fake-hook-secret-for-tests';
const HASH = 'a'.repeat(64);
const enc = (text: string) => new TextEncoder().encode(text);

const event = (over: Partial<Parameters<typeof releaseEvent>[0]> = {}) =>
	releaseEvent({
		tag: 'v1.1.0',
		version: '1.1.0',
		manifest: enc('{"kind":"worker"}\n'),
		manifestUrl:
			'https://github.com/example/worker/releases/download/v1.1.0/drupflare-release-manifest-1.1.0.json',
		schema: { version: 7, accepts: 7 },
		at: new Date('2026-11-21T12:00:00.000Z'),
		...over
	});

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the signature', () => {
	it('matches the published HMAC-SHA256 test vector', () => {
		expect(sign('what do ya want for nothing?', 'Jefe')).toBe(
			'sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
		);
	});

	it('matches an independent HMAC of a known body under a known key', () => {
		const body = eventBody(event());
		expect(body).toBe(
			'{"v":1,"id":"release-v1.1.0","type":"release.published","kind":"worker","version":"1.1.0",' +
				'"manifestDigest":"sha256:f07193e2bcbb5b6c1b5f4b1a9a6a05438602ffcb1a6561d0ccd62a0f3a9d8fc0",' +
				'"manifestUrl":"https://github.com/example/worker/releases/download/v1.1.0/drupflare-release-manifest-1.1.0.json",' +
				'"schemaVersion":7,"acceptsSchema":7,"publishedAt":"2026-11-21T12:00:00.000Z","advisoryAt":null}'
		);
		expect(sign(body, SECRET)).toBe(
			'sha256=261ba939a61004cfa9c5c40d3da0bffc80cc74d9917f2f3676a9fc33ee0833de'
		);
	});

	it('changes with one byte of the body or of the key', () => {
		const body = eventBody(event());
		expect(sign(`${body} `, SECRET)).not.toBe(sign(body, SECRET));
		expect(sign(body, `${SECRET}x`)).not.toBe(sign(body, SECRET));
	});
});

describe('the body ceiling', () => {
	/** an event whose JSON body is exactly `size` bytes, padded through the URL */
	const sized = (size: number) => {
		const base = JSON.stringify(event({ manifestUrl: 'https://example.com/' }));
		const pad = size - new TextEncoder().encode(base).byteLength;
		return event({ manifestUrl: `https://example.com/${'p'.repeat(pad)}` });
	};

	it('accepts a body of exactly 64 KiB', () => {
		expect(new TextEncoder().encode(eventBody(sized(RELEASE_EVENT_MAX_BYTES))).byteLength).toBe(
			RELEASE_EVENT_MAX_BYTES
		);
	});

	it('refuses a body one byte over', () => {
		expect(() => eventBody(sized(RELEASE_EVENT_MAX_BYTES + 1))).toThrow('65536');
	});
});

describe('the event and the manifest against the contract', () => {
	it('is a release.published event of kind worker with the fields the contract requires', () => {
		const e = event();
		expect(Object.keys(e).sort()).toEqual([
			'acceptsSchema',
			'advisoryAt',
			'id',
			'kind',
			'manifestDigest',
			'manifestUrl',
			'publishedAt',
			'schemaVersion',
			'type',
			'v',
			'version'
		]);
		expect(e.v).toBe(1);
		expect(e.id.length).toBeGreaterThanOrEqual(8);
		expect(e.id.length).toBeLessThanOrEqual(64);
		expect(e.type).toBe('release.published');
		expect(e.kind).toBe('worker');
		expect(e.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(() => new URL(e.manifestUrl)).not.toThrow();
		expect(Number.isInteger(e.schemaVersion) && e.schemaVersion >= 0).toBe(true);
		expect(Number.isInteger(e.acceptsSchema) && e.acceptsSchema >= 0).toBe(true);
		expect(e.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
		expect(e.advisoryAt).toBeNull();
	});

	it('names the digest of the manifest bytes it was given', () => {
		const manifest = enc('{"kind":"worker"}\n');
		expect(event({ manifest }).manifestDigest).toBe(
			'sha256:f07193e2bcbb5b6c1b5f4b1a9a6a05438602ffcb1a6561d0ccd62a0f3a9d8fc0'
		);
		expect(event({ manifest: enc('other') }).manifestDigest).not.toBe(event().manifestDigest);
	});

	it('refuses an event id past 64 characters', () => {
		expect(() => event({ tag: `v${'1'.repeat(60)}` })).toThrow('event id');
	});

	it('writes a manifest of kind worker with one asset per sums line and the declared schema', () => {
		const manifest = releaseManifest({
			version: '1.1.0',
			tag: 'v1.1.0',
			repo: 'example/worker',
			schema: { version: 7, accepts: 6 },
			sums: [
				{ name: 'drupflare-worker-1.1.0.tar.gz', sha256: HASH },
				{ name: 'drupflare-box-bundle-1.1.0.tar.gz', sha256: 'b'.repeat(64) }
			]
		});
		expect(manifest).toEqual({
			kind: 'worker',
			version: '1.1.0',
			schemaVersion: 7,
			acceptsSchema: 6,
			assets: [
				{
					name: 'drupflare-worker-1.1.0.tar.gz',
					url: 'https://github.com/example/worker/releases/download/v1.1.0/drupflare-worker-1.1.0.tar.gz',
					digest: `sha256:${HASH}`
				},
				{
					name: 'drupflare-box-bundle-1.1.0.tar.gz',
					url: 'https://github.com/example/worker/releases/download/v1.1.0/drupflare-box-bundle-1.1.0.tar.gz',
					digest: `sha256:${'b'.repeat(64)}`
				}
			]
		});
		expect(new TextDecoder().decode(manifestBytes(manifest)).endsWith('}\n')).toBe(true);
	});

	it('refuses a manifest with no asset, a long version or a long asset name', () => {
		const base = {
			version: '1.1.0',
			tag: 'v1.1.0',
			repo: 'example/worker',
			schema: { version: 7, accepts: 7 }
		};
		expect(() => releaseManifest({ ...base, sums: [] })).toThrow('lists no file');
		expect(() =>
			releaseManifest({
				...base,
				version: 'v'.repeat(65),
				sums: [{ name: 'a', sha256: HASH }]
			})
		).toThrow('1 to 64');
		expect(() =>
			releaseManifest({ ...base, sums: [{ name: 'n'.repeat(201), sha256: HASH }] })
		).toThrow('200');
	});

	it('names the file and the URL from the tag', () => {
		expect(manifestFileName('1.1.0')).toBe('drupflare-release-manifest-1.1.0.json');
		expect(assetUrl('example/worker', 'v1.1.0', 'a.json')).toBe(
			'https://github.com/example/worker/releases/download/v1.1.0/a.json'
		);
	});
});

describe('the sums list and the declared schema', () => {
	it('reads sha256sum lines and refuses anything else', () => {
		expect(readSumsList(`${HASH}  a.tar.gz\n${'b'.repeat(64)} *b.tar.gz\n\n`)).toEqual([
			{ sha256: HASH, name: 'a.tar.gz' },
			{ sha256: 'b'.repeat(64), name: 'b.tar.gz' }
		]);
		expect(() => readSumsList('not a sum line\n')).toThrow('sha256sum');
		expect(() => readSumsList(`${HASH.toUpperCase()}  a\n`)).toThrow('sha256sum');
	});

	it('reads two whole numbers and refuses a missing, negative, fractional or inverted pair', () => {
		expect(packageSchema({ schema: { version: 7, accepts: 5 } })).toEqual({
			version: 7,
			accepts: 5
		});
		for (const bad of [
			{},
			{ schema: {} },
			{ schema: { version: -1, accepts: 0 } },
			{ schema: { version: 1.5, accepts: 1 } },
			{ schema: { version: '7', accepts: 7 } },
			{ schema: { version: 3, accepts: 4 } }
		]) {
			expect(() => packageSchema(bad), JSON.stringify(bad)).toThrow();
		}
	});

	it('is satisfied by this repository', () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
		expect(packageSchema(pkg)).toEqual(pkg.schema);
	});
});

describe('the hook configuration', () => {
	it('stops when the URL or the secret is unset, empty or blank, and says which', () => {
		expect(() => hookConfig({})).toThrow('DASHBOARD_RELEASE_URL');
		expect(() =>
			hookConfig({ DASHBOARD_RELEASE_URL: ' ', DASHBOARD_RELEASE_SECRET: SECRET })
		).toThrow('DASHBOARD_RELEASE_URL');
		expect(() => hookConfig({ DASHBOARD_RELEASE_URL: 'https://x.example/hook' })).toThrow(
			'DASHBOARD_RELEASE_SECRET'
		);
		expect(() =>
			hookConfig({
				DASHBOARD_RELEASE_URL: 'https://x.example/hook',
				DASHBOARD_RELEASE_SECRET: ''
			})
		).toThrow('DASHBOARD_RELEASE_SECRET');
	});

	it('refuses a URL that is not https, and never puts the secret in a message', () => {
		let message = '';
		try {
			hookConfig({
				DASHBOARD_RELEASE_URL: 'http://x.example/hook',
				DASHBOARD_RELEASE_SECRET: SECRET
			});
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain('https');
		expect(message).not.toContain(SECRET);
		expect(
			hookConfig({
				DASHBOARD_RELEASE_URL: 'https://x.example/api/hooks/release',
				DASHBOARD_RELEASE_SECRET: SECRET
			})
		).toEqual({ url: 'https://x.example/api/hooks/release', secret: SECRET });
	});
});

describe('posting the event', () => {
	const hook = { url: 'https://x.example/api/hooks/release', secret: SECRET };

	/** an io whose fetch records each call and answers from a queue */
	function io(
		answers: Response[]
	): Io & { calls: { url: string; init?: RequestInit }[]; naps: number[] } {
		const calls: { url: string; init?: RequestInit }[] = [];
		const naps: number[] = [];
		return {
			calls,
			naps,
			fetch: async (url, init) => {
				calls.push({ url, init });
				const next = answers.shift();
				if (next === undefined) throw new Error('no answer queued');
				return next;
			},
			sleep: async (ms) => {
				naps.push(ms);
			}
		};
	}

	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});

	it('sends the signed raw body with the signature header and no other credential', async () => {
		const body = eventBody(event());
		const fake = io([json(200, { received: true, duplicate: false, releaseId: '1.1.0' })]);
		const result = await postEvent(hook, body, fake);
		expect(result).toEqual({ duplicate: false, releaseId: '1.1.0' });
		const call = fake.calls[0]!;
		expect(call.url).toBe(hook.url);
		expect(call.init?.method).toBe('POST');
		expect(call.init?.body).toBe(body);
		const headers = call.init?.headers as Record<string, string>;
		expect(headers[SIGNATURE_HEADER]).toBe(sign(body, SECRET));
		expect(SIGNATURE_HEADER).toBe('x-drupflare-signature');
		expect(Object.keys(headers).sort()).toEqual(['content-type', 'x-drupflare-signature']);
	});

	it('reports an event the dashboard already knows as a duplicate, not a failure', async () => {
		const fake = io([json(200, { received: true, duplicate: true, releaseId: null })]);
		expect(await postEvent(hook, 'x', fake)).toEqual({ duplicate: true, releaseId: null });
	});

	it('fails on a refusal, on a 200 that does not say received, and on a body that is not JSON', async () => {
		for (const answer of [
			json(401, { code: 'unauthenticated' }),
			json(422, { code: 'unprocessable' }),
			json(200, { received: false }),
			new Response('<html>', { status: 200 })
		]) {
			await expect(postEvent(hook, 'x', io([answer]))).rejects.toThrow('the hook answered');
		}
	});

	it('never puts the secret in a failure message', async () => {
		const body = eventBody(event());
		const error = await postEvent(
			hook,
			body,
			io([json(401, { code: 'unauthenticated' })])
		).catch((e: unknown) => String(e));
		expect(String(error)).not.toContain(SECRET);
		expect(String(error)).not.toContain(sign(body, SECRET));
	});
});

describe('waiting for the manifest', () => {
	const bytes = enc('{"kind":"worker"}\n');
	const answer = (status: number, body = '') => new Response(body, { status });

	function queued(answers: (Response | Error)[]) {
		const naps: number[] = [];
		const io: Io = {
			fetch: async () => {
				const next = answers.shift();
				if (next === undefined) throw new Error('no answer queued');
				if (next instanceof Error) throw next;
				return next;
			},
			sleep: async (ms) => {
				naps.push(ms);
			}
		};
		return { io, naps };
	}

	it('returns once the URL serves the bytes, after as many gaps as misses', async () => {
		const { io, naps } = queued([
			answer(404),
			new Error('reset'),
			answer(200, '{"kind":"worker"}\n')
		]);
		await waitForManifest('https://x.example/m.json', bytes, io, 5, 7);
		expect(naps).toEqual([7, 7]);
	});

	it('gives up when the URL serves different bytes, which would fail the dashboard digest check', async () => {
		const { io } = queued([answer(200, 'other'), answer(200, 'other')]);
		await expect(waitForManifest('https://x.example/m.json', bytes, io, 2, 1)).rejects.toThrow(
			'differs'
		);
	});

	it('gives up when the URL never answers 200', async () => {
		const { io } = queued([answer(404), answer(404)]);
		await expect(waitForManifest('https://x.example/m.json', bytes, io, 2, 1)).rejects.toThrow(
			'answered 404'
		);
	});
});

describe('the command line', () => {
	function dist() {
		const root = mkdtempSync(join(tmpdir(), 'release-event-'));
		scratch.push(root);
		writeFileSync(join(root, 'SHA256SUMS'), `${HASH}  drupflare-worker-1.1.0.tar.gz\n`);
		return root;
	}
	const args = (root: string, command: string, ...more: string[]) => [
		join(ROOT, 'scripts/release-event.ts'),
		command,
		`--dist=${root}`,
		'--tag=v1.1.0',
		'--repo=example/worker',
		`--root=${ROOT}`,
		...more
	];
	const run = (argv: string[], env: Record<string, string>) =>
		spawnSync('bun', argv, {
			env: { PATH: process.env['PATH'] ?? '', ...env },
			encoding: 'utf8'
		});

	it('writes the manifest from the sums and posts nothing', () => {
		const root = dist();
		const out = execFileSync('bun', args(root, 'manifest'), { encoding: 'utf8' });
		expect(out).toContain('1 assets');
		const manifest = JSON.parse(
			readFileSync(join(root, 'drupflare-release-manifest-1.1.0.json'), 'utf8')
		);
		expect(manifest).toMatchObject({ kind: 'worker', version: '1.1.0', schemaVersion: 7 });
		expect(manifest.assets[0].digest).toBe(`sha256:${HASH}`);
	});

	it('fails closed with no secret and no URL, naming both and sending nothing', () => {
		const root = dist();
		execFileSync('bun', args(root, 'manifest'));
		const none = run(args(root, 'post'), {});
		expect(none.status).toBe(1);
		expect(none.stderr).toContain('DASHBOARD_RELEASE_URL');
		const urlOnly = run(args(root, 'post'), {
			DASHBOARD_RELEASE_URL: 'https://x.invalid/hook'
		});
		expect(urlOnly.status).toBe(1);
		expect(urlOnly.stderr).toContain('DASHBOARD_RELEASE_SECRET');
		expect(urlOnly.stderr).not.toContain('attempt');
	});

	it('prints the event and sends nothing on a dry run, even with the secret and URL set', () => {
		const root = dist();
		execFileSync('bun', args(root, 'manifest'));
		const dry = run(args(root, 'post', '--dry-run'), {
			DASHBOARD_RELEASE_URL: 'https://x.invalid/hook',
			DASHBOARD_RELEASE_SECRET: SECRET
		});
		expect(dry.status).toBe(0);
		expect(dry.stdout).toContain('dry run, nothing sent');
		expect(dry.stdout).toContain('"type":"release.published"');
		expect(dry.stdout + dry.stderr).not.toContain(SECRET);
		expect(dry.stdout).not.toContain('sha256=');
	});
});
