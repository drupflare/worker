import { type DeploymentKv, recordClaimed } from '../ops/deployment-site';
import {
	ensureFleetTable,
	FLEET_SCHEMA_VERSION,
	type FleetDb,
	type FleetRow,
	reportSite,
	shouldReport
} from '../ops/fleet';
import { isPaid } from '../ops/plan';
import { FIRST_RUN_KEY } from '../ops/setup-page';
import { SHIPPED_CORE_VERSION } from '../ops/shipped-lock';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { DEPLOYMENT_RECORDED_KEY } from './keys';

/**
 * Writes this site's row into the fleet inventory, when there is anything worth writing.
 *
 * Silent when no D1 binding exists (the free-tier default); the predicate holds the steady state
 * to one row per site per day.
 */
export async function reportToFleet(site: SitePhpDurableObject): Promise<void> {
	const db = (site.env as { FLEET_DB?: FleetDb })?.FLEET_DB;
	if (!db) return;
	try {
		const current: FleetRow = {
			// the DO is addressed by idFromName(site), so its own id carries the site name
			site: site.ctx.id.name ?? 'site',
			packGeneration: String(site.packGeneration() ?? ''),
			coreVersion: SHIPPED_CORE_VERSION,
			workerVersion: String(
				(site.env as { CF_VERSION_METADATA?: { id?: string } })?.CF_VERSION_METADATA?.id ??
					'unknown'
			),
			plan: isPaid(site.env) ? 'paid' : 'free',
			lastSeenMs: site.nowMs(),
			// time-to-patch: the pack generation is fixed at provisioning, so it alone cannot tell
			// a patched old site from an unpatched one
			reconcileVersion: site.reconcileState().version,
			schemaVersion: FLEET_SCHEMA_VERSION,
			// the build refused any other value, so the var is what was packed
			cms: String((site.env as { CMS?: string } | undefined)?.CMS ?? 'drupal'),
			// self-hosted is an operator's own workerd (no platform-injected `CF_VERSION_METADATA`)
			tier:
				(site.env as { SELF_HOSTED?: string } | undefined)?.SELF_HOSTED === '1'
					? 'self-hosted'
					: 'managed',
			health: site.fleetHealth()
		};
		const raw = site.metaGet('fleet_last');
		const previous = (raw ? JSON.parse(raw) : undefined) as FleetRow | undefined;
		if (!shouldReport(previous, current, current.lastSeenMs)) return;
		await ensureFleetTable(db);
		await reportSite(db, current);
		site.metaSet('fleet_last', JSON.stringify(current));
	} catch (e) {
		// an inventory write that failed must never take down the alarm that serves the site
		site.lastFleetError = errorMessage(e);
	}
}

/**
 * Lists a claimed site in the deployment document, once, without making it primary.
 *
 * Keeps a site claimed before the document existed as the one its deployment serves. A first claim
 * records itself as primary in `/__firstrun` instead; a replica is never a site of its own.
 */
export function recordInDeployment(site: SitePhpDurableObject): void {
	if (site.deploymentChecked) return;
	// `metaGet()` creates the serve tables and this runs at the head of every fetch: DDL here would
	// make an evicted object stop declining its first fast-lane read, so wait for another creator
	if (!site.serveTablesReady) return;
	site.deploymentChecked = true;
	try {
		if (site.isReplica() || site.metaGet(FIRST_RUN_KEY) === null) return;
		if (site.metaGet(DEPLOYMENT_RECORDED_KEY) !== null) return;
	} catch {
		return;
	}
	const kv = (site.env as { CONFIG_KV?: DeploymentKv }).CONFIG_KV;
	const name = site.ctx.id.name ?? '';
	site.ctx.waitUntil(
		recordClaimed(kv, name, false).then(
			(doc) => {
				if (doc !== undefined) site.metaSet(DEPLOYMENT_RECORDED_KEY, String(site.nowMs()));
			},
			() => {
				// retried by the next incarnation; a KV blip must not fail a request
			}
		)
	);
}
