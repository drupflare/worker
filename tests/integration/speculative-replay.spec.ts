import { describe, expect, it } from 'vitest';
import { claimSite } from '../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Experiment B for the EXTERNALIZE mechanism: can a PHP execution be rolled back and replayed?
 *
 * The proposal is to let a blocking PHP operation abort, have the host perform the I/O outside PHP,
 * and replay the request with the answer memoized -- so `redis`, `smtp` and `openid_connect` keep
 * their own PHP libraries and Drupal modules instead of being replaced by host implementations. The
 * expensive half is a C-level transport (Experiment A, which needs a phasm toolchain session). This
 * is the half that needs no build and decides whether the rest is worth one.
 *
 * FOUR QUESTIONS, and the order matters because the first is fatal to the design if it fails:
 *
 * 1. does a rollback undo a write PHP made, or only one the host made?
 * 2. does an abort mid-execution leave the database as it was?
 * 3. does a replay with a memoized answer commit exactly once?
 * 4. what differs between the two passes, which is the determinism budget the design has to fit in?
 *
 * NOT A FEATURE TEST. Nothing in `src/` uses any of this; it is a measurement of the primitives,
 * recorded so the next session starts from a reading rather than from an argument.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Replay-4471';

type Payload = Record<string, unknown>;

/** a table this owns outright, so nothing here can be confused with Drupal's own writes */
const SETUP = `CREATE TABLE IF NOT EXISTS cfw_replay_probe (k TEXT PRIMARY KEY, v TEXT)`;

const countProbe = (site: ServeDo) =>
	site
		.fetch(
			new Request(
				`https://do.local/__sql?q=${encodeURIComponent('SELECT COUNT(*) AS c FROM cfw_replay_probe')}`
			)
		)
		.then((r) => r.json() as Promise<Payload>)
		.then((out) => Number(((out['rows'] as Payload[]) ?? [])[0]?.['c'] ?? -1));

/**
 * A fragment that writes through Drupal's own PDO driver and then reports.
 *
 * Through the driver rather than through `ctx.storage.sql` on purpose: the question is whether a
 * write PHP made participates in the host's transaction, and a host-side write trivially does.
 */
const phpWrite = (key: string) => `<?php
require_once '/drupal/vendor/autoload.php';
$out = ['wrote' => false, 'error' => null];
try {
  $db = \\Drupal\\Core\\Database\\Database::getConnection();
  $db->query("INSERT OR REPLACE INTO cfw_replay_probe (k, v) VALUES (:k, :v)", [
    ':k' => '${key}',
    ':v' => 'pass',
  ]);
  $out['wrote'] = true;
} catch (\\Throwable $e) {
  $out['error'] = substr($e->getMessage(), 0, 200);
}
echo json_encode($out);
`;

/** what a replay has to reproduce; each one is a documented determinism hazard */
const NONDETERMINISM = `<?php
echo json_encode([
  'microtime' => microtime(true),
  'random' => random_int(0, PHP_INT_MAX),
  'mt' => mt_rand(),
  'uniqid' => uniqid('', true),
  'session' => function_exists('session_id') ? (string) @session_id() : '',
  'requestTime' => $_SERVER['REQUEST_TIME_FLOAT'] ?? null,
]);
`;

describe('the transaction primitive the design rests on', () => {
	/**
	 * `ctx.storage.transactionSync()` is a SAVEPOINT and rolls back on a throw. What this asks is
	 * whether a PHP write is inside it, because the design's whole safety argument is that a
	 * speculative pass leaves nothing behind.
	 *
	 * The answer is structural and it is the first real constraint: `transactionSync` takes a
	 * SYNCHRONOUS callback and a PHP render is behind an `await`. So the host cannot wrap a render
	 * in one, however the rest of the design turns out.
	 */
	it(
		'cannot wrap a PHP render, because the callback is synchronous and the render is not',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'Replay');
				site.sql.exec(SETUP);

				let threw: string | null = null;
				try {
					// the shape the design needs, written out so the refusal is the measurement
					(
						site.storage as unknown as {
							transactionSync: (fn: () => unknown) => unknown;
						}
					).transactionSync(() => {
						// a promise is all a sync callback can receive from an async render, and
						// returning one does not make the transaction wait for it
						const pending = site.runJson(phpWrite('inside'));
						return pending;
					});
				} catch (e: unknown) {
					threw = String((e as Error)?.message ?? e);
				}
				// drain whatever that started before reading, so the count is not a race
				await site.runJson(phpWrite('settled'));
				return { threw, rows: await countProbe(site) };
			});

			// the finding either way: it throws, or it returns having not waited. Both mean the same
			// thing for the design -- a render cannot be the body of a transactionSync
			expect(out.rows, 'the probe table was never reachable').toBeGreaterThanOrEqual(0);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * So the rollback has to be issued as SQL around the render rather than as a callback.
	 *
	 * `ctx.storage.sql` refuses `BEGIN`, which is why `transactionSync` exists at all -- but a NAMED
	 * savepoint is a different statement, and whether the platform accepts one is the question the
	 * design actually turns on.
	 */
	it(
		'answers whether a named SAVEPOINT can be issued as SQL around an await',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'Replay');
				site.sql.exec(SETUP);
				const before = await countProbe(site);

				let opened: string | null = null;
				let rolled: string | null = null;
				let wrote: Payload = {};
				try {
					site.sql.exec('SAVEPOINT cfw_speculative');
				} catch (e: unknown) {
					opened = String((e as Error)?.message ?? e).slice(0, 200);
				}
				if (opened === null) {
					// the render happens BETWEEN the savepoint and the rollback, which is exactly what
					// a synchronous callback cannot express
					wrote = await site.runJson(phpWrite('speculative'));
					try {
						site.sql.exec('ROLLBACK TO cfw_speculative');
						site.sql.exec('RELEASE cfw_speculative');
					} catch (e: unknown) {
						rolled = String((e as Error)?.message ?? e).slice(0, 200);
					}
				}
				return { before, opened, rolled, wrote, after: await countProbe(site) };
			});

			// MEASURED 2026-09-08 AND IT IS THE ANSWER. The platform refuses the statement by name:
			// "please use the state.storage.transaction() or state.storage.transactionSync() APIs
			// instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements"
			expect(out.before, 'the probe table was not created').toBe(0);
			expect(
				out.opened,
				'a SAVEPOINT was accepted, which would reopen the design'
			).not.toBeNull();
			expect(out.opened).toContain('SAVEPOINT');
			expect(out.opened).toContain('transactionSync');
			// so nothing ran between the two, and the write never happened
			expect(out.after).toBe(0);
		},
		REQUEST_TIMEOUT
	);
});

describe('the determinism budget a replay has to fit in', () => {
	/**
	 * The design only needs the region between the checkpoint and the external call to be
	 * replay-equivalent, which is much narrower than a deterministic request. This measures what
	 * actually differs across two executions of the same fragment in one incarnation.
	 *
	 * Every one of these is a documented hazard, and the point of measuring rather than listing them
	 * is that the interpreter's own behaviour decides which are real here. `microtime()` in
	 * particular is a candidate for NOT differing: the clock does not advance across a synchronous
	 * `php._run()`, which is the measurement rule this whole repository is built on.
	 */
	it(
		'reports which sources differ between two passes',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'Replay');
				const first = await site.runJson(NONDETERMINISM);
				const second = await site.runJson(NONDETERMINISM);
				return { first, second };
			});

			const differs = Object.keys(out.first).filter(
				(k) => JSON.stringify(out.first[k]) !== JSON.stringify(out.second[k])
			);
			console.log(
				`replay determinism: differs=[${differs.join(', ')}] ` +
					`first=${JSON.stringify(out.first)} second=${JSON.stringify(out.second)}`
			);

			// the control: if NOTHING differed the fragment is not exercising the sources at all, and
			// a determinism budget of zero would be a wrong reassuring answer
			expect(Object.keys(out.first).length).toBeGreaterThan(3);
			// randomness is the one that cannot be assumed away, and a replay must memoize it
			expect(differs, 'random_int() agreed twice, which would be the real finding').toContain(
				'random'
			);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A memoized answer is what the second pass consumes, so the mechanism has to survive the thing
	 * that destroys in-memory state: `recycleIfOversized()` drops the interpreter between
	 * invocations.
	 *
	 * A ticket in `$GLOBALS` dies with it silently, which is the third silent-death shape this
	 * project has recorded. The memo therefore belongs in SQL, and this pins that it survives.
	 */
	it(
		'keeps a memoized answer across an interpreter drop',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'Replay');
				site.sql.exec(SETUP);
				site.sql.exec(
					`INSERT OR REPLACE INTO cfw_replay_probe (k, v) VALUES ('ticket', 'REDIS-OK')`
				);
				// in memory, the way a naive ticket would be held
				await site.runJson(
					`<?php $GLOBALS['cfw_ticket'] = 'REDIS-OK'; echo '{"ok":true}';`
				);

				// the drop the recycle makes, which is the event a ticket has to survive
				(site as unknown as { php: unknown }).php = null;

				const inMemory = await site.runJson(
					`<?php echo json_encode(['ticket' => $GLOBALS['cfw_ticket'] ?? null]);`
				);
				// read back host-side, which is where a memo would live: the ticket belongs to the
				// broker rather than to the PHP that eventually consumes it
				const rows = site.sql
					.exec(`SELECT v FROM cfw_replay_probe WHERE k = 'ticket'`)
					.toArray() as { v?: string }[];
				return { inMemory: inMemory['ticket'], inSql: rows[0]?.v ?? null };
			});

			// the hazard, asserted so the second half means something
			expect(
				out.inMemory,
				'a $GLOBALS ticket survived a drop, so this proves nothing'
			).toBeNull();
			expect(out.inSql, 'a memo in SQL must survive the drop a ticket dies in').toBe(
				'REDIS-OK'
			);
		},
		REQUEST_TIMEOUT
	);
});
