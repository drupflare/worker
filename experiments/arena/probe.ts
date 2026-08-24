import { DurableObject } from 'cloudflare:workers';

/**
 * P25: whether an argon2id arena fits beside a booted PHP inside one Durable Object.
 *
 * The backlog closed argon2 on `PHP_PASSWORD_ARGON2_MEMORY_COST` defaulting to 64 MiB against a
 * 128 MB isolate that an install already takes to ~115 MiB. That closes ONE mechanism -- a 64 MiB
 * arena inside PHP's own heap, where `memory.grow` has no inverse so the first hash raises the
 * object's floor for life. It does not close memory-hard password hashing, which is what Drupal 12
 * requires by default.
 *
 * OWASP's floor is m=19456 KiB (19 MiB), t=2, p=1. A JS-side arena is garbage-collected rather than
 * permanent, so the question is only whether 19 MiB of transient allocation COEXISTS with PHP's
 * resident heap, and that is a platform question no local lane can answer -- workerd does not
 * enforce the isolate cap in the gate.
 *
 * MODELLED RATHER THAN INSTRUMENTED WITH PHP, deliberately. A `WebAssembly.Memory` grown to the
 * measured PHP floor is the same allocation PHP makes; carrying the interpreter and the pack here
 * would cost a 48 MB asset upload to measure a number that does not depend on either. Every page is
 * TOUCHED, because an untouched reservation is not a measurement -- workerd charges pages, not
 * declarations.
 */
export class ArenaProbe extends DurableObject {
	private wasm?: WebAssembly.Memory;
	private held: Uint8Array[] = [];

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);

		if (url.pathname === '/reset') {
			this.wasm = undefined;
			this.held = [];
			return Response.json({ ok: true });
		}

		if (url.pathname === '/arena') {
			const wasmMib = q('wasmMib', 96);
			const jsMib = q('jsMib', 19);
			const out: Record<string, unknown> = { wasmMib, jsMib };

			try {
				// PAGES, not bytes: a wasm page is 64 KiB, so 96 MiB is 1,536 pages
				this.wasm = new WebAssembly.Memory({ initial: (wasmMib * 1024 * 1024) / 65_536 });
				const view = new Uint8Array(this.wasm.buffer);
				// EVERY 4 KiB, not every wasm page. Residency is charged per OS page, so touching
				// one byte per 64 KiB wasm page makes 1 of 16 OS pages resident and understates the
				// footprint 16-fold -- the first version of this probe did exactly that and reported
				// 224 MiB coexisting in one object
				for (let i = 0; i < view.length; i += 4096) view[i] = 1;
				out.wasmOk = true;
				out.wasmBytes = view.length;
			} catch (e) {
				out.wasmOk = false;
				out.wasmError = String((e as Error)?.message ?? e);
				return Response.json(out);
			}

			try {
				const arena = new Uint8Array(jsMib * 1024 * 1024);
				for (let i = 0; i < arena.length; i += 4096) arena[i] = 1;
				this.held.push(arena);
				out.arenaOk = true;
				out.arenaBytes = arena.length;
			} catch (e) {
				out.arenaOk = false;
				out.arenaError = String((e as Error)?.message ?? e);
			}
			return Response.json(out);
		}

		// how far a REPEATED arena gets, which is what a login burst looks like
		if (url.pathname === '/burst') {
			const jsMib = q('jsMib', 19);
			const rounds = q('rounds', 5);
			const results: boolean[] = [];
			for (let i = 0; i < rounds; i++) {
				try {
					const arena = new Uint8Array(jsMib * 1024 * 1024);
					for (let j = 0; j < arena.length; j += 4096) arena[j] = 1;
					results.push(true);
					// dropped immediately, which is what a per-hash arena does
				} catch {
					results.push(false);
				}
			}
			return Response.json({ jsMib, rounds, results });
		}

		return new Response('not found', { status: 404 });
	}
}

export default {
	async fetch(request: Request, env: { PROBE: DurableObjectNamespace<ArenaProbe> }) {
		const id = env.PROBE.idFromName('arena');
		return env.PROBE.get(id).fetch(request);
	}
} satisfies ExportedHandler<{ PROBE: DurableObjectNamespace<ArenaProbe> }>;
