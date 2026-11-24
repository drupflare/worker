import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INTERPRETER_IDENTITY } from '../../src/do/isolate.ts';
import {
	BOOT_IMAGE_VARIANTS,
	bootImageDir,
	parseBootImageIndex,
	type BootImageVariant
} from '../../src/ops/boot-image.ts';
import { DRIVER_DIGEST } from '../../src/ops/driver-digest.ts';
import { extensionFingerprint } from '../../src/ops/packed-container.ts';
import {
	contextConfig,
	INTERPRETER_WASM,
	interpreterDigest,
	PACK_SQLITE,
	packConfigDigest
} from '../boot-image-pack.ts';

const ASSETS = resolve(import.meta.dirname, '../..', 'assets');

/** what the tree computes for the parts of a context that do not depend on a site's own env */
export type BootImageExpected = {
	driver: string;
	/** the pack generation named by the sql manifest */
	packGeneration: string;
	/** the interpreter identity the object appends to the generation */
	interpreter: string;
	/** the enabled-module fingerprint of the packed database, which only the pack image keys on */
	packModules: string;
	/** the config digest of the packed database, which only the pack image keys on */
	packConfig: string;
	/** sha-256 of the interpreter on disk, or undefined when it is not built here */
	interpreterSha?: string;
};

/** the part of a context between `key=` and the next top-level `|key=`, or undefined */
export function contextPart(context: string, key: string): string | undefined {
	const parts = context.split(/\|(?=[a-z]+=)/);
	return parts.find((p) => p.startsWith(`${key}=`))?.slice(key.length + 1);
}

/**
 * The reasons one published index no longer matches the tree, empty when it matches.
 *
 * The settings part is not compared: it digests the deployment's own bindings, which a hermetic
 * check cannot know.
 */
export function bootImageDrift(
	variant: BootImageVariant,
	index: { context: string; interpreter?: string },
	expected: BootImageExpected
): string[] {
	const problems: string[] = [];
	const differs = (what: string, recorded: string | undefined, now: string) => {
		if (recorded !== now)
			problems.push(`${variant}: ${what} is ${recorded}, the tree has ${now}`);
	};
	differs('driver digest', contextPart(index.context, 'driver'), expected.driver);
	const generation = (contextPart(index.context, 'generation') ?? '').split('|');
	differs('pack generation', generation[0], expected.packGeneration);
	differs('interpreter identity', generation[2], expected.interpreter);
	if (variant === 'pack') {
		differs('module fingerprint', generation[1], expected.packModules);
		differs('config digest', contextConfig(index.context), expected.packConfig);
	}
	if (expected.interpreterSha !== undefined)
		differs('interpreter sha-256', index.interpreter, expected.interpreterSha);
	return problems;
}

/** the enabled-module fingerprint of the packed database, read the way the object reads it */
function packModules(path = PACK_SQLITE): string {
	// the pack is flagged WAL and a read-only open cannot create the -shm file it needs
	const dir = mkdtempSync(join(tmpdir(), 'pack-modules-'));
	const copy = join(dir, 'site.sqlite');
	copyFileSync(path, copy);
	const db = new DatabaseSync(copy);
	try {
		const row = db
			.prepare("SELECT data FROM config WHERE collection = '' AND name = 'core.extension'")
			.get() as { data?: unknown } | undefined;
		const data = row?.data;
		return extensionFingerprint(
			typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8')
		);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

/** everything the tree computes without a worker, a network or a bake */
export function treeExpectation(): BootImageExpected {
	const manifest = JSON.parse(
		readFileSync(resolve(ASSETS, 'drupal-sql', 'manifest.json'), 'utf8')
	) as { generation: string };
	return {
		driver: DRIVER_DIGEST,
		packGeneration: manifest.generation,
		interpreter: INTERPRETER_IDENTITY,
		packModules: packModules(),
		packConfig: packConfigDigest(),
		interpreterSha: existsSync(INTERPRETER_WASM) ? interpreterDigest() : undefined
	};
}

if (import.meta.main) {
	const expected = treeExpectation();
	const problems: string[] = [];
	let found = 0;
	for (const variant of BOOT_IMAGE_VARIANTS) {
		const path = resolve(ASSETS, bootImageDir(variant), 'index.json');
		if (!existsSync(path)) {
			console.log(`${variant}: no index at ${path}, so nothing is published to check`);
			continue;
		}
		const parsed = parseBootImageIndex(JSON.parse(readFileSync(path, 'utf8')));
		if (typeof parsed === 'string') {
			problems.push(`${variant}: ${parsed}`);
			continue;
		}
		found++;
		problems.push(
			...bootImageDrift(variant, parsed as typeof parsed & { interpreter?: string }, expected)
		);
	}
	for (const p of problems) console.error(p);
	if (problems.length > 0) {
		console.error(
			'a stale boot image makes every site boot plain: run `bun run assets:bootimage`'
		);
		process.exit(1);
	}
	console.log(`boot images match the tree (${found} checked)`);
}
