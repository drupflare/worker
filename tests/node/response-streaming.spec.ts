import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The front worker hands the object's body straight through rather than buffering it.
 *
 * B5 proposes flushing a shell from the front worker and streaming fragments after it. Its cheapest
 * half is already true and worth keeping true: the terminal return passes `res.body` -- a stream --
 * rather than an awaited `res.text()`, so bytes reach the visitor as the object produces them and
 * nothing waits for a whole response to be assembled in the middle.
 *
 * WHAT THE REST OF B5 STILL NEEDS, stated so it is not mistaken for done. The object cannot stream
 * its own render: `php._run()` is one synchronous call into wasm and the response is a complete
 * string when it returns, so there is nothing to stream FROM on a render. Composing in the front
 * worker instead needs the SHELL reachable there, and `cfw_shell` is Durable Object SQL. That is a
 * new personalised storage tier, and it needs the same per-uid proof S1's plan tier just built --
 * which is why it is not being added at the end of a long session. Shipping an unproven
 * personalised tier is the one failure this project has already had.
 *
 * `res.clone()` elsewhere in the file is correct and is not what this guards: a clone is how a
 * deferred KV write or a plan compile reads the body without consuming the one going out.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('the response the front worker returns', () => {
	const source = readFileSync(resolve(ROOT, 'src', 'site.ts'), 'utf8');

	it('passes the object body as a stream', () => {
		expect(source).toContain('return new Response(res.body, { status: res.status, headers });');
	});

	it('never buffers it with an awaited text() on the way out', () => {
		// `await res.text()` on the terminal return would hold every byte until the last one
		// arrived, which is the thing streaming exists to avoid
		expect(source).not.toContain('new Response(await res.text()');
	});

	it('still clones for the deferred readers, which is a different thing', () => {
		// the plan compile and the KV mirror both read the body; a clone is how they do that without
		// consuming the response going to the visitor
		expect(source).toContain('res.clone()');
	});
});
