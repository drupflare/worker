const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class Probe {
	constructor(state, env) {
		this.refs = [];
	}
	async fetch(request) {
		const url = new URL(request.url);
		const mode = url.searchParams.get('mode') ?? 'pressure';
		if (mode === 'micro') {
			const o = { steps: [] };
			const make2 = () => new WeakRef(new WebAssembly.Memory({ initial: 1280 }));
			const refs2 = [make2(), make2()];
			await sleep(1);
			const b = new ArrayBuffer(48 * 1048576);
			void b.byteLength;
			for (let i = 0; i < 5; i++) {
				await Promise.resolve();
				o.steps.push(['micro', i, refs2.filter((r) => r.deref()).length]);
			}
			await new Promise((r) => queueMicrotask(r));
			o.steps.push(['queueMicrotask', refs2.filter((r) => r.deref()).length]);
			await sleep(1);
			o.steps.push(['timer', refs2.filter((r) => r.deref()).length]);
			return Response.json(o);
		}
		if (mode === 'growmeter') {
			const out3 = { steps: [] };
			const m = new WebAssembly.Memory({ initial: 1280 });
			new Uint8Array(m.buffer).fill(1);
			const to = Number(url.searchParams.get('pages') ?? 2300);
			let cur = 1280;
			while (cur < to) {
				const add = Math.min(128, to - cur);
				m.grow(add);
				cur += add;
				new Uint8Array(m.buffer, (cur - add) * 65536, add * 65536).fill(1);
				out3.steps.push(cur);
				await sleep(200);
			}
			out3.linearMiB = m.buffer.byteLength / 1048576;
			this.keep = m;
			await sleep(20000);
			return Response.json(out3);
		}
		if (mode === 'limit') {
			const out2 = { steps: [] };
			const m = new WebAssembly.Memory({ initial: 1280 });
			for (const t of [1447, 1636, 1849, 2090, 2300]) m.grow(t - m.buffer.byteLength / 65536);
			new Uint8Array(m.buffer).fill(1);
			out2.linearMiB = m.buffer.byteLength / 1048576;
			this.keep = m;
			const mb = Number(url.searchParams.get('mb') ?? 48);
			const b = new ArrayBuffer(mb * 1048576);
			out2.untouched = b.byteLength / 1048576;
			await sleep(50);
			const c = new Uint8Array(mb * 1048576).fill(2);
			out2.touched = c.byteLength / 1048576;
			await sleep(50);
			return Response.json(out2);
		}
		const out = { mode, steps: [] };
		// make a dropped "interpreter": a memory plus something referencing it
		const make = () => {
			const m = new WebAssembly.Memory({ initial: 1280 });
			new Uint8Array(m.buffer)[0] = 1;
			return new WeakRef(m);
		};
		const refs = [make(), make()];
		out.alive0 = refs.map((r) => !!r.deref());
		await sleep(1);
		for (let i = 0; i < 12; i++) {
			if (mode === 'pressure') {
				const b = new ArrayBuffer(Number(url.searchParams.get('mb') ?? 48) * 1048576);
				new Uint8Array(b)[0] = 1;
			} else if (mode === 'idle') {
				await sleep(500);
			} else if (mode === 'alloc') {
				const a = [];
				for (let j = 0; j < 200000; j++) a.push({ j, s: 'x'.repeat(50) });
			}
			await sleep(1);
			out.steps.push([i, refs.filter((r) => !!r.deref()).length]);
		}
		return Response.json(out);
	}
}
export default {
	async fetch(r, env) {
		const id = env.P.idFromName(new URL(r.url).searchParams.get('id') ?? 'x');
		return env.P.get(id).fetch(r);
	}
};
