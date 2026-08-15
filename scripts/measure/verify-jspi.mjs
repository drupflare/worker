#!/usr/bin/env node
/**
 * Drives one JSPI build variant through the whole slicing question in order:
 * boot, capability report, interrupt counting (mode 0), interrupt + JSPI
 * suspension (mode 1), then park/resume across two separate fetch invocations.
 *
 * Order matters. mode 0 proves the VM interrupt patch fires at all; mode 1 is the
 * first thing that can hit "trying to suspend JS frames"; park/resume is the one
 * that shows a PHP stack surviving with nothing on the JS stack at all.
 *
 * usage: bun scripts/measure/verify-jspi.mjs <variant> [port]
 *   bun scripts/measure/verify-jspi.mjs jspimb 8820
 */
import { spawn } from 'node:child_process';

const variant = process.argv[2];
if (!variant) {
	console.error('usage: bun scripts/measure/verify-jspi.mjs <variant> [port]');
	process.exit(1);
}
const port = Number(process.argv[3] ?? 8820);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wrangler = spawn(
	'bunx',
	[
		'wrangler',
		'dev',
		'-c',
		`wrangler.probe-${variant}.jsonc`,
		'--port',
		String(port),
		'--inspector-port',
		String(port + 50)
	],
	{ stdio: ['ignore', 'pipe', 'pipe'] }
);
let log = '';
wrangler.stdout.on('data', (d) => (log += d));
wrangler.stderr.on('data', (d) => (log += d));

async function get(path) {
	const r = await fetch(base + path);
	const text = await r.text();
	try {
		return { status: r.status, body: JSON.parse(text) };
	} catch {
		return { status: r.status, body: text.slice(0, 800) };
	}
}

const show = (label, r) =>
	console.log(`\n### ${label} [${r.status}]\n${JSON.stringify(r.body, null, 1)}`);

try {
	const t0 = Date.now();
	let boot = null;
	while (Date.now() - t0 < 240000) {
		try {
			const r = await fetch(`${base}/boot`);
			if (r.ok) {
				boot = await r.json();
				break;
			}
		} catch {
			// not listening yet
		}
		await sleep(1000);
	}
	if (!boot) throw new Error(`never became ready:\n${log.slice(-2500)}`);
	show('boot', { status: 200, body: boot });
	if (!boot.ok) throw new Error('instantiation failed');

	show('version', await get('/version'));
	show('extensions', await get('/extensions'));
	show('jspi capabilities', await get('/jspi'));

	// disarmed: the always-paid decrement only
	show('tick disarmed n=20000', await get('/tick?n=20000&period=0&mode=0'));
	// armed, counting only: proves the flag is reaching zend_interrupt_function
	show('tick count-only n=20000 period=2000', await get('/tick?n=20000&period=2000&mode=0'));
	// armed, suspending: the first place a JS frame on the stack shows up
	show('tick SUSPEND n=20000 period=20000', await get('/tick?n=20000&period=20000&mode=1'));
	show('tick SUSPEND n=20000 period=2000', await get('/tick?n=20000&period=2000&mode=1'));

	show('park', await get('/park?n=20000&period=8000&at=1'));
	show('resume', await get('/resume'));

	// LAST, and on its own instance: exit() shuts the SAPI's output down
	show('bailout (longjmp paths)', await get('/bailout'));
	// exact poll-site count for this workload: period=1 fires at every site
	show('poll-site census n=20000 period=1', await get('/tick?n=20000&period=1&mode=0'));
} catch (e) {
	console.error(`FAILED: ${e.message}`);
	process.exitCode = 1;
} finally {
	wrangler.kill('SIGTERM');
	await sleep(1500);
	wrangler.kill('SIGKILL');
}
