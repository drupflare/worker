import { describe, expect, it } from 'vitest';
import { DRUPAL_METADATA_URL, packagistUrl } from '../../src/ops/packagist';

/**
 * The metadata endpoint, checked against DRUPAL.ORG rather than against ourselves.
 *
 * `packagistUrl()` has now been wrong twice, the same way, and a unit test agreed with it both
 * times. First it pointed at Packagist, which does not carry Drupal contrib at all; then it pointed
 * at `/8/p2/`, which was correct when written and which drupal.org later moved. In both cases
 * `/installable?module=drupal/*` answered `not-found` for every package the product exists to
 * install, and nothing looked broken -- `not-found` is a plausible answer.
 *
 * A string assertion cannot catch this. It proves the constant did not change, which is exactly the
 * property that held while the endpoint moved underneath it. The only non-circular check is to ask
 * the repository where its metadata is: `packages.drupal.org/8/packages.json` declares
 * `metadata-url`, and Composer itself follows that declaration rather than guessing.
 *
 * NETWORK-GATED, on the same asymmetry as `artifactGate`: skip when offline so a developer on a
 * plane does not see red, FAIL when a lane says it has network. A check that can only skip is worse
 * than no check, which is the rule this repository already applies to its build artifacts.
 */

const REQUIRE_NETWORK = process.env.REQUIRE_NETWORK === '1';

async function reachable(): Promise<boolean> {
	try {
		const res = await fetch('https://packages.drupal.org/8/packages.json', {
			signal: AbortSignal.timeout(5_000)
		});
		return res.ok;
	} catch {
		return false;
	}
}

const online = await reachable();
if (!online && REQUIRE_NETWORK) {
	throw new Error(
		'packages.drupal.org is unreachable and REQUIRE_NETWORK=1 says this lane has network'
	);
}

describe.skipIf(!online)('the drupal.org metadata endpoint, as drupal.org declares it', () => {
	it('matches the URL template this code builds', async () => {
		const repo = (await (
			await fetch('https://packages.drupal.org/8/packages.json')
		).json()) as { 'metadata-url'?: string };
		expect(repo['metadata-url'], 'drupal.org stopped declaring metadata-url').toBeDefined();
		// the declaration is relative to the repository root; ours is absolute. `new URL()`
		// percent-encodes the literal `%` in `%package%`, and decodeURIComponent throws on it
		// (`%pa` is not a valid escape), so only that token is normalised back
		const declared = new URL(repo['metadata-url']!, 'https://packages.drupal.org')
			.toString()
			.replace('%25package%25', '%package%');
		expect(declared).toBe(DRUPAL_METADATA_URL);
	});

	it('ACTUALLY RESOLVES for a package that ships inside this artifact', async () => {
		// pathauto is in SHIPPED_LOCK_VERSIONS and in the pack, so a `not-found` here is never a
		// true answer about the world -- it can only mean the lookup is broken
		const res = await fetch(packagistUrl('drupal/pathauto'), {
			signal: AbortSignal.timeout(10_000)
		});
		expect(res.status, `${packagistUrl('drupal/pathauto')} did not resolve`).toBe(200);
		const body = (await res.json()) as { packages?: Record<string, unknown[]> };
		expect(Object.keys(body.packages ?? {})).toContain('drupal/pathauto');
	});

	it('still resolves a non-Drupal dependency against Packagist', async () => {
		const res = await fetch(packagistUrl('symfony/yaml'), {
			signal: AbortSignal.timeout(10_000)
		});
		expect(res.status).toBe(200);
	});
});
