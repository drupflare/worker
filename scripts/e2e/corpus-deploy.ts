#!/usr/bin/env bun
/**
 * Lands a corpus repository's native database into this worker tree and deploys it as a throwaway
 * `cfw-e2e-*` worker, for `corpus-lane.ts --deployed` to drive.
 *
 *   bun scripts/e2e/corpus-deploy.ts --native=<dir holding site.sqlite> --name=cfw-e2e-<id>
 *     [--drangler=<cli.ts>] [--paid] [--cpu-ms=<n>] [--var=NAME=value]
 *
 * Run it from a frozen copy of the worker tree: landing rewrites `assets/drupal/site.sqlite` and the
 * chunks the deploy publishes, and nothing here puts them back. The deploy carries `PW_DIAGNOSTICS`
 * because the lane delivers packages before it claims the site; the site is unclaimed and throwaway,
 * and `bun scripts/e2e/live-deploy.ts --teardown --name=<name>` removes it. Prints `{"origin":...}`.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { landDatabase } from './corpus-lane.js';

/** the arguments `live-deploy.ts` takes to deploy a worker and leave the claim to the caller */
export function deployArgs(
	name: string,
	opts: { paid?: boolean; cpuMs?: number; vars?: string[] } = {}
): string[] {
	if (!name.startsWith('cfw-e2e-')) throw new Error(`refusing to deploy ${name}`);
	return [
		join(import.meta.dirname, 'live-deploy.ts'),
		'--deploy-only',
		'--no-provision',
		`--name=${name}`,
		'--var=PW_DIAGNOSTICS=1',
		...(opts.paid ? ['--paid'] : []),
		...(opts.cpuMs ? [`--cpu-ms=${opts.cpuMs}`] : []),
		...(opts.vars ?? []).map((v) => `--var=${v}`)
	];
}

if (import.meta.main) {
	const flag = (n: string) =>
		process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
	const native = flag('native');
	const name = flag('name');
	if (!native || !name) throw new Error('--native=<dir> and --name=cfw-e2e-<id> are required');
	const root = join(import.meta.dirname, '..', '..');
	const drangler =
		flag('drangler') ?? process.env.DRANGLER ?? join(root, '..', 'drangler', 'src', 'cli.ts');
	landDatabase(root, join(native, 'site.sqlite'), drangler);
	const vars = process.argv.filter((a) => a.startsWith('--var=')).map((a) => a.slice(6));
	const cpuMs = Number(flag('cpu-ms') ?? 0);
	const paid = process.argv.includes('--paid');
	const deploy = spawnSync('bun', deployArgs(name, { paid, cpuMs, vars }), {
		cwd: root,
		stdio: 'inherit',
		env: process.env
	});
	process.exit(deploy.status ?? 1);
}
