import { decode, encode } from '@drupflare/durabledb/codec';
import {
	SiteDurableObject,
	toPositional,
	type SqlBindings,
	type TxnRequest
} from '@drupflare/durabledb/do-sqlite';

export { SiteDurableObject };

/**
 * Drives the Durable Object against REAL ctx.storage.sql -- no Map, no stub.
 *
 * The claims under test, in order of how much they matter:
 *   1. writes survive the instance being destroyed (the actual blocker)
 *   2. integers above 2^31 survive the 32-bit PHP boundary
 *   3. a failed transaction leaves no partial rows (the torn-write case)
 *   4. NOCASE works for ASCII, and the exact extent of the non-ASCII gap
 */

/** the one binding wrangler.do.jsonc declares */
interface DoTestEnv {
	SITE: DurableObjectNamespace;
}

/**
 * A decoded reply from one of the object's `__` routes.
 *
 * `any` values, for the reason `src/site-do.ts` gives its own `Payload`: the shape depends on
 * which route answered, and `unknown` would turn every read in this file into a cast.
 */
type Payload = Record<string, any>;

const stub = (env: DoTestEnv) => env.SITE.get(env.SITE.idFromName('persistence-test'));

async function sql(env: DoTestEnv, text: string, params: SqlBindings = []): Promise<Payload> {
	const res = await stub(env).fetch('https://do/__sql', {
		method: 'POST',
		body: JSON.stringify({ sql: text, params })
	});
	return decode(await res.json()) as Payload;
}

export default {
	async fetch(request: Request, env: DoTestEnv): Promise<Response> {
		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case '/do-suite': {
					const out: Payload = {};

					// ---- 1. schema + writes ----
					await sql(env, 'DROP TABLE IF EXISTS node');
					await sql(
						env,
						'CREATE TABLE node (nid INTEGER PRIMARY KEY, title TEXT COLLATE NOCASE, created INTEGER)'
					);
					const ins = await sql(
						env,
						'INSERT INTO node (nid, title, created) VALUES (:nid, :title, :created)',
						{ ':nid': 1, ':title': 'Hello World', ':created': 1780000000000 }
					);
					out.insert = { ok: ins.ok, changes: ins.changes };

					const read = await sql(
						env,
						'SELECT nid, title, created FROM node WHERE nid = :nid',
						{
							':nid': 1
						}
					);
					out.read = read.rows?.[0];

					// ---- 2. the 32-bit boundary, through the codec ----
					// 1780000000000 is a real Date.now() magnitude and wraps to
					// -397708726 without the codec. Assert the VALUE, not just presence.
					const created = read.rows?.[0]?.created;
					out.bigIntegerSurvived =
						Number(created) === 1780000000000 || String(created) === '1780000000000';
					out.bigIntegerGot = String(created);

					// ---- 3. torn write / interrupted checkpoint ----
					// A transaction that fails partway must leave nothing behind. This is
					// the case that eats a site: a clean WAL round trip proves the happy
					// path, an aborted one proves durability.
					await sql(env, 'BEGIN');
					await sql(
						env,
						"INSERT INTO node (nid, title, created) VALUES (900, 'doomed', 1)"
					);
					const midCount = await sql(env, 'SELECT COUNT(*) AS c FROM node');
					await sql(env, 'ROLLBACK');
					const afterRollback = await sql(env, 'SELECT COUNT(*) AS c FROM node');
					out.transaction = {
						duringTxn: Number(midCount.rows?.[0]?.c),
						afterRollback: Number(afterRollback.rows?.[0]?.c),
						rolledBackCleanly: Number(afterRollback.rows?.[0]?.c) === 1
					};

					// a constraint violation must also leave nothing
					const dup = await sql(
						env,
						"INSERT INTO node (nid, title, created) VALUES (1, 'dup', 1)"
					);
					const afterDup = await sql(env, 'SELECT COUNT(*) AS c FROM node');
					out.constraintViolation = {
						rejected: dup.ok === false,
						error: String(dup.error ?? '').slice(0, 80),
						rowsUnchanged: Number(afterDup.rows?.[0]?.c) === 1
					};

					// ---- 4. NOCASE, and the exact non-ASCII gap ----
					// Drupal registers a NOCASE_UTF8 collation through
					// PDO::sqliteCreateCollation. ctx.storage.sql has no user-defined
					// collations at all, so it must be substituted with builtin NOCASE,
					// which folds ASCII only. Measure the gap rather than asserting it.
					await sql(
						env,
						"INSERT INTO node (nid, title, created) VALUES (2, 'STRASSE', 1)"
					);
					await sql(
						env,
						"INSERT INTO node (nid, title, created) VALUES (3, 'Ünicode', 1)"
					);
					const ascii = await sql(
						env,
						"SELECT nid FROM node WHERE title = 'hello world'"
					);
					const nonAscii = await sql(env, "SELECT nid FROM node WHERE title = 'ünicode'");
					out.nocase = {
						asciiFoldsCaseInsensitively: (ascii.rows?.length ?? 0) === 1,
						nonAsciiFolds: (nonAscii.rows?.length ?? 0) === 1,
						caveat: 'builtin NOCASE folds A-Z only; non-ASCII comparisons are case-SENSITIVE. Ships as a documented limitation.'
					};

					// ---- 5. user-defined collation genuinely unavailable ----
					const udc = await sql(env, 'CREATE TABLE probe (x TEXT COLLATE NOCASE_UTF8)');
					out.nocaseUtf8Available = udc.ok === true;
					out.nocaseUtf8Error = String(udc.error ?? '').slice(0, 90);

					const stats = await (
						await stub(env).fetch('https://do/__stats')
					).json<Payload>();
					out.stats = stats;
					return Response.json(out);
				}

				// Destroys the in-memory instance. A subsequent request constructs a new
				// one, which can only see data that was genuinely persisted.
				case '/do-kill': {
					try {
						await stub(env).fetch('https://do/__stats');
						const id = env.SITE.idFromName('persistence-test');
						const s = env.SITE.get(id);
						// abort() rejects in-flight work and discards the instance
						await s.fetch('https://do/__abort').catch(() => {});
					} catch {
						/* expected */
					}
					return Response.json({ killed: true });
				}

				// THE claim: read after the instance is gone.
				case '/do-persist': {
					const rows = await sql(
						env,
						'SELECT nid, title, created FROM node ORDER BY nid'
					);
					const stats = await (
						await stub(env).fetch('https://do/__stats')
					).json<Payload>();
					return Response.json({
						rowsFound: rows.rows?.length ?? 0,
						rows: rows.rows,
						bigIntegerStillCorrect: String(rows.rows?.[0]?.created) === '1780000000000',
						// a fresh instance starts its own counter, so a low count here is
						// evidence the instance really was rebuilt
						queryCountOnThisInstance: stats.queryCount,
						databaseSize: stats.databaseSize
					});
				}

				case '/do-txnreplay': {
					const call = async (body: TxnRequest) =>
						(
							await stub(env).fetch('https://do/__txnreplay', {
								method: 'POST',
								body: JSON.stringify(encode(body))
							})
						).json();
					const count = async () =>
						Number((await sql(env, 'SELECT COUNT(*) AS c FROM node')).rows?.[0]?.c);

					const before = await count();

					// committed replay
					const committed = decode(
						await call({
							statements: [
								{
									sql: 'INSERT INTO node (title, created) VALUES (:t, 1)',
									params: { ':t': 'replay-a' }
								},
								{
									sql: 'INSERT INTO node (title, created) VALUES (:t, 1)',
									params: { ':t': 'replay-b' }
								}
							],
							commit: true
						})
					) as Payload;
					const afterCommit = await count();

					// speculative replay: must see its own write, then leave nothing behind
					const speculative = decode(
						await call({
							statements: [
								{
									sql: 'INSERT INTO node (title, created) VALUES (:t, 1)',
									params: { ':t': 'ghost' }
								}
							],
							commit: false,
							read: {
								sql: 'SELECT title FROM node WHERE title = :t',
								params: { ':t': 'ghost' }
							}
						})
					) as Payload;
					const afterSpeculative = await count();

					// a failing replay must commit nothing
					const failed = decode(
						await call({
							statements: [
								{ sql: "INSERT INTO node (title, created) VALUES ('good', 1)" },
								{
									sql: "INSERT INTO node (nid, title, created) VALUES (1, 'dup-pk', 1)"
								}
							],
							commit: true
						})
					) as Payload;
					const afterFailure = await count();

					return Response.json({
						committed: {
							ok: committed.ok,
							statements: committed.results?.length,
							lastInsertRowid: String(committed.results?.[1]?.lastInsertRowid),
							rowsAdded: afterCommit - before,
							correct: committed.ok === true && afterCommit - before === 2
						},
						speculative: {
							ok: speculative.ok,
							sawOwnWrite: speculative.readResult?.rows?.[0]?.title === 'ghost',
							leftNothing: afterSpeculative === afterCommit,
							correct:
								speculative.readResult?.rows?.[0]?.title === 'ghost' &&
								afterSpeculative === afterCommit
						},
						failedReplay: {
							rejected: failed.ok === false,
							error: String(failed.error ?? '').slice(0, 70),
							partialWriteLeftBehind: afterFailure !== afterCommit,
							correct: failed.ok === false && afterFailure === afterCommit
						}
					});
				}

				case '/do-keepwarm': {
					// called twice: the second must report an alarm already pending, or the
					// DO would re-arm on every request and the alarm would be meaningless
					const first = await (
						await stub(env).fetch('https://do/__keepwarm')
					).json<Payload>();
					const second = await (
						await stub(env).fetch('https://do/__keepwarm')
					).json<Payload>();
					return Response.json({
						first,
						second,
						idempotent: first.scheduled === true && second.scheduled === false
					});
				}

				case '/do-txn': {
					const out: Payload = {};
					for (const mode of ['sql', 'transactionSync', 'transactionSyncCommit']) {
						const r = await stub(env).fetch('https://do/__txn', {
							method: 'POST',
							body: JSON.stringify({ mode })
						});
						out[mode] = await r.json();
					}
					return Response.json(out);
				}

				case '/do-placeholders': {
					// same rewriter the driver uses, exercised against real SQLite rather
					// than only in the unit test
					const cases: [string, SqlBindings][] = [
						['SELECT :a AS v', { ':a': 42 }],
						["SELECT 'a:b' AS v WHERE :x = 1", { ':x': 1 }],
						['SELECT :big AS v', { ':big': 4294967296 }]
					];
					const results = [];
					for (const [text, params] of cases) {
						const r = await sql(env, text, params);
						results.push({
							sql: text,
							rewritten: toPositional(text, params).text,
							value: String(r.rows?.[0]?.v ?? r.error)
						});
					}
					return Response.json({ results });
				}

				default:
					return new Response(
						'routes: /do-suite /do-kill /do-persist /do-placeholders\n'
					);
			}
		} catch (e: any) {
			return Response.json({ error: String(e?.stack ?? e) }, { status: 500 });
		}
	}
};
