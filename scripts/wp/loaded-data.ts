/** the row counts of a loaded WordPress database at scale 1 */
export interface Shape {
	posts: number;
	postmeta: number;
	terms: number;
	termRelationships: number;
	termmeta: number;
	comments: number;
	commentmeta: number;
	users: number;
	usermeta: number;
	options: number;
	autoloaded: number;
}

/** the database every plan reading and every seeded statistic is taken from */
export const SHAPE: Shape = {
	posts: 20_000,
	postmeta: 100_000,
	terms: 2_000,
	termRelationships: 38_000,
	termmeta: 300,
	comments: 50_000,
	commentmeta: 25_000,
	users: 5_000,
	usermeta: 65_000,
	options: 3_000,
	autoloaded: 150
};

/** the seed every generated value derives from */
export const SEED = 20_260_101;

/** what a baked database already holds in `wp_options`, so the totals land on the shape */
export interface Existing {
	options: number;
	autoloaded: number;
}

/** rows of one table, as column names and value tuples */
export interface Batch {
	table: string;
	columns: string[];
	rows: (string | number)[][];
}

/** the post mix at scale 1: type, status and count; `post` / `publish` takes the remainder */
export const POST_MIX: readonly (readonly [string, string, number])[] = [
	['post', 'draft', 700],
	['post', 'private', 120],
	['post', 'pending', 60],
	['post', 'future', 40],
	['post', 'trash', 300],
	['post', 'auto-draft', 100],
	['page', 'publish', 350],
	['page', 'draft', 50],
	['attachment', 'inherit', 3_500],
	['revision', 'inherit', 3_200],
	['nav_menu_item', 'publish', 120],
	['event', 'publish', 460]
];

/** the taxonomy mix at scale 1: taxonomy and term count; `post_tag` takes the remainder */
export const TAXONOMY_MIX: readonly (readonly [string, number])[] = [
	['category', 120],
	['nav_menu', 6],
	['post_format', 4],
	['product_cat', 10]
];

/** the keys most posts carry, with the fraction of published posts that have each */
const POST_KEYS: readonly (readonly [string, number])[] = [
	['_edit_last', 0.9],
	['_edit_lock', 0.3],
	['_thumbnail_id', 0.55],
	['seo_title', 0.6],
	['seo_description', 0.6],
	['views', 0.85],
	['rating', 0.4]
];

const BASE = { users: 1_000, terms: 1_000, posts: 1_000, comments: 1_000, options: 10_000 };

/** mulberry32: a 32-bit generator whose sequence is fixed by its seed */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

/** a timestamp `minutes` after 2018-01-01 00:00:00 UTC, in WordPress's format */
function stamp(minutes: number): string {
	const t = new Date(Date.UTC(2018, 0, 1) + minutes * 60_000);
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1, 2)}-${pad(t.getUTCDate(), 2)} ${pad(t.getUTCHours(), 2)}:${pad(t.getUTCMinutes(), 2)}:${pad(t.getUTCSeconds(), 2)}`;
}

const BATCH = 500;

/**
 * Yields the rows of a loaded database in dependency order. The same seed and scale give the same
 * rows on any machine, so a statistic taken from it can be taken again.
 */
export function* generate(
	shape: Shape = SHAPE,
	seed: number = SEED,
	scale = 1,
	existing: Existing = { options: 0, autoloaded: 0 },
	postMix: typeof POST_MIX = POST_MIX
): Generator<Batch> {
	const rand = prng(seed);
	const n = (x: number): number => Math.max(1, Math.round(x * scale));
	const int = (below: number): number => Math.floor(rand() * below);
	const skew = (below: number): number => Math.floor(rand() * rand() * below);
	const batches = function* (
		table: string,
		columns: string[],
		count: number,
		row: (i: number) => (string | number)[]
	): Generator<Batch> {
		for (let from = 0; from < count; from += BATCH) {
			const rows: (string | number)[][] = [];
			for (let i = from; i < Math.min(count, from + BATCH); i++) rows.push(row(i));
			yield { table, columns, rows };
		}
	};

	const users = n(shape.users);
	const authors = Math.max(1, Math.min(users, Math.round(300 * scale) || 1));
	yield* batches(
		'wp_users',
		[
			'ID',
			'user_login',
			'user_pass',
			'user_nicename',
			'user_email',
			'user_registered',
			'display_name'
		],
		users,
		(i) => [
			BASE.users + i,
			`user${pad(i, 5)}`,
			'!',
			`user${pad(i, 5)}`,
			`user${pad(i, 5)}@example.invalid`,
			stamp(i * 700),
			`User ${i}`
		]
	);
	const usermetaKeys = [
		'nickname',
		'first_name',
		'last_name',
		'description',
		'rich_editing',
		'syntax_highlighting',
		'comment_shortcuts',
		'admin_color',
		'use_ssl',
		'show_admin_bar_front',
		'locale',
		'wp_capabilities',
		'wp_user_level'
	];
	const usermeta = n(shape.usermeta);
	yield* batches('wp_usermeta', ['user_id', 'meta_key', 'meta_value'], usermeta, (i) => [
		BASE.users + (i % users),
		usermetaKeys[Math.floor(i / users) % usermetaKeys.length]!,
		`v${i % 97}`
	]);

	const terms = n(shape.terms);
	const fixed = TAXONOMY_MIX.map(([t, c]) => [t, Math.min(n(c), terms)] as const);
	const tagCount = Math.max(1, terms - fixed.reduce((a, [, c]) => a + c, 0));
	const taxonomyOf: string[] = [];
	for (const [t, c] of fixed) for (let i = 0; i < c; i++) taxonomyOf.push(t);
	for (let i = 0; i < tagCount; i++) taxonomyOf.push('post_tag');
	yield* batches('wp_terms', ['term_id', 'name', 'slug'], taxonomyOf.length, (i) => [
		BASE.terms + i,
		`Term ${i}`,
		`term-${i}`
	]);
	yield* batches(
		'wp_term_taxonomy',
		['term_taxonomy_id', 'term_id', 'taxonomy', 'description', 'parent', 'count'],
		taxonomyOf.length,
		(i) => [BASE.terms + i, BASE.terms + i, taxonomyOf[i]!, '', 0, int(40)]
	);
	yield* batches('wp_termmeta', ['term_id', 'meta_key', 'meta_value'], n(shape.termmeta), (i) => [
		BASE.terms + (i % taxonomyOf.length),
		`tmeta_${i % 5}`,
		`v${i % 11}`
	]);
	const categories = taxonomyOf.map((t, i) => (t === 'category' ? i : -1)).filter((i) => i >= 0);
	const tags = taxonomyOf.map((t, i) => (t === 'post_tag' ? i : -1)).filter((i) => i >= 0);

	const total = n(shape.posts);
	const mix = postMix.map(([t, s, c]) => [t, s, Math.min(n(c), total)] as const);
	const typed: { type: string; status: string }[] = [];
	for (const [type, status, c] of mix) for (let i = 0; i < c; i++) typed.push({ type, status });
	while (typed.length < total) typed.push({ type: 'post', status: 'publish' });
	typed.length = total;
	// a stable shuffle so dates and ids do not follow the mix
	for (let i = typed.length - 1; i > 0; i--) {
		const j = int(i + 1);
		[typed[i], typed[j]] = [typed[j]!, typed[i]!];
	}
	const lorem =
		'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
	const published: number[] = [];
	const postRows: (string | number)[][] = [];
	const minutesPerPost = Math.floor((8 * 365 * 24 * 60) / total);
	let lastPublished = BASE.posts;
	typed.forEach(({ type, status }, i) => {
		const id = BASE.posts + i;
		const date = stamp(i * minutesPerPost + int(minutesPerPost));
		let name = `post-${id}`;
		let parent = 0;
		if (status === 'auto-draft' || (status === 'draft' && rand() < 0.6)) name = '';
		if (type === 'revision') {
			parent = lastPublished;
			name = `${parent}-revision-v1`;
		}
		if (type === 'attachment') {
			parent = rand() < 0.7 ? lastPublished : 0;
			name = `image-${id}`;
		}
		if (type === 'nav_menu_item') name = String(id);
		if (type === 'post' && status === 'publish') {
			published.push(id);
			lastPublished = id;
		}
		const author = BASE.users + (rand() < 0.6 ? int(5) : int(authors));
		postRows.push([
			id,
			author,
			date,
			date,
			lorem.repeat(1 + int(3)),
			status === 'auto-draft' ? 'Auto Draft' : `Title ${id}`,
			'',
			status,
			name,
			date,
			date,
			parent,
			`http://wordpress.invalid/?p=${id}`,
			type === 'page' ? int(5) : 0,
			type,
			type === 'attachment' ? 'image/jpeg' : '',
			0,
			'',
			'',
			''
		]);
	});
	const postColumns = [
		'ID',
		'post_author',
		'post_date',
		'post_date_gmt',
		'post_content',
		'post_title',
		'post_excerpt',
		'post_status',
		'post_name',
		'post_modified',
		'post_modified_gmt',
		'post_parent',
		'guid',
		'menu_order',
		'post_type',
		'post_mime_type',
		'comment_count',
		'to_ping',
		'pinged',
		'post_content_filtered'
	];
	for (let from = 0; from < postRows.length; from += BATCH) {
		yield { table: 'wp_posts', columns: postColumns, rows: postRows.slice(from, from + BATCH) };
	}

	const metaTotal = n(shape.postmeta);
	const meta: (string | number)[][] = [];
	const pushMeta = (post: number, key: string, value: string): void => {
		if (meta.length < metaTotal) meta.push([post, key, value]);
	};
	for (const id of published) {
		for (const [key, share] of POST_KEYS) if (rand() < share) pushMeta(id, key, `v${int(50)}`);
	}
	typed.forEach(({ type }, i) => {
		const id = BASE.posts + i;
		if (type === 'attachment') {
			pushMeta(id, '_wp_attached_file', `2020/01/image-${id}.jpg`);
			pushMeta(id, '_wp_attachment_metadata', 'a:0:{}');
			if (rand() < 0.4) pushMeta(id, '_wp_attachment_image_alt', 'alt');
		}
	});
	let hash = 0;
	while (meta.length < metaTotal) {
		const id = published[skew(published.length)] ?? BASE.posts;
		if (rand() < 0.5) {
			hash++;
			pushMeta(id, `_oembed_${pad(hash, 8)}`, '<iframe></iframe>');
			pushMeta(id, `_oembed_time_${pad(hash, 8)}`, '1700000000');
		} else {
			pushMeta(id, `custom_field_${int(40)}`, `v${int(200)}`);
		}
	}
	yield* batches(
		'wp_postmeta',
		['post_id', 'meta_key', 'meta_value'],
		meta.length,
		(i) => meta[i]!
	);

	const relCount = n(shape.termRelationships);
	const seen = new Set<string>();
	const rels: (string | number)[][] = [];
	for (let i = 0; rels.length < relCount && i < relCount * 4; i++) {
		const post = published[i % Math.max(1, published.length)] ?? BASE.posts;
		const pool = i % 4 === 0 ? categories : tags;
		if (pool.length === 0) continue;
		const term = BASE.terms + pool[skew(pool.length)]!;
		const key = `${post}:${term}`;
		if (seen.has(key)) continue;
		seen.add(key);
		rels.push([post, term, 0]);
	}
	yield* batches(
		'wp_term_relationships',
		['object_id', 'term_taxonomy_id', 'term_order'],
		rels.length,
		(i) => rels[i]!
	);

	const comments = n(shape.comments);
	const emails = Math.max(1, Math.round(8_000 * scale));
	yield* batches(
		'wp_comments',
		[
			'comment_ID',
			'comment_post_ID',
			'comment_author',
			'comment_author_email',
			'comment_date',
			'comment_date_gmt',
			'comment_content',
			'comment_approved',
			'comment_type',
			'comment_parent'
		],
		comments,
		(i) => {
			const r = rand();
			const approved = r < 0.82 ? '1' : r < 0.88 ? '0' : r < 0.99 ? 'spam' : 'trash';
			const date = stamp(i * Math.floor((8 * 365 * 24 * 60) / comments));
			const kind = rand() < 0.016 ? 'pingback' : 'comment';
			return [
				BASE.comments + i,
				published[skew(published.length)] ?? BASE.posts,
				`Commenter ${int(emails)}`,
				`c${int(emails)}@example.invalid`,
				date,
				date,
				'A comment.',
				approved,
				kind,
				i > 10 && rand() < 0.2 ? BASE.comments + int(i) : 0
			];
		}
	);
	const commentKeys = ['akismet_result', 'akismet_history', 'akismet_as_submitted'];
	yield* batches(
		'wp_commentmeta',
		['comment_id', 'meta_key', 'meta_value'],
		n(shape.commentmeta),
		(i) => [BASE.comments + (i % comments), commentKeys[i % 3]!, `v${i % 13}`]
	);

	const optionRows = Math.max(0, n(shape.options) - existing.options);
	const autoloadRows = Math.max(0, n(shape.autoloaded) - existing.autoloaded);
	yield* batches(
		'wp_options',
		['option_id', 'option_name', 'option_value', 'autoload'],
		optionRows,
		(i) => [
			BASE.options + i,
			i % 3 === 0 ? `_transient_t${i}` : `opt_${i}`,
			`v${i % 31}`,
			i < autoloadRows ? 'on' : 'off'
		]
	);
}
