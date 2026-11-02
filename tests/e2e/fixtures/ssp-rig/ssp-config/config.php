<?php

$origin = \Drupal::request()->getSchemeAndHttpHost();

$config = [
	'baseurlpath' => $origin . '/simplesaml/',
	'secretsalt' => 'ssp-rig-salt-not-a-secret',
	'technicalcontact_name' => 'rig',
	'technicalcontact_email' => 'rig@example.invalid',
	'timezone' => 'UTC',
	'logging.level' => \SimpleSAML\Logger::DEBUG,
	'logging.handler' => 'errorlog',
	'store.type' => 'Drupal\drupflare\SimpleSaml\DatabaseStore',
	'certdir' => __DIR__ . '/cert/',
	'cachedir' => '/tmp/ssp-rig/cache',
	'tempdir' => '/tmp/ssp-rig/tmp',
	'loggingdir' => '/tmp/ssp-rig/log',
	'metadatadir' => __DIR__,
	'metadata.sources' => [['type' => 'flatfile', 'directory' => __DIR__]],
	'session.cookie.secure' => false,
	'session.cookie.samesite' => null,
	'module.enable' => ['core' => true, 'saml' => true, 'admin' => false],
];
