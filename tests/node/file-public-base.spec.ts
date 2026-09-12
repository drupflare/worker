import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BATCHABLE, CROSSING_NAMES } from '../../src/ops/crossings';
import { REPLICA_SAFE_CAPABILITIES } from '../../src/ops/replica';

/**
 * Serving a public file off the Worker, which is the only structural serving lever.
 *
 * A zone Cache Rule cannot save an invocation -- the Worker runs before the cache is consulted --
 * so exactly two paths cost zero Worker requests: a static asset, and a hostname that is not routed
 * to the Worker. An R2 custom domain is the second, and Worker requests at 100,000/day are what
 * bind serving. An image-heavy page spending one per image is the meter counting files rather than
 * visitors.
 *
 * THE R2 TIER WAS ALREADY BUILT AND UNREACHABLE. `drainMirrors()` offloads file bytes,
 * `drainPageMirrors()` offloads pages, and both are gated on a `FILES` binding that
 * `wrangler.jsonc` never declared -- so neither had ever run on a deployed site.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
// `DRUPFLARE_SRC`, which is how CI points at `.siblings/drupflare`. This hardcoded `../drupflare`
// and so read a path that exists on a dev machine and nowhere else -- the same shape CLAUDE.md
// records for `tests/fixtures/renamed-form-state.php`, and the idiom five sibling specs already use
const SIBLING = process.env.DRUPFLARE_SRC ?? '../drupflare';
const WRAPPER = resolve(ROOT, SIBLING, 'src', 'StreamWrapper', 'CfwFileStreamWrapper.php');

describe('the binding the whole R2 tier was gated on', () => {
	/**
	 * **IT IS DELIBERATELY NOT IN THE SHIPPING CONFIG ANY MORE, AND THIS ASSERTED THAT IT WAS.**
	 * Measured 2026-09-11 on a fresh free account: the canonical config uploaded all 4,749 assets
	 * and was then refused with *"Please enable R2 through the Cloudflare Dashboard. [code: 10042]"*
	 * on `/r2/buckets/drupflare-files`. R2 must be enabled from the dashboard before a bucket can
	 * exist, so naming one made the README's deploy button fail for every account that had not done
	 * that. The control was the same deploy with only `r2_buckets` removed: it succeeded, and
	 * wrangler auto-provisioned `CONFIG_KV` and `FLEET_DB` -- KV and D1 were never the problem.
	 *
	 * So the property to hold is no longer "declared". It is that the tier stays EXERCISED and the
	 * runtime stays tolerant, which is what the two assertions below say.
	 */
	it('is not in the shipping config, because naming a bucket refuses the deploy', () => {
		const config = readFileSync(resolve(ROOT, 'wrangler.jsonc'), 'utf8');
		expect(config).not.toContain('r2_buckets');
		expect(config).not.toContain('drupflare-files');
	});

	it('is still bound in the test lane, so the tier is exercised rather than skipped', () => {
		// miniflare's R2 is local and needs no account, which is what lets these two diverge
		const vitest = readFileSync(resolve(ROOT, 'vitest.config.ts'), 'utf8');
		expect(vitest).toContain("r2Buckets: ['FILES']");
	});

	it('is documented as an opt-in addition rather than dropped in silence', () => {
		const docs = readFileSync(resolve(ROOT, 'docs', 'configuration.md'), 'utf8');
		expect(docs).toContain('r2_buckets');
		expect(docs).toContain('10042');
	});
});

describe('the capability that tells PHP where public files live', () => {
	it('is in the crossing census, so it cannot be counted by accident', () => {
		expect(CROSSING_NAMES as readonly string[]).toContain('cfwFilePublicBase');
	});

	it('is batchable, because the answer cannot change under a render', () => {
		expect(BATCHABLE.cfwFilePublicBase).toBe(true);
	});

	it('is replica-safe, being one configured string', () => {
		expect(REPLICA_SAFE_CAPABILITIES.has('cfwFilePublicBase')).toBe(true);
	});
});

describe('and the cost the binding does NOT bring with it', () => {
	it('gates the page mirror on a public origin rather than on the bucket', () => {
		// MEASURED: the mirror queue entry is one row per fill, 9 to 10, against the regeneration
		// meter this project calls the tighter of the two by 12x. With no public hostname the
		// visitor still reaches the Worker, so that row buys nothing at all
		const site = readFileSync(resolve(ROOT, 'src', 'site-do.ts'), 'utf8');
		expect(site).toContain("this.mirrorBucket() && this.publicFilesOrigin() !== ''");
	});

	it('stores the queue WITHOUT ROWID, so it is one row and not two', () => {
		// a `TEXT PRIMARY KEY` on a rowid table gets an automatic index, and the insert charges both
		const mirror = readFileSync(resolve(ROOT, 'src', 'ops', 'page-mirror.ts'), 'utf8');
		expect(mirror).toMatch(/cfw_page_mirror_queue[\s\S]*?WITHOUT ROWID/);
	});
});

describe('and what the wrapper does with it', () => {
	const php = readFileSync(WRAPPER, 'utf8');

	it('never links a private file at a public origin', () => {
		// an R2 custom domain is public by definition and a private file is authorised per request
		expect(php).toMatch(/if \(\$this->scheme !== 'private'\) \{/);
	});

	it('only links a file the object believes has mirrored', () => {
		// the alternative to a Worker URL on a file that has not mirrored yet is a 404 on a file the
		// site holds
		expect(php).toContain('self::isMirrored($this->uri)');
	});

	it('memoises the origin, so forty images do not ask forty times', () => {
		expect(php).toMatch(/private static function publicBase\(\): string/);
		expect(php).toContain('static $base = null;');
	});

	it('falls back to the Worker path when nothing is configured', () => {
		expect(php).toContain("'/sites/default/files/'");
		expect(php).toContain("'/system/files/'");
	});
});
