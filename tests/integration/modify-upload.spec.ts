import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * `/modify`: uploading a module tree that is not on a git host, and rolling one back afterwards.
 *
 * `/git` delivers from a host and `/install` delivers from a registry. A tree on a developer's disk
 * had no route at all, and neither of the two that existed kept history -- `gitRestore()` holds its
 * snapshot in memory for the duration of ONE call, so a git pull that succeeded left nothing to go
 * back to.
 *
 * What is asserted here is the part a unit test cannot reach: that an uploaded revision goes through
 * the SAME apply, verify-boot and restore path a git pull does. A module that breaks the container
 * has to roll back, and the verification is a real kernel boot rather than a syntax check, because a
 * missing service fails when the container is built and not when the file is written.
 */

const ORIGIN = 'https://do.local';
const PACKAGE = 'cfw_probe_mod';

type Json = Record<string, never>;

async function ownerToken(site: ServeDo): Promise<string> {
	// the token rides the firstrun reply only when the run APPLIED, and a firstrun on an unmigrated
	// site does not; without this the whole file reads 401 and looks like an auth defect
	await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
	const res = await site.fetch(
		new Request(`${ORIGIN}/__firstrun`, {
			method: 'POST',
			body: JSON.stringify({ adminPass: 'cfw-Modify-Pass-3318', siteName: 'Modify' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	const body = (await res.json()) as { ownerToken?: string };
	return String(body.ownerToken ?? '');
}

async function sha256(source: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** an info file plus one PHP file, which is the smallest thing `moduleRoots()` will mount */
function moduleTree(body: string, info?: string): Record<string, string> {
	return {
		[`modules/custom/${PACKAGE}/${PACKAGE}.info.yml`]:
			info ?? `name: Probe\ntype: module\ncore_version_requirement: ^11\n`,
		[`modules/custom/${PACKAGE}/${PACKAGE}.module`]: body
	};
}

/**
 * WHAT A BOOT VERIFICATION CAN AND CANNOT SEE, measured rather than assumed.
 *
 * A broken `.module` is not enough on its own, and neither is a malformed `.info.yml`: the boot
 * builds no container of its own, so a module nobody enabled is never discovered and never included.
 * Both were tried and both booted clean. The verification catches a module that IS enabled, which is
 * the case that matters -- an enabled module's `.module` is loaded on every boot.
 *
 * That limit belongs to `gitVerifyBoot()` and predates this route; `/git` carries it too. It is not a
 * hole in the rollback, which does run: it bounds what the verification is looking at.
 */
const BROKEN_MODULE = '<?php\nthis is not php at all ((( \n';

function modify(site: ServeDo, token: string) {
	return async (action: string, params: Record<string, string> = {}, body?: unknown) => {
		const url = new URL(`${ORIGIN}/__modify`);
		url.searchParams.set('action', action);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		const res = await site.fetch(
			new Request(url, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			})
		);
		return { status: res.status, body: (await res.json()) as Json };
	};
}

/** declare, send the bytes it does not have, commit; the shape the CLI drives */
async function upload(
	call: ReturnType<typeof modify>,
	sources: Record<string, string>,
	label: string
) {
	const files = await Promise.all(
		Object.entries(sources).map(async ([path, source]) => ({
			path,
			source,
			hash: await sha256(source),
			bytes: new TextEncoder().encode(source).length
		}))
	);
	const plan = await call('plan', { package: PACKAGE }, { files });
	const wanted = new Set((plan.body['want'] ?? []) as unknown as string[]);
	const blobs = await call(
		'blobs',
		{ package: PACKAGE },
		{
			blobs: files
				.filter((file) => wanted.has(file.hash))
				.map((file) => ({ hash: file.hash, source: file.source }))
		}
	);
	const commit = await call(
		'commit',
		{ package: PACKAGE, label, origin: '/local' },
		{ files: files.map((file) => ({ path: file.path, hash: file.hash })) }
	);
	return { plan, blobs, commit, files };
}

describe('an uploaded revision lands the way a git pull does', () => {
	it('negotiates, applies, and sends only what the site is missing on the second upload', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const token = await ownerToken(site);
			const call = modify(site, token);

			const first = await upload(call, moduleTree('<?php\n// v1\n'), 'first');
			const second = await upload(call, moduleTree('<?php\n// v2\n'), 'second');
			const status = await call('status', { package: PACKAGE });
			const revisions = await call('revisions', { package: PACKAGE });
			const manifest = await call('manifest', {
				package: PACKAGE,
				rev: String(first.commit.body['rev'])
			});
			const manifestActive = await call('manifest', { package: PACKAGE });
			return { token, first, second, status, revisions, manifest, manifestActive };
		});
		console.log(
			`[modify] first=${JSON.stringify(seen.first.commit.body)} second-plan=${JSON.stringify(seen.second.plan.body)}`
		);

		expect(seen.token).not.toBe('');
		expect(seen.first.plan.status).toBe(200);
		// nothing is here yet, so both files are wanted
		expect(seen.first.plan.body['want']).toHaveLength(2);
		expect(seen.first.blobs.body).toMatchObject({ stored: 2, skipped: 0, rejected: [] });
		expect(seen.first.commit.body).toMatchObject({
			ok: true,
			applied: true,
			rolledBack: false
		});

		// THE POINT OF THE NEGOTIATION: the info file did not change, so it is not sent again
		expect(seen.second.plan.body['have']).toHaveLength(1);
		expect(seen.second.plan.body['want']).toHaveLength(1);
		// and the edited file is a MODIFICATION, which is the count the first version got wrong: it
		// ran `planSync` over only the held blobs, so a file whose new bytes had not arrived yet read
		// as a REMOVAL and the caller was told its edit would delete the file it had just edited
		expect(seen.second.plan.body['counts']).toEqual({
			added: 0,
			modified: 1,
			removed: 0,
			unchanged: 1
		});
		expect(seen.second.plan.body['removed']).toEqual([]);
		expect(seen.second.blobs.body).toMatchObject({ stored: 1, skipped: 0 });
		expect(seen.second.commit.body).toMatchObject({ ok: true, applied: true });

		const status = (seen.status.body['packages'] as unknown as { files: number }[])[0];
		expect(status).toMatchObject({ package: PACKAGE, files: 2 });
		expect(seen.revisions.body['revisions']).toHaveLength(2);
		expect(seen.revisions.body['active']).toBe(seen.second.commit.body['rev']);

		// the manifest of a stored revision, which is what makes "diff against last week" possible;
		// `revisions` reports a file COUNT and a caller had no way to ask which files
		const manifest = seen.manifest.body['manifest'] as unknown as Record<string, string>;
		expect(Object.keys(manifest).sort()).toEqual(
			seen.first.files.map((file) => file.path).sort()
		);
		expect(seen.manifest.body['rev']).toBe(seen.first.commit.body['rev']);
		expect(seen.manifestActive.body['rev']).toBe(seen.second.commit.body['rev']);
		expect(seen.manifestActive.body['active']).toBe(true);
	}, 900_000);

	/**
	 * The rollback, which is the assertion that separates this from a file copy.
	 *
	 * A `.module` that cannot be parsed fails when the CONTAINER is built, not when the row is
	 * written, so a route that wrote the files and answered ok would report success on a site that
	 * can no longer render.
	 */
	it('rolls back a revision the kernel refuses to boot, and leaves the previous one serving', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const token = await ownerToken(site);
			const call = modify(site, token);
			const good = await upload(call, moduleTree('<?php\n// good\n'), 'good');
			// enabled first, so the boot actually loads the file the next revision breaks
			const enabled = await site.fetch(
				new Request(`${ORIGIN}/__enable?module=${PACKAGE}`, { method: 'POST' })
			);
			const bad = await upload(call, moduleTree(BROKEN_MODULE), 'bad');
			const status = await call('status', { package: PACKAGE });
			const files = site
				.execSql('SELECT path, source FROM cfw_module_file WHERE package = ?', [PACKAGE])
				.rows.map((row) => String(row['source']));
			return { good, bad, status, files, enabled: enabled.status };
		});
		console.log(
			`[modify-rollback] enable=${seen.enabled} ${JSON.stringify(seen.bad.commit.body)}`
		);

		expect(seen.good.commit.body).toMatchObject({ ok: true, applied: true });
		// the control: without an enabled module the boot loads nothing and the case below
		// would pass for the wrong reason
		expect(seen.enabled).toBe(200);
		expect(seen.bad.commit.status).toBe(409);
		expect(seen.bad.commit.body).toMatchObject({ applied: false, rolledBack: true });
		expect(String(seen.bad.commit.body['error'])).toContain('rolled back');
		// the mounted tree is what it was before the bad upload, byte for byte
		expect(seen.files.some((source) => source.includes('// good'))).toBe(true);
		expect(seen.files.some((source) => source.includes('name: [Probe'))).toBe(false);
	}, 900_000);

	it('activates a stored revision with no bytes on the wire, and refuses one it does not have', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const token = await ownerToken(site);
			const call = modify(site, token);
			const first = await upload(call, moduleTree('<?php\n// v1\n'), 'first');
			await upload(call, moduleTree('<?php\n// v2\n'), 'second');

			const back = await call('activate', { package: PACKAGE, rev: 'previous' });
			const live = site
				.execSql('SELECT source FROM cfw_module_file WHERE package = ? AND path LIKE ?', [
					PACKAGE,
					'%.module'
				])
				.rows.map((row) => String(row['source']));
			const unknown = await call('activate', {
				package: PACKAGE,
				rev: 'f'.repeat(64)
			});
			return { first, back, live, unknown };
		});

		expect(seen.back.status).toBe(200);
		expect(seen.back.body['rev']).toBe(seen.first.commit.body['rev']);
		expect(seen.live.join('')).toContain('// v1');
		expect(seen.unknown.status).toBe(404);
		expect(seen.unknown.body['error']).toBe('no such revision');
	}, 900_000);
});

describe('the route refuses what it cannot verify', () => {
	it('needs an owner token, a package, a known action and a JSON body', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const token = await ownerToken(site);
			const call = modify(site, token);
			const anonymous = await site.fetch(new Request(`${ORIGIN}/__modify?action=status`));
			const wrongToken = await site.fetch(
				new Request(`${ORIGIN}/__modify?action=status`, {
					headers: { authorization: 'Bearer not-the-token' }
				})
			);
			return {
				anonymous: anonymous.status,
				wrongToken: wrongToken.status,
				noPackage: await call('revisions'),
				unknownAction: await call('teleport', { package: PACKAGE }),
				noBody: await call('plan', { package: PACKAGE }),
				emptyCommit: await call('commit', { package: PACKAGE }, { files: [] })
			};
		});

		expect(seen.anonymous).toBe(401);
		expect(seen.wrongToken).toBe(401);
		expect(seen.noPackage.status).toBe(400);
		expect(seen.unknownAction.status).toBe(400);
		expect(String(seen.unknownAction.body['error'])).toContain('teleport');
		// `plan` without a body is a GET, and this action needs a POST carrying one
		expect(seen.noBody.status).toBe(400);
		// a revision with no files would unmount the package, which is not what an upload means
		expect(seen.emptyCommit.status).toBe(400);
	}, 900_000);

	/**
	 * An oversized batch is refused at the EDGE, with the limit named so a client can resize.
	 *
	 * The upload design assumes the client batches, and it can only do that if the refusal says what
	 * to batch to. The front worker answers 413 with `x-cfw-body-limit` before the request reaches
	 * the object, costing no DO request and no interpreter.
	 *
	 * **THE BODY CAP RUNS BEFORE THE CREDENTIAL CHECK, measured rather than read off the line
	 * numbers.** This spec asserted the other order first and passed for the wrong reason: a
	 * constructed `Request` sets no `content-length`, the guard reads exactly that header, so the cap
	 * did not fire and the owner check answered 401. With the header present the cap wins.
	 *
	 * That order is the right one and costs nothing to accept: both are O(1) header reads, refusing
	 * first is strictly less work, and what an anonymous caller learns is `MAX_BODY_BYTES` -- a
	 * deployment constant that `docs/configuration.md` publishes.
	 */
	it('refuses an oversized batch before anything else, naming the limit', async () => {
		const { env } = await import('cloudflare:test');
		const { default: front } = await import('../../src/site');
		const oversized = JSON.stringify({
			blobs: [{ hash: 'a'.repeat(64), source: 'x'.repeat(4096) }]
		});
		const capped = { ...env, MAX_BODY_BYTES: '128' } as never;

		const owned = await front.fetch(
			new Request('https://cfw.local/modify?action=blobs&package=x&site=y', {
				method: 'POST',
				// the guard reads `content-length`, which a constructed Request does not set
				headers: {
					'content-type': 'application/json',
					'content-length': String(oversized.length)
				},
				body: oversized
			}),
			capped
		);
		expect(owned.status).toBe(413);
		expect(owned.headers.get('x-cfw-body-limit')).toBe('128');
		expect(owned.headers.get('x-cfw-deny')).toBe('body-too-large');

		// and the credential still governs a request the cap lets through, which is the control:
		// without it the assertion above would pass on a route with no gate at all
		const uncapped = await front.fetch(
			new Request('https://cfw.local/modify?action=status&site=y', { method: 'GET' }),
			env as never
		);
		expect(uncapped.status).toBe(401);

		const form = 'a='.concat('x'.repeat(4096));
		const public_ = await front.fetch(
			new Request('https://cfw.local/serve?site=y&path=%2F', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'content-length': String(form.length)
				},
				body: form
			}),
			capped
		);
		expect(public_.status).toBe(413);
		expect(public_.headers.get('x-cfw-body-limit')).toBe('128');
		expect(public_.headers.get('x-cfw-deny')).toBe('body-too-large');
	});

	/**
	 * Bytes that do not hash to the name they were sent under are refused.
	 *
	 * A manifest names files by hash, so storing chosen bytes under a chosen hash would let a later
	 * `activate` mount content that was never reviewed under a revision that was.
	 */
	it('refuses a blob whose bytes do not match its hash, and a manifest naming a blob it lacks', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const token = await ownerToken(site);
			const call = modify(site, token);
			const honest = await sha256('the reviewed bytes');
			const forged = await call(
				'blobs',
				{ package: PACKAGE },
				{ blobs: [{ hash: honest, source: 'entirely different bytes' }] }
			);
			const dangling = await call(
				'commit',
				{ package: PACKAGE, label: 'dangling' },
				{ files: [{ path: `modules/custom/${PACKAGE}/x.php`, hash: honest }] }
			);
			return { forged, dangling };
		});

		expect(seen.forged.status).toBe(422);
		expect(seen.forged.body).toMatchObject({ ok: false, stored: 0 });
		expect(seen.forged.body['rejected']).toHaveLength(1);
		expect(seen.dangling.status).toBe(409);
		expect(String(seen.dangling.body['error'])).toContain('does not hold');
	}, 900_000);
});
