import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The accepted-write mark inside a real Durable Object.
 *
 * The node spec proves the counting over SQLite. This one proves what only the platform runtime
 * can: its SQL authorizer accepts the triggers, the statement wrapper reaches them on the object's
 * own handle, and the owner routes answer the shapes a caller builds against.
 */

const call = (obj: ServeDo, path: string, init?: RequestInit) =>
	obj.fetch(new Request(`https://do.local${path}`, init));

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

function seed(obj: ServeDo) {
	obj.sql.exec('CREATE TABLE node (nid INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT)');
	obj.sql.exec('CREATE TABLE cache_render (cid TEXT PRIMARY KEY, data BLOB)');
}

describe('the mark routes', () => {
	it('starts, reads, counts and ends', async () => {
		const out = await inObject(freshSite(), async (obj) => {
			seed(obj);
			const none = await call(obj, '/__writemark');
			const started = await call(obj, '/__writemark?mark=m1', { method: 'POST' });
			const startedBody = await json(started);
			obj.sql.exec("INSERT INTO node (uuid) VALUES ('a')");
			obj.sql.exec("INSERT INTO cache_render VALUES ('c', x'00')");
			const again = await json(await call(obj, '/__writemark?mark=m1', { method: 'POST' }));
			const read = await json(await call(obj, '/__writemark'));
			const clash = await call(obj, '/__writemark?mark=m2', { method: 'POST' });
			const wrong = await call(obj, '/__writemark?mark=m2', { method: 'DELETE' });
			const ended = await json(await call(obj, '/__writemark?mark=m1', { method: 'DELETE' }));
			obj.sql.exec("INSERT INTO node (uuid) VALUES ('b')");
			const after = await call(obj, '/__writemark');
			return {
				none: none.status,
				started: started.status,
				startedBody,
				again,
				read,
				clash: clash.status,
				wrong: wrong.status,
				ended,
				after: after.status,
				triggers: obj.sql
					.exec("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger'")
					.toArray()[0]
			};
		});
		expect(out.none).toBe(404);
		expect(out.started).toBe(201);
		expect(out.startedBody).toMatchObject({ ok: true, mark: 'm1', status: 'started' });
		expect(out.again).toMatchObject({ mark: 'm1', status: 'existing' });
		expect(out.again.startedAt).toBe(out.startedBody.startedAt);
		expect(out.read).toMatchObject({ mark: 'm1', writes: 1, incomplete: false });
		expect(out.clash).toBe(409);
		expect(out.wrong).toBe(409);
		expect(out.ended).toMatchObject({ ended: true });
		expect(out.after).toBe(404);
		expect(out.triggers).toEqual({ c: 0 });
	});

	it('refuses a mark id it cannot store', async () => {
		const status = await inObject(
			freshSite(),
			async (obj) => (await call(obj, '/__writemark?mark=a%20b', { method: 'POST' })).status
		);
		expect(status).toBe(400);
	});

	it('answers a manifest and then the same changes as SQL up to through', async () => {
		const out = await inObject(freshSite(), async (obj) => {
			seed(obj);
			await call(obj, '/__writemark?mark=m1', { method: 'POST' });
			obj.sql.exec("INSERT INTO node (uuid) VALUES ('a'), ('b')");
			const manifest = await json(await call(obj, '/__writechanges'));
			obj.sql.exec("INSERT INTO node (uuid) VALUES ('later')");
			const body = await call(obj, `/__writechanges?body=1&through=${manifest.through}`);
			return { manifest, text: await body.text(), type: body.headers.get('content-type') };
		});
		expect(out.manifest).toMatchObject({ ok: true, through: 2, writes: 2, incomplete: false });
		expect(out.manifest.cannotCarry).toContain('sessions');
		expect(out.type).toContain('text/plain');
		expect(out.text).toContain("REPLACE INTO `node` (`nid`, `uuid`) VALUES (1, 'a');");
		expect(out.text).toContain("VALUES (2, 'b');");
		expect(out.text).not.toContain('later');
		expect(out.text.trimEnd().split('\n').at(-1)).toBe('-- end, 2 statements');
	});

	it('refuses a changes read with no mark and a bad dialect', async () => {
		const out = await inObject(freshSite(), async (obj) => ({
			none: (await call(obj, '/__writechanges')).status,
			dialect: (await call(obj, '/__writechanges?dialect=oracle')).status,
			through: (await call(obj, '/__writechanges?through=-1')).status
		}));
		expect(out).toEqual({ none: 404, dialect: 400, through: 400 });
	});
});

describe('the wrapped handle', () => {
	it('puts triggers on a table the application creates after the mark started', async () => {
		const out = await inObject(freshSite(), async (obj) => {
			await call(obj, '/__writemark?mark=m1', { method: 'POST' });
			obj.sql.exec('CREATE TABLE node__field_tags (entity_id INTEGER PRIMARY KEY, tag TEXT)');
			obj.sql.exec("INSERT INTO node__field_tags VALUES (1, 'x')");
			return json(await call(obj, '/__writemark'));
		});
		expect(out.writes).toBe(2);
	});
});

describe('the changes after a point', () => {
	it('answers only the writes after since, and refuses a bad one', async () => {
		const out = await inObject(freshSite(), async (obj) => {
			seed(obj);
			await call(obj, '/__writemark?mark=m1', { method: 'POST' });
			obj.sql.exec("INSERT INTO node (uuid) VALUES ('a'), ('b')");
			const first = await json(await call(obj, '/__writechanges'));
			obj.sql.exec("INSERT INTO node (uuid) VALUES ('later')");
			const manifest = await json(await call(obj, `/__writechanges?since=${first.through}`));
			const body = await call(
				obj,
				`/__writechanges?body=1&since=${first.through}&through=${manifest.through}`
			);
			return {
				first,
				manifest,
				sinceHeader: body.headers.get('x-cfw-since'),
				plainHeader: (
					await call(obj, `/__writechanges?body=1&through=${manifest.through}`)
				).headers.get('x-cfw-since'),
				text: await body.text(),
				letters: (await call(obj, '/__writechanges?since=x')).status,
				past: (await call(obj, '/__writechanges?since=9&through=3')).status
			};
		});
		expect(out.manifest).toMatchObject({ since: out.first.through, through: 3, writes: 3 });
		expect(out.text.split('\n')[0]).toBe('-- changes after write 2 through write 3, mysql');
		expect(out.text).toContain("VALUES (3, 'later');");
		expect(out.text).not.toContain("'a'");
		expect(out.text.trimEnd().split('\n').at(-1)).toBe('-- end, 1 statement');
		expect(out.sinceHeader).toBe(String(out.first.through));
		expect(out.plainHeader).toBe('0');
		expect(out.letters).toBe(400);
		expect(out.past).toBe(400);
	});
});

describe('a restore that carries the mark', () => {
	const DUMP = [
		'CREATE TABLE restore_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);',
		"INSERT INTO restore_probe (id, v) VALUES (1, 'a');"
	].join('\n');

	async function applied(obj: ServeDo): Promise<void> {
		for (let i = 0; i < 6; i++) {
			await obj.storage.setAlarm(Date.now() + 1);
			await obj.alarm();
		}
	}

	it('opens the mark with the last chunk, so the next write is the first one counted', async () => {
		const out = await inObject(freshSite(), async (obj) => {
			obj.env = { ...obj.env, PW_DIAGNOSTICS: '1' };
			await call(obj, '/__migrate?all=1&prefill=0');
			const res = await call(obj, '/__restore?label=promote-1&mark=op1', {
				method: 'POST',
				body: DUMP
			});
			const answer = await json(res);
			const before = await call(obj, '/__writemark');
			await applied(obj);
			const opened = await json(await call(obj, '/__writemark'));
			obj.sql.exec("INSERT INTO restore_probe (v) VALUES ('visitor')");
			const counted = await json(await call(obj, '/__writemark'));
			return { status: res.status, answer, before: before.status, opened, counted };
		});
		expect(out.status).toBe(200);
		expect(out.answer).toMatchObject({ ok: true, mark: 'op1' });
		expect(out.before).toBe(404);
		expect(out.opened).toMatchObject({ mark: 'op1', writes: 0, incomplete: false });
		expect(out.counted).toMatchObject({ mark: 'op1', writes: 1 });
	});

	it('leaves a restore without the field alone, and refuses a mark it cannot store', async () => {
		const out = await inObject(freshSite(), async (obj) => {
			obj.env = { ...obj.env, PW_DIAGNOSTICS: '1' };
			await call(obj, '/__migrate?all=1&prefill=0');
			const bad = await call(obj, '/__restore?label=promote-0&mark=a%20b', {
				method: 'POST',
				body: DUMP
			});
			const plain = await json(
				await call(obj, '/__restore?label=promote-1', { method: 'POST', body: DUMP })
			);
			await applied(obj);
			return {
				bad: bad.status,
				plain,
				mark: (await call(obj, '/__writemark')).status,
				rows: obj.sql.exec('SELECT COUNT(*) AS c FROM restore_probe').toArray()[0]
			};
		});
		expect(out.bad).toBe(400);
		expect(out.plain).not.toHaveProperty('mark');
		expect(out.mark).toBe(404);
		expect(out.rows).toEqual({ c: 1 });
	});
});
