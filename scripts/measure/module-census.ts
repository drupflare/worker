/**
 * Which modules a cold render loads, and the most a route-aware lazy boot could remove.
 *
 *   bun scripts/measure/module-census.ts [--json]
 *
 * Drives `module-census.spec.ts` and tabulates here. A module counts as IDLE on a route when none
 * of its services was instantiated; its included source and its share of the container are the
 * lever's ceiling for that route, since a lazy boot can at most skip what nothing touched.
 */
import { spawnSync } from 'node:child_process';

const SPEC = 'tests/integration/module-census.spec.ts';
const MARKER = '[module-census]';

type Bucket = { files: number; bytes: number };
type ServiceBucket = { defined: number; definitionBytes: number; initialized: number };
export type Census = {
	enabled: string[];
	includedFiles: number;
	includedBytes: number;
	files: Record<string, Bucket>;
	services: Record<string, ServiceBucket>;
	moduleFiles: { present: number; included: number };
};

export type ArmSummary = {
	arm: string;
	includedFiles: number;
	includedBytes: number;
	bytesByKind: Record<string, number>;
	servicesDefined: number;
	servicesInitialized: number;
	definitionBytes: number;
	definitionBytesByKind: Record<string, number>;
	idleModules: string[];
	idleIncludedBytes: number;
	idleDefinitionBytes: number;
};

const kindOf = (bucket: string) => bucket.split(':')[0] ?? bucket;

export function summarise(arm: string, c: Census): ArmSummary {
	const bytesByKind: Record<string, number> = {};
	for (const [b, v] of Object.entries(c.files)) {
		bytesByKind[kindOf(b)] = (bytesByKind[kindOf(b)] ?? 0) + v.bytes;
	}
	const definitionBytesByKind: Record<string, number> = {};
	let servicesDefined = 0;
	let servicesInitialized = 0;
	let definitionBytes = 0;
	for (const [b, v] of Object.entries(c.services)) {
		definitionBytesByKind[kindOf(b)] =
			(definitionBytesByKind[kindOf(b)] ?? 0) + v.definitionBytes;
		servicesDefined += v.defined;
		servicesInitialized += v.initialized;
		definitionBytes += v.definitionBytes;
	}
	const idleModules = c.enabled.filter(
		(m) => (c.services[`module:${m}`]?.initialized ?? 0) === 0
	);
	return {
		arm,
		includedFiles: c.includedFiles,
		includedBytes: c.includedBytes,
		bytesByKind,
		servicesDefined,
		servicesInitialized,
		definitionBytes,
		definitionBytesByKind,
		idleModules,
		idleIncludedBytes: idleModules.reduce(
			(n, m) => n + (c.files[`module:${m}`]?.bytes ?? 0),
			0
		),
		idleDefinitionBytes: idleModules.reduce(
			(n, m) => n + (c.services[`module:${m}`]?.definitionBytes ?? 0),
			0
		)
	};
}

const pct = (part: number, whole: number) =>
	whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : '-';

if (import.meta.main) {
	const proc = spawnSync(
		'bunx',
		['vitest', 'run', '--project=workers', SPEC, '--disable-console-intercept'],
		{
			encoding: 'utf8',
			maxBuffer: 256 * 1024 * 1024
		}
	);
	const text = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
	const line = text.split('\n').find((l) => l.includes(MARKER));
	if (!line) {
		console.error(text.split('\n').slice(-20).join('\n'));
		throw new Error(`no ${MARKER} line; the spec did not run`);
	}
	const arms = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, Census>;
	const rows = Object.entries(arms).map(([arm, c]) => summarise(arm, c));
	if (process.argv.includes('--json')) {
		console.log(JSON.stringify(rows, null, 2));
	} else {
		for (const r of rows) {
			const k = r.bytesByKind;
			const d = r.definitionBytesByKind;
			console.log(
				`${r.arm.padEnd(16)} files ${r.includedFiles} (${r.includedBytes} B: core ${pct(k['core'] ?? 0, r.includedBytes)}, ` +
					`vendor ${pct(k['vendor'] ?? 0, r.includedBytes)}, module ${pct(k['module'] ?? 0, r.includedBytes)}, ` +
					`theme ${pct(k['theme'] ?? 0, r.includedBytes)}, other ${pct(k['other'] ?? 0, r.includedBytes)})`
			);
			console.log(
				`${''.padEnd(16)} services ${r.servicesInitialized}/${r.servicesDefined} built; definitions ${r.definitionBytes} B ` +
					`(core ${pct(d['core'] ?? 0, r.definitionBytes)}, module ${pct(d['module'] ?? 0, r.definitionBytes)}, ` +
					`vendor ${pct(d['vendor'] ?? 0, r.definitionBytes)})`
			);
			console.log(
				`${''.padEnd(16)} idle modules ${r.idleModules.length}: ${r.idleIncludedBytes} B source ` +
					`(${pct(r.idleIncludedBytes, r.includedBytes)}), ${r.idleDefinitionBytes} B of container ` +
					`(${pct(r.idleDefinitionBytes, r.definitionBytes)})`
			);
		}
	}
}
