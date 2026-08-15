import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * `await` on a non-thenable is legal, silent and free of consequence except to the reader: every
 * caller of `await resolveThing()` then believes the function does I/O, and the next person to touch
 * it preserves an asynchrony that was never there. `scripts/check-await-shape.ts` is the
 * deterministic half; this is the gate that runs it.
 */
describe('no exported function is awaited when it cannot return a promise', () => {
	it('reports nothing across src, scripts and tests', () => {
		const out = execFileSync('bun', ['scripts/check-await-shape.ts'], {
			encoding: 'utf8',
			cwd: process.cwd()
		});
		expect(out).toContain('no awaited non-thenable exports');
	});
});
