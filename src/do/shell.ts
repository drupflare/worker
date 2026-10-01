import { harvestShell, renderFragments } from '../drupal/site-php';
import { indexFragments, purgeShellsForTags } from '../ops/fragment-index';
import {
	assemble,
	fillIdentity,
	type Identity,
	type IdentitySlot,
	normalisedShellsAgree,
	normaliseShell,
	placeholderIds,
	rolesOf,
	shellSafety
} from '../ops/shell-assembly';
import type { SitePhpDurableObject } from '../site-do';
import { firstRow } from '../util/sql';
import { pageTagList } from './helpers';
import type { Row, ShellAssembly } from './types';

async function indexShell(
	site: SitePhpDurableObject,
	path: string,
	recipes: Record<string, unknown>,
	fragmentTags: Record<string, string[]>,
	nowMs: number
): Promise<void> {
	await indexFragments(site.sql, {
		path,
		generation: site.generation(),
		fragments: Object.entries(recipes).map(([id, plan]) => ({
			id,
			plan,
			tags: fragmentTags[id] ?? []
		})),
		nowMs
	});
}

/**
 * Counts stored pages that are shareable shells, with a histogram of why the rest are not.
 *
 * `cfw_page` holds only anonymous GETs, which carry no BigPipe placeholders (BigPipe needs a
 * session), so every row is `unsafe` and `safe` is always 0. `answerable` says so; only
 * `harvestShellFor()` against an authenticated render gives a real verdict.
 */
export function shellCandidates(site: SitePhpDurableObject): {
	safe: number;
	unsafe: number;
	reasons: Record<string, number>;
	/** always false; see the summary */
	answerable: boolean;
	how: string;
} {
	// callers do not all create the tables first
	site.ensureServeTables();
	const rows = site.sql.exec<{ html: string }>('SELECT html FROM cfw_page').toArray();
	let safe = 0;
	let unsafe = 0;
	const reasons: Record<string, number> = {};
	for (const row of rows) {
		const verdict = shellSafety(String(row.html ?? ''));
		if (verdict.safe) {
			safe++;
			continue;
		}
		unsafe++;
		reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
	}
	return {
		safe,
		unsafe,
		reasons,
		answerable: false,
		how: 'cfw_page holds only anonymous renders, which carry no placeholders; POST /shell?path= to harvest one authenticated render and get a real verdict'
	};
}

/**
 * Harvests one path as a shareable shell from two sessions of the same role set.
 *
 * Two normalised renders must be byte-equal; that proves the page, where a marker list only
 * guesses what varies between people. One cookie is rejected.
 *
 * Harvesting empties the `render` bin (that is what creates the holes; see `harvestShell()`), so it
 * is an operator action, never a serving-path one.
 */
export async function harvestShellFor(
	site: SitePhpDurableObject,
	path: string,
	cookies: readonly string[],
	origin: string
): Promise<{ stored: boolean; reason: string; holes?: number; permissionsHash?: string }> {
	if (cookies.length < 2) {
		return { stored: false, reason: 'two sessions of one role set are required, not one' };
	}
	site.ensureServeTables();

	const renders: string[] = [];
	let recipes: Record<string, unknown> = {};
	let shellTags: unknown = [];
	for (const cookie of cookies) {
		const out = await site.runJsonMaybeParked(harvestShell(path, { cookie, origin }));
		if (out['ok'] !== true) {
			return {
				stored: false,
				reason: `harvest failed: ${String(out['error'] ?? 'unknown')}`
			};
		}
		renders.push(String(out['html'] ?? ''));
		recipes = (out['recipes'] ?? {}) as Record<string, unknown>;
		// the shell's own tags (a hole's cacheability stays out of the response)
		shellTags = out['cacheTags'] ?? [];
	}

	const agreement = normalisedShellsAgree(renders[0] as string, renders[1] as string);
	if (!agreement.agree) return { stored: false, reason: agreement.reason };

	const normalised = normaliseShell(renders[0] as string);
	if (!normalised.ok) return { stored: false, reason: normalised.reason };

	// the hash comes from a fragment render (normalising removed it from the shell)
	const probe = await site.runJson(
		renderFragments(path, recipes, { cookie: cookies[0] as string, origin })
	);
	const identity = (probe['identity'] ?? {}) as Identity;
	const fragmentTags = (probe['fragmentTags'] ?? {}) as Record<string, string[]>;
	const permissionsHash = String(identity.permissionsHash ?? '');
	if (permissionsHash === '') {
		return { stored: false, reason: 'no permissions hash, so the shell cannot be keyed' };
	}

	site.sql.exec(
		`INSERT INTO cfw_shell (path, permissions_hash, shell, slots, recipes, harvested_at, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path, permissions_hash) DO UPDATE SET
         shell = excluded.shell,
         slots = excluded.slots,
         recipes = excluded.recipes,
         harvested_at = excluded.harvested_at,
         tags = excluded.tags`,
		path,
		permissionsHash,
		normalised.shell,
		JSON.stringify(normalised.slots),
		JSON.stringify(recipes),
		site.nowMs(),
		pageTagList(shellTags)
	);
	await indexShell(site, path, recipes, fragmentTags, site.nowMs());
	// re-arm the coalesced bump (a site served from shells never fills, so nothing else clears it)
	site.bumpCoalesced = false;
	return {
		stored: true,
		reason: '',
		holes: placeholderIds(normalised.shell).length,
		permissionsHash
	};
}

/**
 * Seeds a shell from one visitor, so assembly restarts after an invalidation without an operator.
 *
 * One sample is enough because nothing is served on it: `assembleFor()` assembles for a uid only
 * after `verifyShellFor()` passes. `bumpGeneration()` purges every shell, hence the need to reseed.
 * The harvest body is Drupal's complete BigPipe stream, so the caller returns it as the page.
 */
export async function seedShellFrom(
	site: SitePhpDurableObject,
	path: string,
	cookie: string,
	origin: string
): Promise<ShellAssembly | undefined> {
	site.ensureServeTables();
	const out = await site.runJsonMaybeParked(harvestShell(path, { cookie, origin }));
	if (out['ok'] !== true) return undefined;

	const body = String(out['html'] ?? '');
	const uid = String(out['uid'] ?? '');
	if (uid === '' || uid === '0') return undefined;

	// same gate as the operator path (no placeholders, or an identity marker outside one)
	const normalised = normaliseShell(body);
	if (!normalised.ok) return undefined;

	const recipes = (out['recipes'] ?? {}) as Record<string, unknown>;
	const shellTags = out['cacheTags'] ?? [];
	const probe = await site.runJsonMaybeParked(renderFragments(path, recipes, { cookie, origin }));
	const identity = (probe['identity'] ?? {}) as Identity;
	const fragmentTags = (probe['fragmentTags'] ?? {}) as Record<string, string[]>;
	const permissionsHash = String(identity.permissionsHash ?? '');
	if (permissionsHash === '') return undefined;

	const at = site.nowMs();
	site.sql.exec(
		`INSERT INTO cfw_shell (path, permissions_hash, shell, slots, recipes, harvested_at, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path, permissions_hash) DO UPDATE SET
         shell = excluded.shell,
         slots = excluded.slots,
         recipes = excluded.recipes,
         harvested_at = excluded.harvested_at,
         tags = excluded.tags`,
		path,
		permissionsHash,
		normalised.shell,
		JSON.stringify(normalised.slots),
		JSON.stringify(recipes),
		at,
		pageTagList(shellTags)
	);
	await indexShell(site, path, recipes, fragmentTags, at);
	// the stored shell is this visitor's own render, so record it verified (saves a second harvest)
	site.sql.exec(
		`INSERT INTO cfw_shell_verified (path, permissions_hash, uid, harvested_at, verified_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path, permissions_hash, uid) DO UPDATE SET
         harvested_at = excluded.harvested_at,
         verified_at = excluded.verified_at`,
		path,
		permissionsHash,
		uid,
		at,
		at
	);
	// re-arm the coalesced bump, or the next content save purges nothing
	site.bumpCoalesced = false;
	return {
		html: body,
		holes: placeholderIds(normalised.shell).length,
		verified: 'proven',
		// from the fragment probe; `harvestShell` does not report roles
		roles: rolesOf(probe)
	};
}

/**
 * Answers one authenticated GET from a stored shell, or undefined to fall through to a render.
 *
 * The fragment render runs first because it yields the permissions hash that selects the shell.
 *
 * A visitor is served an assembly only after it was proven against their own render: the first
 * request per `(path, permissions_hash, uid)` goes through {@link verifyShellFor}. Every failure
 * returns undefined, since the alternative to a correct page is somebody else's page.
 */
export async function assembleFor(
	site: SitePhpDurableObject,
	path: string,
	cookie: string,
	origin: string
): Promise<ShellAssembly | undefined> {
	site.ensureServeTables();
	const candidates = site.sql
		.exec<{
			permissions_hash: string;
			shell: string;
			slots: string;
			recipes: string;
			harvested_at: number;
		}>(
			'SELECT permissions_hash, shell, slots, recipes, harvested_at FROM cfw_shell WHERE path = ?',
			path
		)
		.toArray();
	if (candidates.length === 0) return undefined;

	// any row's recipes will do (a wrong guess costs an unmatched fragment, not a wrong page)
	const probeRecipes = JSON.parse(String(candidates[0]?.recipes ?? '{}')) as Record<
		string,
		unknown
	>;
	const rendered = await site.runJsonMaybeParked(
		renderFragments(path, probeRecipes, { cookie, origin })
	);
	if (rendered['ok'] !== true) return undefined;
	const identity = (rendered['identity'] ?? {}) as Identity;
	const row = candidates.find((c) => c.permissions_hash === identity.permissionsHash);
	if (!row) return undefined;

	const uid = String(identity.uid ?? '');
	if (uid === '') return undefined;
	if (!site.shellVerified(path, row.permissions_hash, uid, row.harvested_at)) {
		return verifyShellFor(site, path, cookie, origin, row);
	}

	let slots: IdentitySlot[];
	try {
		slots = JSON.parse(String(row.slots)) as IdentitySlot[];
	} catch {
		return undefined;
	}
	const filled = fillIdentity(String(row.shell), slots, identity);
	if (!filled.ok) return undefined;

	const fragments = Object.entries((rendered['fragments'] ?? {}) as Record<string, string>).map(
		([id, html]) => ({ id, html })
	);
	const out = assemble(filled.html, fragments);
	// an unfilled hole is a region the visitor would not see
	if (out.unfilled.length > 0) return undefined;
	// roles must be returned: the edge plan is keyed on them and `roleSeen` is keyed by cookie
	return {
		html: out.html,
		holes: out.filled.length,
		verified: 'cached',
		roles: rolesOf(rendered)
	};
}

/**
 * Proves a stored shell against one visitor's own harvest, and answers them from it.
 *
 * It compares harvest to harvest: a harvest empties the render bin, so its holes lack the
 * `#attached` libraries an ordinary render inlines and the asset sets differ by construction.
 * The cost is 40 to 52 rows written, break-even at 4 to 13 requests (`shell-verify-cost.spec.ts`
 * measures it). The harvest body is Drupal's own BigPipe stream and is what the visitor receives.
 */
export async function verifyShellFor(
	site: SitePhpDurableObject,
	path: string,
	cookie: string,
	origin: string,
	row: { permissions_hash: string; shell: string; harvested_at: number }
): Promise<ShellAssembly | undefined> {
	const out = await site.runJsonMaybeParked(harvestShell(path, { cookie, origin }));
	if (out['ok'] !== true) return undefined;
	const body = String(out['html'] ?? '');
	const mine = normaliseShell(body);
	if (!mine.ok) return undefined;

	const uid = String(out['uid'] ?? '');
	if (uid === '' || uid === '0') return undefined;

	if (mine.shell !== String(row.shell)) {
		// the shell carries something this visitor does not render; drop it (it is shared)
		site.sql.exec(
			'DELETE FROM cfw_shell WHERE path = ? AND permissions_hash = ?',
			path,
			row.permissions_hash
		);
		site.sql.exec('DELETE FROM cfw_shell_verified WHERE path = ?', path);
		let at = 0;
		while (at < mine.shell.length && mine.shell[at] === row.shell[at]) at++;
		// durable, so a re-harvest has a record of why the shell went
		site.metaSet(
			'shellRefusal',
			JSON.stringify({
				path,
				uid,
				at,
				mine: mine.shell.slice(at, at + 120),
				stored: String(row.shell).slice(at, at + 120),
				when: site.nowMs()
			})
		);
		return {
			html: body,
			holes: placeholderIds(body).length,
			verified: 'refused',
			roles: rolesOf(out)
		};
	}

	// ponytail: unbounded (paths x role sets x users); add an LRU if the table grows large
	site.sql.exec(
		`INSERT INTO cfw_shell_verified (path, permissions_hash, uid, harvested_at, verified_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path, permissions_hash, uid) DO UPDATE SET
         harvested_at = excluded.harvested_at,
         verified_at = excluded.verified_at`,
		path,
		row.permissions_hash,
		uid,
		row.harvested_at,
		site.nowMs()
	);
	return {
		html: body,
		holes: placeholderIds(body).length,
		verified: 'proven',
		roles: rolesOf(out)
	};
}

/**
 * Drops the shells this invalidation reaches, or all of them when the index could not answer.
 *
 * `wholesale` is the page decision passed through; deciding it again could leave a scoped shell
 * purge standing after a wholesale page purge.
 */
export function purgeShellsFor(
	site: SitePhpDurableObject,
	tags: readonly string[],
	wholesale: boolean
): { dropped: number; kept: number; reasons: string[] } {
	if (!site.hasTable('cfw_shell')) return { dropped: 0, kept: 0, reasons: [] };
	if (!wholesale && tags.length > 0) return purgeShellsForTags(site.sql, tags);
	const dropped = Number(
		firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_shell'))?.c ?? 0
	);
	if (dropped > 0) {
		site.sql.exec('DELETE FROM cfw_shell');
		site.sql.exec('DELETE FROM cfw_shell_verified');
	}
	return {
		dropped,
		kept: 0,
		reasons: wholesale ? ['the tag index could not speak for every stored page'] : []
	};
}
