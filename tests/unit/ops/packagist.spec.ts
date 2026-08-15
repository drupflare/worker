import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PLATFORM,
	checkInstallable,
	checkRequirements,
	isValidPackageName,
	lockVersions,
	newestVersion,
	packagistUrl,
	verdictFor
} from '../../../src/ops/packagist';

/**
 * The one-subrequest installability check.
 *
 * The deliverable is the REFUSAL, not the acceptance. "Cannot install" is unactionable and gets
 * retried; "webform 6.2.0 requires drupal/core ^10 and this site ships 11.4.5" is a decision. So most
 * of what follows asserts that a conflict is named, and that nothing degrades into a false yes --
 * a network failure, an unjudgeable constraint and a missing dependency must each land somewhere other
 * than `installable`.
 */

/** a p2 payload in the shape Packagist actually returns: newest first, under `packages[name]` */
function p2(name: string, versions: Array<{ version: string; require?: Record<string, string> }>) {
	return { packages: { [name]: versions } };
}

function fetcherFor(body: unknown, status = 200): (url: string) => Promise<Response> {
	return async () => new Response(JSON.stringify(body), { status });
}

/** what this site actually ships, trimmed to what the assertions need */
const INSTALLED = { 'drupal/core': '11.4.5', 'drupal/core-recommended': '11.4.5' };

describe('the URL and the name, because a name becomes a URL', () => {
	it('sends drupal/* to drupal.org and everything else to Packagist', () => {
		// the regression. Drupal contrib is not on Packagist at all, so this test previously pinned
		// the endpoint that 404s for every package the product exists to install -- measured:
		// repo.packagist.org/p2/drupal/pathauto.json is a 404, packages.drupal.org/8 has it.
		expect(packagistUrl('drupal/webform')).toBe(
			'https://packages.drupal.org/8/p2/drupal/webform.json'
		);
		expect(packagistUrl('drupal/pathauto')).toBe(
			'https://packages.drupal.org/8/p2/drupal/pathauto.json'
		);
		// a non-Drupal dependency still resolves against Packagist, which does have it
		expect(packagistUrl('symfony/yaml')).toBe(
			'https://repo.packagist.org/p2/symfony/yaml.json'
		);
	});

	it('routes on the vendor, so a lookalike vendor does not reach drupal.org', () => {
		// `drupalx/foo` and `notdrupal/foo` are ordinary Packagist vendors; a prefix match rather
		// than an exact vendor comparison would send them to a repository that does not have them
		expect(packagistUrl('drupalx/foo')).toBe('https://repo.packagist.org/p2/drupalx/foo.json');
		expect(packagistUrl('notdrupal/foo')).toBe(
			'https://repo.packagist.org/p2/notdrupal/foo.json'
		);
	});

	it('accepts real package names', () => {
		for (const name of ['drupal/webform', 'drupal/admin_toolbar', 'symfony/http-kernel']) {
			expect(isValidPackageName(name), name).toBe(true);
		}
	});

	it('REFUSES anything that would need escaping, rather than encoding it', () => {
		// building a URL from unvalidated input is how a traversal reaches a metadata host
		for (const name of [
			'../../etc/passwd',
			'drupal/web form',
			'drupal',
			'Drupal/Webform',
			'drupal/webform?x=1',
			'',
			'a//b'
		]) {
			expect(isValidPackageName(name), name).toBe(false);
		}
	});
});

describe('reading the lock and the payload', () => {
	it('maps name to version from a lock', () => {
		const lock = {
			packages: [
				{ name: 'a/b', version: '1.2.3' },
				{ name: 'c/d', version: 'v2' }
			]
		};
		expect(lockVersions(lock)).toEqual({ 'a/b': '1.2.3', 'c/d': 'v2' });
	});

	it('returns an empty map for junk rather than throwing', () => {
		for (const lock of [null, undefined, {}, { packages: 'nope' }, { packages: [{}] }]) {
			expect(lockVersions(lock)).toEqual({});
		}
	});

	it('takes the newest non-dev release', () => {
		const meta = p2('a/b', [
			{ version: 'dev-main' },
			{ version: '3.0.0', require: { php: '>=8.1' } }
		]);
		expect(newestVersion(meta, 'a/b')).toEqual({ version: '3.0.0', require: { php: '>=8.1' } });
	});

	it('returns null when every release is a dev branch', () => {
		// nothing here can order a dev branch, so it is not a candidate rather than a fallback
		expect(
			newestVersion(p2('a/b', [{ version: 'dev-main' }, { version: '1.x-dev' }]), 'a/b')
		).toBeNull();
	});

	it('drops non-string requirement values instead of passing them to the checker', () => {
		const meta = { packages: { 'a/b': [{ version: '1.0.0', require: { php: 8, ok: '^1' } }] } };
		expect(newestVersion(meta, 'a/b')?.require).toEqual({ ok: '^1' });
	});
});

describe('the refusal names the conflict', () => {
	it('blocks a module needing a core version this site does not have', () => {
		const { conflicts } = checkRequirements({ 'drupal/core': '^10' }, INSTALLED);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.reason).toBe('version');
		// the whole point: the operator learns WHICH package and WHICH constraint
		expect(conflicts[0]!.detail).toContain('drupal/core');
		expect(conflicts[0]!.detail).toContain('11.4.5');
		expect(conflicts[0]!.detail).toContain('^10');
	});

	it('blocks a module needing a package this site does not ship at all', () => {
		const { conflicts } = checkRequirements({ 'drupal/paragraphs': '^1.0' }, INSTALLED);
		expect(conflicts[0]!.reason).toBe('missing');
		expect(conflicts[0]!.installed).toBeNull();
		expect(conflicts[0]!.detail).toContain('not provided');
	});

	it('blocks a module needing an extension the BUILD cannot have', () => {
		// pdo_sqlite is absent from this binary, and a blanket `ext-*` allowance would have waved it
		// through -- which is why the platform map lists extensions instead of pattern-matching
		const { conflicts } = checkRequirements({ 'ext-pdo_sqlite': '*' }, INSTALLED);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.reason).toBe('missing');
	});

	it('satisfies a platform requirement the build does provide', () => {
		const { conflicts, satisfied } = checkRequirements(
			{ php: '>=8.3', 'ext-mbstring': '*' },
			INSTALLED
		);
		expect(conflicts).toEqual([]);
		expect(satisfied).toHaveLength(2);
	});

	it('reports an unjudgeable constraint as unverifiable, NOT as satisfied', () => {
		const { conflicts } = checkRequirements({ 'drupal/core': 'dev-main as 11' }, INSTALLED);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.reason).toBe('unverifiable');
		expect(conflicts[0]!.detail).toContain('cannot decide');
	});
});

describe('the verdict word, and what may never be installable', () => {
	it('is installable only with no conflicts at all', () => {
		expect(verdictFor([])).toBe('installable');
	});

	it('is blocked when any conflict is definite', () => {
		expect(
			verdictFor([
				{ requires: 'a', constraint: '^1', installed: '2', reason: 'version', detail: '' }
			])
		).toBe('blocked');
	});

	it('is unverifiable when the only conflicts are unjudgeable', () => {
		expect(
			verdictFor([
				{
					requires: 'a',
					constraint: 'x',
					installed: '1',
					reason: 'unverifiable',
					detail: ''
				}
			])
		).toBe('unverifiable');
	});

	it('prefers blocked over unverifiable when both are present', () => {
		// a definite conflict is a definite answer; the unknown must not soften it
		expect(
			verdictFor([
				{
					requires: 'a',
					constraint: 'x',
					installed: '1',
					reason: 'unverifiable',
					detail: ''
				},
				{ requires: 'b', constraint: '^1', installed: '2', reason: 'version', detail: '' }
			])
		).toBe('blocked');
	});
});

describe('the whole check, end to end over an injected fetch', () => {
	it('reports installable for a module this site can take', async () => {
		const meta = p2('drupal/ok', [
			{ version: '2.0.0', require: { 'drupal/core': '^11', php: '>=8.3' } }
		]);
		const out = await checkInstallable(fetcherFor(meta), 'drupal/ok', INSTALLED);
		expect(out.verdict).toBe('installable');
		expect(out.version).toBe('2.0.0');
		// the caveat travels WITH the yes, because transitive deps are not resolved
		expect(out.note).toContain('transitive');
	});

	it('reports blocked with the named conflict for a core mismatch', async () => {
		const meta = p2('drupal/old', [{ version: '6.2.0', require: { 'drupal/core': '^10' } }]);
		const out = await checkInstallable(fetcherFor(meta), 'drupal/old', INSTALLED);
		expect(out.verdict).toBe('blocked');
		expect(out.conflicts[0]!.detail).toContain('^10');
	});

	it('reports not-found for a 404 rather than treating it as installable', async () => {
		const out = await checkInstallable(fetcherFor({}, 404), 'drupal/nope', INSTALLED);
		expect(out.verdict).toBe('not-found');
		expect(out.note).toContain('404');
	});

	it('reports UNVERIFIABLE when packagist is unreachable, never installable', async () => {
		// the site must not install on a guess just because the metadata host was down
		const out = await checkInstallable(
			async () => {
				throw new Error('connect timeout');
			},
			'drupal/ok',
			INSTALLED
		);
		expect(out.verdict).toBe('unverifiable');
		expect(out.note).toContain('unreachable');
	});

	it('refuses an invalid name without fetching anything', async () => {
		let fetched = false;
		const out = await checkInstallable(
			async () => {
				fetched = true;
				return new Response('{}');
			},
			'../etc/passwd',
			INSTALLED
		);
		expect(out.verdict).toBe('not-found');
		expect(fetched).toBe(false);
	});

	it('makes exactly ONE subrequest, which is what makes a refusal cheap', async () => {
		let calls = 0;
		const meta = p2('drupal/ok', [{ version: '1.0.0', require: { 'drupal/core': '^11' } }]);
		await checkInstallable(
			async () => {
				calls++;
				return new Response(JSON.stringify(meta));
			},
			'drupal/ok',
			INSTALLED
		);
		expect(calls).toBe(1);
	});

	it('has php in the default platform, or every module would be blocked on it', () => {
		expect(DEFAULT_PLATFORM.php).toBeTruthy();
	});
});
