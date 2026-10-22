/**
 * What userland PHP can try through the vrzno bridge, one script per attempt.
 *
 * Each script prints one JSON object. `fetch`, `WebSocket` and the like are reached through the
 * default root of `new Vrzno()`, which was `globalThis`; the `vrzno_*` functions reach an eval, a
 * global call, a dynamic import and any property of the module.
 */
export const BRIDGE_ATTEMPTS: Record<string, string> = {
	'new Vrzno()->fetch(...)': `<?php
		$g = new Vrzno();
		$r = $g->fetch('http://169.254.169.254/latest/meta-data/');
		echo json_encode(['type' => get_debug_type($r)]);`,
	'new Vrzno()->process->env': `<?php
		$g = new Vrzno();
		$p = $g->process;
		$e = $p->env ?? null;
		echo json_encode(['process' => get_debug_type($p), 'env' => get_debug_type($e)]);`,
	'new Vrzno()->WebSocket': `<?php
		$g = new Vrzno();
		$w = $g->WebSocket;
		echo json_encode(['type' => get_debug_type($w)]);
		$socket = new $w('wss://socket.invalid/');`,
	'new Vrzno()->Function': `<?php
		$g = new Vrzno();
		$f = $g->Function;
		echo json_encode(['type' => get_debug_type($f)]);
		$made = new $f('return 7');
		echo json_encode(['made' => get_debug_type($made)]);`,
	'new Vrzno()->Object->getOwnPropertyNames(globalThis)': `<?php
		$g = new Vrzno();
		$o = $g->Object;
		$names = $o?->getOwnPropertyNames($g->globalThis);
		echo json_encode(['object' => get_debug_type($o), 'names' => get_debug_type($names)]);`,
	'new Vrzno()->caches': `<?php
		$g = new Vrzno();
		echo json_encode(['type' => get_debug_type($g->caches), 'crypto' => get_debug_type($g->crypto)]);`,
	"vrzno_run('fetch', ['http://x'])": `<?php
		echo json_encode(['result' => vrzno_run('fetch', ['http://x.invalid/'])]);`,
	"vrzno_import('data:text/javascript,export default 1')": `<?php
		$r = vrzno_import('data:text/javascript,export default 1');
		echo json_encode(['result' => is_scalar($r) ? $r : get_debug_type($r)]);`,
	"vrzno_eval('1')": `<?php
		echo json_encode(['result' => vrzno_eval('1')]);`,
	"vrzno_env('Object')": `<?php
		echo json_encode(['type' => get_debug_type(vrzno_env('Object'))]);`,
	"vrzno_env('FS')": `<?php
		echo json_encode(['type' => get_debug_type(vrzno_env('FS'))]);`,
	"vrzno_env('process')": `<?php
		echo json_encode(['type' => get_debug_type(vrzno_env('process'))]);`,
	"vrzno_env('targets')": `<?php
		echo json_encode(['type' => get_debug_type(vrzno_env('targets'))]);`,
	"vrzno_shared('anything')": `<?php
		echo json_encode(['type' => get_debug_type(vrzno_shared('anything'))]);`
};

/** what the shipping PHP does with the bridge: reads a host function and calls it with a string */
export const HOST_FUNCTION = `<?php
	$f = vrzno_env('cfwStats');
	echo json_encode([
		'callable' => is_callable($f),
		'reply' => is_callable($f) ? get_debug_type($f('')) : null,
		'constructor' => get_debug_type($f->constructor ?? null),
		'missing' => get_debug_type(vrzno_env('cfwNotInstalled')),
	]);`;

/** one script's printed output, and the error it raised if it raised one */
export type Attempt = { out: string; error?: string | undefined };

/** runs every attempt and the host-function read, each as its own script */
export async function runAttempts(
	run: (code: string) => Promise<Attempt>
): Promise<Record<string, Attempt>> {
	const rows: Record<string, Attempt> = {};
	for (const [name, code] of Object.entries(BRIDGE_ATTEMPTS)) rows[name] = await run(code);
	rows['host function'] = await run(HOST_FUNCTION);
	return rows;
}

/** a live proxy prints as `Vrzno` or `Vrzno:::{...}` in a type field */
const LIVE_PROXY = /:"Vrzno/;

/**
 * Whether every attempt came back closed: no live proxy anywhere, the fixed refusals for the three
 * functions that ran code, null for every module property, and the host function still working with
 * no `constructor` to climb from.
 */
export function closedProblems(rows: Record<string, Attempt>): string[] {
	const bad: string[] = [];
	for (const [name, row] of Object.entries(rows)) {
		if (LIVE_PROXY.test(row.out)) bad.push(`${name}: a live proxy came back (${row.out})`);
	}
	const want = (name: string, text: string) => {
		if (!rows[name]?.out.includes(text))
			bad.push(`${name}: expected ${text}, got ${rows[name]?.out}`);
	};
	want("vrzno_run('fetch', ['http://x'])", '"result":"vrzno: run is closed"');
	want(
		"vrzno_import('data:text/javascript,export default 1')",
		'"result":"vrzno: import is closed"'
	);
	want("vrzno_eval('1')", '"result":"vrzno: eval is closed"');
	for (const name of ["vrzno_env('Object')", "vrzno_env('FS')", "vrzno_env('process')"]) {
		want(name, '{"type":"null"}');
	}
	want("vrzno_env('targets')", '{"type":"null"}');
	want("vrzno_shared('anything')", '{"type":"null"}');
	want('new Vrzno()->process->env', '{"process":"null","env":"null"}');
	want(
		'host function',
		'{"callable":true,"reply":"string","constructor":"null","missing":"null"}'
	);
	return bad;
}
