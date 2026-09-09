import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * How many pages one content save invalidates, on a site with real dependents.
 *
 * Scoped invalidation's headline is arithmetic over two terms. Rows per fill is measured and pinned
 * by `rows-per-fill-audit.spec.ts`; FILLS PER SAVE was never measured at all, and the docblock on
 * `purgeForTags()` carries it as "3 to 10 pages" with no instrument behind it.
 *
 * The site is built rather than seeded: 30 nodes, two taxonomy terms tagging alternating nodes,
 * three menu links pointing at nodes 1-3, and 34 paths filled through the real render path so every
 * `cfw_page` row carries the tag set Drupal produced. A hand-written tag list would decide the
 * answer in advance, and the answer is the quantity under test.
 *
 * BOTH ARMS ON ONE OBJECT, consecutively, and the wholesale arm is measured rather than computed:
 * `pathsForTags()` answers null when any stored page has no recorded tags, so nulling one column
 * takes the same save down the wholesale path and the ratio is a paired reading.
 *
 * **The save fragment performs the request-boundary reset itself, and that is not harness
 * convenience.** `CacheTagsChecksumTrait` memoises every tag it has already invalidated and skips it
 * on a second pass, which is correct for one process per request and wrong on a persistent
 * interpreter. Measured before the resetter learned about it: 48 tags sat memoised across a whole
 * incarnation, a second menu-item save issued NO SQL at all, and the tag its pages depend on was
 * never written. `cache_tags.invalidator.checksum` is on the resetter's seed list now, so `cfw_serve`
 * clears it at the boundary; this fragment calls the same reset because `drupalOp()` is not a serve.
 *
 * **What the host records is narrower than what Drupal invalidates, and the gap is printed rather
 * than asserted here.** `cacheTagsIn()` reads positional bindings only, and Drupal's `merge()` takes
 * the UPDATE branch with NAMED ones once a tag's row exists -- so every invalidation after a tag's
 * first is invisible to `execSql()`. That is a property of one function and is falsified in
 * `tests/unit/ops/render-plan.spec.ts`; this file measures the dependency graph, which is the term
 * the arithmetic needs, and reads the invalidated set from Drupal's own record.
 */

const TIMEOUT = 900_000;

/** enough pages that the wholesale arm hits `PREFILL_ON_SAVE_LIMIT` rather than the page count */
const NODES = 30;

type Purge = {
	purged: number;
	requeued: number;
	policy: string;
	scoped: boolean;
	purgedPages: number;
};

type Site = ServeDo & {
	pendingTags: () => string[];
	clearPendingTags: () => void;
	purgeForTags: (
		tags: readonly string[],
		reason?: string,
		opts?: { bump?: boolean }
	) => Record<string, unknown>;
};

/** a booted kernel with the legacy includes and a session, which entity saves need */
const PREAMBLE = String.raw`
$kernel = $GLOBALS['__pw_kernel'] ?? null;
if ($kernel !== null && method_exists($kernel, 'loadLegacyIncludes')) { $kernel->loadLegacyIncludes(); }
\Drupal::moduleHandler()->loadAll();
$req = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
$req->setSession(new \Symfony\Component\HttpFoundation\Session\Session(
  new \Symfony\Component\HttpFoundation\Session\Storage\MockArraySessionStorage()
));
\Drupal::service('request_stack')->push($req);
`;

const CONTENT = drupalOp(
	PREAMBLE +
		String.raw`
// the tags field the standard profile puts on an article; this pack ships only the page type, so
// the site gets the field it would have had. A term nothing references has no dependents at all
if (\Drupal\field\Entity\FieldStorageConfig::loadByName('node', 'field_tags') === null) {
  \Drupal\field\Entity\FieldStorageConfig::create([
    'field_name' => 'field_tags',
    'entity_type' => 'node',
    'type' => 'entity_reference',
    'settings' => ['target_type' => 'taxonomy_term'],
    'cardinality' => -1,
  ])->save();
  \Drupal\field\Entity\FieldConfig::create([
    'field_name' => 'field_tags',
    'entity_type' => 'node',
    'bundle' => 'page',
    'label' => 'Tags',
    'settings' => ['handler' => 'default', 'handler_settings' => ['target_bundles' => ['tags' => 'tags']]],
  ])->save();
}
$terms = [];
foreach (['Alpha', 'Beta'] as $name) {
  $term = \Drupal\taxonomy\Entity\Term::create(['vid' => 'tags', 'name' => $name]);
  $term->save();
  $terms[] = (int) $term->id();
}
$nids = [];
for ($i = 1; $i <= ${NODES}; $i++) {
  $node = \Drupal\node\Entity\Node::create([
    'type' => 'page',
    'title' => 'Node ' . $i,
    'status' => 1,
    'body' => ['value' => 'body ' . $i, 'format' => 'basic_html'],
    'field_tags' => [['target_id' => $terms[$i % 2]]],
  ]);
  $node->save();
  $nids[] = (int) $node->id();
}
foreach (array_slice($nids, 0, 3) as $nid) {
  \Drupal\menu_link_content\Entity\MenuLinkContent::create([
    'title' => 'Link ' . $nid,
    'link' => ['uri' => 'entity:node/' . $nid],
    'menu_name' => 'main',
  ])->save();
}
$out['terms'] = $terms;
$out['nids'] = $nids;
$out['ok'] = true;`
);

/**
 * One save, with the boundary reset in front of it and Drupal's own invalidation record behind it.
 *
 * The record is the checksum service's memo: `invalidateTags()` writes a key there for every tag it
 * accepted, so after a reset it is exactly this request's set. Reading it beats re-deriving the set
 * from entity types, which would be this test deciding the answer.
 */
const save = (body: string) =>
	drupalOp(
		PREAMBLE +
			String.raw`
\Drupal::service('drupflare.request_resetter')->reset();
$checksum = \Drupal::service('cache_tags.invalidator.checksum');
$memo = new \ReflectionObject($checksum);
${body}
$out['invalidated'] = array_keys((array) $memo->getProperty('invalidatedTags')->getValue($checksum));
$out['ok'] = true;`
	);

/**
 * A save kind and the entity it moves, by round.
 *
 * Four kinds because the fan-out is a property of what the content is REFERENCED BY rather than of
 * its entity type: nodes 1-3 are in the main menu, so every page carries their tags, and nodes 20+
 * are not.
 */
const KINDS: readonly { kind: string; php: (round: number) => string }[] = [
	{
		kind: 'node',
		php: (r) =>
			`$n = \\Drupal\\node\\Entity\\Node::load(${20 + r}); $n->setTitle('Node ${20 + r} r${r}'); $n->save();`
	},
	{
		kind: 'node-in-menu',
		php: (r) =>
			`$n = \\Drupal\\node\\Entity\\Node::load(${1 + r}); $n->setTitle('Node ${1 + r} r${r}'); $n->save();`
	},
	{
		kind: 'term',
		php: (r) =>
			`$t = \\Drupal\\taxonomy\\Entity\\Term::load(${1 + (r % 2)}); $t->setName('Term ${1 + (r % 2)} r${r}'); $t->save();`
	},
	{
		kind: 'menu-item',
		php: (r) =>
			`$l = \\Drupal\\menu_link_content\\Entity\\MenuLinkContent::load(${1 + r}); $l->set('title', 'Link r${r}'); $l->save();`
	}
];

const ROUNDS = 3;

type Round = {
	kind: string;
	round: number;
	invalidated: string[];
	hostSaw: string[];
	purged: number;
	requeued: number;
	policy: string;
	scoped: boolean;
};

const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('fills per save, on a site with real dependents', () => {
	it(
		'measures the dependent set per save kind and the wholesale arm beside it',
		async () => {
			const out = await inObject(freshSite(), async (raw: ServeDo) => {
				const site = raw as Site;
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Fills-9912-pass',
							siteName: 'Fills'
						})
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);
				const content = await site.runJson(CONTENT);
				expect(content.ok, JSON.stringify(content).slice(0, 400)).toBe(true);

				const paths = [
					'/',
					'/node',
					...Array.from({ length: NODES }, (_, i) => `/node/${i + 1}`),
					'/taxonomy/term/1',
					'/taxonomy/term/2'
				];
				const count = (table: string) =>
					Number(
						site.sql.exec(`SELECT COUNT(*) AS c FROM ${table}`).toArray()[0]?.c ?? 0
					);
				const refill = async () => {
					for (const path of paths) {
						if (
							site.sql.exec('SELECT 1 FROM cfw_page WHERE path = ?', path).toArray()
								.length === 0
						) {
							await site.fillOne(path, ['page', 'dynamic_page_cache']);
						}
					}
				};
				await refill();
				const cached = count('cfw_page');

				const one = async (kind: string, php: string): Promise<Round> => {
					site.sql.exec('DELETE FROM cfw_fill_queue');
					site.clearPendingTags();
					const res = await site.runJson(save(php));
					expect(res.ok, `${kind}: ${JSON.stringify(res).slice(0, 400)}`).toBe(true);
					const invalidated = (res.invalidated as string[]) ?? [];
					const hostSaw = site.pendingTags();
					const purge = site.purgeForTags(invalidated, 'cachetags', {
						bump: false
					}) as unknown as Purge;
					return {
						kind,
						round: 0,
						invalidated,
						hostSaw,
						purged: purge.purged,
						requeued: purge.requeued,
						policy: purge.policy,
						scoped: purge.scoped
					};
				};

				const rounds: Round[] = [];
				for (const { kind, php } of KINDS) {
					for (let r = 0; r < ROUNDS; r++) {
						rounds.push({ ...(await one(kind, php(r))), round: r });
						await refill();
					}
				}

				// THE WHOLESALE ARM, on the same object and the same save. One page with no recorded
				// tags is enough to make `pathsForTags()` answer null, which is the fallback the
				// scoped path replaced
				site.sql.exec('UPDATE cfw_page SET tags = NULL WHERE path = ?', '/node/30');
				const wholesale = {
					...(await one(
						'wholesale',
						`$n = \\Drupal\\node\\Entity\\Node::load(20); $n->setTitle('Node 20 wholesale'); $n->save();`
					)),
					round: 0
				};

				return { cached, rounds, wholesale, storedAfter: count('cfw_page') };
			});

			const byKind = new Map<string, Round[]>();
			for (const r of out.rounds) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);

			const table = [...byKind].map(([kind, rs]) => ({
				kind,
				n: rs.length,
				purged: rs.map((r) => r.purged),
				medianPurged: median(rs.map((r) => r.purged)),
				requeued: rs.map((r) => r.requeued),
				medianRequeued: median(rs.map((r) => r.requeued)),
				policy: [...new Set(rs.map((r) => r.policy))],
				// what Drupal invalidated against what the host's own interception recorded
				invalidated: rs.map((r) => r.invalidated.length),
				hostSaw: rs.map((r) => r.hostSaw.length),
				missedByHost: [
					...new Set(
						rs.flatMap((r) => r.invalidated.filter((t) => !r.hostSaw.includes(t)))
					)
				]
			}));
			console.log(
				`[fills-per-save] ${JSON.stringify(
					{
						cachedPages: out.cached,
						table,
						wholesale: {
							scoped: out.wholesale.scoped,
							purged: out.wholesale.purged,
							requeued: out.wholesale.requeued,
							policy: out.wholesale.policy
						}
					},
					null,
					1
				)}`
			);

			expect(out.cached, 'the site has to be populated or nothing here means anything').toBe(
				NODES + 4
			);

			// every kind moved something. A purge that removes nothing passes a one-sided test, and
			// this file exists because the term it measures had no instrument at all
			for (const [kind, rs] of byKind) {
				for (const r of rs) {
					expect(
						r.invalidated.length,
						`${kind} round ${r.round} invalidated no tag, so the save did not happen`
					).toBeGreaterThan(0);
					expect(
						r.purged,
						`${kind} round ${r.round} purged no page on a site with ${out.cached} cached`
					).toBeGreaterThan(0);
					expect(r.scoped, `${kind} round ${r.round} fell to the wholesale path`).toBe(
						true
					);
				}
			}

			// the wholesale arm is the control: same save, same site, tag index unusable
			expect(out.wholesale.scoped, 'nulling a tag column must take the wholesale path').toBe(
				false
			);
			expect(out.wholesale.purged).toBe(out.cached);

			// THE CLAIM SCOPED INVALIDATION EXISTS FOR: an ordinary node save is a fraction of it
			const plain = byKind.get('node') ?? [];
			for (const r of plain) {
				expect(
					r.purged,
					'a node save purged as much as a wholesale purge, so scoping bought nothing'
				).toBeLessThan(out.wholesale.purged);
			}

			// AND THE HALF THAT IS NOT FLATTERING: a save whose entity is referenced by the main
			// menu reaches every page, so scoping saves nothing on it. Asserted rather than
			// mentioned, because the arithmetic that quotes one ratio for "a save" hides this
			const inMenu = byKind.get('node-in-menu') ?? [];
			for (const r of inMenu) {
				expect(
					r.purged,
					'a menu-linked node save was expected to reach every cached page'
				).toBe(out.cached);
			}
		},
		TIMEOUT
	);
});
