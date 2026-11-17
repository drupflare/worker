import { describe, expect, it } from 'vitest';
import type { RoleHost } from '../../../src/do/host';
import {
	MARK_REFUSAL,
	handsBackSession,
	keepsMark,
	laneOf,
	refusesPoolOwner,
	refusesPrimaryRoutes,
	refusesReconcile,
	roleName,
	trustsModuleFiles
} from '../../../src/do/role';

const host = (flags: { replica?: boolean; lane?: boolean }): RoleHost =>
	({
		isReplica: () => flags.replica === true,
		isPoolLane: () => flags.lane === true
	}) as unknown as RoleHost;

const SESSION = 'SESS0123456789abcdef0123456789abcdef=value';

describe('the named replica rules', () => {
	it('leaves reconciliation to the primary, so a pool lane does not reconcile', () => {
		expect(refusesReconcile(host({ replica: true, lane: true }))).toBe(true);
		expect(refusesReconcile(host({ replica: true, lane: false }))).toBe(false);
	});

	it('leaves autoscaling and lane provisioning to the primary', () => {
		expect(refusesPoolOwner(host({ lane: true }))).toBe(true);
		expect(refusesPoolOwner(host({}))).toBe(false);
	});

	it('trusts module files on a replica and checks them everywhere else', () => {
		expect(trustsModuleFiles(host({ replica: true }))).toBe(true);
		expect(trustsModuleFiles(host({}))).toBe(false);
	});

	it('reads the primary and lane number from the object name', () => {
		const named = (name?: string) =>
			({ ctx: { id: { name } } }) as unknown as Pick<RoleHost, 'ctx'>;
		expect(laneOf(named('example.com#r3'))).toEqual({ site: 'example.com', lane: 3 });
		expect(laneOf(named('example.com'))).toBeUndefined();
		expect(laneOf(named(undefined))).toBeUndefined();
	});

	it('names the role the stats and the replica status report', () => {
		expect(roleName(host({ replica: true }))).toBe('replica');
		expect(roleName(host({ replica: false, lane: true }))).toBe('primary');
		expect(roleName(host({}))).toBe('primary');
	});

	it('keeps the mark refusal text and status a client sees', () => {
		expect(MARK_REFUSAL).toEqual({ message: 'a replica lane keeps no mark', status: 409 });
	});

	it('refuses a mark on a replica and on nothing else', () => {
		expect(keepsMark(host({ replica: true }))).toBe(true);
		expect(keepsMark(host({ replica: false, lane: true }))).toBe(false);
		expect(keepsMark(host({}))).toBe(false);
	});

	it('answers the primary-only routes by pool lane, not by replica', () => {
		// a read-only primary is a replica without being a pool lane and must keep answering
		expect(refusesPrimaryRoutes(host({ replica: true, lane: false }))).toBe(false);
		expect(refusesPrimaryRoutes(host({ replica: false, lane: true }))).toBe(true);
	});

	it('hands a session back only from a pool lane that was given a session cookie', () => {
		expect(handsBackSession(host({ lane: true }), SESSION)).toBe(true);
		expect(handsBackSession(host({ lane: true }), 'theme=dark')).toBe(false);
		expect(handsBackSession(host({ lane: true }), '')).toBe(false);
		expect(handsBackSession(host({ replica: true, lane: false }), SESSION)).toBe(false);
	});
});
