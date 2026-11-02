import '@drupflare/cartridge/shim';
import { PhpBase } from 'php-wasm/PhpBase';
import controlGlue from './build/control-worker.mjs';
import wasmModule from './build/php8.5.tuned.wasm';
import shipGlue from './build/ship-worker.mjs';
import { clampReps, refuse } from './guard.js';

const wsLog = [];
const RealWS = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWS {
	constructor(url, protocols) {
		super(url, protocols);
		const entry = { url: String(url), at: Date.now(), events: [] };
		wsLog.push(entry);
		for (const t of ['open', 'error', 'close']) {
			this.addEventListener(t, (ev) =>
				entry.events.push({ t, at: Date.now(), code: ev.code, msg: ev.message })
			);
		}
	}
};

const GLUES = { control: controlGlue, ship: shipGlue };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let memory;
let current;

async function boot(arm) {
	if (current?.arm === arm) return current;
	current = undefined;
	if (memory) new Uint8Array(memory.buffer).fill(0);
	else memory = new WebAssembly.Memory({ initial: 1024, maximum: 65536 });
	const diag = [];
	const out = [];
	const wss = arm.endsWith('wss');
	const t0 = Date.now();
	class P extends PhpBase {
		constructor() {
			super(Promise.resolve({ default: GLUES[arm.split('-')[0]] }), {
				ini: 'opcache.enable=0\nopcache.enable_cli=0\nmemory_limit=64M\ndefault_socket_timeout=2\ndisplay_errors=0',
				...(wss ? { websocket: { url: 'wss://', subprotocol: 'null' } } : {}),
				printErr: (t) => diag.push(`err: ${t}`),
				onAbort: (w) => diag.push(`abort: ${w}`),
				instantiateWasm(imports, receive) {
					imports.env.memory = memory;
					WebAssembly.instantiate(wasmModule, imports)
						.then((i) => receive(i, wasmModule))
						.catch((e) => diag.push(`FAILED: ${e?.message ?? e}`));
					return {};
				}
			});
		}
	}
	const php = new P();
	const text = (e) => out.push(...[].concat(e.detail ?? []));
	php.addEventListener('output', text);
	php.addEventListener('error', text);
	await php.binary;
	current = { arm, php, out, diag, bootMs: Date.now() - t0 };
	return current;
}

const ONE = {
	fsockopen: `$r=@fsockopen($H,$P,$en,$es,2);`,
	ssc: `$r=@stream_socket_client("tcp://$H:$P",$en,$es,2);`,
	unix: `$r=@stream_socket_client("unix:///tmp/s5.sock",$en,$es,2);`,
	socket: `if(!function_exists('socket_create')){echo json_encode(['skipped'=>'no sockets extension']);return;}
$s=@socket_create(AF_INET,SOCK_STREAM,SOL_TCP);$r=false;$en=0;$es='';
if($s===false){$en=socket_last_error();$es='socket_create: '.socket_strerror($en);}
else{$ok=@socket_connect($s,$H,$P);$r=$ok?$s:false;if(!$ok){$en=socket_last_error($s);$es=socket_strerror($en);}}`
};

function code(fn, host, port, reps) {
	return `<?php
$H=${JSON.stringify(host)};$P=${port};$res=[];
for($i=0;$i<${reps};$i++){$en=0;$es='';$t=microtime(true);
${ONE[fn]}
$bytes=0;$ok=false;
if(is_resource($r)&&get_resource_type($r)==='stream'){$ok=true;@fwrite($r,"GET / HTTP/1.0\\r\\nHost: $H\\r\\n\\r\\n");stream_set_blocking($r,false);$d=@fread($r,4096);$bytes=is_string($d)?strlen($d):0;@fclose($r);}
elseif($r instanceof Socket){$ok=true;@socket_close($r);}
$res[]=['ret'=>$ok?'connected':var_export($r,true),'errno'=>$en,'errstr'=>$es,'bytes'=>$bytes,'php_ms'=>round((microtime(true)-$t)*1000,3)];}
echo json_encode(['fn'=>${JSON.stringify(fn)},'gethostbyname'=>gethostbyname($H),'res'=>$res]);`;
}

async function run(url) {
	const q = url.searchParams;
	const arm = q.get('arm');
	const fn = q.get('fn');
	const host = q.get('host') ?? url.hostname;
	const port = Number(q.get('port') ?? 443);
	const reps = clampReps(q.get('reps'));
	const seen = wsLog.length;
	const inst = await boot(arm);
	inst.out.length = 0;
	if (fn === 'info') {
		await inst.php._run(
			`<?php echo json_encode(['version'=>PHP_VERSION,'ext'=>get_loaded_extensions(),'socket_create'=>function_exists('socket_create'),'fsockopen'=>function_exists('fsockopen'),'ssc'=>function_exists('stream_socket_client'),'disabled'=>ini_get('disable_functions'),'transports'=>stream_get_transports()]);`
		);
		return {
			arm,
			bootMs: inst.bootMs,
			memBytes: memory.buffer.byteLength,
			diag: inst.diag,
			out: inst.out.join('')
		};
	}
	const t0 = Date.now();
	let ret, err;
	try {
		ret = await inst.php._run(code(fn, host, port, reps));
	} catch (e) {
		err = String(e?.stack ?? e);
	}
	const jsMs = Date.now() - t0;
	await sleep(2500);
	return {
		arm,
		fn,
		host,
		port,
		bootMs: inst.bootMs,
		jsMs,
		ret,
		err,
		out: inst.out.join(''),
		diag: inst.diag.slice(-8),
		ws: wsLog.slice(seen)
	};
}

async function control(url) {
	const host = url.searchParams.get('host') ?? url.hostname;
	const out = {};
	const seen = wsLog.length;
	try {
		const r = await fetch(`https://${host}/sink-ping`, { redirect: 'manual' });
		out.fetch = { status: r.status, body: (await r.text()).slice(0, 80) };
	} catch (e) {
		out.fetch = { err: String(e) };
	}
	try {
		const ws = new WebSocket(`wss://${host}:443/`);
		await new Promise((res, rej) => {
			ws.addEventListener('open', res);
			ws.addEventListener('error', () => rej(new Error('ws error')));
			setTimeout(() => rej(new Error('ws timeout')), 4000);
		});
		out.ws = 'open';
		ws.close();
	} catch (e) {
		out.ws = String(e);
	}
	try {
		const { connect } = await import('cloudflare:sockets');
		const s = connect({ hostname: host, port: 443 });
		await Promise.race([
			s.opened,
			sleep(4000).then(() => Promise.reject(new Error('timeout')))
		]);
		out.tcp = 'opened';
		s.close();
	} catch (e) {
		out.tcp = String(e);
	}
	await sleep(500);
	out.ws_log = wsLog.slice(seen);
	return out;
}

export class Probe {
	constructor(state, env) {}
	async fetch(req) {
		const url = new URL(req.url);
		try {
			const body = url.pathname === '/control' ? await control(url) : await run(url);
			return Response.json(body);
		} catch (e) {
			return Response.json({ fatal: String(e?.stack ?? e) }, { status: 500 });
		}
	}
}

export class Sink {
	constructor(state) {
		this.state = state;
	}
	async fetch(req) {
		const url = new URL(req.url);
		const log = (await this.state.storage.get('log')) ?? [];
		if (url.pathname === '/sinklog') return Response.json(log);
		if (log.length >= 200) return new Response('sink ok');
		log.push({
			at: Date.now(),
			path: url.pathname,
			upgrade: req.headers.get('upgrade'),
			port: url.port
		});
		await this.state.storage.put('log', log);
		if (req.headers.get('upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			pair[1].accept();
			pair[1].addEventListener('message', (m) => pair[1].send(`echo ${m.data}`));
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		return new Response('sink ok');
	}
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === '/run' || url.pathname === '/control') {
			const bad = refuse(url, req, env);
			if (bad) return Response.json({ err: bad.err }, { status: bad.status });
			return env.PROBE.get(env.PROBE.idFromName('probe')).fetch(req);
		}
		return env.SINK.get(env.SINK.idFromName('sink')).fetch(req);
	}
};
