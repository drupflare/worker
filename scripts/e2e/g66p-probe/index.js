import { WorkerEntrypoint } from 'cloudflare:workers';

export class Cap extends WorkerEntrypoint {
	read(path) {
		return 'cap:' + this.ctx.props.tenant + ':' + path;
	}
	boom() {
		throw new Error('cap-boom');
	}
}

export class Gate extends WorkerEntrypoint {
	fetch(request) {
		const host = new URL(request.url).hostname;
		if (this.ctx.props.allow.includes(host)) return new Response('gate-allowed:' + host);
		return new Response('gate-denied:' + host, { status: 403 });
	}
}

const DYN = `
export default { async fetch(request, env) {
	const url = new URL(request.url);
	const p = url.pathname;
	if (p === '/ok') return Response.json({ ok: true, cap: await env.CAP.read('/hello') });
	if (p === '/transform') {
		const body = { id: 1, items: [1, 2, 3] };
		return Response.json({ n: body.items.map((x) => x * 2), cap: await env.CAP.read('/t') });
	}
	if (p === '/heavy') {
		let s = 0;
		for (let i = 0; i < 2000000; i++) s += i % 7;
		return Response.json({ s });
	}
	if (p === '/bindings') {
		const out = { keys: Object.keys(env) };
		out.hostSecret = env.HOST_SECRET ?? null;
		out.loader = typeof env.LOADER;
		out.kv = typeof env.KV;
		out.cap = typeof env.CAP;
		try {
			const m = await import('cloudflare:workers');
			out.importedEnvKeys = Object.keys(m.env || {});
			out.importedSecret = (m.env && m.env.HOST_SECRET) ?? null;
		} catch (e) { out.importErr = String(e).slice(0, 120); }
		out.globalHits = Object.getOwnPropertyNames(globalThis).filter((k) => /host|secret|loader/i.test(k));
		return Response.json(out);
	}
	if (p === '/tenant') {
		const out = { loader: typeof env.LOADER };
		out.readT2 = await env.CAP.read('/x', 't2');
		for (const k of ['ctx', 'props', 'env']) {
			try { const v = await env.CAP[k]; out[k] = typeof v + ':' + JSON.stringify(v ?? null).slice(0, 100); }
			catch (e) { out[k] = 'err:' + String(e).slice(0, 100); }
		}
		out.prior = globalThis.__leak ?? null;
		globalThis.__leak = url.searchParams.get('tag');
		return Response.json(out);
	}
	if (p === '/net') {
		const out = {};
		try { const r = await fetch('https://example.com/'); out.fetch = { reached: r.status }; }
		catch (e) { out.fetch = { blocked: String(e).slice(0, 120) }; }
		try {
			const { connect } = await import('cloudflare:sockets');
			const s = connect({ hostname: 'example.com', port: 80 });
			await s.opened;
			out.connect = { reached: true };
		} catch (e) { out.connect = { blocked: String(e).slice(0, 120) }; }
		return Response.json(out);
	}
	if (p === '/gate') {
		const out = {};
		for (const h of ['allowed.test', 'example.com']) {
			try { const r = await fetch('https://' + h + '/x'); out[h] = { http: r.status, body: await r.text() }; }
			catch (e) { out[h] = { blocked: String(e).slice(0, 120) }; }
		}
		return Response.json(out);
	}
	if (p === '/cpu') { let n = 0; for (;;) { n++; } }
	if (p === '/idle') { await new Promise((r) => setTimeout(r, 20000)); return Response.json({ done: true }); }
	if (p === '/mem') {
		const a = []; let mb = 0;
		try { for (; mb < 640; mb += 4) { const u = new Uint8Array(4 * 1024 * 1024); u.fill(1); a.push(u); } return Response.json({ survived: mb }); }
		catch (e) { return Response.json({ thrown: String(e).slice(0, 120), mb }); }
	}
	if (p === '/throw') throw new Error('handler-throw');
	if (p === '/hang') { await new Promise(() => {}); }
	if (p === '/badjson') return new Response('not json{', { headers: { 'content-type': 'application/json' } });
	if (p === '/big') return new Response('x'.repeat(5 * 1024 * 1024));
	if (p === '/caperror') return Response.json({ v: await env.CAP.boom() });
	if (p === '/status500') return new Response('nope', { status: 500 });
	return new Response('?', { status: 404 });
} };`;

const BROKEN = 'export default { fetch( {';

const withTimeout = (p, ms, label) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(label + ' timeout ' + ms + 'ms')), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			}
		);
	});

function spec(ctx, q) {
	const cpuMs = Number(q.get('cpu') ?? 50);
	const code = q.get('mode') === 'syntax' ? BROKEN : DYN;
	const props = { tenant: q.get('tenant') ?? 't1' };
	const out = {
		compatibilityDate: '2026-10-13',
		mainModule: 'main.js',
		modules: { 'main.js': code },
		env: { CAP: ctx.exports.Cap({ props }) },
		globalOutbound: null,
		limits: { cpuMs, subRequests: 4 }
	};
	if (q.get('gate')) {
		out.globalOutbound = ctx.exports.Gate({ props: { allow: ['allowed.test'] } });
	}
	return out;
}

async function call(env, ctx, q, path) {
	const via = q.get('via') ?? 'load';
	const id = q.get('id') ?? 'g66p-a';
	const s = spec(ctx, q);
	const stub = via === 'get' ? env.LOADER.get(id, () => s) : env.LOADER.load(s);
	const res = await stub.getEntrypoint().fetch('http://dyn' + path);
	return res;
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const q = url.searchParams;
		if (url.pathname === '/plain') return new Response('ok');
		if (url.pathname === '/probe') {
			const timeout = Number(q.get('timeout') ?? 4000);
			const t0 = Date.now();
			try {
				const res = await withTimeout(call(env, ctx, q, q.get('p')), timeout, 'call');
				const text = await withTimeout(res.text(), timeout, 'body');
				return Response.json({
					http: res.status,
					body: text.slice(0, 700),
					bytes: text.length,
					ms: Date.now() - t0
				});
			} catch (e) {
				return Response.json({ error: String(e).slice(0, 300), ms: Date.now() - t0 });
			}
		}
		if (url.pathname === '/tenants') {
			const out = [];
			const steps = [
				['get', 'g66p-ta', 'A'],
				['get', 'g66p-tb', 'B'],
				['get', 'g66p-ta', 'A2'],
				['load', '', 'L1'],
				['load', '', 'L2']
			];
			for (const [via, id, tag] of steps) {
				const qq = new URLSearchParams({ via, id, tag });
				try {
					const res = await call(env, ctx, qq, '/tenant?tag=' + tag);
					out.push({ via, id, tag, body: await res.json() });
				} catch (e) {
					out.push({ via, id, tag, error: String(e).slice(0, 200) });
				}
			}
			return Response.json(out);
		}
		if (url.pathname === '/page') {
			const mode = q.get('handler') ?? 'ok';
			const where = q.get('where') ?? 'inline';
			const t0 = Date.now();
			let h = { mode, where };
			const run = async () => {
				const t1 = Date.now();
				try {
					const res = await withTimeout(call(env, ctx, q, '/' + mode), 2000, 'call');
					const text = await withTimeout(res.text(), 2000, 'body');
					h = {
						mode,
						where,
						status: 'ok',
						http: res.status,
						bytes: text.length,
						ms: Date.now() - t1
					};
				} catch (e) {
					h = {
						mode,
						where,
						status: 'failed',
						error: String(e).slice(0, 160),
						ms: Date.now() - t1
					};
				}
			};
			if (mode !== 'none') {
				if (where === 'inline') await run();
				else ctx.waitUntil(run());
			}
			return new Response('<html><body><h1>PAGE-RENDERED</h1></body></html>', {
				headers: { 'x-handler': JSON.stringify(h), 'x-page-ms': String(Date.now() - t0) }
			});
		}
		if (url.pathname === '/mix') {
			const kind = q.get('kind');
			const site = q.get('site') ?? '0';
			const t0 = Date.now();
			const path = kind === 'heavy' ? '/heavy' : '/transform';
			const qq = new URLSearchParams(
				kind === 'exec'
					? { via: 'load' }
					: {
							via: 'get',
							id: kind === 'heavy' ? 'g66p-heavy' : 'g66p-site-' + site,
							cpu: kind === 'heavy' ? '1000' : '50'
						}
			);
			try {
				const res = await call(env, ctx, qq, path);
				return Response.json({
					kind,
					http: res.status,
					ms: Date.now() - t0,
					body: (await res.text()).slice(0, 80)
				});
			} catch (e) {
				return Response.json({ kind, error: String(e).slice(0, 200), ms: Date.now() - t0 });
			}
		}
		return new Response('?', { status: 404 });
	}
};
