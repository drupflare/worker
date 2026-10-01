/**
 * Capability classification for the stress-chosen module list.
 *
 * Separate from `catalog.ts` (measurement output, not mechanism): `KNOWN_MODULE_CAPABILITIES` there
 * stays the authority for what ships; this is the working set `allKnownCapabilities()` merges in.
 * These are engineering positions: `refused` only where the platform cannot host the module, and a
 * non-empty entry says what would move it up a tier. An absent entry is `unknown`, never
 * `works-today`, so add no entry that has not been looked at.
 * @module
 */

import { type ModuleCapability } from './catalog';
import { GENERATED_TIER_NOTES } from './generated/modules';

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
	 * `needs` only says whether outbound calls can be split across invocations. `simple_sitemap`
	 * forced this: it needs `ext-xmlwriter`, which the coarse vocabulary scored as installable and
	 * `hook_requirements` then refused. `capability-contract.spec.ts` executes every id here on
	 * the shipping interpreter.
	 */
	vectors?: readonly string[];
}

/**
 * The per-module tier declarations, from `config/modules.yml`.
 *
 * A module is added by declaring it in the YAML and running `bun run gen:config`; nothing here
 * needs editing.
 */
export const MODULE_TIER_NOTES: Readonly<Record<string, TierNote>> = GENERATED_TIER_NOTES;

/**
 * The classification set, this table merged over the shipped one.
 *
 * `catalog.ts` keeps its own list because it ships with the artifact. A module classified in both
 * takes the value here, the more recently measured.
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
