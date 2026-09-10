/**
 * Does an authenticated request answer correctly when a replica lane serves it?
 *
 *   bun scripts/measure/session-on-lane.ts --pass=<admin password> [--cycles=20] [--depth=6]
 *
 * WHY THIS IS ITS OWN HARNESS. `measure:host` reported 4-5 errors per `auth-account` cell and a
 * hand-driven loop caught `RuntimeException: Failed to start the session.` once in ten -- and then
 * 120 consecutive requests on one session came back clean, twice, with and without two candidate
 * fixes. A rate that varies with warmth cannot decide anything, so this drives the variable the
 * ad-hoc loops held fixed: SESSION AGE. Each cycle logs in fresh and then issues `depth` requests,
 * so the early requests of a young session are sampled `cycles` times instead of once.
 *
 * The reading is the failure rate BY REQUEST INDEX. A defect on session establishment concentrates
 * at index 0-1 and a defect in steady state spreads flat; one number over a whole run cannot tell
 * those apart, which is why the ad-hoc loops were unattributable.
 */

import { login, setExtraHeaders } from './vps-compare';

const arg = (name: string, fallback: string): string =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const BASE = arg('base', 'http://127.0.0.1:8787');
const SITE = arg('site', 'bench2');
const PASS = arg('pass', '');
const CYCLES = Number(arg('cycles', '20'));
const DEPTH = Number(arg('depth', '6'));
const LANES = Number(arg('lanes', '3'));
const PATH = arg('path', '/user');

if (PASS === '') {
	console.error('usage: bun scripts/measure/session-on-lane.ts --pass=<admin password>');
	process.exit(1);
}

const host = `${SITE}.localhost`;
setExtraHeaders({ host });

type Hit = {
	cycle: number;
	index: number;
	status: number;
	replica: string;
	error: string;
};

async function provisionLanes(): Promise<number> {
	let ready = 0;
	for (let lane = 1; lane <= LANES; lane++) {
		const res = await fetch(`${BASE}/replica?action=provision&lane=${lane}&budget=4000`, {
			headers: { host }
		});
		if (res.ok) ready += 1;
	}
	return ready;
}

/** the message a failure carries, trimmed; a JSON error body and an HTML one both appear here */
function reasonOf(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: string };
		if (typeof parsed.error === 'string') return parsed.error;
	} catch {
		/* an HTML error page, handled below */
	}
	const match = /(RuntimeException|Exception|Error)[^<\n"]{0,120}/.exec(body);
	return match ? match[0] : body.slice(0, 80).replace(/\s+/g, ' ');
}

const ready = LANES > 0 ? await provisionLanes() : 0;
console.error(`[session-on-lane] lanes ${ready}/${LANES}, ${CYCLES} cycles x ${DEPTH} requests`);

const hits: Hit[] = [];
for (let cycle = 0; cycle < CYCLES; cycle++) {
	const cookie = await login(BASE, 'admin', PASS);
	if (cookie === null) {
		console.error(`[session-on-lane] cycle ${cycle}: login failed`);
		continue;
	}
	for (let index = 0; index < DEPTH; index++) {
		const res = await fetch(`${BASE}${PATH}`, {
			redirect: 'manual',
			headers: { host, cookie }
		});
		const body = res.status >= 400 ? await res.text() : '';
		hits.push({
			cycle,
			index,
			status: res.status,
			replica: res.headers.get('x-cfw-replica') ?? '?',
			error: body === '' ? '' : reasonOf(body)
		});
	}
}

const failures = hits.filter((h) => h.status >= 500);
const byIndex = Array.from({ length: DEPTH }, (_, i) => {
	const at = hits.filter((h) => h.index === i);
	return { index: i, n: at.length, failed: at.filter((h) => h.status >= 500).length };
});
const reasons: Record<string, number> = {};
for (const f of failures) reasons[f.error] = (reasons[f.error] ?? 0) + 1;
const objects: Record<string, number> = {};
for (const h of hits) objects[h.replica] = (objects[h.replica] ?? 0) + 1;

console.log(
	JSON.stringify(
		{
			site: SITE,
			path: PATH,
			lanes: ready,
			requests: hits.length,
			failed: failures.length,
			failureRate: hits.length === 0 ? 0 : failures.length / hits.length,
			// the reading that separates establishment from steady state
			byRequestIndex: byIndex,
			reasons,
			objects,
			verdict: failures.length === 0 ? 'no failure reproduced' : 'reproduced'
		},
		null,
		1
	)
);
process.exit(failures.length === 0 ? 0 : 1);
