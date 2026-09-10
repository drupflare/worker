import { type ModuleCapability } from './catalog.js';
import { GENERATED_TIER_NOTES } from './generated/modules.js';

/**
 * Capability classification for the stress-chosen module list.
 *
 * A SEPARATE FILE from `catalog.ts` so the table can grow without touching the classifier, and
 * because this is measurement output rather than mechanism. `KNOWN_MODULE_CAPABILITIES` there stays
 * the authority for what ships; this is the working set, merged into it by `allKnownCapabilities()`.
 *
 * **THESE ARE ENGINEERING POSITIONS, NOT VERDICTS.** A module is `refused` only where the platform
 * cannot host it after asking what a rewrite would take. Every non-empty entry carries
 * what it would take to move up a tier, because "blocked" without a route out is just a shrug.
 *
 * **An absent entry is `unknown`, never `works-today`.** `tierFor()` enforces that; this file must
 * never gain an entry that has not actually been looked at.
 */

/** what a classification cost to reach, so a later reader can retest it rather than trust it */
export interface TierNote {
	needs: readonly ModuleCapability[];
	/** the mechanism, not the module: why this capability and not another */
	why: string;
	/** what would move it up a tier, and roughly how big that is */
	lift?: string;
	/**
	 * Capability-contract vector ids this module needs, beyond the three coarse ones.
	 *
	 * `needs` answers one question well -- can the module's outbound calls be split across
	 * invocations -- and cannot express anything else. `simple_sitemap` is the case that forced
	 * this: it refuses to install without `ext-xmlwriter`, which is neither outbound nor cron, so
	 * the coarse vocabulary scored it as installable and the install then failed on its own
	 * `hook_requirements`. Every id here is EXECUTED against the shipping interpreter by
	 * `capability-contract.spec.ts`, so a refusal on this list rests on a measurement.
	 */
	vectors?: readonly string[];
}

/**
 * The per-module tier declarations, from `config/modules.yml`.
 *
 * Hand-maintained here until 2026-09-09. A module is added by declaring it in the YAML and running
 * `bun run gen:config`; nothing in this file needs editing for a new module.
 */
export const MODULE_TIER_NOTES: Readonly<Record<string, TierNote>> = GENERATED_TIER_NOTES;

/**
 * The classification set, this table merged over the shipped one.
 *
 * `catalog.ts` keeps its own list because it ships with the artifact; this one is the working set
 * from the compatibility pass. Merging rather than replacing means a module classified in both
 * places takes the value here, which is the more recently measured of the two.
 */
export function allKnownCapabilities(
	shipped: Readonly<Record<string, readonly ModuleCapability[]>>
): Record<string, readonly ModuleCapability[]> {
	const merged: Record<string, readonly ModuleCapability[]> = { ...shipped };
	for (const [name, note] of Object.entries(MODULE_TIER_NOTES)) merged[name] = note.needs;
	return merged;
}

/** the composer names this pass covered, for a report that can say what it did not cover */
export const CLASSIFIED_MODULES = Object.keys(MODULE_TIER_NOTES);
