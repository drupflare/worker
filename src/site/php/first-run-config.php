<?php

use Drupal\Core\Cache\Cache;
use Drupal\Core\Site\Settings;
use Drupal\drupflare\Hook\OwnerTier;
use Drupal\user\Entity\User;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');

$opt = json_decode(__CFW_PAYLOAD__, true);
$out = ['ok' => false, 'applied' => [], 'skipped' => []];

try {
	// __CFW_CLAIM_BOOT__

	// site name, mail and timezone are config, so go through the config factory
	if (empty($opt['migrated'])) {
		$editable = Drupal::configFactory()->getEditable('system.site');
		foreach (['siteName' => 'name', 'siteMail' => 'mail'] as $key => $configKey) {
			if (!empty($opt[$key])) {
				$editable->set($configKey, $opt[$key]);
				$out['applied'][] = 'system.site.' . $configKey;
			} else {
				$out['skipped'][] = 'system.site.' . $configKey;
			}
		}
		$editable->save();
	}

	if (!empty($opt['timezone'])) {
		Drupal::configFactory()
			->getEditable('system.date')
			->set('timezone.default', $opt['timezone'])
			->save();
		$out['applied'][] = 'system.date.timezone.default';
	}

	// MANDATORY, not tidiness. Completing the request lifecycle means calling
	// $kernel->terminate(), and automated_cron subscribes to TERMINATE. With
	// system.cron_last absent it fires drupal_cron() inline on the very first
	// request, cron reaches for outbound HTTP (update, announcements_feed), and the
	// wasm build dies with "ReferenceError: Asyncify is not defined" -- a JS
	// exception, so catch (Throwable) around terminate() does NOT contain it.
	// Measured: every terminate=1 render 500'd until this was set. Interval 0 is
	// core's own "Never" option. Cron runs from the Durable Object alarm instead.
	if (Drupal::moduleHandler()->moduleExists('automated_cron')) {
		$cronConfig = Drupal::configFactory()->getEditable('automated_cron.settings');
		if ((int) $cronConfig->get('interval') !== 0) {
			$cronConfig->set('interval', 0)->save();
			$out['applied'][] = 'automated_cron.settings.interval=0';
		} else {
			$out['skipped'][] = 'automated_cron.settings.interval (already 0)';
		}
	}

	// __CFW_SCHEMA_REPAIR__

	// __CFW_PACK_CONSISTENCY__

	// uid 1 through the entity API so the password hasher and the presave hooks run
	$admin = empty($opt['migrated']) ? User::load(1) : null;
	if (!empty($opt['migrated'])) {
		$out['skipped'][] = 'uid1 (migrated site keeps its administrator)';
	} elseif ($admin === null) {
		$out['skipped'][] = 'uid1 (not loadable)';
	} else {
		if (!empty($opt['adminName'])) {
			$admin->setUsername($opt['adminName']);
			$out['applied'][] = 'uid1.name';
		}
		if (!empty($opt['adminMail'])) {
			$admin->setEmail($opt['adminMail']);
			$out['applied'][] = 'uid1.mail';
		}
		if (!empty($opt['adminPass'])) {
			$admin->setPassword($opt['adminPass']);
			$out['applied'][] = 'uid1.pass';
		}
		// the pack was installed weeks before this site existed, so uid 1's birthday is the BAKE date
		// and the account reads as created before the site it belongs to
		if (!empty($opt['claimedAt'])) {
			$admin->set('created', (int) $opt['claimedAt']);
			$out['applied'][] = 'uid1.created';
		}
		$admin->activate();
		$admin->save();
		$out['adminName'] = $admin->getAccountName();
		$out['adminMail'] = $admin->getEmail();
		// the claimed account is the owner, as a role so a team can share it
		if (class_exists(OwnerTier::class)) {
			$out['owner'] = OwnerTier::establish($admin);
		}
	}

	// THE CLOCK IN THE PACK IS THE ONE FROM THE BAKE, and the status report reads it. install_time
	// shipped inside the packed database at the bake date, system.cron_last shipped absent, and
	// SystemRequirementsHooks falls back to install_time when cron_last is not numeric -- so a site
	// provisioned today opened with a red Cron row weeks old. Both are stamped at the claim, which is
	// the first moment this site has a real birthday
	if (!empty($opt['claimedAt'])) {
		Drupal::state()->set('install_time', (int) $opt['claimedAt']);
		Drupal::state()->set('system.cron_last', (int) $opt['claimedAt']);
		$out['applied'][] = 'state.install_time';
		$out['applied'][] = 'state.cron_last';
	}

	// MINTED HERE BECAUSE A REPLICA MAY NOT MINT IT, and until this line nothing did. Drupal creates
	// system.private_key lazily on the first render that needs a CSRF token, so a site that had been
	// migrated and claimed did not hold one -- and admissionVerdict() lists it as mandatory state,
	// correctly, since two objects each minting their own issue tokens the other rejects. Measured:
	// three lanes sat at CREATED through 40 provision steps each, then reached VERIFIED in 1 step
	// each once a single form render had minted it. Drupal's own service, so the value is
	// indistinguishable from a lazily minted one
	$out['privateKey'] = strlen(Drupal::service('private_key')->get()) > 0 ? 'present' : 'MISSING';

	// the salt is the HOST's now: src/ops/site-secrets.ts mints one per site at boot, persists it in
	// cfw_meta and appends the assignment to settings.php, so generating another here would replace a
	// live salt with one nothing stores and invalidate every session on the next remount
	$out['hashSalt'] = strlen(Settings::getHashSalt()) > 0 ? 'present' : 'MISSING';

	// config changes have to reach the render caches or the old site name persists
	Cache::invalidateTags(['config:system.site', 'rendered']);
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 900);
}

echo json_encode($out);
