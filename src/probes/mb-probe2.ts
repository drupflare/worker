/**
 * MB_PROBE2, copied verbatim out of src/memtest.js so a build variant can be
 * probed without touching the worker that recorded the original divergences.
 * The same source runs natively via scripts/mb-probe2-native.php, so wasm and
 * native cannot drift.
 */
export const MB_PROBE2 = String.raw`<?php
$f = function (): string {
  $root = defined('MB_ROOT') ? MB_ROOT : '/drupal';
  chdir($root);
  require $root . '/autoload.php';

  $r = [
    'ext' => [
      'mbstring' => extension_loaded('mbstring'),
      'iconv' => extension_loaded('iconv'),
      'intl' => extension_loaded('intl'),
    ],
  ];

  // the exact functions Drupal 11 core calls
  $core = [
    'mb_strtolower', 'mb_substr', 'mb_strlen', 'mb_strtoupper',
    'mb_convert_encoding', 'mb_chr', 'mb_language', 'mb_internal_encoding',
    'mb_check_encoding', 'mb_strpos', 'mb_stripos', 'mb_ord',
    'mb_detect_encoding', 'mb_convert_case',
  ];
  foreach ($core as $fn) {
    $r['coreFns'][$fn] = function_exists($fn);
  }

  // which char makes mb_strwidth disagree
  $chars = [
    'ascii_a' => 'a',
    'latin_e_acute' => "\u{e9}",
    'combining_acute' => "e\u{0301}",
    'cjk_ni' => "\u{4f60}",
    'fullwidth_A' => "\u{ff21}",
    'emoji_grin' => "\u{1f600}",
    'cyrillic_i' => "\u{439}",
  ];
  foreach ($chars as $k => $c) {
    $r['strwidth'][$k] = mb_strwidth($c);
    $r['strlen_per_char'][$k] = mb_strlen($c);
  }

  // invalid UTF-8: the case that silently corrupts content
  $bad = [
    'ff_fe_middle' => "abc\xff\xfedef",
    'lone_continuation' => "abc\x80def",
    'truncated_3byte' => "abc\xe4\xbd",
    'overlong' => "abc\xc0\xafdef",
    'surrogate' => "abc\xed\xa0\x80def",
  ];
  foreach ($bad as $k => $s) {
    $r['invalid'][$k] = [
      'bytes' => strlen($s),
      'mb_strlen' => mb_strlen($s),
      'mb_check_encoding' => mb_check_encoding($s, 'UTF-8'),
      'mb_substr_0_5' => bin2hex(mb_substr($s, 0, 5)),
      'mb_substr_all' => bin2hex(mb_substr($s, 0, 100)),
      'mb_strtolower' => bin2hex(mb_strtolower($s)),
      'mb_convert_utf8' => bin2hex(mb_convert_encoding($s, 'UTF-8', 'UTF-8')),
    ];
  }

  // Greek final sigma is contextual lowercasing
  $greek = [
    'ODOS' => "\u{39f}\u{394}\u{39f}\u{3a3}",
    'SIGMA_alone' => "\u{3a3}",
    'SIGMA_mid' => "\u{3a3}\u{391}",
    'ASH' => "\u{391}\u{3a3}\u{397}",
  ];
  foreach ($greek as $k => $s) {
    $r['greek'][$k] = [
      'lower' => bin2hex(mb_strtolower($s)),
      'upper' => bin2hex(mb_strtoupper($s)),
      'title' => bin2hex(mb_convert_case($s, MB_CASE_TITLE, 'UTF-8')),
    ];
  }

  // mb_chr / mb_ord round trip over the planes
  foreach ([65, 233, 0x4f60, 0x1f600, 0x10FFFF] as $cp) {
    $ch = mb_chr($cp, 'UTF-8');
    $r['chr_ord'][$cp] = [
      'chr' => $ch === false ? false : bin2hex($ch),
      'ord' => $ch === false ? false : mb_ord($ch, 'UTF-8'),
    ];
  }

  $r['mb_language_uni'] = mb_language('uni');
  $r['mb_language_get'] = mb_language();
  $r['mb_internal_encoding_get'] = mb_internal_encoding();

  $U = 'Drupal\Component\Utility\Unicode';
  $r['unicode_check'] = $U::check();
  $r['unicode_getStatus'] = $U::getStatus();
  $r['unicode_STATUS_MULTIBYTE'] = $U::STATUS_MULTIBYTE;

  return json_encode($r);
};
echo $f();`;
