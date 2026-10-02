import { describe, expect, it } from 'vitest';
import { packCachedEnv } from '../../../src/do/lazy-mount';

type Calls = string[];

function assetsFor(calls: Calls, answer: (url: string) => Response): Fetcher {
	return {
		fetch: async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			calls.push(url);
			return answer(url);
		}
	} as unknown as Fetcher;
}

describe('the per-file pack fetch cache', () => {
	it('returns an env with no ASSETS binding untouched', () => {
		const env = { OTHER: 1 };
		expect(packCachedEnv(env)).toBe(env);
	});

	it('fetches a pack member once and serves its bytes and parsed json from the copy', async () => {
		const calls: Calls = [];
		const assets = assetsFor(calls, () => new Response('{"a":1}'));
		const cached = packCachedEnv({ ASSETS: assets });
		const url = 'https://assets.local/core.pf.json';

		const first = await cached.ASSETS.fetch(url);
		const second = await cached.ASSETS.fetch(new Request(url));
		expect(calls).toEqual([url]);
		expect(first.ok).toBe(true);
		expect(new TextDecoder().decode(await first.arrayBuffer())).toBe('{"a":1}');
		const parsed = await first.json();
		expect(parsed).toEqual({ a: 1 });
		// the second boot reads the same parsed object, not a second parse
		expect(await second.json()).toBe(parsed);
	});

	it('passes every other path straight through to the binding', async () => {
		const calls: Calls = [];
		const cached = packCachedEnv({
			ASSETS: assetsFor(calls, () => new Response('x'))
		});
		await cached.ASSETS.fetch('https://assets.local/other.js');
		await cached.ASSETS.fetch('https://assets.local/other.js');
		expect(calls).toHaveLength(2);
	});

	it('does not remember a failed fetch, so the next boot retries it', async () => {
		const calls: Calls = [];
		let attempt = 0;
		const assets = assetsFor(calls, () =>
			attempt++ === 0 ? new Response('no', { status: 503 }) : new Response('[1]')
		);
		const cached = packCachedEnv({ ASSETS: assets });
		const url = 'https://assets.local/core.pf.bin';

		const failed = await cached.ASSETS.fetch(url);
		expect([failed.ok, failed.status]).toEqual([false, 503]);
		// the removal runs on a microtask after the first answer
		await Promise.resolve();
		await Promise.resolve();
		const retried = await cached.ASSETS.fetch(url);
		expect(retried.ok).toBe(true);
		expect(calls).toHaveLength(2);
	});

	it('shares one copy between two wrappers over the same binding', async () => {
		const calls: Calls = [];
		const assets = assetsFor(calls, () => new Response('p'));
		await packCachedEnv({ ASSETS: assets }).ASSETS.fetch('https://assets.local/core.pf.bin');
		await packCachedEnv({ ASSETS: assets }).ASSETS.fetch('https://assets.local/core.pf.bin');
		expect(calls).toHaveLength(1);
	});
});
