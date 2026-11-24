import { afterEach, describe, expect, it } from 'vitest';
import { distOf, metadataUrl, pickVersion } from '../../../../src/ops/composer/package-install';
import {
	allowedDerived,
	BODY_CAP,
	capped,
	composerDocument,
	forgetProviderHashes,
	githubDocument,
	githubSlug,
	hostRefusal,
	isAssetPackage,
	MAX_REDIRECTS,
	MAX_REPOSITORIES,
	parseRepositories,
	repositoryDocument,
	RepositoryRefused,
	repositoryValue,
	scanProviderHash
} from '../../../../src/ops/composer/repositories';

const HASH = 'a'.repeat(64);
const streamOf = (...chunks: string[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		}
	});

afterEach(() => forgetProviderHashes());

describe('scanning a provider index', () => {
	const needle = `"bower-asset/jquery":{"sha256":"${HASH}"}`;

	it('finds a name in one chunk', async () => {
		const index = `{"providers":{"bower-asset/other":{"sha256":"${'b'.repeat(64)}"},${needle}}}`;
		expect(await scanProviderHash(streamOf(index), 'bower-asset/jquery')).toBe(HASH);
	});

	it('finds a name that straddles two chunks, and one split inside the hash', async () => {
		const at = needle.indexOf('"sha256"');
		expect(
			await scanProviderHash(
				streamOf(`{${needle.slice(0, at)}`, `${needle.slice(at)}}`),
				'bower-asset/jquery'
			)
		).toBe(HASH);
		expect(
			await scanProviderHash(
				streamOf(`{${needle.slice(0, -20)}`, `${needle.slice(-20)}}`),
				'bower-asset/jquery'
			)
		).toBe(HASH);
	});

	it('does not take a name that only starts with the one asked for', async () => {
		const index = `{"bower-asset/jquery-ui":{"sha256":"${HASH}"}}`;
		expect(await scanProviderHash(streamOf(index), 'bower-asset/jquery')).toBeUndefined();
	});
});

describe('a composer repository', () => {
	const route = (table: Record<string, () => Response>) =>
		(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			const answer = table[url];
			return answer ? answer() : new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;

	it('reads a v1 provider index and the document its hash addresses, lowercasing the name', async () => {
		const fetcher = route({
			'https://assets.test/packages.json': () =>
				Response.json({
					'providers-url': '/p/%package%/%hash%.json',
					'provider-includes': {
						'p/provider-latest/%hash%.json': { sha256: 'c'.repeat(64) }
					}
				}),
			[`https://assets.test/p/provider-latest/${'c'.repeat(64)}.json`]: () =>
				new Response(
					streamOf(`{"providers":{"npm-asset/fakeobjects":{"sha256":"${HASH}"}}}`)
				),
			[`https://assets.test/p/npm-asset/fakeobjects/${HASH}.json`]: () =>
				Response.json({
					packages: { 'npm-asset/fakeobjects': { '4.15.0': { version: '4.15.0' } } }
				})
		});
		const doc = await composerDocument(
			{ type: 'composer', url: 'https://assets.test' },
			'npm-asset/FakeObjects',
			fetcher
		);
		expect(pickVersion(doc, 'npm-asset/fakeobjects', '4.15.0')).toMatchObject({
			version: '4.15.0'
		});
	});

	it('remembers a hash so the index is scanned once per name', async () => {
		let indexReads = 0;
		const fetcher = route({
			'https://assets.test/packages.json': () =>
				Response.json({
					'providers-url': '/p/%package%/%hash%.json',
					'provider-includes': { 'p/idx/%hash%.json': { sha256: 'd'.repeat(64) } }
				}),
			[`https://assets.test/p/idx/${'d'.repeat(64)}.json`]: () => {
				indexReads++;
				return new Response(streamOf(`{"x/y":{"sha256":"${HASH}"}}`));
			},
			[`https://assets.test/p/x/y/${HASH}.json`]: () => Response.json({ packages: {} })
		});
		const repo = { type: 'composer', url: 'https://assets.test' } as const;
		await composerDocument(repo, 'x/y', fetcher);
		await composerDocument(repo, 'x/y', fetcher);
		expect(indexReads).toBe(1);
	});

	it('reads a repository that names a metadata-url', async () => {
		const fetcher = route({
			'https://r.test/packages.json': () =>
				Response.json({ 'metadata-url': '/p2/%package%.json' }),
			'https://r.test/p2/acme/app.json': () =>
				Response.json({ packages: { 'acme/app': [{ version: '1.0.0' }] } })
		});
		const doc = await composerDocument(
			{ type: 'composer', url: 'https://r.test/' },
			'acme/app',
			fetcher
		);
		expect(pickVersion(doc, 'acme/app')).toMatchObject({ version: '1.0.0' });
	});

	it('answers undefined when the repository has no such package', async () => {
		const fetcher = route({
			'https://r.test/packages.json': () => Response.json({ packages: {} })
		});
		expect(
			await composerDocument(
				{ type: 'composer', url: 'https://r.test' },
				'acme/none',
				fetcher
			)
		).toBeUndefined();
	});
});

describe('a GitHub repository listed by a project', () => {
	it('names the owner and repository of the URL forms composer accepts', () => {
		expect(githubSlug('https://github.com/fflch/pragmatica-drupal-module.git')).toBe(
			'fflch/pragmatica-drupal-module'
		);
		expect(githubSlug('git@github.com:uspdev/replicado_drupal.git')).toBe(
			'uspdev/replicado_drupal'
		);
		expect(githubSlug('https://gitlab.com/a/b.git')).toBeUndefined();
	});

	it('builds a document from tags, with the requirements read at each tag', async () => {
		const fetcher = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/tags'))
				return Response.json([{ name: 'v1.0.1' }, { name: '1.0.0' }]);
			if (url.endsWith('/v1.0.1/composer.json'))
				return Response.json({ require: { 'uspdev/utils': '^1.0' } });
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;
		const doc = await githubDocument(
			{ type: 'vcs', url: 'https://github.com/uspdev/replicado_drupal.git' },
			'uspdev/replicado_drupal',
			fetcher
		);
		const picked = pickVersion(doc, 'uspdev/replicado_drupal', '1.0.1');
		expect(picked).toMatchObject({
			version: '1.0.1',
			require: { 'uspdev/utils': '^1.0' },
			dist: {
				type: 'zip',
				url: 'https://api.github.com/repos/uspdev/replicado_drupal/zipball/v1.0.1'
			}
		});
	});

	it('does not answer for a package whose name is not the repository path', async () => {
		const fetcher = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
		expect(
			await githubDocument(
				{ type: 'vcs', url: 'https://github.com/uspdev/replicado_drupal.git' },
				'other/name',
				fetcher
			)
		).toBeUndefined();
	});

	it('tries each repository in order and takes the first document', async () => {
		const fetcher = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/tags')) return Response.json([{ name: '2.0.0' }]);
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;
		const doc = await repositoryDocument(
			[
				{ type: 'composer', url: 'https://empty.test' },
				{ type: 'vcs', url: 'https://github.com/a/b.git' }
			],
			'a/b',
			fetcher
		);
		expect(pickVersion(doc, 'a/b')).toMatchObject({ version: '2.0.0' });
	});
});

describe('reading the query and the names', () => {
	it('keeps https composer and vcs repositories and drops the rest', () => {
		expect(
			parseRepositories([
				'composer|https://asset-packagist.org',
				'vcs|https://github.com/a/b.git',
				'composer|http://insecure.test',
				'path|../local',
				'garbage'
			])
		).toEqual([
			{ type: 'composer', url: 'https://asset-packagist.org' },
			{ type: 'vcs', url: 'https://github.com/a/b.git' }
		]);
	});

	it('recognises the names only asset packagist serves', () => {
		expect(isAssetPackage('bower-asset/jquery')).toBe(true);
		expect(isAssetPackage('npm-asset/fakeobjects')).toBe(true);
		expect(isAssetPackage('drupal/token')).toBe(false);
	});

	it('finds a package a requirement spells with capitals, as packagist keys it in lowercase', () => {
		const doc = { packages: { 'querypath/querypath': [{ version: '3.0.5' }] } };
		expect(pickVersion(doc, 'querypath/QueryPath', '^3.0')).toMatchObject({ version: '3.0.5' });
		expect(metadataUrl('composer', 'querypath/QueryPath')).toBe(
			'https://repo.packagist.org/p2/querypath/querypath.json'
		);
	});

	it('reads a v1 document that keys its versions by number', () => {
		const doc = {
			packages: {
				'bower-asset/jquery': {
					'4.1.0': { version: '4.1.0' },
					'4.0.0': { version: '4.0.0' }
				}
			}
		};
		expect(pickVersion(doc, 'bower-asset/jquery', '4.0.0')).toMatchObject({ version: '4.0.0' });
		expect(pickVersion(doc, 'bower-asset/jquery')).toMatchObject({ version: '4.1.0' });
	});
});

describe('the repositories a caller may name', () => {
	it('refuses IP literals, localhost, single-label and internal names, however they are spelled', () => {
		for (const host of [
			'127.0.0.1',
			'10.0.0.5',
			'169.254.169.254',
			'0x7f.1',
			'2130706433',
			'[::1]',
			'[fd00::1]',
			'localhost',
			'LOCALHOST.',
			'intranet',
			'printer.local',
			'db.internal',
			'host.localdomain',
			'a.localhost'
		]) {
			const urlHost = host.startsWith('[') ? host : host;
			expect(parseRepositories([`composer|https://${urlHost}/`]), host).toEqual([]);
		}
		expect(hostRefusal('Example.COM.')).toBeUndefined();
		expect(parseRepositories(['composer|https://Example.COM./'])).toHaveLength(1);
	});

	it('refuses credentials, a port and a non-https scheme', () => {
		expect(parseRepositories(['composer|https://user:pw@r.test/'])).toEqual([]);
		expect(parseRepositories(['composer|https://r.test:8443/'])).toEqual([]);
		expect(parseRepositories(['composer|ftp://r.test/'])).toEqual([]);
	});

	it('keeps no more than the repository cap', () => {
		const many = Array.from(
			{ length: MAX_REPOSITORIES + 5 },
			(_, i) => `composer|https://r${i}.test`
		);
		expect(parseRepositories(many)).toHaveLength(MAX_REPOSITORIES);
	});
});

describe('URLs a repository names for itself', () => {
	const repo = 'https://repo.example.com';

	it('allows its own domain and its subdomains, and the known hosts', () => {
		expect(allowedDerived('https://repo.example.com/p2/x.json', repo)).toBeUndefined();
		expect(allowedDerived('https://cdn.example.com/p2/x.json', repo)).toBeUndefined();
		expect(allowedDerived('https://cdn.asset-packagist.org/p/x.json', repo)).toBeUndefined();
		expect(allowedDerived('https://api.github.com/repos/a/b/tags', repo)).toBeUndefined();
	});

	it('refuses another domain, http, an IP address and an internal name with a reason', () => {
		expect(allowedDerived('https://evil.test/x', repo)).toMatch(
			/not on the repository's own domain/
		);
		expect(allowedDerived('http://repo.example.com/x', repo)).toMatch(/not an https URL/);
		expect(allowedDerived('https://169.254.169.254/latest', repo)).toMatch(/not an https URL/);
		expect(allowedDerived('https://metadata.internal/x', repo)).toMatch(/not an https URL/);
	});

	it('refuses a metadata-url that points at another host', async () => {
		const fetcher = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/packages.json'))
				return Response.json({ 'metadata-url': 'https://169.254.169.254/%package%.json' });
			return new Response('x');
		}) as unknown as typeof fetch;
		await expect(
			composerDocument({ type: 'composer', url: 'https://r.example.com' }, 'a/b', fetcher)
		).rejects.toThrow(/repository refused: .*not an https URL/);
	});
});

describe('redirects, size and request counts', () => {
	const repo = { type: 'composer', url: 'https://r.example.com' } as const;

	it('revalidates a redirect target and refuses one that leaves the domain', async () => {
		const fetcher = (async () =>
			new Response(null, {
				status: 302,
				headers: { location: 'https://evil.test/x' }
			})) as unknown as typeof fetch;
		await expect(composerDocument(repo, 'a/b', fetcher)).rejects.toThrow(/own domain/);
	});

	it('follows a redirect inside the domain, and asks for it not to be followed automatically', async () => {
		const seen: (string | undefined)[] = [];
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			seen.push(init?.redirect);
			if (String(input) === 'https://r.example.com/packages.json')
				return new Response(null, {
					status: 301,
					headers: { location: 'https://cdn.example.com/packages.json' }
				});
			return Response.json({ packages: { 'a/b': [{ version: '1.0.0' }] } });
		}) as unknown as typeof fetch;
		const doc = await composerDocument(repo, 'a/b', fetcher);
		expect(pickVersion(doc, 'a/b')).toMatchObject({ version: '1.0.0' });
		expect(seen.every((r) => r === 'manual')).toBe(true);
	});

	it('stops after the redirect cap', async () => {
		let n = 0;
		const fetcher = (async () => {
			n++;
			return new Response(null, {
				status: 302,
				headers: { location: `https://r.example.com/${n}` }
			});
		}) as unknown as typeof fetch;
		await expect(composerDocument(repo, 'a/b', fetcher)).rejects.toThrow(/too many redirects/);
		expect(n).toBe(MAX_REDIRECTS + 1);
	});

	it('errors on a body past its cap', async () => {
		const big = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(BODY_CAP + 1));
				controller.close();
			}
		});
		await expect(capped(big, BODY_CAP).getReader().read()).rejects.toBeInstanceOf(
			RepositoryRefused
		);
	});

	it('stops a package that would need more requests than its budget', async () => {
		const fetcher = (async () =>
			new Response('{}', { status: 404 })) as unknown as typeof fetch;
		const repos = Array.from({ length: MAX_REPOSITORIES }, (_, i) => ({
			type: 'composer' as const,
			url: `https://r${i}.example.com`
		}));
		await expect(repositoryDocument(repos, 'a/b', fetcher)).resolves.toBeUndefined();
		let calls = 0;
		const counting = (async () => {
			calls++;
			return Response.json({
				'providers-url': '/p/%package%/%hash%.json',
				'provider-includes': {
					'p/a/%hash%.json': {},
					'p/b/%hash%.json': {},
					'p/c/%hash%.json': {},
					'p/d/%hash%.json': {},
					'p/e/%hash%.json': {},
					'p/f/%hash%.json': {},
					'p/g/%hash%.json': {},
					'p/h/%hash%.json': {},
					'p/i/%hash%.json': {},
					'p/j/%hash%.json': {},
					'p/k/%hash%.json': {},
					'p/l/%hash%.json': {},
					'p/m/%hash%.json': {}
				}
			});
		}) as unknown as typeof fetch;
		await expect(repositoryDocument(repos, 'a/b', counting)).rejects.toThrow(
			/too many requests/
		);
		expect(calls).toBeLessThanOrEqual(12);
	});
});

describe('what a failed fetch tells the caller', () => {
	it('names the refusal and never quotes the body', async () => {
		const fetcher = (async () =>
			new Response('SECRET-INTERNAL-BODY not json', {
				status: 200
			})) as unknown as typeof fetch;
		const failure = await composerDocument(
			{ type: 'composer', url: 'https://r.example.com' },
			'a/b',
			fetcher
		).catch((e: Error) => e);
		expect(failure).toBeInstanceOf(RepositoryRefused);
		expect(String((failure as Error).message)).toBe(
			'repository refused: a document that is not JSON'
		);
	});
});

describe('a branch held at a commit', () => {
	const doc = {
		packages: {
			'drupal/ego': [
				{
					version: 'dev-1.0.x',
					source: {
						type: 'git',
						url: 'https://git.drupalcode.org/project/ego.git',
						reference: 'newhead'
					}
				}
			]
		}
	};

	it('keeps the commit the constraint names instead of the branch head', () => {
		const entry = pickVersion(
			doc,
			'drupal/ego',
			'dev-1.0.x#57a1fd42328135560ff1833a9a92d2bc7ab4444d'
		);
		expect(entry).toMatchObject({
			version: 'dev-1.0.x',
			source: { reference: '57a1fd42328135560ff1833a9a92d2bc7ab4444d' }
		});
		expect(entry?.['dist']).toBeUndefined();
	});

	it('still reads the head when no commit is named', () => {
		expect(pickVersion(doc, 'drupal/ego', 'dev-1.0.x')).toMatchObject({
			source: { reference: 'newhead' }
		});
	});
});

describe('a package the project defines itself', () => {
	const WANT = [
		{
			name: 'ckeditor-plugin/fakeobjects',
			constraint: '4.15.0',
			definition: {
				version: '4.15.0',
				type: 'drupal-library',
				dist: {
					url: 'https://download.ckeditor.com/fakeobjects/releases/fakeobjects_4.15.0.zip',
					type: 'zip'
				}
			},
			url: 'https://download.ckeditor.com/fakeobjects/releases/fakeobjects_4.15.0.zip',
			mount: 'libraries/fakeobjects'
		},
		{
			name: 'briancherne/jquery-hoverintent',
			constraint: '1.10.1',
			definition: {
				version: 'v1.10.1',
				type: 'drupal-library',
				source: {
					url: 'https://github.com/briancherne/jquery-hoverIntent',
					reference: 'v1.10.1'
				}
			},
			url: 'https://codeload.github.com/briancherne/jquery-hoverIntent/zip/v1.10.1',
			mount: 'libraries/jquery-hoverintent'
		},
		{
			name: 'drupal/content_moderation_revert',
			constraint: '1.x-dev',
			definition: {
				version: '1.x-dev',
				type: 'drupal-module',
				source: {
					url: 'https://git.drupalcode.org/sandbox/sam-3118829.git',
					reference: 'refs/heads/8.x-1.x'
				}
			},
			url: 'https://git.drupalcode.org/sandbox/sam-3118829/-/archive/8.x-1.x/sam-3118829-8.x-1.x.zip',
			mount: 'modules/contrib/content_moderation_revert'
		},
		{
			name: 'drupal_git/viewsreference_filter',
			constraint: 'dev-1.x#e53af5ceef0e706d440df7573176ce7cf4fa5b8f',
			definition: {
				version: 'dev-1.x',
				type: 'drupal-module',
				source: {
					url: 'https://git.drupalcode.org/project/viewsreference_filter.git',
					reference: 'e53af5ceef0e706d440df7573176ce7cf4fa5b8f'
				}
			},
			url: 'https://git.drupalcode.org/project/viewsreference_filter/-/archive/e53af5ceef0e706d440df7573176ce7cf4fa5b8f/viewsreference_filter-e53af5ceef0e706d440df7573176ce7cf4fa5b8f.zip',
			mount: 'modules/contrib/viewsreference_filter'
		}
	];

	it.each(WANT)(
		'resolves $name from its lock entry to the archive the lock names',
		async ({ name, constraint, definition, url, mount }) => {
			const doc = await repositoryDocument([{ type: 'package', name, definition }], name);
			const entry = pickVersion(doc, name, constraint);
			expect(entry).toBeDefined();
			const dist = distOf(entry as Record<string, unknown>, name);
			expect(dist).toMatchObject({ url, mount });
			expect(await repositoryDocument([], name)).toBeUndefined();
		}
	);

	it('answers only for the name it defines', async () => {
		const [one] = WANT;
		const repo = { type: 'package' as const, name: one!.name, definition: one!.definition };
		expect(await repositoryDocument([repo], 'acme/other')).toBeUndefined();
		expect(await repositoryDocument([repo], one!.name.toUpperCase())).toBeDefined();
	});

	it('travels as one query value and is read back unchanged', () => {
		for (const one of WANT) {
			const repo = { type: 'package' as const, name: one.name, definition: one.definition };
			expect(parseRepositories([repositoryValue(repo)])).toEqual([repo]);
		}
	});

	it('drops a definition that breaks a rule', () => {
		const ok = {
			name: 'acme/lib',
			version: '1.0.0',
			dist: { url: 'https://dist.example.com/lib.zip', type: 'zip' }
		};
		const bad = [
			{ ...ok, dist: { url: 'http://dist.example.com/lib.zip' } },
			{ ...ok, dist: { url: 'https://localhost/lib.zip' } },
			{ ...ok, dist: { url: 'https://10.0.0.1/lib.zip' } },
			{ ...ok, dist: { url: 'https://user:pw@dist.example.com/lib.zip' } },
			{
				...ok,
				dist: undefined,
				source: { url: 'https://evil.example/x.git', reference: 'main' }
			},
			{
				...ok,
				dist: undefined,
				source: { url: 'https://github.com/acme/lib', reference: 'a b' }
			},
			{ ...ok, dist: undefined },
			{ ...ok, name: '../../etc' },
			{ ...ok, version: 'x'.repeat(65) },
			{ ...ok, type: 'a b' }
		];
		for (const one of bad) {
			expect(parseRepositories([`package|${JSON.stringify(one)}`])).toEqual([]);
		}
		expect(parseRepositories(['package|not json'])).toEqual([]);
		expect(parseRepositories([`package|${JSON.stringify(ok)}`])).toHaveLength(1);
		expect(
			parseRepositories([`package|${JSON.stringify({ ...ok, note: 'x'.repeat(5000) })}`])
		).toEqual([]);
	});

	it('keeps a digest the lock carries and drops one that is not hex', () => {
		const base = { name: 'acme/lib', version: '1.0.0' };
		const dist = { url: 'https://dist.example.com/lib.zip', type: 'zip' };
		const sha = 'a'.repeat(40);
		const [kept] = parseRepositories([
			`package|${JSON.stringify({ ...base, dist: { ...dist, shasum: sha } })}`
		]);
		const [dropped] = parseRepositories([
			`package|${JSON.stringify({ ...base, dist: { ...dist, shasum: 'zz' } })}`
		]);
		expect(kept).toMatchObject({ definition: { dist: { shasum: sha } } });
		expect((dropped as { definition: { dist: object } }).definition.dist).not.toHaveProperty(
			'shasum'
		);
	});
});
