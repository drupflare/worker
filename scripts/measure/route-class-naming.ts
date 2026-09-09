/**
 * Can one compiled plan serve every entity of a route class?
 *
 * `compilePlan()` diffs two renders of ONE path and names each varying region with a recogniser.
 * A route-class plan would diff renders of DIFFERENT entities of one class, so the varying regions
 * are field values rather than CSPRNG tokens. This measures what fraction of those regions can be
 * accounted for, and what fraction of a class's entities one plan could therefore serve.
 *
 * The diff is `compilePlan()` itself, not a second implementation of it. What is added here is the
 * inverse the VM does not have: given a plan, extract the values a third render puts in its slots.
 *
 * Bodies come from native PHP against the SHIPPED pack database, because the question is about
 * Drupal's markup rather than about the interpreter. RULE 0 does not apply: nothing here is a
 * duration.
 */

import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePlan, type RenderPlan } from '../../src/ops/render-plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const DRUPAL_SRC = process.env.DRUPAL_ROOT ?? resolve(REPO, 'drupal-src');
const DRUPFLARE_SRC = process.env.DRUPFLARE_SRC ?? resolve(REPO, '../drupflare');
const ROM_SRC = process.env.ROM_SRC ?? resolve(REPO, '../rom');
const STREAM_HTTP_SRC = process.env.STREAM_HTTP_SRC ?? resolve(REPO, '../stream-http');
const PACK_DB = resolve(REPO, 'assets/drupal/site.sqlite');
const SCRATCH = process.env.RCN_SCRATCH ?? join(tmpdir(), 'route-class-naming');

/** how many characters a field value may reclaim from the constant either side of its region */
const RECLAIM_MAX = 96;

export type RegionClass = 'recognised' | 'field' | 'field_ref' | 'volatile' | 'unknown';

export type SlotReport = {
	name: string;
	kind: string;
	klass: RegionClass;
	/** the entity field keys that explain it, when they do */
	field: string | null;
	explain: Explanation | null;
	a: string;
	b: string;
};

export type ClassReport = {
	label: string;
	entities: number;
	/** regions varying between TWO RENDERS OF ONE ENTITY, which is today's per-path problem */
	baselineRegions: number | null;
	baselineUnnamed: number | null;
	constantOps: number;
	constantBytes: number;
	slots: SlotReport[];
	/** entities the plan reproduces AND whose every slot resolves from the entity's OWN row */
	served: number;
	/** the same, also allowing values denormalised from entities this one references */
	servedRelaxed: number;
	failures: string[];
	/** entities the plan's constants do not even align with */
	unmatched: number;
	unknownSamples: Array<{ text: string; count: number }>;
};

export type Entity = { id: string; path: string; html: string; values: Record<string, string> };

// #region harvest

const SETTINGS_PHP = `<?php
$databases['default']['default'] = [
	'driver' => 'sqlite',
	'database' => __DIR__ . '/files/.sqlite',
	'namespace' => 'Drupal\\\\sqlite\\\\Driver\\\\Database\\\\sqlite',
	'prefix' => '',
];
$settings['hash_salt'] = 'route-class-naming';
$settings['config_sync_directory'] = 'sites/default/files/config/sync';
$settings['file_public_path'] = 'sites/default/files';
$settings['update_free_access'] = FALSE;
$settings['entity_update_batch_size'] = 50;
`;

/**
 * The harvest, and the two things it is careful about.
 *
 * Field values are chosen with distinct first AND last characters, so a shared affix cannot eat
 * part of a value and turn a nameable region into an opaque one. That biases the result UPWARD:
 * the number this produces is an upper bound on what a real site's content would give.
 *
 * The page and dynamic-page caches are emptied before every render, so a second render of one
 * path measures real per-request variation rather than a replay.
 */
const HARVEST_PHP = String.raw`<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Session\UserSession;
use Drupal\node\Entity\Node;
use Drupal\user\Entity\User;
use Symfony\Component\HttpFoundation\Request;

$root = __DIR__;
chdir($root);
$autoloader = require $root . '/autoload.php';
// composer never runs here, exactly as it never runs on the edge; the packed tree IS the vendor
// directory, so the same PSR-4 root the boot fragment registers has to be registered by hand
$autoloader->addPsr4('Drupflare\\StreamHttp\\', $root . '/libraries/drupflare-stream-http/src');
// drupal-src's core is PATCHED for the edge: EntityReferenceItemBase calls \PhpWasmSyncFiber where
// upstream calls \Fiber, because the wasm build has none. Native PHP does, so alias it back
if (!class_exists('PhpWasmSyncFiber', FALSE)) {
	class_alias(\Fiber::class, 'PhpWasmSyncFiber');
}

// the app root is passed explicitly: composer's autoloader lives behind a symlink to the real tree,
// so DrupalKernel's own guess walks up to drupal-src and reads ITS settings.php rather than this one
$request = Request::create('/');
$kernel = DrupalKernel::createFromRequest($request, $autoloader, 'prod', TRUE, $root);
$kernel->boot();
$kernel->preHandle($request);

$container = $kernel->getContainer();
$container->get('current_user')->setAccount(new UserSession(['uid' => 1, 'roles' => ['authenticated']]));

// distinct first and last characters so no shared affix can eat part of a value.
// the last two are the shapes a title-and-body corpus cannot contain and that decide the answer:
// an OPTIONAL FIELD LEFT EMPTY changes the markup's shape, not just its values
$SEEDS = [
	['Qq Alpha Zed', 'Quantities of alpha material arrived on the seventh.'],
	['Ww Bravo Yew', 'Whatever bravo was measuring, it stopped in March.'],
	['Ee Charlie Xis', 'Everything charlie touched came back rounded up.'],
	['Rr Delta Wold', 'Regarding delta: the second pass disagreed with the first.'],
	['Tt Echo Vane', '<p>Two echoes returned.</p><p>One of them from the wrong wall.</p>'],
	['Yy Foxtrot Ulm', ''],
];

$uids = [];
foreach (['aurelia', 'bertrand', 'cordelia'] as $i => $name) {
	$existing = \Drupal::entityTypeManager()->getStorage('user')->loadByProperties(['name' => $name]);
	if ($existing) {
		$uids[] = (int) reset($existing)->id();
		continue;
	}
	$user = User::create(['name' => $name, 'mail' => $name . '@example.com', 'status' => 1]);
	$user->save();
	$uids[] = (int) $user->id();
}

// AN ENTITY REFERENCE IS THE CASE THAT DECIDES THIS, and the shipped page type has none: its
// rendered value is the label on ANOTHER entity's row, which a per-entity slot bundle does not hold
if (!\Drupal\field\Entity\FieldStorageConfig::loadByName('node', 'field_ref')) {
	\Drupal\field\Entity\FieldStorageConfig::create([
		'field_name' => 'field_ref',
		'entity_type' => 'node',
		'type' => 'entity_reference',
		'settings' => ['target_type' => 'node'],
	])->save();
	\Drupal\field\Entity\FieldConfig::create([
		'field_name' => 'field_ref',
		'entity_type' => 'node',
		'bundle' => 'page',
		'label' => 'Related',
	])->save();
	\Drupal::service('entity_display.repository')
		->getViewDisplay('node', 'page', 'default')
		->setComponent('field_ref', ['type' => 'entity_reference_label'])
		->save();
}

$nodes = [];
foreach ($SEEDS as $i => $seed) {
	$node = Node::create([
		'type' => 'page',
		'title' => $seed[0],
		'uid' => $uids[$i % count($uids)],
		'status' => 1,
		'created' => 1735689600 + ($i * 86400 * 37),
		'body' => $seed[1] === '' ? [] : ['value' => $seed[1], 'format' => 'basic_html'],
	]);
	$node->save();
	$nodes[] = $node;
}
// each node points at the one before it, so the reference renders a DIFFERENT entity's label
foreach ($nodes as $i => $node) {
	if ($i === 0) {
		continue;
	}
	$node->set('field_ref', ['target_id' => $nodes[$i - 1]->id()]);
	$node->save();
}

/** every scalar the entity's own row carries, plus what is derivable from it alone */
function entity_values($entity) {
	$out = [];
	foreach ($entity->toArray() as $field => $items) {
		if (!is_array($items)) {
			$out[$field] = (string) $items;
			continue;
		}
		foreach ($items as $delta => $item) {
			if (!is_array($item)) {
				$out[$field . '.' . $delta] = (string) $item;
				continue;
			}
			foreach ($item as $prop => $value) {
				if (is_scalar($value) || $value === NULL) {
					$out[$field . '.' . $delta . '.' . $prop] = (string) $value;
				}
			}
		}
	}
	$out['__id'] = (string) $entity->id();
	$out['__uuid'] = (string) $entity->uuid();
	try {
		$out['__url'] = $entity->toUrl()->toString();
	}
	catch (\Throwable $e) {
	}
	if ($entity->hasField('title')) {
		$out['__label_escaped'] = \Drupal\Component\Utility\Html::escape((string) $entity->label());
	}
	if ($entity->hasField('body') && !$entity->get('body')->isEmpty()) {
		$body = $entity->get('body')->first();
		$out['__body_processed'] = (string) check_markup($body->value, $body->format);
	}
	// dates are row-derivable, so a rendered date is a field value under some format
	$formatter = \Drupal::service('date.formatter');
	foreach (['created', 'changed'] as $field) {
		if (!$entity->hasField($field)) {
			continue;
		}
		$ts = (int) $entity->get($field)->value;
		foreach (array_keys(\Drupal::entityTypeManager()->getStorage('date_format')->loadMultiple()) as $format) {
			$out['__date.' . $field . '.' . $format] = $formatter->format($ts, $format);
		}
		$out['__date.' . $field . '.raw'] = (string) $ts;
	}
	// values that belong to ANOTHER entity's row, reachable only by denormalising them into this
	// entity's bundle. Kept under their own prefix so the strict and relaxed answers stay separable
	foreach ($entity->getFieldDefinitions() as $name => $definition) {
		if ($definition->getType() !== 'entity_reference' || $entity->get($name)->isEmpty()) {
			continue;
		}
		foreach ($entity->get($name) as $delta => $item) {
			$target = $item->entity;
			if (!$target) {
				continue;
			}
			$out['__ref.' . $name . '.' . $delta . '.label'] = (string) $target->label();
			$out['__ref.' . $name . '.' . $delta . '.id'] = (string) $target->id();
			try {
				$out['__ref.' . $name . '.' . $delta . '.url'] = $target->toUrl()->toString();
			}
			catch (\Throwable $e) {
			}
		}
	}
	if (method_exists($entity, 'getOwner') && $entity->getOwner()) {
		$out['__author'] = (string) $entity->getOwner()->getDisplayName();
		$out['__author_uid'] = (string) $entity->getOwnerId();
	}
	return $out;
}

function render_path($kernel, $path) {
	// Html::$seenIds is per-REQUEST state, and this process serves many; without the reset the
	// unique-id counter climbs across renders and every menu block id reads as per-entity variation.
	// That is the harness, not Drupal, and it was measured before it was noticed
	\Drupal\Component\Utility\Html::resetSeenIds();
	// re-read the service every time: drupal_flush_all_caches() rebuilds the container, so an
	// account set on a captured one silently keeps rendering as uid 1 and the page carries an
	// admin toolbar no anonymous visitor ever sees
	\Drupal::service('current_user')->setAccount(new \Drupal\Core\Session\AnonymousUserSession());
	foreach (['cache.page', 'cache.dynamic_page_cache', 'cache.render'] as $bin) {
		if (\Drupal::hasService($bin)) {
			\Drupal::service($bin)->deleteAll();
		}
	}
	$request = Request::create($path);
	$response = $kernel->handle($request);
	return ['status' => $response->getStatusCode(), 'html' => (string) $response->getContent()];
}

// the user class is only measurable if anonymous may read it at all
user_role_grant_permissions('anonymous', ['access user profiles']);
drupal_flush_all_caches();

// renders are anonymous, which is the class the tail is served to
$container->get('current_user')->setAccount(new UserSession(['uid' => 0, 'roles' => ['anonymous']]));

$out = ['classes' => []];

$class = ['label' => 'node canonical (type: page, view mode: full, anonymous)', 'entities' => []];
foreach ($nodes as $node) {
	$rendered = render_path($kernel, '/node/' . $node->id());
	$class['entities'][] = [
		'id' => (string) $node->id(),
		'path' => '/node/' . $node->id(),
		'status' => $rendered['status'],
		'html' => $rendered['html'],
		'values' => entity_values($node),
	];
}
// a second render of the FIRST entity, so per-request variation is separable from per-entity
$again = render_path($kernel, '/node/' . $nodes[0]->id());
$class['repeat'] = $again['html'];
$out['classes'][] = $class;

$class = ['label' => 'user canonical (anonymous)', 'entities' => []];
foreach ($uids as $uid) {
	$user = User::load($uid);
	$rendered = render_path($kernel, '/user/' . $uid);
	$class['entities'][] = [
		'id' => (string) $uid,
		'path' => '/user/' . $uid,
		'status' => $rendered['status'],
		'html' => $rendered['html'],
		'values' => entity_values($user),
	];
}
$out['classes'][] = $class;

file_put_contents($root . '/harvest.json', json_encode($out));
fwrite(STDERR, "harvested\n");
`;

/** a scratch Drupal root of symlinks, so nothing writes into the build input or the tracked pack */
function buildScratchRoot(): string {
	rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(join(SCRATCH, 'sites/default/files/config/sync'), { recursive: true });
	mkdirSync(join(SCRATCH, 'modules/custom'), { recursive: true });
	mkdirSync(join(SCRATCH, 'libraries/drupflare-stream-http'), { recursive: true });

	for (const entry of [
		'core',
		'vendor',
		'profiles',
		'themes',
		'recipes',
		'autoload.php',
		'index.php'
	])
		symlinkSync(join(DRUPAL_SRC, entry), join(SCRATCH, entry));
	symlinkSync(join(DRUPAL_SRC, 'modules/contrib'), join(SCRATCH, 'modules/contrib'));

	// the machine name comes from the MOUNT, not the repo directory; `../rom` is `cfw_do_sqlite`
	symlinkSync(DRUPFLARE_SRC, join(SCRATCH, 'modules/custom/drupflare'));
	symlinkSync(ROM_SRC, join(SCRATCH, 'modules/custom/cfw_do_sqlite'));
	if (existsSync(join(STREAM_HTTP_SRC, 'src')))
		symlinkSync(
			join(STREAM_HTTP_SRC, 'src'),
			join(SCRATCH, 'libraries/drupflare-stream-http/src')
		);

	copyFileSync(PACK_DB, join(SCRATCH, 'sites/default/files/.sqlite'));
	writeFileSync(join(SCRATCH, 'sites/default/settings.php'), SETTINGS_PHP);
	writeFileSync(join(SCRATCH, 'harvest.php'), HARVEST_PHP);
	return SCRATCH;
}

function harvest(): { classes: Array<{ label: string; entities: Entity[]; repeat?: string }> } {
	const root = buildScratchRoot();
	execFileSync('php', ['-d', 'memory_limit=1G', join(root, 'harvest.php')], {
		stdio: ['ignore', 'inherit', 'inherit'],
		cwd: root
	});
	// readFileSync with an encoding, never Buffer.toString(encoding): inside a program carrying both
	// @cloudflare/workers-types and @types/node the Buffer overloads are shadowed away
	return JSON.parse(readFileSync(join(root, 'harvest.json'), 'utf8'));
}

// #endregion

// #region classify

/** the constant bytes immediately before and after a slot, which a value may have been eaten by */
function neighbours(plan: RenderPlan, name: string): { before: string; after: string } {
	const i = plan.ops.findIndex((op) => op[0] === 's' && op[1] === name);
	const prev = i > 0 ? plan.ops[i - 1] : undefined;
	const next = i + 1 < plan.ops.length ? plan.ops[i + 1] : undefined;
	return {
		before: prev && prev[0] === 't' ? prev[1] : '',
		after: next && next[0] === 't' ? next[1] : ''
	};
}

/** how a region is rebuilt: literal text, or the value of one of the entity's own fields */
export type Part = { text: string } | { field: string };

export type Explanation = { head: number; tail: number; parts: Part[] };

/**
 * How a varying region is composed out of the entity's own field values, or null.
 *
 * Two mechanics, and both are already in `render-plan.ts` for the ids it names, which is why doing
 * them here is fidelity rather than tuning:
 *
 * - RECLAIM. The diff's bracket eats whatever characters the two renders happened to share, so a
 *   value's leading and trailing bytes sit in the constants either side. `recogniseDomId()` tries
 *   every split of the missing count for the same reason. Left alone, the shared tail of two bodies
 *   is baked into a constant and the plan stops aligning with a third entity.
 * - COMPOSITION. One region can hold a value, constant markup, and the value again --
 *   `recogniseSpan()` returns exactly that shape for a build id. A canonical plus a shortlink tag is
 *   the same shape with the node id.
 */
function explainRegion(
	sampleA: string,
	sampleB: string,
	valuesA: Record<string, string>,
	valuesB: Record<string, string>,
	before: string,
	after: string
): Explanation | null {
	const keys = Object.keys(valuesA).filter(
		(k) => (valuesA[k] ?? '') !== '' && (valuesA[k] ?? '') !== (valuesB[k] ?? '')
	);
	const byFirst = new Map<string, string[]>();
	for (const k of keys) {
		const c = valuesA[k]![0]!;
		(byFirst.get(c) ?? byFirst.set(c, []).get(c)!).push(k);
	}
	for (const list of byFirst.values())
		list.sort((x, y) => valuesA[y]!.length - valuesA[x]!.length);

	const parse = (a: string, b: string): Part[] | null => {
		const parts: Part[] = [];
		let i = 0;
		let j = 0;
		let text = '';
		let fields = 0;
		while (i < a.length || j < b.length) {
			let took = false;
			for (const key of byFirst.get(a[i] ?? ' ') ?? []) {
				const va = valuesA[key]!;
				const vb = valuesB[key]!;
				if (!a.startsWith(va, i) || !b.startsWith(vb, j)) continue;
				if (text !== '') parts.push({ text });
				text = '';
				parts.push({ field: key });
				fields++;
				i += va.length;
				j += vb.length;
				took = true;
				break;
			}
			if (took) continue;
			if (i < a.length && j < b.length && a[i] === b[j]) {
				text += a[i];
				i++;
				j++;
				continue;
			}
			return null;
		}
		if (fields === 0) return null;
		if (text !== '') parts.push({ text });
		return parts;
	};

	const maxHead = Math.min(RECLAIM_MAX, before.length);
	const maxTail = Math.min(RECLAIM_MAX, after.length);
	for (let head = 0; head <= maxHead; head++) {
		const prefix = head === 0 ? '' : before.slice(before.length - head);
		for (let tail = 0; tail <= maxTail; tail++) {
			const suffix = after.slice(0, tail);
			const parts = parse(prefix + sampleA + suffix, prefix + sampleB + suffix);
			if (parts) return { head, tail, parts };
		}
	}
	return null;
}

/** what a rebuilt region should read for one entity, given the recipe */
function compose(parts: Part[], values: Record<string, string>): string | null {
	let out = '';
	for (const part of parts) {
		if ('text' in part) out += part.text;
		else if (values[part.field] === undefined) return null;
		else out += values[part.field];
	}
	return out;
}

function classifySlots(
	plan: RenderPlan,
	a: Entity,
	b: Entity,
	volatileSamples: ReadonlySet<string> = new Set()
): SlotReport[] {
	return Object.entries(plan.slots).map(([name, slot]) => {
		const kind =
			slot.kind === 'build_id'
				? `build_id:${slot.role}`
				: slot.kind === 'unknown'
					? 'unknown'
					: slot.kind;
		if (slot.kind !== 'unknown')
			return {
				name,
				kind,
				klass: 'recognised' as const,
				field: null,
				explain: null,
				a: plan.sample[name] ?? '',
				b: plan.sampleB[name] ?? ''
			};
		const { before, after } = neighbours(plan, name);
		const sampleA = plan.sample[name] ?? '';
		const sampleB = plan.sampleB[name] ?? '';
		const explain = explainRegion(sampleA, sampleB, a.values, b.values, before, after);
		const field = explain
			? explain.parts
					.filter((p): p is { field: string } => 'field' in p)
					.map((p) => p.field)
					.join(' + ')
			: null;
		// a region that also varies between TWO RENDERS OF ONE ENTITY is per-request volatility, not
		// per-entity variation; today's per-path plan already refuses on it, so it is not a route-class
		// problem and must not be counted as one
		// containment rather than equality: a class diff merges regions the control diff kept apart,
		// because between two entities more of the page varies and there is no anchor line between
		const isVolatile = [...volatileSamples].some(
			(v) => v.length >= 2 && (sampleA.includes(v) || sampleB.includes(v))
		);
		const borrowed = explain
			? explain.parts.some((p) => 'field' in p && p.field.startsWith('__ref.'))
			: false;
		return {
			name,
			kind,
			klass: (field
				? borrowed
					? 'field_ref'
					: 'field'
				: isVolatile
					? 'volatile'
					: 'unknown') as RegionClass,
			field,
			explain,
			a: sampleA,
			b: sampleB
		};
	});
}

/**
 * The plan a field recogniser would have emitted: every named region owns its whole value.
 *
 * Without this the shared tail of two bodies stays in the constant behind the slot, and the plan
 * stops aligning with the third entity -- which reads as "the class cannot be served" when what
 * actually happened is that nothing reclaimed the bytes. `compilePlan()` does the same thing for
 * the ids it names.
 */
function rebuildPlan(plan: RenderPlan, slots: SlotReport[]): RenderPlan {
	const ops = plan.ops.map((op) => [...op] as typeof op);
	const byName = new Map(slots.map((s) => [s.name, s]));
	for (const [i, op] of ops.entries()) {
		if (op[0] !== 's') continue;
		const explain = byName.get(op[1])?.explain;
		if (!explain) continue;
		const prev = i > 0 ? ops[i - 1] : undefined;
		const next = i + 1 < ops.length ? ops[i + 1] : undefined;
		if (explain.head > 0 && prev && prev[0] === 't')
			prev[1] = prev[1].slice(0, Math.max(0, prev[1].length - explain.head));
		if (explain.tail > 0 && next && next[0] === 't') next[1] = next[1].slice(explain.tail);
	}
	return { ...plan, ops: ops.filter((op) => op[0] !== 't' || op[1] !== '') };
}

/**
 * The values a third render puts in a plan's slots, or null when the plan's constants do not align.
 *
 * This is the inverse of `runPlan()` and the VM has no need for it, so it lives here rather than in
 * `render-plan.ts`: the serving side generates slot values, it never reads them back out.
 */
export function extractSlots(plan: RenderPlan, html: string): Record<string, string> | null {
	let at = 0;
	const values: Record<string, string> = {};
	let pending: string | null = null;
	for (const op of plan.ops) {
		if (op[0] === 's') {
			pending = op[1];
			continue;
		}
		const found = html.indexOf(op[1], at);
		if (found < 0) return null;
		if (pending !== null) {
			values[pending] = html.slice(at, found);
			pending = null;
		} else if (found !== at) {
			return null;
		}
		at = found + op[1].length;
	}
	if (pending !== null) values[pending] = html.slice(at);
	else if (at !== html.length) return null;
	return values;
}

/**
 * A plan serves an entity when its constants align AND every slot resolves.
 *
 * `strict` is the definition F1 was proposed under: a value readable from the entity's OWN row. The
 * relaxed answer also allows values denormalised from the entities it references, which is a
 * different artifact with a different invalidation rule, so the two are reported separately.
 */
function serves(
	plan: RenderPlan,
	slots: SlotReport[],
	entity: Entity,
	strict: boolean
): true | string {
	const values = extractSlots(plan, entity.html);
	if (values === null) return 'constants do not align';
	for (const slot of slots) {
		if (slot.klass === 'unknown') return `slot ${slot.name} is unnameable`;
		if (slot.klass === 'volatile') return `slot ${slot.name} varies per request`;
		if (slot.klass === 'field_ref' && strict) return `slot ${slot.name} borrows another row`;
		if (slot.klass === 'recognised') continue;
		if (compose(slot.explain!.parts, entity.values) !== values[slot.name])
			return `slot ${slot.name} does not reproduce`;
	}
	return true;
}

export function measureClass(label: string, entities: Entity[], repeat?: string): ClassReport {
	const [a, b, ...rest] = entities;
	if (!a || !b) throw new Error(`${label}: needs at least two entities`);

	// THE CONTROL. Two renders of ONE entity: everything varying here is per-request and is already
	// what today's per-path plan has to name. Without it a per-request random id reads as a
	// route-class failure and the wrong mechanism gets closed
	const baseline = repeat ? compilePlan(a.html, repeat, label) : null;
	const volatileSamples = new Set<string>();
	let baselineUnnamed = 0;
	if (baseline) {
		for (const [name, slot] of Object.entries(baseline.slots)) {
			volatileSamples.add(baseline.sample[name] ?? '');
			volatileSamples.add(baseline.sampleB[name] ?? '');
			if (slot.kind === 'unknown') baselineUnnamed++;
		}
	}

	// EVERY witness pair, not the first two. Two entities that disagree in SHAPE -- an optional field
	// empty in one and set in the other -- compile a plan neither of them explains, and picking the
	// first pair would report that as the class's answer. The best pair is the one a compiler would
	// have kept
	let best: {
		plan: RenderPlan;
		slots: SlotReport[];
		served: number;
		relaxed: number;
		failures: string[];
	} | null = null;
	for (let i = 0; i < entities.length; i++) {
		for (let j = i + 1; j < entities.length; j++) {
			const raw = compilePlan(entities[i]!.html, entities[j]!.html, label);
			const s = classifySlots(raw, entities[i]!, entities[j]!, volatileSamples);
			const p = rebuildPlan(raw, s);
			let strictOk = 0;
			let relaxedOk = 0;
			const why: string[] = [];
			for (const entity of entities) {
				const strict = serves(p, s, entity, true);
				if (strict === true) strictOk++;
				else why.push(`${entity.path}: ${strict}`);
				if (serves(p, s, entity, false) === true) relaxedOk++;
			}
			if (
				best === null ||
				strictOk > best.served ||
				(strictOk === best.served && relaxedOk > best.relaxed)
			)
				best = { plan: p, slots: s, served: strictOk, relaxed: relaxedOk, failures: why };
		}
	}
	const { plan, slots, served, relaxed: servedRelaxed, failures } = best!;

	let unmatched = 0;
	for (const entity of entities) if (extractSlots(plan, entity.html) === null) unmatched++;

	// recurrence across consecutive pairs, so a one-off is distinguishable from a structural hole
	const counts = new Map<string, number>();
	for (let i = 0; i + 1 < entities.length; i++) {
		const p = compilePlan(entities[i]!.html, entities[i + 1]!.html, label);
		for (const s of classifySlots(p, entities[i]!, entities[i + 1]!, volatileSamples))
			if (s.klass === 'unknown') counts.set(s.a, (counts.get(s.a) ?? 0) + 1);
	}

	return {
		label,
		entities: entities.length,
		baselineRegions: baseline ? Object.keys(baseline.slots).length : null,
		baselineUnnamed: baseline ? baselineUnnamed : null,
		constantOps: plan.ops.filter((op) => op[0] === 't').length,
		constantBytes: plan.ops.reduce((n, op) => n + (op[0] === 't' ? op[1].length : 0), 0),
		slots,
		served,
		servedRelaxed,
		failures,
		unmatched,
		unknownSamples: [...counts.entries()]
			.map(([text, count]) => ({ text, count }))
			.sort((x, y) => y.count - x.count || y.text.length - x.text.length)
			.slice(0, 10)
	};
}

// #endregion

function show(text: string): string {
	if (text.length <= 1_000) return text;
	return `${text.slice(0, 500)}\n    ... [${text.length} bytes, middle elided] ...\n${text.slice(-500)}`;
}

function report(r: ClassReport): void {
	const by = (k: RegionClass) => r.slots.filter((s) => s.klass === k).length;
	console.log(`\n=== ${r.label}`);
	console.log(`entities            ${r.entities}`);
	if (r.baselineRegions !== null)
		console.log(
			`control: one entity, two renders -> ${r.baselineRegions} varying regions, ${r.baselineUnnamed} unnamed by today's recognisers`
		);
	console.log(`constant ops        ${r.constantOps} (${r.constantBytes} bytes)`);
	console.log(`varying regions     ${r.slots.length}`);
	console.log(`  recognised        ${by('recognised')}`);
	console.log(`  field (own row)   ${by('field')}`);
	console.log(`  field (other row) ${by('field_ref')}`);
	console.log(`  volatile          ${by('volatile')} (per-request, not per-entity)`);
	console.log(`  UNKNOWN           ${by('unknown')}`);
	console.log(`constants unaligned ${r.unmatched} of ${r.entities}`);
	console.log(
		`SERVED, own row     ${r.served}/${r.entities} = ${((r.served / r.entities) * 100).toFixed(1)}%`
	);
	console.log(
		`served, denormalised ${r.servedRelaxed}/${r.entities} = ${((r.servedRelaxed / r.entities) * 100).toFixed(1)}%`
	);
	for (const s of r.slots.filter((s) => s.klass === 'field' || s.klass === 'field_ref'))
		console.log(`  ${s.klass === 'field' ? 'field    ' : 'field_ref'} ${s.name} <- ${s.field}`);
	for (const f of r.failures.slice(0, 8)) console.log(`  refused ${f}`);
	if (r.unknownSamples.length > 0) {
		console.log(`\n--- most common UNKNOWN regions in ${r.label}`);
		for (const [i, u] of r.unknownSamples.entries())
			console.log(
				`\n[${i + 1}] seen in ${u.count} consecutive pairs, ${u.text.length} bytes:\n${show(u.text)}`
			);
	}
}

if (import.meta.main) {
	const data = harvest();
	const reports: ClassReport[] = [];
	for (const cls of data.classes) {
		const bad = cls.entities.filter((e) => (e as unknown as { status: number }).status !== 200);
		if (bad.length > 0) console.log(`WARNING ${cls.label}: ${bad.length} non-200 renders`);
		reports.push(measureClass(cls.label, cls.entities, cls.repeat));
	}
	for (const r of reports) report(r);
	const total = reports.reduce((n, r) => n + r.entities, 0);
	const served = reports.reduce((n, r) => n + r.served, 0);
	const relaxed = reports.reduce((n, r) => n + r.servedRelaxed, 0);
	console.log(
		`\nOVERALL, own row only  ${served}/${total} = ${((served / total) * 100).toFixed(1)}%`
	);
	console.log(
		`OVERALL, denormalised  ${relaxed}/${total} = ${((relaxed / total) * 100).toFixed(1)}%`
	);
	console.log(`bar was ~90% per class`);
}
