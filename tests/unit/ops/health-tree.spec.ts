import { describe, expect, it } from 'vitest';
import {
	healthTree,
	reconcileNode,
	repairNode,
	supervisorNode,
	worse
} from '../../../src/ops/health-tree';
import { CLEAN_STATE } from '../../../src/ops/repair';

describe('one scale for three producers', () => {
	it('orders levels so the worst wins', () => {
		expect(worse('ok', 'warn')).toBe('warn');
		expect(worse('critical', 'info')).toBe('critical');
		expect(worse('error', 'error')).toBe('error');
	});

	it('maps each reconcile state and keeps the producer word', () => {
		const node = reconcileNode({
			version: 3,
			packVersion: 4,
			steps: [
				{ id: 'a', since: 1, describe: 'A', state: 'satisfied', detail: '' },
				{ id: 'b', since: 1, describe: 'B', state: 'applied', detail: '' },
				{ id: 'c', since: 2, describe: 'C', state: 'deferred', detail: 'unclaimed' },
				{ id: 'd', since: 3, describe: 'D', state: 'owed', detail: 'x' },
				{ id: 'e', since: 4, describe: 'E', state: 'failed', detail: 'attempt 3: y' }
			]
		});
		expect(node.children.map((c) => [c.id, c.level, c.state])).toEqual([
			['reconcile.a', 'ok', 'satisfied'],
			['reconcile.b', 'ok', 'applied'],
			['reconcile.c', 'info', 'deferred'],
			['reconcile.d', 'warn', 'owed'],
			['reconcile.e', 'error', 'failed']
		]);
		expect(node.level).toBe('error');
		expect(node.state).toBe('behind');
	});

	it('maps a finding severity and names its scope', () => {
		const node = supervisorNode([
			{ code: 'memory.trend_rising', severity: 'warn', scope: '/admin', context: 'rising' }
		]);
		expect(node.children[0]).toMatchObject({
			id: 'supervisor.memory.trend_rising',
			level: 'warn',
			title: 'memory.trend_rising on /admin',
			detail: 'rising'
		});
		expect(supervisorNode([]).level).toBe('ok');
	});

	it('reads quarantine as critical and strikes as a warning', () => {
		expect(repairNode({ ...CLEAN_STATE }).level).toBe('ok');
		expect(repairNode({ ...CLEAN_STATE, code: 'render.empty', strikes: 1 }).level).toBe('warn');
		expect(repairNode({ ...CLEAN_STATE, rung: 'quarantine' }).level).toBe('critical');
	});

	it('rolls the worst node up to the tree', () => {
		expect(healthTree([repairNode({ ...CLEAN_STATE }), supervisorNode([])]).level).toBe('ok');
		expect(healthTree([repairNode({ ...CLEAN_STATE, rung: 'quarantine' })]).level).toBe(
			'critical'
		);
	});
});
