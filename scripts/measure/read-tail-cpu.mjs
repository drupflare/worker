import { readFile } from 'node:fs/promises';

/**
 * Extracts per-invocation cpuTime from a `wrangler tail --format json` capture.
 *
 *   bunx wrangler tail <worker> --format json > /tmp/tail.jsonl
 *   bun scripts/measure/read-tail-cpu.mjs /tmp/tail.jsonl [urlSubstring]
 *
 * RULE 0 exists because of this file: in-PHP microtime() reads 0 on the edge, so
 * cpuTime from a deployed worker is the only authoritative absolute. Durable Object
 * invocations and Worker invocations arrive in the same stream and must be separated
 * -- a DO render and the Worker that dispatched it are two different budgets.
 */

const [file, filter] = process.argv.slice(2);
if (!file) {
	console.error('usage: read-tail-cpu.mjs <tail.jsonl> [urlSubstring]');
	process.exit(1);
}

const raw = await readFile(file, 'utf8');

/**
 * `wrangler tail --format json` pretty-prints each event and concatenates them, so
 * the stream is neither one object nor one-object-per-line. Scan brace depth, and
 * track string/escape state so a `{` inside a header value cannot desynchronise it.
 */
function splitConcatenatedJson(text) {
	const out = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '{') {
			if (depth === 0) start = i;
			depth++;
		} else if (c === '}') {
			depth--;
			if (depth === 0 && start >= 0) {
				out.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return out;
}

const events = [];
for (const chunk of splitConcatenatedJson(raw)) {
	try {
		events.push(JSON.parse(chunk));
	} catch {
		// wrangler prints human-readable banners into the same stream
	}
}

const rows = [];
for (const e of events) {
	const cpu = e.cpuTime ?? e.wallTime ?? null;
	if (typeof e.cpuTime !== 'number') continue;
	const url = e.event?.request?.url ?? e.event?.rayId ?? '';
	const kind = e.entrypoint ?? e.scriptName ?? '';
	rows.push({
		cpuMs: e.cpuTime,
		wallMs: e.wallTime ?? null,
		model: e.executionModel ?? '',
		outcome: e.outcome,
		url: String(url),
		kind
	});
}

const median = (xs) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const groups = new Map();
for (const r of rows) {
	if (filter && !r.url.includes(filter)) continue;
	const key = r.model || 'unknown';
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(r);
}

for (const [model, rs] of groups) {
	const cpus = rs.map((r) => r.cpuMs);
	console.log(
		`${model.padEnd(14)} n=${String(rs.length).padStart(3)}  median ${median(cpus)} ms  min ${Math.min(...cpus)}  max ${Math.max(...cpus)}`
	);
	console.log(`  order: ${cpus.join(', ')}`);
	const bad = rs.filter((r) => r.outcome && r.outcome !== 'ok');
	if (bad.length) console.log(`  non-ok outcomes: ${bad.map((b) => b.outcome).join(', ')}`);
}
if (!groups.size) console.log('no cpuTime events matched');
