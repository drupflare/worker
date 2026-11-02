import { afterAll, describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { GENERATED_COLLISIONS } from '../../src/ops/generated/modules';
import {
	BLOCKED_MODULES,
	GENERATED_MODULES,
	REQUEST_TIMEOUT,
	enable,
	migrate,
	mustCarry,
	packedContrib,
	type Payload
} from '../helpers/contrib-pack';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * One enable-and-assert case generated from what a module's own files declare.
 *
 * The declaration is read from the installed module at run time: `*.services.yml`,
 * `*.routing.yml`, `*.libraries.yml`, `config/install` and `config/schema`. Nothing here is a list
 * written from memory, so the case can only claim what the module itself says it provides. A
 * hand-written row in `contrib-verify.spec.ts` stays the stronger form where one exists.
 *
 * Like that spec, it needs a fixture pack (`bun scripts/contrib-fixture.ts --mount`), and a module
 * the shipping pack does not carry is skipped there and a failure against a fixture pack.
 */

/** modules that install in a phase of `contrib-fixture.ts`; absent from the base pack they skip */
const SEPARATE_LOCK = Object.entries(GENERATED_COLLISIONS)
	.filter(([, c]) => !c.require)
	.map(([name]) => name);

type ServiceFlags = { abstract: boolean; private: boolean; synthetic: boolean; class: string };

type Declared = {
	version: string;
	services: Record<string, ServiceFlags>;
	routes: string[];
	routeNeeds: Record<string, string>;
	libraries: string[];
	install: string[];
	schema: string[];
};

const probe = (
	name: string,
	spec: { declared?: Declared; instantiate?: boolean; check?: boolean }
) =>
	String.raw`<?php
$spec = json_decode(${JSON.stringify(JSON.stringify({ name, ...spec }))}, true);
$name = $spec['name'];
$out = ['ok' => true];
if (!defined('CSS_COMPONENT')) { require_once '/drupal/core/includes/common.inc'; }
\Drupal::service('request_stack')->push(\Symfony\Component\HttpFoundation\Request::create('/', 'GET'));
$mh = \Drupal::moduleHandler();
$mh->loadAll();
$c = \Drupal::getContainer();
$out['control'] = $c->has('entity_type.manager');
$out['exists'] = $mh->moduleExists($name);
$read = function ($file) {
  if (!is_file($file)) { return []; }
  $v = \Drupal\Component\Serialization\Yaml::decode(file_get_contents($file));
  return is_array($v) ? $v : [];
};
$ls = function ($dir) {
  return is_dir($dir) ? array_values(array_filter(scandir($dir), fn($f) => str_ends_with($f, '.yml'))) : [];
};
$declared = $spec['declared'] ?? null;
if ($declared === null) {
  $list = \Drupal::service('extension.list.module');
  $files = new \ReflectionProperty(\Drupal\Core\Extension\ExtensionDiscovery::class, 'files');
  $files->setAccessible(true);
  $files->setValue(null, []);
  $list->reset()->getList();
  $root = \Drupal::root() . '/' . $list->getPath($name);
  $info = $list->getList()[$name]->info ?? [];
  $defs = $read($root . '/' . $name . '.services.yml')['services'] ?? [];
  $defaultPublic = (($defs['_defaults']['public'] ?? true) !== false);
  $services = [];
  foreach ($defs as $id => $def) {
    $id = (string) $id;
    if ($id === '' || $id[0] === '_') { continue; }
    $d = is_array($def) ? $def : [];
    $services[$id] = [
      'abstract' => !empty($d['abstract']),
      'private' => (($d['public'] ?? $defaultPublic) === false),
      'synthetic' => !empty($d['synthetic']),
      'class' => (string) ($d['class'] ?? ''),
    ];
  }
  $routes = [];
  $routeNeeds = [];
  foreach ($read($root . '/' . $name . '.routing.yml') as $r => $def) {
    if ($r === 'route_callbacks') { continue; }
    $routes[] = (string) $r;
    $need = is_array($def) ? ($def['requirements']['_module_dependencies'] ?? null) : null;
    if (is_string($need) && $need !== '') { $routeNeeds[(string) $r] = $need; }
  }
  $libraries = array_map('strval', array_keys($read($root . '/' . $name . '.libraries.yml')));
  $install = array_map(fn($f) => substr($f, 0, -4), $ls($root . '/config/install'));
  $schema = [];
  foreach ($ls($root . '/config/schema') as $f) {
    foreach (array_keys($read($root . '/config/schema/' . $f)) as $key) { $schema[] = (string) $key; }
  }
  $declared = [
    'version' => (string) ($info['version'] ?? ''),
    'services' => $services,
    'routes' => $routes,
    'routeNeeds' => $routeNeeds,
    'libraries' => $libraries,
    'install' => $install,
    'schema' => $schema,
  ];
  $out['declared'] = $declared;
}
$registered = [];
$instantiated = [];
foreach ($declared['services'] as $id => $flags) {
  $registered[$id] = $c->has($id);
  if (!empty($spec['instantiate']) && $registered[$id] && !$flags['abstract'] && !$flags['private'] && !$flags['synthetic']) {
    if ($flags['class'] !== '' && !class_exists($flags['class']) && !interface_exists($flags['class'])) { $instantiated[$id] = 'MISSINGCLASS:' . $flags['class']; continue; }
    try { \Drupal::service($id); $instantiated[$id] = true; }
    catch (\Throwable $e) { $instantiated[$id] = get_class($e) . ': ' . substr($e->getMessage(), 0, 240); }
  }
}
$out['registered'] = $registered;
$out['instantiated'] = $instantiated;
$have = array_flip(\Drupal::database()->query('SELECT name FROM {router}')->fetchCol());
$out['routes'] = [];
$out['routeNeedsMet'] = [];
foreach ($declared['routes'] as $r) {
  $out['routes'][$r] = isset($have[$r]);
  if (isset($declared['routeNeeds'][$r])) {
    $met = false;
    foreach (explode(',', $declared['routeNeeds'][$r]) as $group) {
      $all = true;
      foreach (explode('+', $group) as $dep) { $all = $all && $mh->moduleExists(trim($dep)); }
      $met = $met || $all;
    }
    $out['routeNeedsMet'][$r] = $met;
  }
}
$disc = \Drupal::service('library.discovery');
$out['libraries'] = [];
foreach ($declared['libraries'] as $k) {
  try { $out['libraries'][$k] = (bool) @$disc->getLibraryByName($name, $k); }
  catch (\Throwable $e) { $out['libraries'][$k] = false; }
}
$storage = \Drupal::service('config.storage');
$out['installed'] = [];
foreach ($declared['install'] as $n) { $out['installed'][$n] = $storage->exists($n); }
$typed = \Drupal::service('config.typed');
$out['schema'] = [];
foreach ($declared['schema'] as $k) {
  if (str_contains($k, '*')) { continue; }
  try { $out['schema'][$k] = (bool) $typed->hasConfigSchema($k); }
  catch (\Throwable $e) { $out['schema'][$k] = false; }
}
$errors = [];
if (!empty($spec['check'])) {
  $mh->loadInclude($name, 'install');
  foreach (['requirements', 'runtime_requirements'] as $hook) {
    try {
      $mh->invokeAllWith($hook, function (callable $impl, string $module) use ($name, $hook, &$errors) {
        if ($module !== $name) { return; }
        foreach ((array) ($hook === 'requirements' ? $impl('runtime') : $impl()) as $key => $row) {
          $s = $row['severity'] ?? 0;
          $sev = is_object($s) ? (int) ($s->value ?? 0) : (int) $s;
          if ($sev === 2) { $errors[] = $key . ': ' . (string) ($row['title'] ?? '') . ' / ' . (string) ($row['value'] ?? ''); }
        }
      });
    } catch (\Throwable $e) { $errors[] = $hook . ' threw ' . get_class($e) . ': ' . $e->getMessage(); }
  }
}
$out['requirementErrors'] = $errors;
echo json_encode($out, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);`;

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Run = {
	module: string;
	version: string;
	verdict: 'verified' | 'untested' | 'failed';
	evidence: string;
	failures: string[];
	declared: Declared;
	diagnostics: Record<string, unknown>;
};

type Raw = {
	before: Payload;
	enabled?: Payload;
	after?: Payload;
	declared: Declared;
};

/** the services a case asserts: abstract, synthetic and private definitions are not in the container */
const asserted = (d: Declared) =>
	Object.entries(d.services)
		.filter(([, f]) => !f.abstract && !f.synthetic && !f.private)
		.map(([id]) => id);

const unconditional = (d: Declared) => d.routes.filter((r) => d.routeNeeds[r] === undefined);

const surface = (d: Declared) => asserted(d).length + unconditional(d).length + d.libraries.length;

const map = (v: unknown) => (v ?? {}) as Record<string, unknown>;

function judge(name: string, raw: Raw): Run {
	const d = raw.declared;
	const failures: string[] = [];
	const run: Run = {
		module: name,
		version: d.version,
		verdict: 'failed',
		evidence: '',
		failures,
		declared: d,
		diagnostics: {}
	};
	if (surface(d) === 0) {
		run.verdict = 'untested';
		run.evidence = 'ships no assertable surface: no service, route or library declared';
		return run;
	}
	const { before, enabled, after } = raw;
	if (!enabled || !after) throw new Error(`${name}: judged before the enable ran`);
	if (enabled['ok'] !== true) {
		failures.push(`enable failed: ${JSON.stringify(enabled).slice(0, 400)}`);
		return run;
	}
	if (enabled['nowEnabled'] !== true || after['exists'] !== true) {
		failures.push('not in core.extension after the install');
	}
	if (before['control'] !== true || after['control'] !== true) {
		failures.push('CONTROL: the probe cannot see the container');
	}
	if (before['exists'] === true) failures.push('already enabled before the install');

	const regBefore = map(before['registered']);
	const regAfter = map(after['registered']);
	const made = map(after['instantiated']);
	let registered = 0;
	let instantiated = 0;
	const privates = Object.values(d.services).filter((f) => f.private && !f.abstract).length;
	const noClass: string[] = [];
	for (const id of asserted(d)) {
		if (regAfter[id] !== true) {
			failures.push(`service ${id} is not registered in the rebuilt container`);
			continue;
		}
		registered++;
		if (regBefore[id] === true)
			failures.push(`service ${id} was registered before the install`);
		if (made[id] === true) instantiated++;
		else if (String(made[id]).startsWith('MISSINGCLASS:'))
			noClass.push(`${id} (${String(made[id]).slice(13)})`);
		else if (made[id] !== undefined)
			failures.push(`service ${id} did not instantiate: ${made[id]}`);
	}

	const routesBefore = map(before['routes']);
	const routesAfter = map(after['routes']);
	const needsMet = map(after['routeNeedsMet']);
	let conditional = 0;
	for (const r of d.routes) {
		if (d.routeNeeds[r] !== undefined && needsMet[r] !== true) {
			conditional++;
			continue;
		}
		if (routesAfter[r] !== true) failures.push(`route ${r} is not in the router table`);
		if (routesBefore[r] === true)
			failures.push(`route ${r} was in the router table before the install`);
	}

	const libsBefore = map(before['libraries']);
	const libsAfter = map(after['libraries']);
	for (const l of d.libraries) {
		if (libsAfter[l] !== true) failures.push(`library ${name}/${l} does not resolve`);
		if (libsBefore[l] === true)
			failures.push(`library ${name}/${l} resolved before the install`);
	}

	const installed = map(after['installed']);
	for (const n of d.install) {
		if (installed[n] !== true) failures.push(`config ${n} from config/install is missing`);
	}
	const schema = map(after['schema']);
	for (const [k, ok] of Object.entries(schema)) {
		if (ok !== true) failures.push(`config schema ${k} does not resolve`);
	}
	for (const e of (after['requirementErrors'] ?? []) as string[]) {
		failures.push(`hook_requirements runtime error: ${e}`);
	}

	const parts = [
		`${count(registered, 'service')} registered and ${instantiated} instantiated` +
			(noClass.length > 0
				? ` (${noClass.length} class not installed: ${noClass.join(', ')})`
				: '') +
			(privates > 0 ? `, ${privates} private not asserted` : ''),
		count(d.routes.length - conditional, 'route') +
			(conditional > 0 ? ` (${conditional} more need a module that is not enabled)` : ''),
		count(d.libraries.length, 'library').replace('librarys', 'libraries')
	];
	if (d.install.length > 0) parts.push(`${d.install.length} install config`);
	const checked = Object.keys(schema).length;
	if (checked > 0) parts.push(`${checked} schema types`);
	run.evidence = `generic: ${parts.join(', ')}`;
	run.diagnostics = {
		privateServices: privates,
		privateRegistered: Object.keys(d.services).filter(
			(id) => d.services[id]?.private && regAfter[id] === true
		).length,
		abstractSkipped: Object.values(d.services).filter((f) => f.abstract).length,
		syntheticSkipped: Object.values(d.services).filter((f) => f.synthetic).length
	};
	if (failures.length === 0) run.verdict = 'verified';
	return run;
}

/**
 * Enable one module on a fresh site and read its declaration before and after.
 *
 * `between` runs after the enable and ahead of the second reading; the negative control uses it to
 * damage the module's files while the declaration it hands back stays the one read from the original.
 */
async function generic(
	name: string,
	between?: (site: ServeDo, d: Declared) => Promise<void>
): Promise<Run> {
	const raw = await inObject(freshSite(), async (site) => {
		await migrate(site);
		await site.runJson(BOOT_KERNEL);
		const before = await site.runJson(probe(name, {}));
		const declared = before['declared'] as Declared | undefined;
		if (!declared) {
			throw new Error(
				`${name}: the declaration probe answered ${JSON.stringify(before).slice(0, 600)}`
			);
		}
		if (surface(declared) === 0) return { before, declared } as Raw;
		const enabled = await enable(site, name);
		await site.runJson(BOOT_KERNEL);
		await between?.(site, declared);
		const after = await site.runJson(probe(name, { declared, instantiate: true, check: true }));
		return { before, enabled, after, declared } as Raw;
	});
	return judge(name, raw);
}

const report: Run[] = [];

afterAll(() => {
	if (report.length === 0) return;
	const body = [...report]
		.sort((a, b) => a.module.localeCompare(b.module))
		.map((r) => `${r.module} ${r.version} | ${r.verdict} | ${r.evidence}`);
	console.log(['', ...body].map((l) => `[contrib-generic] ${l}`).join('\n'));
});

async function reachable(name: string): Promise<boolean> {
	const packed = await packedContrib();
	if (packed.has(name)) return true;
	if (
		mustCarry(packed) &&
		!SEPARATE_LOCK.includes(name.startsWith('drupal/') ? name : `drupal/${name}`) &&
		!BLOCKED_MODULES.includes(name)
	) {
		throw new Error(
			`${name} is not in the mounted FIXTURE pack: composer require --dev drupal/${name} ` +
				'in drupal-src, then re-run'
		);
	}
	return false;
}

describe('generic enable-and-assert from the module own declaration', () => {
	for (const name of [
		...GENERATED_MODULES,
		...SEPARATE_LOCK.map((n) => n.replace('drupal/', ''))
	]) {
		it(
			`${name}: everything its own files declare is present after the enable`,
			async (ctx) => {
				if (!(await reachable(name))) {
					ctx.skip(
						`${name} is not in the shipping pack; \`bun scripts/contrib-fixture.ts --mount\` mounts one`
					);
					return;
				}
				const run = await generic(name);
				report.push(run);
				console.log(`[contrib-generic] ${name} ${JSON.stringify(run.diagnostics)}`);
				if (run.verdict === 'untested') ctx.skip(`${name} ${run.evidence}`);
				expect(run.failures, `${name}:\n${run.failures.join('\n')}`).toEqual([]);
			},
			REQUEST_TIMEOUT
		);
	}
});

// #region controls

/**
 * Positive: the generator agrees with two hand-written rows of different shape. `devel` has
 * services, routes and install config; `editor_advanced_link` declares only a library. The ids
 * below are the ones those rows in `contrib-verify.spec.ts` assert.
 */
describe('controls for the generated case', () => {
	it(
		'agrees with the hand-written devel row: its four services, both configs, and routes',
		async (ctx) => {
			if (!(await reachable('devel'))) return ctx.skip('devel is not in the shipping pack');
			const run = await generic('devel');
			report.push(run);
			expect(run.failures, run.failures.join('\n')).toEqual([]);
			const hand = [
				'devel.dumper',
				'plugin.manager.devel_dumper',
				'devel.route_subscriber',
				'devel.error_subscriber'
			];
			for (const id of hand)
				expect(run.declared.services[id], `${id} not declared`).toBeDefined();
			for (const n of ['devel.settings', 'system.menu.devel']) {
				expect(run.declared.install, `${n} not in config/install`).toContain(n);
			}
			expect(run.declared.routes.length).toBeGreaterThan(0);
			console.log(`[contrib-generic] control devel ${run.evidence}`);
		},
		REQUEST_TIMEOUT
	);

	it(
		'agrees with the hand-written editor_advanced_link row: libraries and no services or routes',
		async (ctx) => {
			if (!(await reachable('editor_advanced_link'))) {
				return ctx.skip('editor_advanced_link is not in the shipping pack');
			}
			const run = await generic('editor_advanced_link');
			report.push(run);
			expect(run.failures, run.failures.join('\n')).toEqual([]);
			expect(run.declared.libraries.length).toBeGreaterThan(0);
			expect(asserted(run.declared)).toEqual([]);
			expect(run.declared.routes).toEqual([]);
			console.log(`[contrib-generic] control editor_advanced_link ${run.evidence}`);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * Negative: a service the module declares and the container lacks is named in the failure.
	 *
	 * After the install, the service's block is cut out of the module's `services.yml` in the mounted
	 * tree and the container is rebuilt, so it compiles without it while the declaration is still the
	 * one read from the original file. The last declared service that nothing else references is the
	 * one cut, so the compile still succeeds. The enable itself cannot host the cut: it remounts the
	 * pack, which puts the original file back.
	 */
	it(
		'reports a declared service missing from the container by name',
		async (ctx) => {
			if (!(await reachable('devel'))) return ctx.skip('devel is not in the shipping pack');
			let cut = '';
			const run = await generic('devel', async (site, d) => {
				const reply = await site.runJson(String.raw`<?php
$f = \Drupal::root() . '/' . \Drupal::service('extension.list.module')->getPath('devel') . '/devel.services.yml';
$t = rtrim(file_get_contents($f)) . "\n";
$ids = json_decode(${JSON.stringify(JSON.stringify(Object.keys(d.services)))}, true);
$cut = null;
foreach (array_reverse($ids) as $id) {
  if (substr_count($t, '@' . $id) === 0) { $cut = $id; break; }
}
$n = 0;
if ($cut !== null) {
  $t = preg_replace('/^  ' . preg_quote($cut, '/') . ':\R(?:(?:    .*|\s*)\R)*/m', '', $t, 1, $n);
  file_put_contents($f, $t);
}
\Drupal::service('kernel')->rebuildContainer();
echo json_encode(['cut' => $cut, 'replaced' => $n, 'stillThere' => str_contains(file_get_contents($f), '  ' . $cut . ':')]);`);
				expect(reply['replaced'], JSON.stringify(reply)).toBe(1);
				expect(reply['stillThere']).toBe(false);
				cut = String(reply['cut']);
			});
			expect(cut).not.toBe('');
			console.log(
				`[contrib-generic] negative control cut ${cut}: ${run.failures.join(' | ')}`
			);
			expect(run.verdict).toBe('failed');
			expect(run.failures.join('\n')).toContain(`service ${cut} is not registered`);
		},
		REQUEST_TIMEOUT
	);
});

// #endregion
