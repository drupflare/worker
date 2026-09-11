<?php
/**
 * Evicts nginx's cached copies of the URIs a content save affects.
 *
 * `ngx_cache_purge` is a third-party module and the official `nginx:alpine` image does not carry
 * it, so the purge removes the cache ENTRIES instead: the zone is a shared volume, and nginx writes
 * the cache key into each file, so the file for a URI can be found by its key rather than by
 * re-deriving the md5 of `$scheme$request_method$host$request_uri` and hoping the derivation
 * matches. Finding by key is also what makes this robust to a change in `fastcgi_cache_key`.
 *
 * Scoped rather than wholesale: emptying the zone on every save is correct but throws away every
 * unrelated page, which is the cost a competent operator tunes away. The set below is what a node
 * save actually changes on this site -- the front page, the listing, and the node's own URL.
 *
 * @param string $dir    the `fastcgi_cache_path` root
 * @param array  $uris   request URIs to evict
 * @return int           entries removed
 */
function cfw_vps_purge(string $dir, array $uris, string $host = '127.0.0.1'): int
{
	if (!is_dir($dir)) {
		return 0;
	}
	$wanted = [];
	foreach ($uris as $uri) {
		// the key nginx stores, from `fastcgi_cache_key "$scheme$request_method$host$request_uri"`
		$wanted[] = 'KEY: http' . 'GET' . $host . $uri;
	}
	$removed = 0;
	$it = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
	);
	foreach ($it as $file) {
		if (!$file->isFile()) {
			continue;
		}
		// the key sits in the first few hundred bytes; reading the whole body would make a purge
		// proportional to the size of the cache rather than to the number of entries
		$head = @file_get_contents($file->getPathname(), false, null, 0, 1024);
		if ($head === false) {
			continue;
		}
		foreach ($wanted as $key) {
			if (strpos($head, $key) !== false) {
				if (@unlink($file->getPathname())) {
					$removed++;
				}
				break;
			}
		}
	}
	return $removed;
}
