import { describe, expect, it } from 'vitest';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

/**
 * The heap through migrate, install and a render, on whichever pointer ABI the lane was given.
 *
 * TEMPORARY, for the P26 wasm64 measurement. `heap-growth.spec.ts` opens every profile with
 * `/__migrate?all=1`, which does the whole migration in ONE invocation and does not complete on
 * wasm64 -- and it takes the invocation with it, so nothing can be read afterwards. Measured here,
 * the same migration driven in CHUNKS completes on wasm64 at a flat 96.00 MiB, so `all=1` is what
 * that ABI cannot do rather than the migration itself. Reading the heap after each step is what
 * separates those two claims.
 */

const MIB = 1_048_576;
const AUTH_PASS = 'cfw-Growth-Pass-8821';

/**
 * Only runs when an ABI arm was asked for.
 *
 * It drives 40 migrate chunks and a render, which is ~40 s the default lane should not spend to
 * re-measure the arm it already covers in `heap-growth.spec.ts`. Kept rather than deleted because
 * re-deriving it is what separated "wasm64 runs out of memory" from what actually happens.
 */
declare const __DRUPFLARE_ABI__: string;
// injected by `vitest.config.ts`; `process.env` does not exist inside workerd, so reading it here
// made this spec skip on EVERY run including the arm it exists for
const arm = typeof __DRUPFLARE_ABI__ === 'string' ? __DRUPFLARE_ABI__ : '';

describe.skipIf(!arm)('the heap through a chunked workload on this ABI', () => {
	it('reports linear memory at each step', async () => {
		const series = await inObject(freshSite(), async (site: ServeDo) => {
			const out: Array<Record<string, unknown>> = [];
			const heap = async (): Promise<number> => {
				const res = await site.fetch(new Request('https://do.local/__heap?op=status'));
				const body = (await res.json()) as Record<string, unknown>;
				return Number(body.linearMemoryBytes ?? 0);
			};
			const step = async (name: string, run: () => Promise<unknown>): Promise<boolean> => {
				try {
					await run();
				} catch (e) {
					out.push({ step: name, threw: String((e as Error).message).slice(0, 90) });
					return false;
				}
				try {
					out.push({ step: name, mib: (await heap()) / MIB });
				} catch (e) {
					out.push({
						step: name,
						heapUnreadable: String((e as Error).message).slice(0, 60)
					});
					return false;
				}
				return true;
			};

			await step('boot', () => site.fetch(new Request('https://do.local/__php')));

			// chunked rather than `all=1`, which is the only difference that matters here
			for (let i = 0; i < 40; i++) {
				const ok = await step(`migrate ${i}`, () =>
					site.fetch(new Request('https://do.local/__migrate?prefill=0'))
				);
				if (!ok) return out;
			}

			await step('firstrun', () =>
				site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						body: JSON.stringify({ adminPass: AUTH_PASS, siteName: 'Growth' }),
						headers: { 'content-type': 'application/json' }
					})
				)
			);
			await step('render', async () => {
				queuePath(site, '/', { arm: false });
				await site.fetch(new Request('https://do.local/__fill'));
			});

			// `printErr` and `onAbort` push into `bootDiag`, read OFF THE INSTANCE rather than through
			// `/__php`: that route re-enters the interpreter, and after an `exit(1)` the interpreter
			// is what is broken -- so the route that reports the diagnosis dies of the thing it was
			// asked to diagnose
			const diag = (site as unknown as { bootDiag?: string[] }).bootDiag ?? [];
			out.push({ step: 'diag', tail: diag.slice(-10) });
			return out;
		});

		// only the first and last few matter; the migrate plateau is noise once it is flat
		const flat = series.filter((s) => typeof s.mib === 'number').map((s) => s.mib as number);
		console.log(
			`[abi-steps] ${JSON.stringify({
				steps: series.length,
				peakMib: flat.length ? Math.max(...flat) : null,
				last: series.slice(-4)
			})}`
		);
		expect(series.length).toBeGreaterThan(0);
	});
});
