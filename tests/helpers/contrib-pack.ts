import { env } from 'cloudflare:test';
import { GENERATED_COLLISIONS } from '../../src/ops/generated/modules';
import { SHIPPING_PACK_CONTRIB } from '../../src/ops/module-table';
import { BLOCKED_MODULES } from './contrib-blocked';
import type { ServeDo } from './serve-do';

export { BLOCKED_MODULES };

export type Payload = Record<string, unknown>;
export const REQUEST_TIMEOUT = 900_000;

export const call = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<Payload>);

export const migrate = (site: ServeDo) => call(site, '/__migrate?all=1&prefill=0');
export const enable = (site: ServeDo, module: string) =>
	call(site, `/__enable?module=${encodeURIComponent(module)}`);

/**
 * The contrib machine names in the index the Durable Object mounts.
 *
 * Read through the real ASSETS binding, so it is the same bytes `mountDrupalLazy()` fetches. As text
 * plus a scan rather than `JSON.parse`, because the fixture index is 1.7 MB and every path in it is
 * a string this only has to match against.
 */
let packedOnce: Promise<Set<string>> | null = null;
export function packedContrib(): Promise<Set<string>> {
	packedOnce ??= (async () => {
		const res = await env.ASSETS.fetch(new URL('https://a.local/drupal-pf/core.pf.json'));
		if (!res.ok) throw new Error(`pack index not reachable: core.pf.json ${res.status}`);
		const found = new Set<string>();
		// BOTH prefixes: composer/installers puts a theme under `themes/contrib`, so scanning
		// modules alone reported every contrib theme as absent from a pack that carries it
		for (const m of (await res.text()).matchAll(/"(?:modules|themes)\/contrib\/([^/"]+)\//g)) {
			found.add(m[1] as string);
		}
		return found;
	})();
	return packedOnce;
}

export const shippingNames = SHIPPING_PACK_CONTRIB.map((n) => n.split('/')[1] as string);

/** a pack carrying anything past the shipping four is a fixture build, and owes every case */
export const isFixturePack = (packed: Set<string>) =>
	[...packed].some((name) => !shippingNames.includes(name));

declare const __DRUPFLARE_CONTRIB_FIXTURE__: boolean;

/** set by `contrib-fixture.ts` for its vitest child, whatever pack ended up mounted */
export const fixtureRun =
	typeof __DRUPFLARE_CONTRIB_FIXTURE__ === 'boolean' ? __DRUPFLARE_CONTRIB_FIXTURE__ : false;

/** a module the pack lacks fails in a fixture run or against a fixture pack, and skips otherwise */
export const mustCarry = (packed: Set<string>, fixture = fixtureRun) =>
	fixture || isFixturePack(packed);

/** short names of modules that install in a phase of `contrib-fixture.ts`, absent from the base pack */
export const PHASE_OWNERS = Object.entries(GENERATED_COLLISIONS)
	.filter(([, c]) => !c.require)
	.map(([name]) => name.replace('drupal/', ''));

/** the modules `contrib-generic.spec.ts` covers; the other spec counts them */
export const GENERATED_MODULES = [
	'gin_toolbar',
	'embed',
	'features',
	'diff',
	'rabbit_hole',
	'entity_embed',
	'schema_metatag',
	'migrate_tools',
	'dropzonejs',
	'link_attributes',
	'config_update',
	'media_library_form_element',
	'entity_clone',
	'migrate_source_csv',
	'layout_builder_restrictions',
	'cas',
	'samlauth',
	'openid_connect'
] as const;
