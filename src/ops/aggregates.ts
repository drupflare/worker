/**
 * Replaces a page's asset tags with the aggregates the build already produced.
 *
 * This runs on the rendered page, not in Drupal: `css.preprocess` cannot be turned on because the
 * source files are not in MEMFS (Drupal's aggregate route answers 69 bytes and the page has no
 * CSS). A library is replaced only when every one of its files appears in the page, contiguously
 * and in declaration order; anything else keeps its tags, so a miss means fewer aggregates rather
 * than missing rules.
 * @module
 */

/** what `pack-aggregates.ts` writes; only the two fields this reads are named */
export type AggregateIndex = {
	libraries: Record<string, { css?: string; js?: string }>;
	files: Record<string, { css?: string[]; js?: string[] }>;
};

/** the rewritten page and what changed */
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
 * Drupal appends `?v=11.4.5` to every asset URL, so paths are compared without it. A tag with no
 * local path (inline `<script>`, CDN `<link>`) is skipped so it cannot break a run.
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
		// a protocol-relative `//cdn.example/a.js` is off-site but passes `startsWith('/')`
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
 * Runs are applied from the end of the document backwards so offsets stay valid. Overlapping runs
 * are refused: two libraries claiming one tag means the match is wrong.
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
			let found: { from: number; to: number } | undefined;
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
			if (found === undefined) continue;
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
