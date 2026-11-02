import { WorkerEntrypoint } from 'cloudflare:workers';

export class Cap extends WorkerEntrypoint {
	read(path) {
		return 'cap:' + this.ctx.props.tenant + ':' + path;
	}
}

const DYNAMIC = [
	'export default { async fetch(req, env) {',
	'	const p = new URL(req.url).pathname;',
	'	if (p === "/cap") return Response.json({ cap: await env.CAP.read("/hello") });',
	'	if (p === "/env") return Response.json({ keys: Object.keys(env) });',
	'	if (p === "/net") {',
	'		try { const r = await fetch("https://example.com/"); return Response.json({ reached: r.status }); }',
	'		catch (e) { return Response.json({ blocked: String(e) }); }',
	'	}',
	'	return new Response("?", { status: 404 });',
	'} };'
].join('\n');

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === '/plain') return new Response('ok');
		const mode = url.searchParams.get('mode') ?? 'load';
		const id = url.searchParams.get('id') ?? 'g66-a';
		const path = url.searchParams.get('p') ?? 'cap';
		const code = () => ({
			compatibilityDate: '2026-03-01',
			mainModule: 'main.js',
			modules: { 'main.js': DYNAMIC },
			env: { CAP: ctx.exports.Cap({ props: { tenant: 't1' } }) },
			globalOutbound: null,
			...(url.searchParams.has('limits') ? { limits: { cpuMs: 50, subRequests: 2 } } : {})
		});
		const t0 = Date.now();
		try {
			const stub = mode === 'get' ? env.LOADER.get(id, code) : env.LOADER.load(code());
			const res = await stub.getEntrypoint().fetch('http://dyn/' + path);
			return Response.json({
				mode,
				path,
				status: res.status,
				body: await res.text(),
				ms: Date.now() - t0
			});
		} catch (e) {
			return Response.json(
				{ mode, path, error: String(e), ms: Date.now() - t0 },
				{ status: 500 }
			);
		}
	}
};
