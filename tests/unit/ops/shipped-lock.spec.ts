import { describe, expect, it } from 'vitest';
import {
	SHIPPED_CORE_VERSION,
	SHIPPED_LOCK_VERSIONS,
	SHIPPED_PROVIDES
} from '../../../src/ops/shipped-lock';

/**
 * The lock reaches the isolate as bundled text, through wrangler's `Text` rule, so this is the
 * lane that proves the import resolves where the code runs. The values themselves are the lock's
 * to decide and are compared with the file on disk in `tests/node/shipped-lock.spec.ts`.
 */
describe('the bundled composer lock', () => {
	it('names a core version and the packages beside it', () => {
		expect(SHIPPED_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(SHIPPED_LOCK_VERSIONS['drupal/core']).toBe(SHIPPED_CORE_VERSION);
		expect(SHIPPED_LOCK_VERSIONS['drupflare/rom']).toBeTruthy();
	});

	it('knows which virtual packages the locked ones satisfy', () => {
		expect(SHIPPED_PROVIDES['psr/log-implementation']).toBeTruthy();
	});
});
