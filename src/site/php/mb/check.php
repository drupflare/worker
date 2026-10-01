<?php
if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
	$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
}

$cases = [
	'ascii' => 'abc',
	'valid accented' => "caf\xc3\xa9",
	'valid CJK' => "\xe4\xbd\xa0\xe5\xa5\xbd",
	'valid astral emoji' => "\xf0\x9f\x98\x80",
	'two bad bytes' => "abc\xff\xfedef",
	'lone continuation' => "abc\x80def",
	'truncated 3-byte end' => "abc\xe4\xbd",
	'truncated 3-byte mid' => "abc\xe4\xbddef",
	'overlong C0' => "abc\xc0\xafdef",
	'surrogate ED A0 80' => "abc\xed\xa0\x80def",
	'truncated 4-byte mid' => "abc\xf0\x9fdef",
	'F5 out of range' => "abc\xf5\x80\x80\x80def",
];

$out = [
	'mbstringExtension' => extension_loaded('mbstring'),
	'iconvExtension' => extension_loaded('iconv'),
	'wrappersInstalled' => function_exists('cfw_mb_installed'),
	'sanitizerPresent' => function_exists('cfw_mb_sanitize'),
	'cases' => [],
];

foreach ($cases as $label => $raw) {
	$out['cases'][$label] = [
		'in' => bin2hex($raw),
		'mb_substr' => mb_substr($raw, 0, 100000),
		'mb_strlen' => mb_strlen($raw),
		'mb_strtolower' => mb_strtolower($raw),
		// must NOT be sanitised: an invalid string has to still report invalid
		'mb_check_encoding' => mb_check_encoding($raw, 'UTF-8'),
	];
}

echo json_encode($out);
