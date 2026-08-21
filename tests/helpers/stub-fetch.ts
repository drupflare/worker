import { afterEach } from 'vitest';

/**
 * Replaces `globalThis.fetch` and records what was asked for.
 *
 * Shared by the two mail specs, which had to split because one of them needs the pack and the other
 * eleven tests do not -- see the header of `mail-drupal.spec.ts`. Duplicating eight lines across the
 * split would have been two copies of a stub that must behave identically for the comparison between
 * them to mean anything.
 *
 * The real `fetch` is captured at module load and restored in an `afterEach` registered here, so a
 * spec that imports this cannot forget to put it back.
 */
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

export function stubFetch(status = 200, body = '{"success":true}') {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		calls.push({ url, init });
		return Promise.resolve(new Response(body, { status }));
	}) as typeof fetch;
	return (account: string) => calls.filter((c) => c.url.includes(`/accounts/${account}/`));
}
