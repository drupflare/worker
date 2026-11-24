/**
 * Composer repositories beyond Packagist and packages.drupal.org: the ones a project lists under
 * `repositories`, and Asset Packagist, which serves the `bower-asset/*` and `npm-asset/*` names.
 *
 * Asset Packagist publishes no `p2` documents. Its `packages.json` names a provider index, one
 * large document mapping every package to the hash its own document is addressed by. The index is
 * scanned as a stream for the one name wanted, so it is never held in memory, and each name found
 * is remembered for the life of the isolate.
 *
 * @module
 */

/** a repository served over https, which the resolver reads as a document or a tag list */
export type RemoteRepository = { type: 'composer' | 'vcs'; url: string };

/** what a lock records for a package: enough to build the one document no registry serves */
export type InlinePackage = {
	version: string;
	type?: string;
	dist?: { url: string; type?: string; shasum?: string };
	source?: { url: string; reference: string };
};

/** one package a project defines itself, as a composer `package` repository or its lock entry */
export type InlineRepository = { type: 'package'; name: string; definition: InlinePackage };

/** a repository a project declares, reduced to the kinds the resolver reads */
export type Repository = RemoteRepository | InlineRepository;

/** the repository that serves `bower-asset/*` and `npm-asset/*` */
export const ASSET_PACKAGIST: RemoteRepository = {
	type: 'composer',
	url: 'https://asset-packagist.org'
};

/** names served only by Asset Packagist */
export const isAssetPackage = (name: string): boolean => /^(bower|npm)-asset\//.test(name);

/** repositories a project may list, and requests one package may spend across them */
export const MAX_REPOSITORIES = 8;
export const MAX_FETCHES_PER_PACKAGE = 12;

/** redirects followed per request */
export const MAX_REDIRECTS = 3;

/** response caps: a small one for any host, and the known index host's large one */
export const BODY_CAP = 4 * 1024 * 1024;
export const INDEX_CAP = 32 * 1024 * 1024;

/** hosts the resolver treats as known, whatever repository asks for them */
const KNOWN_HOSTS = [
	'asset-packagist.org',
	'repo.packagist.org',
	'packages.drupal.org',
	'api.github.com',
	'raw.githubusercontent.com'
];

/** raised when a repository or a URL it names breaks a rule; the message is the reason */
export class RepositoryRefused extends Error {}

const PRIVATE_SUFFIXES = ['.local', '.internal', '.localdomain', '.localhost'];

/** a hostname normalised for comparison: lowercase with no trailing dot */
const normal = (host: string) => host.toLowerCase().replace(/\.$/, '');

/** why a hostname is not a public DNS name, or undefined when it is one */
export function hostRefusal(hostname: string): string | undefined {
	const host = normal(hostname);
	if (host.includes(':') || host.startsWith('[')) return 'an IPv6 literal';
	const labels = host.split('.');
	if (/^(?:0x[0-9a-f]+|\d+)$/i.test(labels.at(-1) ?? '')) return 'an IP address';
	if (labels.length < 2) return 'a single-label host';
	if (host === 'localhost' || PRIVATE_SUFFIXES.some((x) => host.endsWith(x)))
		return 'a local or internal name';
	return undefined;
}

/** a URL that is https, carries no credentials or port, and names a public host */
export function publicHttpsUrl(value: string): URL | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
	return hostRefusal(url.hostname) === undefined ? url : undefined;
}

/** the registrable domain, approximated by the last two labels, or three under a two-letter ccTLD */
function registrable(host: string): string {
	const labels = normal(host).split('.');
	const second = labels.at(-2) ?? '';
	const take =
		labels.at(-1)?.length === 2 &&
		['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'].includes(second)
			? 3
			: 2;
	return labels.slice(-take).join('.');
}

/** whether a URL a repository's own document names may be fetched on that repository's behalf */
export function allowedDerived(target: string, repoUrl: string): string | undefined {
	const url = publicHttpsUrl(target);
	if (!url) return `${target.slice(0, 80)} is not an https URL on a public host`;
	const host = normal(url.hostname);
	if (KNOWN_HOSTS.some((k) => host === k || host.endsWith(`.${k}`))) return undefined;
	const home = normal(new URL(repoUrl).hostname);
	return registrable(host) === registrable(home)
		? undefined
		: `${host} is not on the repository's own domain ${registrable(home)}`;
}

/** counts the requests one package may spend across every repository */
export type Budget = { left: number };

/**
 * Fetches without following redirects blindly: each hop is checked against the repository and
 * capped at `MAX_REDIRECTS`, and the budget is charged per request.
 */
export async function guardedFetch(
	target: string,
	repoUrl: string,
	budget: Budget,
	fetcher: typeof fetch
): Promise<{ res: Response; url: string }> {
	let url = target;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const refusal = allowedDerived(url, repoUrl);
		if (refusal) throw new RepositoryRefused(`repository refused: ${refusal}`);
		if (budget.left-- <= 0)
			throw new RepositoryRefused('repository refused: too many requests for one package');
		const res = await fetcher(url, { redirect: 'manual' });
		const next = res.headers.get('location');
		if (res.status >= 300 && res.status < 400 && next) {
			url = new URL(next, url).toString();
			continue;
		}
		return { res, url };
	}
	throw new RepositoryRefused('repository refused: too many redirects');
}

/** a body that errors once it passes a byte cap */
export function capped(body: ReadableStream<Uint8Array>, cap: number): ReadableStream<Uint8Array> {
	let seen = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > cap)
					throw new RepositoryRefused('repository refused: response over the size cap');
				controller.enqueue(chunk);
			}
		})
	);
}

/** a JSON body read under the cap, or undefined for a failed status */
async function cappedJson(res: Response, cap: number): Promise<unknown | undefined> {
	if (!res.ok || !res.body) return undefined;
	const reader = capped(res.body, cap).getReader();
	const decoder = new TextDecoder();
	let text = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	try {
		return JSON.parse(text + decoder.decode());
	} catch {
		// the parser's message quotes the start of the body, which is not for the caller
		throw new RepositoryRefused('repository refused: a document that is not JSON');
	}
}

const hashes = new Map<string, string>();

/** forgets the remembered provider hashes; for tests */
export function forgetProviderHashes(): void {
	hashes.clear();
}

/**
 * Scans a provider index for `"<name>":{"sha256":"<hex>"}` without holding the document.
 *
 * The needle can straddle two chunks, so the tail of each chunk is carried into the next.
 */
export async function scanProviderHash(
	body: ReadableStream<Uint8Array>,
	name: string
): Promise<string | undefined> {
	const needle = `"${name}":{"sha256":"`;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let carry = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return undefined;
			const text = carry + decoder.decode(value, { stream: true });
			const at = text.indexOf(needle);
			if (at >= 0) {
				const hash = /^[0-9a-f]{64}/.exec(text.slice(at + needle.length))?.[0];
				if (hash) return hash;
			}
			carry = text.slice(-(needle.length + 64));
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

type Root = {
	'metadata-url'?: string;
	'providers-url'?: string;
	'provider-includes'?: Record<string, { sha256?: string }>;
	packages?: Record<string, unknown>;
};

const fill = (template: string, values: Record<string, string>) =>
	template.replace(/%(\w+)%/g, (all, key: string) => values[key] ?? all);

/** whether the index host is one the resolver knows to serve a large provider index */
const isKnownIndexHost = (url: string) => {
	const host = normal(new URL(url).hostname);
	return host === 'asset-packagist.org' || host.endsWith('.asset-packagist.org');
};

/** a composer-type repository's document for one package, or undefined when it has none */
export async function composerDocument(
	repo: RemoteRepository,
	name: string,
	fetcher: typeof fetch = fetch,
	budget: Budget = { left: MAX_FETCHES_PER_PACKAGE }
): Promise<unknown | undefined> {
	const key = name.toLowerCase();
	const get = (target: string) => guardedFetch(target, repo.url, budget, fetcher);
	const root0 = await get(
		new URL('packages.json', `${repo.url.replace(/\/+$/, '')}/`).toString()
	);
	const root = (await cappedJson(root0.res, BODY_CAP)) as Root | undefined;
	if (!root) return undefined;
	const at = (path: string) => new URL(path, root0.url).toString();
	if (root['metadata-url']) {
		const got = await get(at(fill(root['metadata-url'], { package: key })));
		return cappedJson(got.res, BODY_CAP);
	}
	if (root.packages && key in root.packages) return { packages: root.packages };
	const template = root['providers-url'];
	if (!template) return undefined;
	let hash = hashes.get(key);
	if (!hash) {
		for (const [path, meta] of Object.entries(root['provider-includes'] ?? {})) {
			const got = await get(at(fill(path, { hash: meta.sha256 ?? '' })));
			if (!got.res.ok || !got.res.body) continue;
			const cap = isKnownIndexHost(got.url) ? INDEX_CAP : BODY_CAP;
			hash = await scanProviderHash(capped(got.res.body, cap), key);
			if (hash) break;
		}
		if (!hash) return undefined;
		hashes.set(key, hash);
	}
	const got = await get(at(fill(template, { package: key, hash })));
	return cappedJson(got.res, BODY_CAP);
}

/** `owner/repo` of a GitHub URL, or undefined for any other host or an odd name */
export function githubSlug(url: string): string | undefined {
	const slug = /^(?:https:\/\/|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url)?.[1];
	return slug !== undefined && /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : undefined;
}

/**
 * A GitHub repository's tags as the document composer would build from them, when the package name
 * is the repository's own path (`fflch/pragmatica-drupal-module`). Each entry carries the
 * repository's `composer.json` requirements read at that tag; branches are not listed.
 */
export async function githubDocument(
	repo: RemoteRepository,
	name: string,
	fetcher: typeof fetch = fetch,
	budget: Budget = { left: MAX_FETCHES_PER_PACKAGE }
): Promise<unknown | undefined> {
	const slug = githubSlug(repo.url);
	if (!slug || slug.toLowerCase() !== name.toLowerCase()) return undefined;
	const get = (target: string) => guardedFetch(target, 'https://github.com/', budget, fetcher);
	const tagged = await get(`https://api.github.com/repos/${slug}/tags?per_page=10`);
	const tags = (await cappedJson(tagged.res, BODY_CAP)) as { name: string }[] | undefined;
	if (!Array.isArray(tags)) return undefined;
	const list = [];
	for (const tag of tags.slice(0, Math.max(0, budget.left - 1))) {
		const raw = await get(
			`https://raw.githubusercontent.com/${slug}/${encodeURIComponent(tag.name)}/composer.json`
		);
		const manifest = ((await cappedJson(raw.res, BODY_CAP).catch(() => undefined)) ??
			{}) as Record<string, unknown>;
		list.push({
			...manifest,
			name,
			version: tag.name.replace(/^v/i, ''),
			dist: {
				type: 'zip',
				url: `https://api.github.com/repos/${slug}/zipball/${encodeURIComponent(tag.name)}`
			}
		});
	}
	return { packages: { [name]: list } };
}

/** the document for a package the project defines itself, when the name asked for is that one */
export function inlineDocument(repo: InlineRepository, name: string): unknown | undefined {
	if (repo.name.toLowerCase() !== name.toLowerCase()) return undefined;
	const { version, type, dist, source } = repo.definition;
	return {
		packages: {
			[repo.name]: [
				{
					name: repo.name,
					version: version.replace(/^v/i, ''),
					...(type ? { type } : {}),
					...(dist ? { dist } : {}),
					...(source
						? {
								source: {
									...source,
									reference: source.reference.replace(/^refs\/heads\//, '')
								}
							}
						: {})
				}
			]
		}
	};
}

/** the first document any repository answers for a package, within one request budget */
export async function repositoryDocument(
	repos: readonly Repository[],
	name: string,
	fetcher: typeof fetch = fetch
): Promise<unknown | undefined> {
	const budget: Budget = { left: MAX_FETCHES_PER_PACKAGE };
	for (const repo of repos.slice(0, MAX_REPOSITORIES)) {
		const doc =
			repo.type === 'package'
				? inlineDocument(repo, name)
				: repo.type === 'vcs'
					? await githubDocument(repo, name, fetcher, budget)
					: await composerDocument(repo, name, fetcher, budget);
		if (doc) return doc;
	}
	return undefined;
}

/** hosts an inline package's git source may name; both serve a zip of any ref */
const SOURCE_HOSTS = ['github.com', 'git.drupalcode.org'];

/** the inline definition a `package|<json>` value carries, or undefined when any field breaks a rule */
export function inlineRepository(json: string): InlineRepository | undefined {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const { name, version, type, dist, source } = raw as {
		name?: unknown;
		version?: unknown;
		type?: unknown;
		dist?: { url?: unknown; type?: unknown; shasum?: unknown };
		source?: { url?: unknown; reference?: unknown };
	};
	if (typeof name !== 'string' || !/^[a-z0-9][\w.-]*\/[\w.-]+$/i.test(name)) return undefined;
	if (typeof version !== 'string' || !/^[\w.+~-]{1,64}$/.test(version)) return undefined;
	if (type !== undefined && (typeof type !== 'string' || !/^[\w-]{1,40}$/.test(type)))
		return undefined;
	const definition: InlinePackage = { version, ...(type ? { type: type as string } : {}) };
	if (dist) {
		if (typeof dist.url !== 'string' || publicHttpsUrl(dist.url) === undefined)
			return undefined;
		const kind = dist.type === 'tar' || dist.type === 'zip' ? dist.type : undefined;
		const shasum =
			typeof dist.shasum === 'string' && /^[0-9a-f]{40,64}$/i.test(dist.shasum)
				? dist.shasum
				: undefined;
		definition.dist = {
			url: dist.url,
			...(kind ? { type: kind } : {}),
			...(shasum ? { shasum } : {})
		};
	}
	if (source) {
		const url = typeof source.url === 'string' ? publicHttpsUrl(source.url) : undefined;
		if (!url || !SOURCE_HOSTS.includes(normal(url.hostname))) return undefined;
		if (typeof source.reference !== 'string' || !/^[\w./-]{1,100}$/.test(source.reference))
			return undefined;
		definition.source = { url: url.toString().replace(/\/$/, ''), reference: source.reference };
	}
	return definition.dist || definition.source ? { type: 'package', name, definition } : undefined;
}

/** the `repository` query value for one repository; `parseRepositories` reads it back */
export function repositoryValue(repo: Repository): string {
	return repo.type === 'package'
		? `package|${JSON.stringify({ name: repo.name, ...repo.definition })}`
		: `${repo.type}|${repo.url}`;
}

/**
 * `type|url` pairs, and `package|<json>` definitions, from repeated `repository` query values. Only
 * an https URL on a public DNS name is kept, and no more than `MAX_REPOSITORIES`; anything else is
 * dropped.
 */
export function parseRepositories(values: readonly string[]): Repository[] {
	return values
		.flatMap((value): Repository[] => {
			const [type, ...rest] = value.split('|');
			const url = rest.join('|');
			if (type === 'package') {
				const inline = value.length <= 4096 ? inlineRepository(url) : undefined;
				return inline ? [inline] : [];
			}
			const ok =
				type === 'vcs' ? githubSlug(url) !== undefined : publicHttpsUrl(url) !== undefined;
			return (type === 'composer' || type === 'vcs') && ok ? [{ type, url }] : [];
		})
		.slice(0, MAX_REPOSITORIES);
}
