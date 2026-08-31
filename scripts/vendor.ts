import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve('php-wasm/package.json'));
const outDir = resolve(import.meta.dirname, '../vendor');

/**
 * The versions extracted from the npm `php-wasm` package, which ships 8.0 through 8.5.
 *
 * **8.5 IS NOT HERE.** The interpreter that ships is a `phasm` build fetched into
 * `.interp/` by `scripts/fetch-interpreter.ts`; npm's `php8.5-web.mjs` is the upstream default build
 * with the same version number and different bytes. Writing one to `vendor/php8.5.wasm` would put
 * two different 8.5 binaries a directory apart, which is how `static-free-v1` got bundled at 710,410
 * bytes over the ceiling with nothing failing but the size.
 *
 * 8.3 is what `src/probes/index.ts` imports, and every recorded probe figure was taken on it. 8.4 has
 * no consumer and the report prices it as a dead end; it is kept only because `vendor/` is an
 * append-only historical store.
 */
const VERSIONS = ['8.3', '8.4'];

await mkdir(outDir, { recursive: true });

for (const version of VERSIONS) {
	const glueName = `php${version}-web.mjs`;
	const glue = await readFile(join(pkgRoot, glueName), 'utf8');

	const hash = glue.match(/([0-9a-f]{40})\.wasm/)?.[1];
	if (!hash) throw new Error(`no wasm hash found in ${glueName}`);

	const wasm = await readFile(join(pkgRoot, `${hash}.wasm`));
	await writeFile(join(outDir, `php${version}.wasm`), wasm);

	// the glue resolves the binary itself; we hand it a prebuilt Module instead,
	// so neutralize the fetch path rather than let it construct a bad URL
	const patched = glue.replaceAll(`${hash}.wasm`, `php${version}.wasm`);
	await writeFile(join(outDir, glueName), patched);

	console.log(
		`php ${version}: ${glueName} + php${version}.wasm (${wasm.length} bytes, hash ${hash.slice(0, 8)})`
	);
}
