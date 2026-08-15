import {
	checkRequirements,
	newestVersion,
	verdictFor,
	type Conflict
} from '../../src/ops/packagist.js';
import { SHIPPED_LOCK_VERSIONS } from '../../src/ops/shipped-lock.js';
import { QA_MODULES } from './modules.js';

/**
 * What `/installable` would answer if its metadata URL were right.
 *
 *   bun scripts/qa/oracle-probe.ts [--url=current|fixed] [--json=out.json]
 *
 * So this drives the REAL `newestVersion` / `checkRequirements` / `verdictFor` out of
 * `src/ops/packagist.ts` -- imported, never reimplemented -- against both the shipped URL and the
 * corrected one. The difference between the two columns is the cost of the bug.
 *
 * `--url=current` reproduces the shipped behaviour; `--url=fixed` uses the endpoint drupal.org's
 * own `packages.json` declares in its `metadata-url` field. Neither is hardcoded from memory: run
 * `curl -s https://packages.drupal.org/8/packages.json` to see it.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const hit = args.find((a: string) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (hit === undefined) return undefined;
	return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};

/** what `src/ops/packagist.ts` builds today */
export function shippedUrl(name: string): string {
	const vendor = String(name ?? '').split('/')[0];
	return vendor === 'drupal'
		? `https://packages.drupal.org/8/p2/${name}.json`
		: `https://repo.packagist.org/p2/${name}.json`;
}

/** what drupal.org's `packages.json` declares under `metadata-url` */
export function correctedUrl(name: string): string {
	const vendor = String(name ?? '').split('/')[0];
	return vendor === 'drupal'
		? `https://packages.drupal.org/files/packages/8/p2/${name}.json`
		: `https://repo.packagist.org/p2/${name}.json`;
}

interface Probe {
	composer: string;
	url: string;
	status: number;
	verdict: string;
	version: string | null;
	note: string;
	conflicts: Conflict[];
}

async function probe(name: string, url: string): Promise<Probe> {
	let res: Response;
	try {
		res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
	} catch (e) {
		return {
			composer: name,
			url,
			status: 0,
			verdict: 'unverifiable',
			version: null,
			note: `unreachable: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
			conflicts: []
		};
	}
	if (!res.ok) {
		return {
			composer: name,
			url,
			status: res.status,
			verdict: 'not-found',
			version: null,
			note: `packagist returned ${res.status}`,
			conflicts: []
		};
	}
	const meta = (await res.json()) as unknown;
	const newest = newestVersion(meta, name);
	if (!newest) {
		return {
			composer: name,
			url,
			status: res.status,
			verdict: 'not-found',
			version: null,
			note: 'no non-dev release in the payload',
			conflicts: []
		};
	}
	const { conflicts } = checkRequirements(newest.require, SHIPPED_LOCK_VERSIONS);
	return {
		composer: name,
		url,
		status: res.status,
		verdict: verdictFor(conflicts),
		version: newest.version,
		note: conflicts.map((c) => c.detail).join('; ') || 'every direct requirement satisfied',
		conflicts
	};
}

const which = flag('url') ?? 'both';
const build = which === 'current' ? shippedUrl : correctedUrl;
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

const out: { current?: Probe; fixed?: Probe; composer: string }[] = [];

// deduped: `views` and `media` are core and share one composer name
const names = [...new Set(QA_MODULES.map((m) => m.composer))];

console.log(pad('package', 34) + pad('shipped URL', 14) + pad('corrected URL', 16) + 'conflict');
console.log('-'.repeat(110));

for (const name of names) {
	const row: { current?: Probe; fixed?: Probe; composer: string } = { composer: name };
	if (which === 'both' || which === 'current') row.current = await probe(name, shippedUrl(name));
	if (which === 'both' || which === 'fixed') row.fixed = await probe(name, correctedUrl(name));
	out.push(row);
	console.log(
		pad(name, 34) +
			pad(row.current ? `${row.current.verdict}` : '-', 14) +
			pad(row.fixed ? `${row.fixed.verdict}` : '-', 16) +
			(row.fixed?.conflicts.map((c) => c.detail).join('; ') ?? '').slice(0, 60)
	);
}

const changed = out.filter((r) => r.current && r.fixed && r.current.verdict !== r.fixed.verdict);
console.log('');
console.log(`${out.length} package(s); ${changed.length} answer differently once the URL is right`);

const jsonOut = flag('json');
if (jsonOut) {
	await Bun.write(jsonOut, `${JSON.stringify({ build: build.name, out }, null, 2)}\n`);
	console.log(`wrote ${jsonOut}`);
}
