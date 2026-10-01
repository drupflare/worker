/**
 * The pack's compiled container, published beside the SQL chunks so an existing site can take it.
 *
 * A driver-pack update empties `cache_container` (the `container-driver-digest` reconcile step) and
 * the next boot rebuilds it inside a render, after which the next invocation was reset for memory
 * (a waiting visitor got a 1101). Writing the pack's row, baked against the running driver and the
 * site's module set, removes the rebuild.
 *
 * No imports, because `scripts/pack-sql.ts` runs under plain node and reads this file directly.
 * @module
 */

/** where the file sits in the asset tree */
export const PACKED_CONTAINER_PATH = 'drupal-sql/container.json';

/** the side table in `site.sqlite` the bake writes and the chunks leave out */
export const PACKED_CONTAINER_TABLE = 'cfw_packed_container';

/** one `cache_container` row as the bake stored it */
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

/** the contents of `container.json`: containers by module set, and the baking driver */
export type PackedContainer = {
	/** the driver digest the containers were baked with; see `container-digest.ts` */
	driver: string;
	/**
	 * One container per module set the bake produced: the migrated pack, and the same site once
	 * claimed (first-run enables `cfw_do_sqlite`). The cid does not carry the module set, so
	 * {@link extensionFingerprint} tells them apart.
	 */
	variants: { modules: string; rows: PackedContainerRow[] }[];
};

/**
 * The enabled-module set as one short value, over the raw `core.extension` config data.
 *
 * FNV-1a over the text: it detects a changed module list, it does not authenticate one. The site
 * and the packer both call this, so they agree on what "the same modules" means.
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

/** the rows that can replace a site's container, or undefined when it must rebuild its own */
export function packedContainerFor(
	packed: PackedContainer | undefined,
	driver: string,
	siteModules: string
): PackedContainerRow[] | undefined {
	if (!packed || packed.driver === '' || packed.driver !== driver || siteModules === '') {
		return undefined;
	}
	const rows = packed.variants.find((v) => v.modules === siteModules)?.rows ?? [];
	return rows.length > 0 ? rows : undefined;
}
