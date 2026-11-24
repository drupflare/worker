import { describe, expect, it } from 'vitest';
import { planBootImage } from '../../src/do/boot/image';
import { BOOT_KERNEL, saveNode } from '../../src/drupal/php/site';
import { ensureHashSalt } from '../../src/ops/site/secrets';
import { phpScript } from '../../src/util/php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The shared boot image against a real pack: one object bakes, others boot from what it captured.
 *
 * Four things have to hold for it to ship. A restored site renders what a plain boot renders. The
 * heap it was handed carries nothing of the bake's secrets, because the bake's heap is published.
 * A site that differs from the bake in any way boots plain. A file that arrives wrong costs one
 * plain boot and never a wrong page.
 */

const TIMEOUT = 1_800_000;
const OWNER = { 'x-cfw-owner': 'test' };

type Captured = {
	variant: 'pack' | 'claimed';
	index: Record<string, any>;
	files: Map<string, Uint8Array>;
	/** the session id the bake's interpreter held, which the heap carries */
	sid?: string;
};

/** pages a stock site stores: the bake renders the first two, so the rest meet a restored heap cold */
const PATHS = ['/', '/user/login', '/user/register', '/filter/tips', '/node'] as const;

const call = (site: ServeDo, path: string) => site.fetch(new Request(`https://do.local${path}`));

async function migrated(stub: DurableObjectStub, env: Record<string, unknown> = {}) {
	await inObject(stub, (site) => {
		site.env = { ...site.env, ...env };
	});
	await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
	await inObject(stub, (site) => {
		site.php = undefined;
	});
}

/** bakes one object and reads every file back through the route a rig uses */
async function bake(): Promise<Captured> {
	const stub = freshSite();
	await migrated(stub, { BOOT_IMAGE_BAKE: '1' });
	const res = await stub.fetch('https://do.local/__heap?op=bootimage', { headers: OWNER });
	const body = (await res.json()) as { index: Record<string, any>; error?: string };
	expect(res.status, JSON.stringify(body)).toBe(200);
	const files = new Map<string, Uint8Array>();
	for (const chunk of body.index.chunks as { file: string }[]) {
		const part = await stub.fetch(`https://do.local/__heap?op=bootimage&file=${chunk.file}`, {
			headers: OWNER
		});
		files.set(chunk.file, new Uint8Array(await part.arrayBuffer()));
	}
	// what the published heap says about a session, read from the interpreter it was taken from
	const session = await php(stub, 'echo json_encode(["sid" => session_id()]);');
	return { variant: 'pack', index: body.index, files, sid: String(session.sid) };
}

let baked: Promise<Captured> | undefined;
const image = () => (baked ??= bake());

/** serves the image beside the real asset binding, which the pack chunks still come from */
function withImage(
	site: ServeDo,
	published: Captured | Captured[],
	tamper?: (file: string, b: Uint8Array) => Uint8Array
) {
	const images = Array.isArray(published) ? published : [published];
	const real = site.env.ASSETS as {
		fetch: (r: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	};
	site.env = {
		...site.env,
		BOOT_IMAGE: '1',
		ASSETS: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				const path = new URL(url).pathname;
				for (const captured of images) {
					const dir = `/bootimage/${captured.variant}/`;
					if (path === `${dir}index.json`) return Response.json(captured.index);
					const bytes = path.startsWith(dir)
						? captured.files.get(path.slice(dir.length))
						: undefined;
					if (bytes)
						return new Response(tamper ? tamper(path.slice(dir.length), bytes) : bytes);
				}
				// an image the spec did not publish is absent, whatever a local bake left in the assets
				if (path.startsWith('/bootimage/')) return new Response(null, { status: 404 });
				return real.fetch(input, init);
			}
		}
	};
}

async function render(stub: DurableObjectStub, path = '/') {
	return inObject(stub, async (site) => {
		const before = Number((site as any).queryCount ?? 0);
		const outcome = await site.fillOne(path);
		const queries = Number((site as any).queryCount ?? 0) - before;
		const row = site.sql.exec('SELECT html FROM cfw_page WHERE path = ?', path).toArray()[0] as
			{ html?: string } | undefined;
		return {
			outcome,
			queries,
			html: String(row?.html ?? ''),
			origin: String((site as any).canonicalOrigin()),
			bootImage: (site as any).bootImage as Record<string, any> | undefined
		};
	});
}

/** what two renders of one site may legitimately differ in: its own address and per-render ids */
function normalized(html: string, origin: string): string {
	const host = new URL(origin).host;
	return html
		.split(origin)
		.join('ORIGIN')
		.split(host)
		.join('HOST')
		.replace(/views-dom-id:[0-9a-f]+/g, 'views-dom-id:X')
		.replace(/js-view-dom-id-[0-9a-f]+/g, 'js-view-dom-id-X')
		.replace(/"permissionsHash":"[0-9a-f]+"/g, '"permissionsHash":"X"')
		.replace(/form_build_id" value="[^"]+"/g, 'form_build_id" value="X"')
		.replace(/data-drupal-selector="form-[^"]+"/g, 'data-drupal-selector="form-X"')
		.replace(/name="form_token" value="[^"]+"/g, 'name="form_token" value="X"')
		.replace(/"csrf_token":"[^"]*"/g, '"csrf_token":"X"')
		.replace(/(drupalSettings[^<]*"ajaxPageState"[^}]*})/g, 'AJAXSTATE')
		.replace(/\s+/g, ' ');
}

const php = (stub: DurableObjectStub, code: string) =>
	inObject(stub, (site) => site.runJson(phpScript(code)));

/** an image baked on a claimed site, which carries no config digest and refreshes config state */
async function bakeClaimed(): Promise<Captured> {
	const stub = freshSite();
	await migrated(stub, { BOOT_IMAGE_BAKE: '1', RECONCILE: '0' });
	await claim(stub, 'Baked Site');
	const res = await stub.fetch('https://do.local/__heap?op=bootimage&scope=reset', {
		headers: OWNER
	});
	const body = (await res.json()) as { index: Record<string, any> };
	expect(res.status, JSON.stringify(body)).toBe(200);
	const files = new Map<string, Uint8Array>();
	for (const chunk of body.index.chunks as { file: string }[]) {
		const part = await stub.fetch(`https://do.local/__heap?op=bootimage&file=${chunk.file}`, {
			headers: OWNER
		});
		files.set(chunk.file, new Uint8Array(await part.arrayBuffer()));
	}
	return { variant: 'claimed', index: body.index, files };
}

let bakedClaimed: Promise<Captured> | undefined;
const claimedImage = () => (bakedClaimed ??= bakeClaimed());

async function claim(stub: DurableObjectStub, siteName: string) {
	const res = await stub.fetch('https://do.local/__firstrun', {
		method: 'POST',
		body: JSON.stringify({ siteName }),
		headers: { 'content-type': 'application/json' }
	});
	expect(((await res.json()) as { ok: boolean }).ok, 'the claim has to succeed').toBe(true);
	await inObject(stub, (site) => {
		site.php = undefined;
	});
}

/** edits a site the way an editor would, through Drupal's own writers so invalidation runs */
const EDITS: Record<string, { config: boolean; code: string }> = {
	'the site name': {
		config: true,
		code: "Drupal::configFactory()->getEditable('system.site')->set('name', 'Renamed Site')->save();"
	},
	'the theme colour': {
		config: true,
		code: "Drupal::configFactory()->getEditable('olivero.settings')->set('base_primary_color', '#d4410c')->save();"
	},
	'a block': {
		config: true,
		code: "\\Drupal\\block\\Entity\\Block::load('olivero_powered')->disable()->save();"
	},
	'the maintenance switch': {
		config: false,
		code: "Drupal::state()->set('system.maintenance_mode', 1);"
	},
	'a main menu link': {
		config: false,
		code: "\\Drupal\\menu_link_content\\Entity\\MenuLinkContent::create(['title' => 'Edited link', 'link' => ['uri' => 'internal:/user/login'], 'menu_name' => 'main'])->save();"
	}
};

/** a session for the boot request, which hooks that touch a temp store need when run from a script */
const SESSION =
	"$stack = Drupal::service('request_stack'); if (!$stack->getCurrentRequest()) { $stack->push(Symfony\\Component\\HttpFoundation\\Request::create('/')); } " +
	'$stack->getCurrentRequest()->setSession(new Symfony\\Component\\HttpFoundation\\Session\\Session(new Symfony\\Component\\HttpFoundation\\Session\\Storage\\MockArraySessionStorage()));';

const ARTICLE =
	"Drupal\\node\\Entity\\NodeType::create(['type' => 'article', 'name' => 'Article'])->save();";

/** edits to the entities and permissions a restored heap holds definitions of, with the page that shows each */
const ENTITY_EDITS: Record<string, { config: boolean; code: string; path: string }> = {
	'a field on a new content type': {
		config: true,
		path: '/field-node',
		code:
			SESSION +
			ARTICLE +
			"Drupal\\field\\Entity\\FieldStorageConfig::create(['field_name' => 'field_note', 'entity_type' => 'node', 'type' => 'string'])->save();" +
			"Drupal\\field\\Entity\\FieldConfig::create(['field_name' => 'field_note', 'entity_type' => 'node', 'bundle' => 'article', 'label' => 'Note'])->save();" +
			"Drupal::service('entity_display.repository')->getViewDisplay('node', 'article')->setComponent('field_note', ['type' => 'string'])->save();" +
			"Drupal\\node\\Entity\\Node::create(['type' => 'article', 'title' => 'With a field', 'uid' => 1, 'status' => 1, 'field_note' => 'note kept by the field'])->save();" +
			"Drupal\\path_alias\\Entity\\PathAlias::create(['path' => '/node/1', 'alias' => '/field-node'])->save();"
	},
	'a permission for anonymous visitors': {
		config: true,
		path: '/permission-node',
		code:
			SESSION +
			ARTICLE +
			"user_role_grant_permissions('anonymous', ['access user profiles']);" +
			"Drupal\\node\\Entity\\Node::create(['type' => 'article', 'title' => 'With an author link', 'uid' => 1, 'status' => 1])->save();" +
			"Drupal\\path_alias\\Entity\\PathAlias::create(['path' => '/node/1', 'alias' => '/permission-node'])->save();"
	}
};

type Arm = { stub: DurableObjectStub; pages: Record<string, Awaited<ReturnType<typeof render>>> };

/** one site, claimed or not, edited, then rendered on a plain boot or from an image */
async function arm(opts: {
	claimed?: string;
	edit?: string;
	image?: Captured;
	saveNode?: boolean;
	paths?: string[];
}): Promise<Arm> {
	const stub = freshSite();
	await migrated(stub, { RECONCILE: '0' });
	if (opts.claimed) await claim(stub, opts.claimed);
	await inObject(stub, (site) => site.runJson(BOOT_KERNEL));
	// a page cached before the edit is what a stale checksum memo would wrongly keep valid
	if (opts.edit || opts.saveNode) await inObject(stub, (site) => site.fillOne('/'));
	const edit = opts.edit ? { ...EDITS, ...ENTITY_EDITS }[opts.edit] : undefined;
	if (edit) await php(stub, edit.code + "\necho json_encode(['ok' => true]);");
	if (opts.saveNode)
		await inObject(stub, (site) =>
			site.runJson(saveNode({ title: 'Edited front', body: 'hello' }))
		);
	await inObject(stub, (site) => {
		site.php = undefined;
		if (opts.image) withImage(site, opts.image);
	});
	const pages: Arm['pages'] = {};
	for (const path of opts.paths ?? ['/', '/user/login']) pages[path] = await render(stub, path);
	return { stub, pages };
}

/** the first byte two renders disagree at, with both sides around it, or an empty string */
function firstDifference(a: { html: string; origin: string }, b: { html: string; origin: string }) {
	const x = normalized(a.html, a.origin);
	const y = normalized(b.html, b.origin);
	let at = 0;
	while (at < x.length && x[at] === y[at]) at++;
	return x === y
		? ''
		: `at ${at}: ${x.slice(at - 80, at + 120)} || ${y.slice(at - 80, at + 120)}`;
}

describe('a site that was edited after the bake', () => {
	for (const [name, edit] of Object.entries(EDITS)) {
		it(
			`${edit.config ? 'refreshes' : 'keeps'} what ${name} changed, from an image or a plain boot alike`,
			async () => {
				const claimedAs = `Claimed ${name}`;
				const captured = await claimedImage();
				const plain = await arm({ claimed: claimedAs, edit: name });
				const restored = await arm({ claimed: claimedAs, edit: name, image: captured });
				for (const path of ['/', '/user/login']) {
					const image = restored.pages[path]!.bootImage;
					expect(image?.used, `${path} ${JSON.stringify(image)}`).toBe(true);
					expect(String(image?.reason)).toContain('config reset');
					expect(firstDifference(restored.pages[path]!, plain.pages[path]!), path).toBe(
						''
					);
				}
			},
			TIMEOUT
		);
	}

	it(
		'serves a node saved after the bake, which a stale checksum memo would hide',
		async () => {
			const captured = await claimedImage();
			const plain = await arm({ claimed: 'Claimed node', saveNode: true });
			const restored = await arm({
				claimed: 'Claimed node',
				saveNode: true,
				image: captured
			});
			expect(restored.pages['/']!.bootImage?.used).toBe(true);
			expect(plain.pages['/']!.html).toContain('Edited front');
			expect(firstDifference(restored.pages['/']!, plain.pages['/']!)).toBe('');
		},
		TIMEOUT
	);

	for (const [name, edit] of Object.entries(EDITS).filter(([, e]) => !e.config)) {
		it(
			`boots an UNCLAIMED site from the strict image after ${name}, and renders the same page`,
			async () => {
				const captured = await image();
				const plain = await arm({ edit: name });
				const restored = await arm({ edit: name, image: captured });
				for (const path of ['/', '/user/login']) {
					expect(restored.pages[path]!.bootImage, path).toMatchObject({
						used: true,
						reason: 'pack image, context equal'
					});
					expect(firstDifference(restored.pages[path]!, plain.pages[path]!), path).toBe(
						''
					);
				}
				void edit;
			},
			TIMEOUT
		);
	}
});

describe('a claimed site whose entities changed after the bake', () => {
	for (const [name, edit] of Object.entries(ENTITY_EDITS)) {
		it(
			`renders what ${name} added, from an image or a plain boot alike`,
			async () => {
				const captured = await claimedImage();
				const paths = [edit.path];
				const plain = await arm({ claimed: `Claimed ${name}`, edit: name, paths });
				const restored = await arm({
					claimed: `Claimed ${name}`,
					edit: name,
					image: captured,
					paths
				});
				expect(restored.pages[edit.path]!.bootImage?.used).toBe(true);
				expect(plain.pages[edit.path]!.html).toContain(
					name === 'a field on a new content type'
						? 'note kept by the field'
						: 'href="/user/1"'
				);
				expect(firstDifference(restored.pages[edit.path]!, plain.pages[edit.path]!)).toBe(
					''
				);
			},
			TIMEOUT
		);
	}

	it(
		'hands a later config save to the objects services loaded before the restore',
		async () => {
			const captured = await claimedImage();
			const stub = freshSite();
			await migrated(stub, { RECONCILE: '0' });
			await claim(stub, 'Claimed holders');
			await inObject(stub, (site) => site.runJson(BOOT_KERNEL));
			await php(
				stub,
				"Drupal::configFactory()->getEditable('system.performance')->set('cache.page.max_age', 3600)->save();\necho json_encode(['ok' => true]);"
			);
			await inObject(stub, (site) => {
				site.php = undefined;
				withImage(site, captured);
			});
			const held = `$sub = Drupal::service('finish_response_subscriber');
				$config = (new ReflectionProperty($sub, 'config'))->getValue($sub);
				echo json_encode(['held' => $config->get('cache.page.max_age'), 'shared' => $config === Drupal::config('system.performance')]);`;
			const before = await php(stub, held);
			expect(before).toMatchObject({ held: 3600, shared: true });
			await php(
				stub,
				"Drupal::configFactory()->getEditable('system.performance')->set('cache.page.max_age', 7200)->save();\necho json_encode(['ok' => true]);"
			);
			expect(await php(stub, held)).toMatchObject({ held: 7200, shared: true });
		},
		TIMEOUT
	);
});

describe('the boot images this tree publishes', () => {
	it(
		'are the ones a freshly migrated site and a freshly claimed one boot from',
		async () => {
			// a published image keyed to anything else boots every site plain and nothing reports it,
			// which is what a heap generation that gained the interpreter's identity did to the last bake
			const stub = freshSite();
			await migrated(stub, { RECONCILE: '0', BOOT_IMAGE: '1' });
			const pack = await inObject(stub, (site) => planBootImage(site as any));
			expect(pack.reason, 'rerun `bun run assets:bootimage`').toBe(
				'pack image, context equal'
			);
			await claim(stub, 'Some Site');
			const claimed = await inObject(stub, (site) => planBootImage(site as any));
			expect(claimed.reason, 'rerun `bun run assets:bootimage`').toBe(
				'claimed image, context equal, config reset'
			);
		},
		TIMEOUT
	);
});

describe('which published image a site boots from', () => {
	it(
		'takes the pack image for a site the pack made and the claimed image for a claimed one',
		async () => {
			const both = [await image(), await claimedImage()];
			const stub = freshSite();
			await migrated(stub, { RECONCILE: '0' });
			await inObject(stub, (site) => withImage(site, both));
			expect((await render(stub)).bootImage).toMatchObject({
				used: true,
				reason: 'pack image, context equal'
			});

			const claimedStub = freshSite();
			await migrated(claimedStub, { RECONCILE: '0' });
			await claim(claimedStub, 'Some Site');
			await inObject(claimedStub, (site) => withImage(site, both));
			expect((await render(claimedStub)).bootImage).toMatchObject({
				used: true,
				reason: 'claimed image, context equal, config reset'
			});
		},
		TIMEOUT
	);

	it(
		'boots a claimed site plain when only the pack image is published, naming the mismatch',
		async () => {
			const pack = await image();
			const stub = freshSite();
			await migrated(stub, { RECONCILE: '0' });
			await claim(stub, 'Some Site');
			await inObject(stub, (site) => withImage(site, [pack]));
			expect((await render(stub)).bootImage).toMatchObject({
				used: false,
				reason: 'context differs'
			});
		},
		TIMEOUT
	);
});

describe('the shared boot image', () => {
	it(
		'captures the boot memory, named by the context of a plain site',
		async () => {
			const { index, files } = await image();
			expect(index.chunks.length).toBeGreaterThan(0);
			// anonymous captures no longer grow the 64 MiB start (two rebakes read 67,108,864)
			expect(index.byteLength).toBeGreaterThanOrEqual(1024 * 65_536);
			expect(files.size).toBe(index.chunks.length);
			expect(String(index.context)).toMatch(
				/^generation=.+\|driver=.+\|config=[0-9a-f]{32}\|settings=/
			);
			expect(index.handles.length).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'boots a second site from it and renders what a plain boot renders',
		async () => {
			const captured = await image();
			const restored = freshSite();
			await migrated(restored);
			await inObject(restored, (site) => withImage(site, captured));
			const plain = freshSite();
			// the lever is on by default and the tree publishes an image, so the control opts out
			await migrated(plain, { BOOT_IMAGE: '0' });

			const first = await render(restored, PATHS[0]);
			expect(first.bootImage?.used, JSON.stringify(first.bootImage)).toBe(true);
			expect(first.bootImage?.files).toBe(captured.index.chunks.length);
			const control = await render(plain, PATHS[0]);
			expect(control.bootImage?.used).toBe(false);
			// the restored heap already holds the container, discovery and theme state a plain boot
			// builds from the database, so a first render that reads as much was not restored
			expect(
				first.queries,
				`restored ${first.queries}, plain ${control.queries}`
			).toBeLessThan(control.queries);

			// the first path above warmed the page store, so the rest render from the heap's own state
			for (const path of PATHS) {
				const a = path === PATHS[0] ? first : await render(restored, path);
				const b = await render(plain, path);
				expect(a.html.length, path).toBeGreaterThan(1000);
				const x = normalized(a.html, a.origin);
				const y = normalized(b.html, b.origin);
				let at = 0;
				while (at < x.length && x[at] === y[at]) at++;
				expect(
					x === y
						? ''
						: `${path} at ${at}: ${x.slice(at - 80, at + 120)} || ${y.slice(at - 80, at + 120)}`
				).toBe('');
			}
		},
		TIMEOUT
	);

	it(
		'hands the restored site its own salt and private key, and never the bake',
		async () => {
			const captured = await image();
			const stub = freshSite();
			await migrated(stub);
			await inObject(stub, (site) => withImage(site, captured));
			// PHP that runs before any request, where the per-request resetter has not yet run
			await inObject(stub, (site) => site.ensurePhp());
			const early = await php(
				stub,
				`
use Drupal\\Core\\Site\\Settings;
echo json_encode(['salt' => Settings::getHashSalt(), 'key' => Drupal::service('private_key')->get()]);`
			);
			const first = await render(stub, '/user/login');
			expect(first.bootImage?.used, JSON.stringify(first.bootImage)).toBe(true);

			const own = await inObject(stub, (site) => ensureHashSalt(site.secretStore() as any));
			expect(early.salt).toBe(own);
			const seen = await php(
				stub,
				`
use Drupal\\Core\\Site\\Settings;
echo json_encode([
	'salt' => Settings::getHashSalt(),
	'key' => Drupal::service('private_key')->get(),
	'rand' => [mt_rand(), mt_rand()],
]);`
			);
			expect(seen.salt).toBe(own);
			const stored = await inObject(stub, (site) => {
				const row = site.sql
					.exec(
						"SELECT value FROM key_value WHERE collection = 'state' AND name = 'system.private_key'"
					)
					.toArray()[0] as { value?: unknown } | undefined;
				const text =
					row?.value instanceof Uint8Array
						? new TextDecoder().decode(row.value)
						: String(row?.value);
				return /"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? text;
			});
			expect(seen.key).toBe(stored);
			expect(early.key).toBe(stored);

			// a second site restored from the same image draws other values from every source
			const other = freshSite();
			await migrated(other);
			await inObject(other, (site) => withImage(site, captured));
			await render(other, '/user/login');
			const again = await php(
				other,
				`
use Drupal\\Core\\Site\\Settings;
echo json_encode(['salt' => Settings::getHashSalt(), 'key' => Drupal::service('private_key')->get(), 'rand' => [mt_rand(), mt_rand()]]);`
			);
			expect(again.salt).not.toBe(seen.salt);
			expect(again.key).not.toBe(seen.key);
			expect(again.rand).not.toEqual(seen.rand);
		},
		TIMEOUT
	);

	it(
		'starts the first request on a session of its own, as an anonymous visitor, with nothing of the bake left',
		async () => {
			const captured = await image();
			expect(captured.sid, 'the bake held a session id').toMatch(/^[A-Za-z0-9,-]+$/);
			const probe = `
echo json_encode([
	'sid' => session_id(),
	'keys' => array_keys($_SESSION ?? []),
	'uid' => (int) Drupal::currentUser()->id(),
]);`;
			const restored = freshSite();
			await migrated(restored);
			await inObject(restored, (site) => withImage(site, captured));
			const served = await render(restored, '/user/login');
			expect(served.bootImage?.used).toBe(true);
			const after = await php(restored, probe);

			const plain = freshSite();
			await migrated(plain);
			await render(plain, '/user/login');
			const control = await php(plain, probe);

			expect(after.uid).toBe(0);
			expect(after.sid).not.toBe(captured.sid);
			expect(after.keys).toEqual(control.keys);
			expect(control.sid).not.toBe(after.sid);
		},
		TIMEOUT
	);

	it(
		'gives every replayed site and every request its own session, never the bake or a neighbour',
		async () => {
			const captured = await image();
			expect(captured.sid, 'the bake held a session id').toMatch(/^[A-Za-z0-9,-]{20,}$/);
			const probe = `
echo json_encode([
	'sid' => session_id(),
	'keys' => array_keys($_SESSION ?? []),
	'uid' => (int) Drupal::currentUser()->id(),
]);`;
			const plain = freshSite();
			await migrated(plain);
			await render(plain, '/user/login');
			const control = await php(plain, probe);

			const seen: string[] = [captured.sid!];
			for (let replay = 0; replay < 4; replay++) {
				const restored = freshSite();
				await migrated(restored);
				await inObject(restored, (site) => withImage(site, captured));
				for (const path of ['/user/login', '/user/register']) {
					const served = await render(restored, path);
					expect(served.bootImage?.used).toBe(true);
					const after = await php(restored, probe);
					expect(after.uid).toBe(0);
					expect(after.keys).toEqual(control.keys);
					expect(after.sid).toMatch(/^[A-Za-z0-9,-]{20,}$/);
					expect(seen, `replay ${replay} ${path} reused a session id`).not.toContain(
						after.sid
					);
					seen.push(String(after.sid));
				}
			}
			expect(new Set(seen).size).toBe(seen.length);
		},
		TIMEOUT
	);

	it(
		'boots plain when the site differs from the bake, and says which part',
		async () => {
			const captured = await image();
			const stub = freshSite();
			await migrated(stub);
			await inObject(stub, (site) => {
				const row = site.sql
					.exec("SELECT data FROM config WHERE collection = '' AND name = 'system.site'")
					.toArray()[0] as { data: string | Uint8Array };
				const text =
					typeof row.data === 'string' ? row.data : new TextDecoder().decode(row.data);
				site.sql.exec(
					"UPDATE config SET data = ? WHERE collection = '' AND name = 'system.site'",
					`${text} `
				);
				withImage(site, captured);
			});
			const out = await render(stub);
			expect(out.bootImage).toMatchObject({ used: false, reason: 'context differs' });
			expect(out.html.length).toBeGreaterThan(1000);
		},
		TIMEOUT
	);

	it(
		'drops a heap a bad file left half written and boots plain, rendering the same page',
		async () => {
			const captured = await image();
			const last = captured.index.chunks.at(-1).file as string;
			const stub = freshSite();
			await migrated(stub);
			await inObject(stub, (site) =>
				withImage(site, captured, (file, bytes) => {
					if (file !== last) return bytes;
					const bad = bytes.slice();
					bad[17] = bad[17]! ^ 1;
					return bad;
				})
			);
			const out = await render(stub);
			expect(out.bootImage).toMatchObject({ used: false, rebooted: true });
			expect(String(out.bootImage?.reason)).toContain('does not match');
			expect(out.html.length).toBeGreaterThan(1000);
		},
		TIMEOUT
	);

	it(
		'does nothing when the lever is off, however the image is published',
		async () => {
			const captured = await image();
			const stub = freshSite();
			await migrated(stub);
			await inObject(stub, (site) => {
				withImage(site, captured);
				site.env = { ...site.env, BOOT_IMAGE: '0' };
			});
			const out = await render(stub);
			expect(out.bootImage).toMatchObject({ used: false, reason: 'off' });
		},
		TIMEOUT
	);
});
