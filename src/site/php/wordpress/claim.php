<?php

// __CFW_HOST_HELPERS__

// WordPress declares ABSPATH and every function once, so an interpreter serves one run
if (defined('ABSPATH')) {
	echo json_encode(['ok' => false, 'error' => 'this interpreter already loaded WordPress']);
	return;
}

$cfwIn = json_decode(__CFW_PAYLOAD__, true);
$cfwOrigin = (string) $cfwIn['origin'];
$cfwHost = (string) (parse_url($cfwOrigin, PHP_URL_HOST) ?: 'localhost');
$cfwHttps = strncmp($cfwOrigin, 'https:', 6) === 0;
$cfwPort = (int) (parse_url($cfwOrigin, PHP_URL_PORT) ?: ($cfwHttps ? 443 : 80));
$_SERVER['HTTP_HOST'] = $cfwPort === 80 || $cfwPort === 443 ? $cfwHost : $cfwHost . ':' . $cfwPort;
$_SERVER['SERVER_NAME'] = $cfwHost;
$_SERVER['SERVER_PORT'] = (string) $cfwPort;
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
if ($cfwHttps) {
	$_SERVER['HTTPS'] = 'on';
}

$cfwOut = ['ok' => false];
ob_start();
chdir('/wordpress');
try {
	require '/wordpress/wp-load.php';
	global $wpdb;

	$cfwLogin = (string) ($cfwIn['adminName'] ?: 'admin');
	$cfwMail = (string) ($cfwIn['adminMail'] ?: '');
	if (sanitize_user($cfwLogin, true) !== $cfwLogin) {
		throw new RuntimeException('invalid_username');
	}
	if ($cfwMail !== '' && !is_email($cfwMail)) {
		throw new RuntimeException('invalid_email');
	}
	$cfwFirst = get_userdata(1);
	// the bake leaves one administrator whose hash is the unusable marker; the owner takes it over
	// so the posts it wrote keep an author and no second account is left behind
	$cfwTakeover = $cfwFirst !== false && $cfwFirst->user_pass === '!';

	if ($cfwTakeover) {
		$wpdb->update(
			$wpdb->users,
			['user_login' => $cfwLogin, 'user_nicename' => sanitize_title($cfwLogin)],
			['ID' => 1],
		);
		clean_user_cache(1);
	}
	$cfwUser = [
		'user_login' => $cfwLogin,
		'user_pass' => (string) $cfwIn['adminPass'],
		'display_name' => $cfwLogin,
		'role' => 'administrator',
	];
	if ($cfwMail !== '') {
		$cfwUser['user_email'] = $cfwMail;
	}
	if ($cfwTakeover) {
		$cfwUser['ID'] = 1;
	}
	// wp_insert_user hashes a new account's password and takes an update's as already hashed, so the
	// takeover goes through wp_update_user, which hashes
	$cfwId = $cfwTakeover ? wp_update_user($cfwUser) : wp_insert_user($cfwUser);
	if (is_wp_error($cfwId)) {
		$cfwOut['error'] = 'wordpress: ' . $cfwId->get_error_code();
	} else {
		if (!empty($cfwIn['siteName'])) {
			update_option('blogname', (string) $cfwIn['siteName']);
		}
		if (!empty($cfwIn['siteMail'])) {
			update_option('admin_email', (string) $cfwIn['siteMail']);
		} elseif ($cfwMail !== '') {
			update_option('admin_email', $cfwMail);
		}
		// the options the bake leaves behind point at its placeholder; the config constants already
		// win at read time, and this makes the stored rows true too
		// the owner supplied the address, so WordPress has nothing to ask them to confirm at login
		update_option('admin_email_lifespan', time() + 6 * MONTH_IN_SECONDS);
		update_option('siteurl', $cfwOrigin);
		update_option('home', $cfwOrigin);
		$cfwOut = [
			'ok' => true,
			'userId' => (int) $cfwId,
			'adminName' => $cfwLogin,
			'tookOver' => $cfwTakeover,
		];
	}
} catch (Throwable $e) {
	$cfwOut['error'] = get_class($e) . ': ' . $e->getMessage();
}
ob_end_clean();
echo json_encode($cfwOut, JSON_INVALID_UTF8_SUBSTITUTE);
