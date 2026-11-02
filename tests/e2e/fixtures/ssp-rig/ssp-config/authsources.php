<?php

$idp = \SimpleSAML\Metadata\SAMLParser::parseDescriptorsString(
	file_get_contents(__DIR__ . '/idp.xml'),
);

$config = [
	'default-sp' => [
		'saml:SP',
		'entityID' => 'urn:drupflare:ssp-rig',
		'idp' => array_key_first($idp),
		'privatekey' => 'sp.key',
		'certificate' => 'sp.crt',
		'sign.authnrequest' => true,
		'sign.logout' => true,
		'redirect.sign' => false,
		'validate.logout' => true,
		'WantAssertionsSigned' => true,
	],
];
