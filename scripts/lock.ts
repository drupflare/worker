import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shippedLock, type ShippedLock } from '../src/ops/lock-map';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Reads the root `composer.lock` from disk, which is the one place these facts are written.
 *
 * Read on every call rather than held in a module constant: a process that has just run
 * `composer update` would otherwise keep the version it started with.
 */
export function readLock(root: string = ROOT): ShippedLock {
	return shippedLock(JSON.parse(readFileSync(join(root, 'composer.lock'), 'utf8')));
}
