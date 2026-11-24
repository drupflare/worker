import { describe, expect, it } from 'vitest';
import { account } from '../../../scripts/economics/bill';
import { SPOOL_REQUESTS } from '../../../scripts/economics/measured';
import { WORKERS_PAID } from '../../../scripts/economics/rates';
import {
	DECORATION_CPU_MS,
	DEPLOYED_SESSION,
	MATRIX,
	MIX_121,
	TAB_2000,
	billWithSpool,
	breakEvenViews,
	deployedResiduals,
	envelopeInput,
	firstViewFloor,
	freeViewsPerDay,
	loadOff,
	matrixResiduals,
	netFloor,
	populationLoad,
	requestsPerView,
	rigPath,
	sequenceDocuments,
	serverJoulesSaved,
	visitLoad,
	workerLoad,
	type Engine,
	type Requests,
	type Visit
} from '../../../scripts/economics/spool';
import { FREE_QUOTAS } from '../../../scripts/measure/free-envelope';

const sum = (x: { documents: number; contacts: number; writes: number }) =>
	x.documents + x.contacts + x.writes;
const clients: Engine[] = ['worker', 'none'];
const local: Requests = { ...SPOOL_REQUESTS, documentsBeforeControl: 2 };
const one = (views: number, distinct: number): Visit => ({ views, distinct });

describe('the Worker requests of a visit with spool on', () => {
	it('costs a first view what it cost before spool, on every client', () => {
		for (const client of clients) {
			expect(sum(visitLoad(one(1, 1), client))).toBe(sum(loadOff(one(1, 1))));
		}
	});

	it('never costs a device more than the same visit with spool off', () => {
		for (const before of [1, 2, 3, 5]) {
			const k = { ...SPOOL_REQUESTS, documentsBeforeControl: before };
			for (let views = 1; views <= 60; views++) {
				for (let distinct = 1; distinct <= views; distinct++) {
					const v = one(views, distinct);
					expect(sum(workerLoad(v, k))).toBeLessThanOrEqual(sum(loadOff(v)));
				}
			}
		}
	});

	it('is bounded by the documents before control plus the distinct pages visited', () => {
		for (const distinct of [1, 3, 9, 20]) {
			for (const views of [1, 2, 5, 20, 121, 2000]) {
				const documents = workerLoad(one(views, distinct)).documents;
				expect(documents).toBeLessThanOrEqual(
					Math.min(views, SPOOL_REQUESTS.documentsBeforeControl) + distinct
				);
			}
		}
	});

	it('costs nothing for a view of a page the device holds, however many it makes', () => {
		const few = workerLoad(one(30, 9));
		const many = workerLoad(one(5000, 9));
		expect(sum(many)).toBe(sum(few));
		const path = rigPath(40);
		expect(sequenceDocuments([...path, '/', '/node/3', '/'])).toBe(sequenceDocuments(path));
	});

	it('charges a held view only through the held-view constant', () => {
		const dear = { ...SPOOL_REQUESTS, heldView: 1 };
		expect(workerLoad(one(30, 9), dear).documents).toBe(
			workerLoad(one(30, 9)).documents + (30 - SPOOL_REQUESTS.documentsBeforeControl - 9)
		);
		const path = rigPath(40);
		expect(sequenceDocuments([...path, '/'], dear)).toBe(sequenceDocuments(path, dear) + 1);
	});

	it('does not hold a page the device saw before its worker controlled', () => {
		expect(sequenceDocuments(['/a', '/b', '/a'], local)).toBe(3);
		expect(sequenceDocuments(['/a', '/b', '/c', '/c'], local)).toBe(3);
	});

	it('counts the closed form as an upper bound on any actual path', () => {
		for (let views = 1; views <= 60; views++) {
			const path = rigPath(views);
			const distinct = new Set(path).size;
			expect(sequenceDocuments(path)).toBeLessThanOrEqual(
				workerLoad(one(views, distinct)).documents
			);
		}
	});

	it('replaces a return day document with one contact and leaves writes where they were', () => {
		const base = one(10, 4);
		const back = { ...base, returnDays: 4, writes: 2 };
		expect(sum(loadOff(back)) - sum(loadOff(base))).toBe(6);
		expect(sum(workerLoad(back)) - sum(workerLoad(base))).toBe(
			4 * SPOOL_REQUESTS.returnDayContact + 2
		);
	});

	it('adds the extra per device only to a visit with a second view', () => {
		const extra = { ...SPOOL_REQUESTS, deviceExtra: 2 };
		expect(sum(workerLoad(one(1, 1), extra))).toBe(1);
		expect(sum(workerLoad(one(5, 5), extra))).toBe(sum(workerLoad(one(5, 5))) + 2);
	});

	it('averages over the clients of a population', () => {
		const v = one(20, 9);
		const mixed = sum(populationLoad(v, { worker: 0.5 }));
		expect(mixed).toBeCloseTo(
			0.5 * sum(visitLoad(v, 'worker')) + 0.5 * sum(visitLoad(v, 'none')),
			9
		);
	});
});

describe('the model against the measurements', () => {
	it('reproduces every cell of the local device matrix with no free parameter', () => {
		for (const row of matrixResiduals()) {
			expect(row).toEqual({ views: row.views, on: 0, onReturn: 0, off: 0, offReturn: 0 });
		}
		expect(matrixResiduals()).toHaveLength(MATRIX.length);
	});

	it('reproduces the deployed fixed session once the worker controls a view later', () => {
		expect(deployedResiduals()).toEqual({ on: 0, off: 0 });
		expect(DEPLOYED_SESSION.on).toBeLessThan(DEPLOYED_SESSION.off);
	});

	it('misses the matrix at the deployed constant and the deployed session at the local one', () => {
		expect(matrixResiduals(SPOOL_REQUESTS).some((r) => r.on !== 0)).toBe(true);
		expect(deployedResiduals(local).on).not.toBe(0);
	});

	it('walks the front page and articles 1 to 8 in turn, as the rig does', () => {
		expect(rigPath(1)).toEqual(['/']);
		expect(rigPath(6)).toEqual(['/', '/node/1', '/', '/node/2', '/', '/node/3']);
		expect(new Set(rigPath(20)).size).toBe(9);
		expect(rigPath(18)[16]).toBe('/');
		expect(rigPath(18)[17]).toBe('/node/1');
	});
});

describe('requests a view costs falls as a device holds more pages', () => {
	it('never rises with views at a fixed number of distinct pages', () => {
		for (const pop of [{ worker: 1 }, { worker: 0.5 }]) {
			for (const distinct of [1, 3, 9]) {
				const costs = [10, 20, 50, 121, 2000].map((views) =>
					requestsPerView(one(views, distinct), pop)
				);
				expect(costs).toEqual([...costs].sort((a, b) => b - a));
			}
		}
	});

	it('never falls as the device visits more distinct pages', () => {
		const costs = [1, 3, 9, 20].map((d) => requestsPerView(one(20, d), { worker: 1 }));
		expect(costs).toEqual([...costs].sort((a, b) => a - b));
		expect(costs[0]).toBeLessThan(costs[3]!);
	});

	it('falls as more visits run a worker, and is flat when none does', () => {
		const v = one(20, 9);
		const costs = [0, 0.5, 1].map((w) => requestsPerView(v, { worker: w }));
		expect(costs).toEqual([...costs].sort((a, b) => b - a));
		expect(costs[0]).toBe(1);
	});

	it('breaks even after the documents before control plus the distinct pages', () => {
		for (const d of [1, 3, 9, 20]) {
			const at = breakEvenViews(d)!;
			expect(at).toBe(SPOOL_REQUESTS.documentsBeforeControl + d + 1);
			expect(sum(workerLoad(one(at, d)))).toBeLessThan(sum(loadOff(one(at, d))));
			expect(sum(workerLoad(one(at - 1, d)))).toBe(sum(loadOff(one(at - 1, d))));
		}
	});

	it('never breaks even when a held view costs a request', () => {
		expect(breakEvenViews(9, { ...SPOOL_REQUESTS, heldView: 1 })).toBeUndefined();
	});
});

describe('the net floor of capacity on the free plan', () => {
	it('is the cap itself when every visitor makes one view and never returns', () => {
		expect(firstViewFloor()).toBe(FREE_QUOTAS.workerRequestsPerDay);
	});

	it('is the cap, because a device never costs more than spool off', () => {
		for (const before of [1, 2, 3]) {
			const floor = netFloor({ ...SPOOL_REQUESTS, documentsBeforeControl: before });
			expect(floor.viewsPerDay).toBe(FREE_QUOTAS.workerRequestsPerDay);
			expect(floor.perView).toBe(1);
		}
	});

	it('falls below the cap only by requests a device adds beyond its documents', () => {
		const floor = netFloor({ ...SPOOL_REQUESTS, deviceExtra: 1 });
		expect(floor.atViews).toBe(2);
		expect(floor.perView).toBeCloseTo(1.5, 9);
		expect(floor.viewsPerDay).toBeCloseTo(FREE_QUOTAS.workerRequestsPerDay / 1.5, 6);
	});

	it('carries more views a day when more of them are held on the device', () => {
		const v = { worker: 1 };
		expect(freeViewsPerDay(requestsPerView(MIX_121, v))).toBeGreaterThan(
			FREE_QUOTAS.workerRequestsPerDay
		);
		expect(freeViewsPerDay(requestsPerView(TAB_2000, v))).toBeGreaterThan(
			freeViewsPerDay(requestsPerView(MIX_121, v))
		);
	});
});

describe('the envelope input a visit gives', () => {
	it('is one document a view when spool changes nothing', () => {
		const input = envelopeInput(one(1, 1), { worker: 1 });
		expect(input).toEqual({ documentsPerView: 1, contactsPerView: 0 });
	});

	it('carries a missScale only when one is given', () => {
		const pop = { worker: 1 };
		expect(envelopeInput(MIX_121, pop)).not.toHaveProperty('missScale');
		expect(envelopeInput(MIX_121, pop, 1).missScale).toBe(1);
	});

	it('splits a return day into contacts and documents per view', () => {
		const v = { ...one(2, 2), returnDays: 2 };
		const input = envelopeInput(v, { worker: 1 });
		expect(input.contactsPerView).toBeCloseTo(2 / 2, 9);
	});
});

describe('the bill with spool', () => {
	it('is the existing model when every view is a document and no CPU is added', () => {
		for (const views of [100_000, 10_000_000, 30_000_000]) {
			const load = { documentsPerView: 1, contactsPerView: 0 };
			expect(billWithSpool(1, views, load, 0).total).toBeCloseTo(account(1, views).total, 6);
		}
	});

	it('adds the decoration CPU to every document that reaches the Worker', () => {
		const load = { documentsPerView: 1, contactsPerView: 0 };
		const extra = billWithSpool(1, 30_000_000, load).total - account(1, 30_000_000).total;
		expect(extra).toBeCloseTo(
			(DECORATION_CPU_MS * 30_000_000 * WORKERS_PAID.usdPerMillionCpuMs) / 1e6,
			6
		);
	});

	it('falls as fewer documents reach the Worker once the site pays for requests', () => {
		const bills = [1, 0.75, 0.5, 0.25].map(
			(d) => billWithSpool(1, 30_000_000, { documentsPerView: d, contactsPerView: 0 }).total
		);
		expect(bills).toEqual([...bills].sort((a, b) => b - a));
		expect(bills[3]).toBeLessThan(bills[0]!);
	});

	it('leaves a free site free while every meter fits', () => {
		expect(
			billWithSpool(1, 100_000, { documentsPerView: 0.5, contactsPerView: 0.1 }).free
		).toBe(true);
	});

	it('costs a site whose visits fetch every page no more than the decoration CPU', () => {
		const visit = one(20, 20);
		const load = populationLoad(visit, { worker: 1 });
		const bill = billWithSpool(1, 30_000_000, {
			documentsPerView: load.documents / visit.views,
			contactsPerView: load.contacts / visit.views
		}).total;
		const off = account(1, 30_000_000).total;
		expect(bill).toBeGreaterThan(off);
		expect(bill - off).toBeCloseTo(
			(DECORATION_CPU_MS * 30_000_000 * WORKERS_PAID.usdPerMillionCpuMs) / 1e6,
			6
		);
	});
});

describe('the server energy one local view spares', () => {
	it('is the cached serve CPU at the model watts, a few millijoules', () => {
		expect(serverJoulesSaved(1.8)).toBeCloseTo(0.0046, 4);
		expect(serverJoulesSaved(3.6)).toBeCloseTo(2 * serverJoulesSaved(1.8), 9);
	});
});
