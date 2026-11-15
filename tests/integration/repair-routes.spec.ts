import { describe, expect, it, vi } from 'vitest';
import { mintOwnerToken } from '../../src/ops/site-secrets';
import { LEDGER_MAX_ROWS } from '../../src/ops/supervisor';
import { inObject, provisionedNamedSite, type ServeDo } from '../helpers/serve-do';

/** the two owner repair routes: `/recycle` and `/ledger-gc` */

let sites = 0;

async function claimed() {
	const stub = await provisionedNamedSite(`repair-${++sites}.example`);
	const token = await inObject(stub, async (site) => {
		site.ensureServeTables();
		return (await mintOwnerToken(site.secretStore())) ?? '';
	});
	return { stub, token };
}

const call = (stub: DurableObjectStub, path: string, method: string, token?: string) =>
	inObject(stub, (site) =>
		site.fetch(
			new Request(`https://do.local${path}`, {
				method,
				headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
			})
		)
	);

type Site = ServeDo & {
	recycles?: number;
	speculating?: boolean;
	php: unknown;
	lastRecycle?: { reason: string };
};

const residentInterpreter = (site: ServeDo) => {
	(site as Site).php = { binary: { HEAPU8: new Uint8Array(16) } };
};

const seedLedger = (site: ServeDo, rows: number) => {
	site.ensureServeTables();
	for (let i = 0; i < rows; i++) {
		site.sql.exec(
			"INSERT INTO cfw_health (ts, code, severity, scope, context, action, outcome, attempt) VALUES (?, 'x.y', 1, '', '', '', '', 0)",
			i
		);
	}
};

describe('POST /recycle', () => {
	it('answers 405 to a GET', async () => {
		const { stub, token } = await claimed();
		expect((await call(stub, '/__recycle', 'GET', token)).status).toBe(405);
	});

	it('drops a resident interpreter and counts it', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		await inObject(stub, (site) => residentInterpreter(site));
		const res = await call(stub, '/__recycle', 'POST', token);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			recycled: true,
			recyclesBefore: 0,
			recyclesAfter: 1
		});
		const last = await inObject(stub, (site) => (site as Site).lastRecycle?.reason);
		expect(last).toBe('owner');
	});

	it('counts nothing when no interpreter is resident', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			(site as Site).php = undefined;
		});
		const body = (await (await call(stub, '/__recycle', 'POST', token)).json()) as {
			recycled: boolean;
			recyclesAfter: number;
		};
		expect(body).toMatchObject({ recycled: false, recyclesAfter: 0 });
	});

	it('refuses with 409 while a transaction is open and leaves the interpreter', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			residentInterpreter(site);
			(site as Site).speculating = true;
		});
		const res = await call(stub, '/__recycle', 'POST', token);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ ok: false, error: 'a transaction is open' });
		const state = await inObject(stub, (site) => ({
			recycles: (site as Site).recycles ?? 0,
			resident: (site as Site).php !== undefined
		}));
		expect(state).toEqual({ recycles: 0, resident: true });
	});
});

describe('POST /ledger-gc', () => {
	it('answers 405 to a GET', async () => {
		const { stub, token } = await claimed();
		expect((await call(stub, '/__ledger-gc', 'GET', token)).status).toBe(405);
	});

	it('trims an oversized ledger to the cap', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		await inObject(stub, (site) => seedLedger(site, LEDGER_MAX_ROWS + 7));
		const body = await (await call(stub, '/__ledger-gc', 'POST', token)).json();
		expect(body).toEqual({
			ok: true,
			rowsBefore: LEDGER_MAX_ROWS + 7,
			rowsDeleted: 7,
			cap: LEDGER_MAX_ROWS
		});
		const left = await inObject(
			stub,
			(site) => site.sql.exec('SELECT COUNT(*) AS n FROM cfw_health').toArray()[0]!.n
		);
		expect(left).toBe(LEDGER_MAX_ROWS);
	});

	it('leaves a small ledger alone', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => seedLedger(site, 3));
		const body = await (await call(stub, '/__ledger-gc', 'POST', token)).json();
		expect(body).toEqual({ ok: true, rowsBefore: 3, rowsDeleted: 0, cap: LEDGER_MAX_ROWS });
	});
});
