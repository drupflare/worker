/**
 * Fetches an interpreter from a `phasm` workflow artifact into `.interp/` and packs it.
 *
 * The binaries this worker runs are built by `phasm` and published as workflow artifacts. Until now
 * the only copy lived in `vendor/`, hand-placed, on one machine -- so a clean clone could not
 * reproduce a deploy, and the PHP 8.5 seam existed only because an artifact had been copied in by
 * hand.
 *
 * Writes to `.interp/`, never to `vendor/`: that directory holds unreproducible hand-built
 * binaries and is the one permanent loss available in this repo.
 *
 * ```sh
 * bun scripts/fetch-interpreter.ts control85 8.5
 * bun scripts/fetch-interpreter.ts control85 8.5 4102938475 --pin
 * ```
 *
 * @see scripts/pack-wasm-zstd.ts which this calls to produce the shipped frame
 * @see src/runtime/php-binary-85.ts for the seam that imports the result
 * @see .github/workflows/interpreter.yml which drives this from a phasm publish
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packWasm } from './pack-wasm-zstd';
import { interpreterFiles, sha256 } from './release-payload';

const OUT_DIR = '.interp';
const REPO = process.env.PHASM_REPO ?? 'drupflare/phasm';

/** where the pin lands; tracked, unlike everything else this script writes */
export const PIN_PATH = 'interp.lock.json';

/** what one fetch produced, in the shape the pin and the workflow summary both read */
export type FetchResult = {
	wasm: string;
	glue: string;
	frame: string;
	raw: number;
	packed: number;
	declared: number;
	artifactId: string;
};

/**
 * `interp.lock.json`: which phasm artifact produced the bytes in `.interp/`.
 *
 * The binaries themselves are 9-12 MB and gitignored, so this is the only part of an interpreter
 * bump that a reviewer can read. It records the artifact id because phasm rebuilds the same rc to
 * different bytes -- 12,218,400 then 12,218,393 -- so "the newest artifact" does not name a build.
 */
export type InterpreterPin = {
	name: 'drupflare-interpreter-pin';
	version: 1;
	repo: string;
	variant: string;
	phpVersion: string;
	artifactId: string;
	frame: { raw: number; packed: number; declared: number };
	files: { path: string; bytes: number; sha256: string }[];
};

function run(cmd: string, args: string[]): string {
	return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

/**
 * Content-addresses a completed fetch.
 *
 * @param result - what {@link fetchInterpreter} returned; every path in it is read from disk
 * @param variant - the phasm rc name the bytes were built from
 * @param phpVersion - the version in the asset filenames
 */
export function buildPin(
	result: FetchResult,
	variant: string,
	phpVersion: string,
	repo = REPO
): InterpreterPin {
	return {
		name: 'drupflare-interpreter-pin',
		version: 1,
		repo,
		variant,
		phpVersion,
		artifactId: result.artifactId,
		frame: { raw: result.raw, packed: result.packed, declared: result.declared },
		files: [result.wasm, result.glue, result.frame].sort().map((path) => ({
			path,
			bytes: statSync(path).size,
			sha256: sha256(path)
		}))
	};
}

/**
 * Asserts the canonical config's binary seam imports the files this fetch just wrote.
 *
 * Without it a fetch for the wrong PHP version succeeds, writes `.interp/php8.3.*`, and leaves the
 * seam importing the `php8.5.*` files it already had -- so the bundle builds, the size gate passes,
 * and what was measured is the incumbent interpreter. A hydrated tree makes that the DEFAULT
 * outcome, because hydrate restores the incumbent first.
 *
 * @param root - the checkout holding `wrangler.jsonc`
 * @throws naming both sides, because the failure is a version mismatch and not a missing file.
 */
export function assertSeamImports(root: string, result: FetchResult): void {
	const imports = interpreterFiles(root);
	const missing = [result.frame, result.glue].filter((path) => !imports.includes(path));
	if (missing.length) {
		throw new Error(
			`the aliased seam imports ${imports.join(', ')} and this fetch wrote ` +
				`${missing.join(', ')}, so the bundle would ship the interpreter already on disk. ` +
				'Fetch the version the seam names, or pass --any-version to keep the files anyway.'
		);
	}
}

/**
 * Downloads one variant's `.wasm` and its glue, then packs the wasm.
 *
 * @param variant - a phasm rc name, e.g. `control85`
 * @param phpVersion - the version in the asset filenames, e.g. `8.5`
 * @param artifactId - a phasm Actions artifact id; defaults to the newest unexpired one
 */
export function fetchInterpreter(
	variant: string,
	phpVersion: string,
	artifactId?: string
): FetchResult {
	mkdirSync(OUT_DIR, { recursive: true });

	// THE ARTIFACTS API, NOT `gh run list`, and two earlier versions of this got it wrong. phasm's
	// newest RELEASE carries no assets at all, so release-asset download fails outright; and picking
	// "the newest successful run" picks a lint run, whose commit has no interpreter artifact. Asking
	// for artifacts by NAME is independent of which workflow produced them and of run ordering.
	const id =
		artifactId ??
		run('gh', [
			'api',
			`repos/${REPO}/actions/artifacts?per_page=100`,
			'--jq',
			`[.artifacts[] | select(.name | startswith("phasm-${variant}-")) | select(.expired == false)] | .[0].id`
		]).trim();
	if (!id || id === 'null') {
		throw new Error(`no unexpired artifact named phasm-${variant}-* on ${REPO}`);
	}

	const zip = join(OUT_DIR, `${variant}.zip`);
	run('bash', ['-c', `gh api repos/${REPO}/actions/artifacts/${id}/zip > ${zip}`]);
	run('bash', ['-c', `cd ${OUT_DIR} && unzip -o -q ${variant}.zip && rm -f ${variant}.zip`]);

	const base = `phasm-${variant}-php${phpVersion}-worker.mjs`;
	const gotWasm = join(OUT_DIR, 'dist', `${base}.wasm`);
	const gotGlue = join(OUT_DIR, 'dist', base);
	for (const f of [gotWasm, gotGlue]) {
		if (!existsSync(f)) {
			throw new Error(`${f} is not in artifact ${id}; is the variant or php version wrong?`);
		}
	}

	const wasm = join(OUT_DIR, `php${phpVersion}.wasm`);
	const glue = join(OUT_DIR, `php${phpVersion}-worker.mjs`);
	renameSync(gotWasm, wasm);
	renameSync(gotGlue, glue);

	// packWasm refuses a frame whose header disagrees with the file it packed, so the declared size
	// is checked here rather than left for a startup throw on the edge
	const { raw, packed, declared, out } = packWasm(wasm, OUT_DIR);
	return { wasm, glue, frame: out, raw, packed, declared, artifactId: String(id) };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const [variant, phpVersion, artifactId] = args.filter((a: string) => !a.startsWith('--'));
	if (!variant || !phpVersion) {
		console.error(
			'usage: bun scripts/fetch-interpreter.ts <variant> <php-version> [artifact-id]' +
				' [--pin] [--any-version]'
		);
		console.error('   eg: bun scripts/fetch-interpreter.ts control85 8.5');
		process.exit(2);
	}
	const result = fetchInterpreter(variant, phpVersion, artifactId);
	if (!args.includes('--any-version')) assertSeamImports(process.cwd(), result);
	console.log(`${result.wasm}  raw=${result.raw}  packed to ${result.packed} zstd bytes`);
	console.log(`${result.frame}  declares ${result.declared} inflated bytes`);
	console.log(`${result.glue}`);
	if (args.includes('--pin')) {
		const pin = buildPin(result, variant, phpVersion);
		writeFileSync(PIN_PATH, JSON.stringify(pin, null, '\t') + '\n');
		console.log(`${PIN_PATH}  pins artifact ${pin.artifactId} on ${pin.repo}`);
	}
	console.log('the seam that imports these is src/runtime/php-binary-85.ts');
}
