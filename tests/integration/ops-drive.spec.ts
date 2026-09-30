import { describe, expect, it } from 'vitest';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * A config import and a queue drain are stepped operations: the route runs the first step and the
 * alarm chain carries the rest, one step per firing, until a step says `done` or fails.
 *
 * PHP is replaced by a script of replies, so this covers the driving (what is persisted, what each
 * step is handed, when the job ends) and not the operations themselves, which the sibling suites
 * cover.
 */

type Call = { name: string; args: string[]; options: Record<string, unknown> };
type Reply = Record<string, unknown>;

const decode = (code: string): Call => {
	const literal = /\$req = json_decode\((".*")\, true\);/.exec(code)?.[1];
	if (!literal) throw new Error('not an opsRun fragment');
	return JSON.parse(JSON.parse(literal) as string) as Call;
};

function script(site: ServeDo, replies: Reply[]): Call[] {
	const calls: Call[] = [];
	site.php = { stubbed: true };
	site.runJson = async (code) => {
		// the registry lookup the route makes before it runs anything
		if (!code.includes('$req = json_decode')) {
			return {
				ok: true,
				operations: { cim: { sliced: true }, 'queue-drain': { sliced: true } }
			};
		}
		calls.push(decode(code));
		return replies[calls.length - 1] ?? { ok: true, done: true };
	};
	return calls;
}

async function driven(replies: Reply[], route: string, init: RequestInit = { method: 'POST' }) {
	return inObject(freshSite(), async (site: ServeDo) => {
		markProvisioned(site);
		const calls = script(site, replies);
		const res = await site.fetch(new Request(`https://do.local/__ops?${route}`, init));
		const first = { status: res.status, body: (await res.json()) as Reply };
		const held = () => site.metaGet('ops_job') !== null;
		const afterFirst = held();
		const alarms: boolean[] = [];
		for (let i = 0; i < replies.length && held(); i++) {
			await site.alarm();
			alarms.push(held());
		}
		return {
			first,
			afterFirst,
			alarms,
			calls,
			last: (site as unknown as { lastOpsJob?: Reply }).lastOpsJob
		};
	});
}

describe('a stepped operation is carried by the alarm', () => {
	it('runs the first step in the request with the payload, then one step per firing without it', async () => {
		const seen = await driven(
			[
				{ ok: true, done: false, step: 1 },
				{ ok: true, done: false, step: 2 },
				{ ok: true, done: true, step: 3 }
			],
			'op=cim&drive=1&collections=language.fr,language.de&budget=3',
			{ method: 'POST', body: JSON.stringify({ 'system.site': { name: 'A' } }) }
		);
		expect(seen.first.status).toBe(200);
		expect(seen.first.body['driven']).toBe(true);
		expect(seen.afterFirst).toBe(true);
		expect(seen.alarms).toEqual([true, false]);
		expect(seen.calls.map((c) => c.name)).toEqual(['cim', 'cim', 'cim']);
		expect(seen.calls[0]!.options['payload']).toEqual({ 'system.site': { name: 'A' } });
		expect(seen.calls[1]!.options['payload']).toBeUndefined();
		// what shapes the run rides every step, not only the first
		expect(seen.calls.map((c) => c.options['collections'])).toEqual(
			Array(3).fill(['language.fr', 'language.de'])
		);
		expect(seen.calls.map((c) => c.options['budget'])).toEqual([3, 3, 3]);
		expect(seen.last).toMatchObject({ name: 'cim', more: false, done: true });
	}, 600_000);

	it('ends a job on a failed step and keeps it failed rather than restarting it', async () => {
		const seen = await driven(
			[
				{ ok: true, done: false },
				{ ok: false, error: 'import failed' }
			],
			'op=cim&drive=1',
			{ method: 'POST', body: '{}' }
		);
		expect(seen.alarms).toEqual([false]);
		expect(seen.calls).toHaveLength(2);
		expect(seen.last).toMatchObject({ more: false, ok: false, error: 'import failed' });
	}, 600_000);

	it('finishes in the request when the first step is already done, and persists nothing', async () => {
		const seen = await driven([{ ok: true, done: true }], 'op=cim&drive=1', {
			method: 'POST',
			body: '{}'
		});
		expect(seen.first.body['driven']).toBe(false);
		expect(seen.afterFirst).toBe(false);
		expect(seen.calls).toHaveLength(1);
	}, 600_000);

	it('drains a queue by count, handing every step the queue and the limit', async () => {
		const seen = await driven(
			[
				{ ok: true, done: false, remaining: 12 },
				{ ok: true, done: true, remaining: 0 }
			],
			'op=queue-drain&drive=1&limit=5&arg=default'
		);
		expect(seen.calls.map((c) => [c.name, c.args, c.options['limit']])).toEqual([
			['queue-drain', ['default'], 5],
			['queue-drain', ['default'], 5]
		]);
		expect(seen.alarms).toEqual([false]);
	}, 600_000);
});
