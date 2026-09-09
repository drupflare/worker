import {
	BASE_URL,
	expect,
	gotoPage,
	ownerToken,
	signInToSurface,
	SITE,
	test
} from './utils/fixtures.js';

/**
 * The `/_cfw` surface, driven the way an operator drives it.
 *
 * EVERY OTHER BROWSER SPEC HERE DRIVES A STOCK DRUPAL PAGE. Twelve files, and not one of them opened
 * a page this project adds -- so the surface that installs modules, connects git remotes and
 * configures single sign-on had no browser coverage at all, while the pages Drupal ships had twelve
 * files of it. `admin-surface.spec.ts` closed the route level; this closes the level where a form
 * posts, a button fires and an inline script either runs or throws.
 *
 * What the route level structurally cannot see, and what each of these asserts:
 *
 * - a form whose credential it has no way to send. The Access page's Configure form posted to
 *   `/setup/oidc?action=save` and the page said to send `Authorization: Bearer`, which a plain HTML
 *   POST cannot do. It answered 401 to every operator who ever used it.
 * - an inline handler blocked by the Content-Security-Policy. `script-src` is in the header for
 *   exactly this reason and a header assertion does not prove a listener attached.
 * - a button wired to nothing. `[data-install]` is rendered by the same function whether or not the
 *   click handler below it parses.
 */

const SURFACE = '/_cfw';

test.describe('an operator signs in to the surface', () => {
	test('a page refuses an operator who has not signed in, and says where to', async ({
		page
	}) => {
		const res = await page.goto(`${SURFACE}/git`);
		expect(res?.status(), 'the surface answered without a credential').toBeLessThan(400);
		// the redirect is followed by the browser, so what matters is where it landed
		await expect(page).toHaveURL(/\/_cfw\/login/);
		await expect(page.locator('#token')).toBeVisible();
		// nothing on the sign-in page links into the surface it is guarding
		await expect(page.getByRole('link', { name: 'Git' })).toHaveCount(0);
	});

	test.describe('a refused credential', () => {
		// the 401 IS the assertion here, and chromium logs one console error per non-2xx response
		test.use({ refusals: [401] });

		test('is refused and leaves the operator on the form', async ({ page }) => {
			await page.goto(`${SURFACE}/login`);
			await page.locator('#token').fill('not-the-owner-token');
			await page.getByRole('button', { name: 'Sign In' }).click();
			await expect(page).toHaveURL(/\/_cfw\/login/);
			await expect(page.locator('.card.bad')).toBeVisible();
			// and nothing was handed out: the next page still refuses
			await page.goto(`${SURFACE}/git`);
			await expect(page).toHaveURL(/\/_cfw\/login/);
		});
	});

	test('the right token opens every page, and each one renders its own content', async ({
		page
	}) => {
		await signInToSurface(page);

		// each pair is a page and something only THAT page's body can produce, so a shell rendered
		// around an error still fails
		const pages: [string, RegExp][] = [
			[SURFACE, /Every meter this site can run out of/],
			[`${SURFACE}/extend`, /resolves against/],
			[`${SURFACE}/commands`, /have a driver that can actually run here/],
			[`${SURFACE}/deploy`, /What deploying actually involves/],
			[`${SURFACE}/git`, /How a Pull Works/],
			[`${SURFACE}/access`, /What a Login Refuses/]
		];
		for (const [path, marker] of pages) {
			await page.goto(path);
			await expect(page.locator('body'), path).toContainText(marker);
			await expect(page.getByRole('link', { name: 'Sign Out' }), path).toBeVisible();
		}
	});

	test('signing out closes the surface again', async ({ page }) => {
		await signInToSurface(page);
		await page.goto(SURFACE);
		await page.getByRole('link', { name: 'Sign Out' }).click();
		await expect(page).toHaveURL(/\/_cfw\/login/);
		// and the cookie is gone rather than merely unused
		await page.goto(`${SURFACE}/commands`);
		await expect(page).toHaveURL(/\/_cfw\/login/);
	});
});

test.describe('the surface acts on the site', () => {
	test.beforeEach(async ({ page }) => {
		await signInToSurface(page);
	});

	/**
	 * The Extend page, end to end against the real registry.
	 *
	 * It sent `name` where the route reads `module`, so every query answered `not-found` for every
	 * package that exists, and six renderer unit tests passed throughout because they were given
	 * hand-built rows.
	 */
	test('Extend answers a real package with a version and a verdict', async ({ page }) => {
		await page.goto(`${SURFACE}/extend`);
		await page.locator('input[name="q"]').fill('drupal/token');
		await page.getByRole('button', { name: 'Check' }).click();
		await page.waitForLoadState('load');

		const row = page.locator('tbody tr').first();
		await expect(row).toContainText('drupal/token');
		// the version column read a field no response has ever carried, so it was permanently blank
		await expect(row.locator('td').nth(1)).not.toHaveText('-');
		// and the verdict is a real one rather than the not-found every query used to produce
		await expect(row).not.toContainText('not-found');
	});

	test('Extend offers Install, and Enable only after something is installed', async ({
		page
	}) => {
		await page.goto(`${SURFACE}/extend?q=drupal%2Ftoken`);
		const install = page.locator('[data-install]').first();
		await expect(install, 'no Install button on an installable package').toBeVisible();
		// the two are separate operations and the page used to tell the operator to go and type a
		// Drush command for the second one
		await expect(page.locator('[data-enable]').first()).toBeDisabled();
	});

	/**
	 * The one that proves a handler attached.
	 *
	 * A button rendered by a template and a button with a listener on it are indistinguishable in the
	 * HTML. This clicks one and asserts the page reacted -- which fails if the CSP blocked the
	 * script, if the script threw while parsing, or if the fetch went somewhere that answers 404.
	 */
	test('a Command runs against the object and reports what it did', async ({ page }) => {
		await page.goto(`${SURFACE}/commands`);
		await page.locator('input[name="op"]').fill('status');
		await page.getByRole('button', { name: 'Run' }).click();
		await page.waitForLoadState('load');
		// the result card only exists when the operation returned something
		await expect(page.locator('.card pre')).toBeVisible();
	});

	test('a command that takes no arguments says so rather than running', async ({ page }) => {
		await page.goto(`${SURFACE}/commands?op=cr+extra`);
		await expect(page.locator('.card.bad')).toContainText('takes no arguments');
	});

	test.describe('a remote that will not connect', () => {
		// the remote is refused on purpose; 400 is what `/git` answers and 4xx is what is asserted
		test.use({ refusals: [400, 401, 403, 404] });

		test('is reported rather than failing silently', async ({ page }) => {
			await page.goto(`${SURFACE}/git`);
			await page.locator('#git-add input[name="repo"]').fill('https://github.com/nope/nope');
			await page.locator('#git-add input[name="token"]').fill('not-a-real-token');
			await page.getByRole('button', { name: 'Connect' }).click();
			// THE ASSERTION IS THAT THE HANDLER RAN. A refusal printed here proves the submit
			// listener attached, the fetch reached `/git`, and the owner cookie authenticated it;
			// the old page called `window.prompt()` at this point and a cancelled prompt returned
			// with no trace at all
			await expect(page.locator('#git-out')).toContainText(/Could not connect|refused|not/i, {
				timeout: 60_000
			});
		});
	});

	/**
	 * The Access form, which could not work.
	 *
	 * It was a plain `<form method="POST">` to a route that requires the owner token as a bearer
	 * header. A browser cannot set one on a form submission, so every operator who filled this in
	 * got a 401 page. Now it posts with the session cookie and renders the discovery result.
	 */
	test('Access saves an issuer and reports discovery against it', async ({ page }) => {
		await page.goto(`${SURFACE}/access`);
		await page.locator('input[name="issuer"]').fill('https://accounts.example.invalid');
		await page.locator('input[name="clientId"]').fill('drupflare-browser-lane');
		await page.getByRole('button', { name: 'Save' }).click();

		// the issuer does not resolve, so discovery FAILS -- and the failure being reported is the
		// evidence the write landed and the round trip completed
		await expect(page.locator('#oidc-out')).toContainText(/Saved|Refused/, { timeout: 60_000 });

		await page.reload();
		await expect(page.locator('.card').first()).toContainText('accounts.example.invalid');
	});

	test('Access clears what it saved', async ({ page }) => {
		page.once('dialog', (d) => void d.accept());
		await page.goto(`${SURFACE}/access`);
		await page.locator('#oidc-clear').click();
		await page.waitForLoadState('load');
		await expect(page.locator('.card').first()).toContainText('Not Configured');
	});

	test('Limits reads the meters this site has actually spent', async ({ page }) => {
		await page.goto(SURFACE);
		const rows = page.locator('tbody tr');
		await expect(await rows.count()).toBeGreaterThan(3);
		// the projection takes its numbers from the query, so this proves the arithmetic is live
		await page.goto(`${SURFACE}?images=2000&styles=10`);
		await expect(page.locator('body')).toContainText('20,000');
	});
});

/**
 * The invariant a module install has to hold.
 *
 * The historical failure is not that the install fails; it is that it succeeds and takes an
 * unrelated page down with it. Nothing checked the pages that were not the point of the change.
 */
test.describe('the site still works after the surface has been used', () => {
	test('the pages a visitor and an operator need still render', async ({ page }) => {
		await signInToSurface(page);
		// touching a page that reads from the object, so this runs after the surface has driven it
		await page.goto(`${SURFACE}/commands`);

		for (const path of ['/', '/user/login']) {
			const res = await gotoPage(page, path);
			expect(res.status(), path).toBe(200);
		}
	});

	test('the surface never becomes a Drupal page, and Drupal never loses its own', async () => {
		// `/_cfw` is claimed by the Worker; `/admin` is Drupal's. They used to be the same prefix,
		// so an owner reaching for their admin UI got the hosting product's Limits page
		const surface = await fetch(`${BASE_URL}${SURFACE}`, {
			redirect: 'manual',
			headers: { authorization: `Bearer ${ownerToken()}` }
		});
		expect(surface.headers.get('content-type') ?? '').toContain('text/html');
		expect(
			surface.headers.get('cache-control'),
			'an admin page must never be stored at the edge'
		).toContain('no-store');

		const drupal = await fetch(`${BASE_URL}/serve?site=${SITE}&path=%2Fadmin`, {
			redirect: 'manual',
			headers: { cookie: '' }
		});
		expect(drupal.status, '/admin stopped belonging to Drupal').not.toBe(404);
	});
});

/**
 * The owner token is the whole credential, so its handling is worth asserting rather than assuming.
 */
test.describe('the credential', () => {
	test('is not readable by script once it is a session', async ({ page }) => {
		await signInToSurface(page);
		// as an expression string rather than a closure: this tsconfig carries no DOM lib, and adding
		// one to reach `document` breaks every spec that imports from `src/`
		const readable = await page.evaluate<string>('document.cookie');
		expect(readable, 'the admin cookie is reachable from page script').not.toContain(
			'cfw_admin'
		);
	});

	test('does not travel to a page a visitor can influence', async ({ page }) => {
		await signInToSurface(page);
		// SameSite=Strict, asserted through the cookie jar rather than through the header text
		const jar = await page.context().cookies(BASE_URL);
		const admin = jar.find((c) => c.name === 'cfw_admin');
		expect(admin, 'no admin cookie was set').toBeDefined();
		expect(admin?.httpOnly).toBe(true);
		expect(admin?.sameSite).toBe('Strict');
	});

	test('a bearer token reaches the same pages, so a script needs no browser', async () => {
		const res = await fetch(`${BASE_URL}${SURFACE}/deploy`, {
			headers: { authorization: `Bearer ${ownerToken()}` },
			redirect: 'manual'
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('What deploying actually involves');
	});
});
