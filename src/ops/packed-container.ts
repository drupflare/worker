/**
 * The pack's compiled container, published beside the SQL chunks so an existing site can take it.
 *
 * A driver-pack update empties `cache_container` (the `container-driver-digest` reconcile step),
 * and the next boot rebuilt it inside a render. Measured 2026-09-25 on a deployed site: the
 * rebuilding fill completed, then the next invocation was reset for the isolate's memory and a
 * waiting visitor got a 1101. When the pack's row was baked against the running driver and for the
 * site's module set, writing it removes the rebuild.
 *
 * No imports, because `scripts/pack-sql.ts` runs under plain node and reads this file directly.
 */

/** where the file sits in the asset tree */
export const PACKED_CONTAINER_PATH = 'drupal-sql/container.json';

/** the side table in `site.sqlite` the bake writes and the chunks leave out */
export const PACKED_CONTAINER_TABLE = 'cfw_packed_container';

export type PackedContainerRow = {
	cid: string;
	/** the serialized container, base64: it carries NULs */
	data: string;
	expire: number;
	created: number;
	serialized: number;
	tags: string;
	checksum: string;
};

export type PackedContainer = {
	/** the driver digest the containers were baked with; see `container-digest.ts` */
	driver: string;
	/**
	 * One container per module set the bake produced: the migrated pack, and the same site once
	 * claimed, since first-run enables `cfw_do_sqlite`. The cid does not carry the module set, so
	 * {@link extensionFingerprint} of `core.extension` is what tells them apart.
	 */
	variants: { modules: string; rows: PackedContainerRow[] }[];
};

/**
 * The enabled-module set as one short value, over the raw `core.extension` config data.
 *
 * FNV-1a over the text; it picks up a changed module list, it does not authenticate one. The site
 * and the packer both call this, so the two cannot disagree about what "the same modules" means.
 */
export function extensionFingerprint(text: string): string {
	if (text === '') return '';
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${text.length}:${h.toString(16)}`;
}

/** the row's bytes back from base64 */
export function base64Bytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** the rows that can replace a site's container, or null when the site has to rebuild its own */
export function packedContainerFor(
	packed: PackedContainer | null,
	driver: string,
	siteModules: string
): PackedContainerRow[] | null {
	if (!packed || packed.driver === '' || packed.driver !== driver || siteModules === '') {
		return null;
	}
	const rows = packed.variants.find((v) => v.modules === siteModules)?.rows ?? [];
	return rows.length > 0 ? rows : null;
}
