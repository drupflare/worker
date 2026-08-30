import { expect, gotoPage, loginAsAdmin, test } from './utils/fixtures.js';

/**
 * Building a content type and putting a field on it, which is the first thing anyone does.
 *
 * Every earlier spec drives a form core ships pre-built. This one makes Drupal WRITE schema: a new
 * bundle, then a field storage and a field instance on it, then a node of that bundle. Those are
 * three different write paths -- config entity save, field storage create (which alters the entity
 * schema), and a content entity save -- and the driver's speculative-replay and 2^53 guards sit
 * under all of them.
 *
 * IT IS ALSO THE ONLY AJAX FLOW THE LANE DRIVES, which is why it is worth its runtime. Picking a
 * field type is an AJAX POST that opens a modal, and both halves of that were broken: the response
 * came back wrapped in a `<textarea>` because `Accept` never reached Symfony, and ajax.js then
 * refused it because `X-Drupal-Ajax-Token` was dropped on the way out. Nothing else in the suite
 * makes an AJAX request, so nothing else could see it.
 */

// unique per run, because a spec that creates a config entity is not idempotent: a second run
// against the same state directory hits "the machine-readable name is already in use" and fails for
// a reason that has nothing to do with the runtime. `node-create.pw.ts` does the same for its title
const RUN = Date.now().toString(36);
const TYPE_LABEL = `Browser Lane Type ${RUN}`;
const TYPE_ID = `browser_lane_type_${RUN}`;
const FIELD_LABEL = `Lane Note ${RUN}`;
const FIELD_NAME = `field_lane_note_${RUN}`;

test('an admin creates a content type, adds a field through the modal, and uses it', async ({
	page
}) => {
	await loginAsAdmin(page);

	await gotoPage(page, '/admin/structure/types/add');
	await page.locator('#edit-name').fill(TYPE_LABEL);
	// the machine name is derived by JS; waiting for it is the difference between saving
	// `browser_lane_type` and saving nothing at all
	await expect(page.locator('.machine-name-value')).toHaveText(TYPE_ID, { timeout: 60_000 });
	await page.getByRole('button', { name: 'Save' }).first().click();
	await page.waitForLoadState('load');

	await gotoPage(page, `/admin/structure/types/manage/${TYPE_ID}/fields/add-field`);
	// a card, not a radio: field_ui renders `<label class="field-option use-ajax">` and the click
	// is an AJAX POST that answers with an openDialog command
	await page.locator('.field-option', { hasText: 'Plain text' }).first().click();

	const modal = page.locator('#drupal-modal');
	await expect(modal).toBeVisible({ timeout: 60_000 });
	await modal.locator('input[name="label"]').fill(FIELD_LABEL);
	await modal.locator('input[name="field_options_wrapper"][value="string"]').check();
	// the button pane is a SIBLING of #drupal-modal: jQuery UI lifts the form actions out of the
	// content div into `.ui-dialog-buttonpane`, so scoping to the content finds no button at all
	await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();
	await page.waitForLoadState('load');

	// the second step, in the same dialog: the title becomes "<label> settings for <bundle>" and
	// the button pane swaps Continue for Save. Waiting on the title is what makes this a step
	// rather than a race -- the pane is rebuilt by an AJAX command, not by a navigation
	const pane = page.locator('.ui-dialog-buttonpane');
	await expect(pane.getByRole('button', { name: 'Save', exact: true })).toBeVisible({
		timeout: 60_000
	});
	await pane.getByRole('button', { name: 'Save', exact: true }).click();
	await page.waitForLoadState('load');

	// the field list is the observable: it is read back out of config, not out of the form
	await gotoPage(page, `/admin/structure/types/manage/${TYPE_ID}/fields`);
	await expect(page.getByText(FIELD_LABEL)).toBeVisible();
	// the machine name core derived, which proves the storage was created and not just the label
	await expect(page.getByText(FIELD_NAME)).toBeVisible();

	// and the bundle is usable, which the config alone does not prove
	await gotoPage(page, `/node/add/${TYPE_ID}`);
	// by label, not by `#edit-title-0-value`: that id is stable on core's own bundles and is not on
	// a bundle created during the run
	await page.getByRole('textbox', { name: /^Title/ }).fill('A node on the new type');
	await page.getByRole('button', { name: 'Save' }).first().click();
	await page.waitForLoadState('load');
	await expect(page.getByRole('heading', { name: 'A node on the new type' })).toBeVisible();
});
