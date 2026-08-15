/**
 * The instrument for durable files.
 *
 * A probe that cannot fail is not a probe. The reads here are NOT satisfiable from
 * anything the same request wrote in memory: `op=read` opens a fresh interpreter's view of storage,
 * and the caller drives it as a separate invocation after dropping the interpreter. A single
 * write-then-read inside one PHP run would pass with the bytes still sitting in a buffer.
 */
export const FILES_PROBE = String.raw`<?php
$out = ['ok' => true];

// which class the container bound. If this is not CfwFileStreamWrapper the override did not take,
// and everything below would be measuring MEMFS while looking like a pass.
try {
  $manager = \Drupal::service('stream_wrapper_manager');
  $public = $manager->getViaScheme('public');
  $out['publicClass'] = $public === false ? null : get_class($public);
  $private = $manager->getViaScheme('private');
  $out['privateClass'] = $private === false ? null : get_class($private);
  $out['schemes'] = array_keys($manager->getWrappers());
  // PHP-level registration is a separate step from the container binding, and leaving it out is
  // how this probe first reported a bound class and a failed write in the same breath. The
  // container knows stream_wrapper.public is our class; PHP does not know the public scheme
  // exists until StreamWrapperManager::register() calls stream_wrapper_register(). A real
  // request triggers that during kernel boot, so production is fine, a bare BOOT_KERNEL is not.
  //
  // no backticks anywhere in this file. It is a String.raw block, so one backtick in a PHP
  // comment ends the JavaScript literal, leaves the JS still valid, and breaks the PHP.
  $out['wrappersBefore'] = stream_get_wrappers();
  if (method_exists($manager, 'register')) {
    $manager->register();
  }
  $out['wrappersAfter'] = stream_get_wrappers();
} catch (\Throwable $e) {
  $out['managerError'] = $e->getMessage();
}

$op = $GLOBALS['__cfw_files_op'] ?? 'write';
$uri = $GLOBALS['__cfw_files_uri'] ?? 'public://cfw-probe/note.txt';
$out['op'] = $op;
$out['uri'] = $uri;

if ($op === 'write') {
  $body = $GLOBALS['__cfw_files_body'] ?? 'durable';
  // through Drupal's API, not through the wrapper class, so a container that ignored the override
  // is what fails rather than what gets bypassed
  $wrote = @file_put_contents($uri, $body);
  $out['bytesWritten'] = $wrote === false ? -1 : $wrote;
  $out['existsAfterWrite'] = @file_exists($uri);
  $out['sizeAfterWrite'] = @filesize($uri);
  $out['ok'] = $wrote !== false;
} elseif ($op === 'read') {
  $body = @file_get_contents($uri);
  $out['found'] = $body !== false;
  $out['body'] = $body === false ? null : $body;
  $out['bytes'] = $body === false ? -1 : strlen($body);
  $out['sha1'] = $body === false ? null : sha1($body);
  $out['ok'] = $body !== false;
} elseif ($op === 'unlink') {
  $out['unlinked'] = @unlink($uri);
  $out['existsAfter'] = @file_exists($uri);
  $out['ok'] = $out['unlinked'] === true && $out['existsAfter'] === false;
} elseif ($op === 'dir') {
  // is_dir() on a keyspace with no directory records is the case url_stat() has to synthesise
  $dir = dirname($uri);
  $out['isDir'] = @is_dir($dir);
  $names = [];
  $handle = @opendir($dir);
  if ($handle !== false) {
    while (($name = readdir($handle)) !== false) {
      $names[] = $name;
    }
    closedir($handle);
  }
  $out['entries'] = $names;
  $out['ok'] = $out['isDir'] === true;
} elseif ($op === 'url') {
  // the URL a theme or an image style would emit; a wrong one is a broken <img> rather than an error
  try {
    $out['externalUrl'] = \Drupal::service('file_url_generator')->generateString($uri);
  } catch (\Throwable $e) {
    $out['urlError'] = $e->getMessage();
  }
  $out['ok'] = isset($out['externalUrl']);
}

echo json_encode($out);
`;
