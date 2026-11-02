const EXTRA_HOSTS = ['127.0.0.1'];
const PORTS = new Set([0, 80, 443, 8443, 8799]);
const FNS = new Set(['info', 'fsockopen', 'ssc', 'unix', 'socket']);
const ARMS = new Set(['control-stock', 'control-wss', 'ship-stock', 'ship-wss']);

export function refuse(url, req, env) {
	const key = env?.PROBE_KEY;
	if (!key || req.headers.get('x-probe-key') !== key) return { status: 403, err: 'key required' };
	const q = url.searchParams;
	const host = q.get('host') ?? url.hostname;
	if (host !== url.hostname && !EXTRA_HOSTS.includes(host))
		return { status: 403, err: 'disallowed host' };
	if (!PORTS.has(Number(q.get('port') ?? 443))) return { status: 403, err: 'disallowed port' };
	if (url.pathname === '/run') {
		if (!ARMS.has(q.get('arm') ?? '')) return { status: 400, err: 'unknown arm' };
		if (!FNS.has(q.get('fn') ?? '')) return { status: 400, err: 'unknown fn' };
	}
	return undefined;
}

export function clampReps(raw) {
	const n = Math.trunc(Number(raw ?? 3));
	return Number.isFinite(n) ? Math.min(Math.max(n, 1), 5) : 3;
}
