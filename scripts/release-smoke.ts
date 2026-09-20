/**
 * Proves the HYDRATED payload boots and renders, which no cheap check above it can.
 *
 * The steps before this one verify the artifact as BYTES: `sha256sum -c SHA256SUMS` proves the
 * tarball matches its own digests, `hydrate --force` proves it unpacks and lands every marker, and
 * `release:check` dry-runs the bundle and prices it. None of them starts the interpreter, so a
 * payload carrying a glue/wasm mismatch or a pack the kernel cannot read passes all three.
 *
 * It replaces a second full `bun run test` in the release lane. That run re-proved the CODE, which
 * the gate job and every CI lane on the same commit already did; what nothing else covers is this
 * TREE, assembled from the published artifact rather than from the build directory.
 *
 * `wrangler dev --local` is one of the three instruments that reach the shipping seam at all -- the
 * gate aliases the raw interpreter and cannot.
 */

import { migrateSite, startDevServer } from './dev-server.js';

const SITE = 'release-smoke';

async function main(): Promise<void> {
	const dev = await startDevServer({
		label: 'release-smoke',
		port: 8809,
		vars: { PW_DIAGNOSTICS: '1' }
	});
	try {
		// PREFILL OFF, or this proves nothing about the interpreter. A migrate seeds `cfw_page`, and
		// a cached page is answered off `ctx.storage.sql` without booting PHP -- the first version of
		// this check read `x-cfw-cache: HIT` and would have passed on a payload whose wasm could not
		// start. `migrateSite` guards the flag itself: it throws if anything was prefilled anyway.
		const passes = await migrateSite(dev.origin, SITE, { prefill: false });
		console.log(`release-smoke: migrated in ${passes} pass(es), nothing prefilled`);

		const url = new URL('/serve', dev.origin);
		url.searchParams.set('site', SITE);
		url.searchParams.set('path', '/');
		const res = await fetch(url, {
			headers: { host: `${SITE}.localhost` },
			signal: AbortSignal.timeout(300_000)
		});
		const body = await res.text();
		const tier = res.headers.get('x-cfw-cache');
		if (!res.ok) {
			throw new Error(`/serve answered ${res.status} (${tier}): ${body.slice(0, 400)}`);
		}
		// the tier is the assertion, not a detail. RENDER is the only value that means PHP ran; a
		// HIT or an AGED would mean this check had quietly stopped covering what it exists for
		if (tier !== 'RENDER') {
			throw new Error(
				`/serve answered from ${tier}, so no kernel booted and nothing was proved`
			);
		}
		// a 200 is not evidence Drupal rendered either; the fill chain answers 503 and an error page
		// is still markup, so assert something only a booted kernel emits
		if (!/<html/i.test(body) || !body.includes('/core/')) {
			throw new Error(`/serve answered 200 with no Drupal markup: ${body.slice(0, 400)}`);
		}
		console.log(`release-smoke: rendered ${body.length} bytes from ${tier}`);
	} finally {
		dev.stop();
	}
}

await main();
