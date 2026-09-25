import type { reconcileReport } from './reconcile.js';
import { isQuarantined, type RepairState } from './repair.js';
import type { Finding, Severity } from './supervisor.js';

/**
 * The repair and health state of one site, as one typed tree.
 *
 * Three producers report on a site: the supervisor's findings, the reconcile chain's per-step
 * verdicts and the repair ladder's rung. Each keeps its own vocabulary in `state`, and `level`
 * puts them on one scale, so a renderer reads this rather than re-deriving each producer's meaning.
 */

/** one scale for every producer, worst last */
export const HEALTH_LEVELS = ['ok', 'info', 'warn', 'error', 'critical'] as const;

export type HealthLevel = (typeof HEALTH_LEVELS)[number];

export type HealthSource = 'reconcile' | 'supervisor' | 'repair';

export interface HealthNode {
	/** stable, prefixed by source: `reconcile.owner-tiers`, `supervisor.memory.trend_rising` */
	id: string;
	source: HealthSource;
	level: HealthLevel;
	/** the producer's own word for it: `owed`, `applied`, `quarantine`, a severity */
	state: string;
	title: string;
	/** empty when there is nothing to say */
	detail: string;
	children: HealthNode[];
}

export interface HealthTree {
	/** the worst level anywhere below */
	level: HealthLevel;
	nodes: HealthNode[];
}

/** the worse of two levels */
export function worse(a: HealthLevel, b: HealthLevel): HealthLevel {
	return HEALTH_LEVELS.indexOf(a) >= HEALTH_LEVELS.indexOf(b) ? a : b;
}

const RECONCILE_LEVEL: Record<string, HealthLevel> = {
	satisfied: 'ok',
	applied: 'ok',
	deferred: 'info',
	owed: 'warn',
	failed: 'error'
};

/** the reconcile chain as one node per step, under one node for the chain */
export function reconcileNode(report: ReturnType<typeof reconcileReport>): HealthNode {
	const children = report.steps.map((step): HealthNode => ({
		id: `reconcile.${step.id}`,
		source: 'reconcile',
		level: RECONCILE_LEVEL[step.state] ?? 'warn',
		state: step.state,
		title: step.describe,
		detail: step.detail,
		children: []
	}));
	const behind = report.version < report.packVersion;
	return {
		id: 'reconcile',
		source: 'reconcile',
		level: children.reduce<HealthLevel>((l, c) => worse(l, c.level), 'ok'),
		state: behind ? 'behind' : 'current',
		title: 'Reconciliation with the shipping pack',
		detail: `version ${report.version} of ${report.packVersion}`,
		children
	};
}

const SEVERITY_LEVEL: Record<Severity, HealthLevel> = {
	info: 'info',
	warn: 'warn',
	error: 'error',
	critical: 'critical'
};

/** the supervisor's latest findings, one node each */
export function supervisorNode(findings: readonly Finding[]): HealthNode {
	const children = findings.map((f): HealthNode => ({
		id: `supervisor.${f.code}`,
		source: 'supervisor',
		level: SEVERITY_LEVEL[f.severity],
		state: f.severity,
		title: f.scope === '' ? f.code : `${f.code} on ${f.scope}`,
		detail: f.context,
		children: []
	}));
	return {
		id: 'supervisor',
		source: 'supervisor',
		level: children.reduce<HealthLevel>((l, c) => worse(l, c.level), 'ok'),
		state: children.length === 0 ? 'clear' : 'findings',
		title: 'Host tripwires from the last supervised alarm',
		detail: children.length === 0 ? '' : `${children.length} finding(s)`,
		children
	};
}

/** the repair ladder's rung; quarantine is the only rung a visitor feels */
export function repairNode(state: RepairState): HealthNode {
	const quarantined = isQuarantined(state);
	return {
		id: 'repair',
		source: 'repair',
		level: quarantined ? 'critical' : state.strikes > 0 ? 'warn' : 'ok',
		state: state.rung,
		title: 'Repair ladder',
		detail: state.code === null ? '' : `${state.strikes} strike(s) on ${state.code}`,
		children: []
	};
}

export function healthTree(nodes: HealthNode[]): HealthTree {
	return { level: nodes.reduce<HealthLevel>((l, n) => worse(l, n.level), 'ok'), nodes };
}
