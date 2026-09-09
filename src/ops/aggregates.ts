/**
 * Replacing a page's asset tags with the aggregates the build already produced.
 *
 * ## Why the substitution happens here and not in Drupal
 *
 * `css.preprocess` ON is worth 3.2 ms a render -- 21 ms to 18, n=40 per arm, bracketed in both
 * orders -- plus 60 `<link>` and 11 `<script>` collapsing to 9 and 2, and about 5,400 bytes off
 * every stored page row. And it cannot be turned on: the source files do not exist in MEMFS, so
 * Drupal's own aggregate route answers 69 bytes and the page it produces has no CSS at all.
 *
 * ## Why the page rather than the library list
 *
 * The obvious input is the render array's `#attached[library]`, and by the time a RESPONSE exists it
 * is gone -- so the host cannot ask which libraries a page used. The page itself names every file,
 * which is the same information from the other side, and it needs no PHP change to read.
 *
 * ## The safety rule, which is the whole design
 *
 * A library is replaced only when EVERY one of its files appears in the page, CONTIGUOUSLY and in
 * declaration order. Anything else leaves that library's tags alone. That is what makes the failure
 * mode "fewer libraries aggregated" rather than "a page missing rules": a partial replacement is
 * exactly the broken-CSS page the last attempt at this shipped, and it looked faster.
 */

/** what `pack-aggregates.ts` writes; only the two fields this reads are named */
export type AggregateIndex = {
	libraries: Record<string, { css?: string; js?: string }>;
	files: Record<string, { css?: string[]; js?: string[] }>;
};

export type Substitution = {
	html: string;
	/** libraries whose tags were replaced */
	replaced: string[];
	/** tags removed, so the saving is reported rather than asserted */
	tagsRemoved: number;
};

/** one asset tag found in the page, with the source path it points at */
type Tag = { start: number; end: number; path: string };

/**
 * Every stylesheet or script tag in document order, with its query stripped.
 *
 * Drupal appends `?v=11.4.5` to every asset URL, so the path has to be compared without it. A tag
 * with no recognisable path is skipped rather than matched loosely -- an inline `<script>` and a CDN
 * `<link>` both belong to nobody and must not break a run.
 */
export function assetTags(html: string, kind: 'css' | 'js'): Tag[] {
	const pattern =
		kind === 'css'
			? /<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi
			: /<script\b[^>]*\bsrc=["'][^"']+["'][^>]*><\/script>/gi;
	const attribute = kind === 'css' ? /\bhref=["']([^"']+)["']/i : /\bsrc=["']([^"']+)["']/i;
	const out: Tag[] = [];
	for (const m of html.matchAll(pattern)) {
		const at = m.index;
		if (at === undefined) continue;
		const href = attribute.exec(m[0])?.[1];
		// `//cdn.example/a.js` starts with a slash and is OFF-SITE; a protocol-relative URL passes a
		// naive `startsWith('/')` and would be matched against a local library path
		if (href === undefined || !href.startsWith('/') || href.startsWith('//')) continue;
		out.push({ start: at, end: at + m[0].length, path: href.split('?')[0] as string });
	}
	return out;
}

/** the tag a replacement emits */
function aggregateTag(name: string, kind: 'css' | 'js', base: string): string {
	const url = `${base}/${name}`;
	return kind === 'css'
		? `<link rel="stylesheet" media="all" href="${url}">`
		: `<script src="${url}"></script>`;
}

/**
 * Finds each library's contiguous run of tags and replaces it with one aggregate tag.
 *
 * Runs are located and then applied from the END of the document backwards, so an earlier
 * replacement cannot move the offsets of a later one. Overlapping runs are refused: two libraries
 * claiming the same tag means the match is not what it looks like.
 */
export function substituteAggregates(
	html: string,
	index: AggregateIndex,
	base = '/agg'
): Substitution {
	const replaced: string[] = [];
	let tagsRemoved = 0;
	let out = html;

	for (const kind of ['css', 'js'] as const) {
		const tags = assetTags(out, kind);
		if (tags.length === 0) continue;
		const at = new Map<string, number[]>();
		tags.forEach((tag, i) => {
			const seen = at.get(tag.path) ?? [];
			seen.push(i);
			at.set(tag.path, seen);
		});

		const runs: Array<{ id: string; from: number; to: number; name: string }> = [];
		const claimed = new Set<number>();
		for (const [id, paths] of Object.entries(index.files)) {
			const wanted = paths[kind];
			const name = index.libraries[id]?.[kind];
			if (wanted === undefined || wanted.length === 0 || name === undefined) continue;
			const first = at.get(wanted[0] as string);
			if (first === undefined) continue;
			// every candidate start, because a file may legitimately appear more than once
			let found: { from: number; to: number } | null = null;
			for (const start of first) {
				let ok = true;
				for (let k = 0; k < wanted.length; k++) {
					if (tags[start + k]?.path !== wanted[k]) {
						ok = false;
						break;
					}
				}
				if (!ok) continue;
				const to = start + wanted.length - 1;
				let free = true;
				for (let k = start; k <= to; k++) if (claimed.has(k)) free = false;
				if (!free) continue;
				found = { from: start, to };
				break;
			}
			if (found === null) continue;
			for (let k = found.from; k <= found.to; k++) claimed.add(k);
			runs.push({ id, from: found.from, to: found.to, name });
		}

		// last first, so no replacement invalidates another's offsets
		runs.sort((a, b) => b.from - a.from);
		for (const run of runs) {
			const from = tags[run.from];
			const to = tags[run.to];
			if (from === undefined || to === undefined) continue;
			out = out.slice(0, from.start) + aggregateTag(run.name, kind, base) + out.slice(to.end);
			tagsRemoved += run.to - run.from + 1;
			replaced.push(`${run.id}:${kind}`);
		}
	}

	return { html: out, replaced, tagsRemoved };
}
