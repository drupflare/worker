import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configDigest, type BootImageIndex, type BootImageVariant } from '../src/ops/boot-image.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** the packed database a freshly provisioned site's config rows equal */
export const PACK_SQLITE = resolve(ROOT, 'assets', 'drupal', 'site.sqlite');

/** the interpreter the worker bundles, whose heap an image is a copy of */
export const INTERPRETER_WASM = resolve(ROOT, '.interp', 'php8.5.tuned.wasm');

/** the config digest of the packed database, computed by the same function the object runs */
export function packConfigDigest(path = PACK_SQLITE): string {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return configDigest({
			exec: (query: string) => {
				const rows = db.prepare(query).all() as Record<string, unknown>[];
				return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
			}
		});
	} finally {
		db.close();
	}
}

/** the config part of an index's context, or undefined when the context has none */
export function contextConfig(context: string): string | undefined {
	return /(?:^|\|)config=([0-9a-f]+)(?:\||$)/.exec(context)?.[1];
}

/** what a capture must be before it is published: keyed the way its variant is, and not empty */
export function checkCapture(
	variant: BootImageVariant,
	index: Pick<BootImageIndex, 'context' | 'handles'>,
	packDigest: string
): void {
	const config = contextConfig(index.context);
	if (variant === 'pack' && config !== packDigest)
		throw new Error(`the bake site's config digest is ${config}, the pack's is ${packDigest}`);
	if (variant === 'claimed' && !index.context.includes('config=reset'))
		throw new Error(`a claimed image has to be keyed without a digest: ${index.context}`);
	if (index.handles.length === 0) throw new Error('the capture named no handle');
}

/** sha256 of the interpreter module on disk */
export function interpreterDigest(path = INTERPRETER_WASM): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}
