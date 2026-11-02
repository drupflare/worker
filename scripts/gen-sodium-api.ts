/**
 * Dumps the ext-sodium API of a native PHP into `src/site/generated/sodium-api.ts`.
 *
 *   bun run gen:sodium-api          rewrite the generated module
 *   bun run gen:sodium-api --check  fail if what is on disk disagrees with the native PHP
 *
 * The module is the inventory the stand-in is measured against: every function with its
 * parameters, every constant with its value and every class. It needs a PHP 8.5 with ext-sodium.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SODIUM_API } from '../src/site/generated/sodium-api';

const TARGET = resolve(import.meta.dirname, '..', 'src', 'site', 'generated', 'sodium-api.ts');

const DUMP = `<?php
$e = new ReflectionExtension('sodium');
$fns = [];
foreach ($e->getFunctions() as $name => $f) {
	$params = [];
	foreach ($f->getParameters() as $p) {
		$row = ['name' => $p->getName(), 'type' => (string) ($p->getType() ?? 'mixed')];
		if ($p->isPassedByReference()) { $row['ref'] = true; }
		if ($p->getAttributes(SensitiveParameter::class)) { $row['sensitive'] = true; }
		if ($p->isOptional()) { $row['def'] = $p->getDefaultValue(); }
		$params[] = $row;
	}
	$fns[] = ['name' => $name, 'params' => $params, 'returns' => (string) $f->getReturnType()];
}
echo json_encode([
	'version' => PHP_VERSION,
	'functions' => $fns,
	'constants' => $e->getConstants(),
	'classes' => array_keys($e->getClasses()),
], JSON_UNESCAPED_SLASHES);
`;

/** the inventory a native PHP reports, as parsed JSON */
export function dumpNativeApi(php = 'php'): SodiumApi | undefined {
	const run = spawnSync(php, ['-n', '-r', DUMP.replace(/^<\?php\n/, '')], { encoding: 'utf8' });
	if (run.status !== 0 || !run.stdout.startsWith('{')) return undefined;
	return JSON.parse(run.stdout) as SodiumApi;
}

/** one function of the inventory */
export type ApiFunction = {
	name: string;
	params: {
		name: string;
		type: string;
		ref?: true;
		sensitive?: true;
		def?: string | number | boolean | null;
	}[];
	returns: string;
};

/** what the dump holds */
export type SodiumApi = {
	version: string;
	functions: ApiFunction[];
	constants: Record<string, string | number>;
	classes: string[];
};

if (import.meta.main) {
	const api = dumpNativeApi();
	if (!api) {
		console.error('no native php with ext-sodium answered');
		process.exit(1);
	}
	const body =
		`/** the ext-sodium API as PHP ${api.version} reports it; \`bun run gen:sodium-api\` writes it */\n` +
		`export const SODIUM_API = ${JSON.stringify(api, null, '\t')} as const;\n`;
	if (process.argv.includes('--check')) {
		const same = JSON.stringify(SODIUM_API) === JSON.stringify(api);
		if (!same) {
			console.error('src/site/generated/sodium-api.ts disagrees with the native PHP');
			process.exit(1);
		}
		console.log('sodium-api.ts agrees with the native PHP');
	} else {
		writeFileSync(TARGET, body);
		spawnSync('bunx', ['prettier', '--write', TARGET], { stdio: 'inherit' });
		console.log(
			`wrote ${api.functions.length} functions, ${Object.keys(api.constants).length} constants`
		);
	}
}
