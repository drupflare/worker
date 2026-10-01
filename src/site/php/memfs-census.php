<?php
// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
$root = json_decode(__CFW_ROOT__);
$out = ['root' => $root, 'files' => 0, 'dirs' => 0, 'bytes' => 0, 'bin' => 0];

try {
	if (is_dir($root)) {
		$it = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
			RecursiveIteratorIterator::SELF_FIRST,
		);
		foreach ($it as $entry) {
			if ($entry->isDir()) {
				$out['dirs']++;
				continue;
			}
			$out['files']++;
			$out['bytes'] += (int) $entry->getSize();
			if (substr($entry->getFilename(), -4) === '.bin') {
				$out['bin']++;
			}
		}
	}
	$out['opcacheEnabled'] = (int) ini_get('opcache.enable');
	$out['fileCacheOnly'] = (int) ini_get('opcache.file_cache_only');
	$out['opcacheLoaded'] = extension_loaded('Zend OPcache');
	if (function_exists('opcache_get_status')) {
		$status = @opcache_get_status(false);
		$out['opcacheStatus'] = is_array($status)
			? [
				'enabled' => $status['opcache_enabled'] ?? null,
				'scripts' => $status['opcache_statistics']['num_cached_scripts'] ?? null,
			]
			: null;
	}
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}

echo json_encode($out);
