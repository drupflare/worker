<?php

use Drupal\drupflare\Degradation;
use Drupal\drupflare\Shim\CurlShim;

if (!extension_loaded('curl') && !function_exists('cfw_curl_installed')) {
	// __CFW_CURL_OPTIONS__
	// __CFW_CURL_INERT__

	function cfw_curl_installed(): bool
	{
		return true;
	}

	/**
	 * The one shim instance, resolved on FIRST USE rather than at declaration time.
	 *
	 * This fragment runs from ensurePhp(), which is before Drupal's autoloader exists, so a
	 * class_exists() guard around the declarations would never pass and the functions would
	 * never be declared at all. Resolving here instead means the class is looked up when a
	 * caller actually makes a request, by which time the module is loaded.
	 *
	 * @return CurlShim|null
	 *   NULL when the module is not loaded, which every caller below treats as a refusal.
	 */
	function cfw_curl_shim()
	{
		static $shim = null;
		if ($shim === null && class_exists(CurlShim::class)) {
			$shim = new CurlShim();
		}
		return $shim;
	}

	/**
	 * Declares the gap once, then answers the way curl answers a connection it cannot make.
	 *
	 * Never silently absent. Without the module there is no queue to defer into, so the
	 * honest answer is the same FALSE a caller already handles -- but an operator gets a
	 * status-report row saying why instead of an unexplained failure.
	 */
	function cfw_curl_absent(): false
	{
		if (class_exists(Degradation::class)) {
			Degradation::record(
				'curl_*',
				'the drupflare module is not loaded, so there is no deferred-HTTP queue to route curl through',
			);
		}
		return false;
	}

	/**
	 * @param string|null $url
	 *   The URL to request, or NULL to set it later.
	 *
	 * @return array<string, mixed>|false
	 *   The opaque handle, or FALSE when the shim is unavailable.
	 */
	function curl_init($url = null)
	{
		$shim = cfw_curl_shim();
		if ($shim === null) {
			return cfw_curl_absent();
		}
		return $shim->init($url === null ? null : (string) $url);
	}

	/**
	 * @param array<mixed>|false $handle
	 *   The handle curl_init() returned.
	 * @param int $option
	 *   A CURLOPT_* constant.
	 * @param mixed $value
	 *   The option value.
	 *
	 * @return bool
	 */
	function curl_setopt(&$handle, $option, $value)
	{
		$shim = cfw_curl_shim();
		if ($shim === null || !is_array($handle)) {
			return cfw_curl_absent();
		}
		return $shim->setopt($handle, (int) $option, $value);
	}

	/**
	 * @param array<mixed>|false $handle
	 *   The handle curl_init() returned.
	 * @param array<int, mixed> $options
	 *   CURLOPT_* constants mapped to their values.
	 *
	 * @return bool
	 */
	function curl_setopt_array(&$handle, $options)
	{
		$shim = cfw_curl_shim();
		if ($shim === null || !is_array($handle)) {
			return cfw_curl_absent();
		}
		return $shim->setoptArray($handle, (array) $options);
	}

	/**
	 * @param array<mixed>|false $handle
	 *   The handle curl_init() returned.
	 *
	 * @return string|bool
	 */
	function curl_exec(&$handle)
	{
		$shim = cfw_curl_shim();
		if ($shim === null || !is_array($handle)) {
			return cfw_curl_absent();
		}
		return $shim->exec($handle);
	}

	/**
	 * @param array<mixed>|false $handle
	 *   The handle curl_init() returned.
	 * @param int|null $key
	 *   A CURLINFO_* constant, or NULL for every field.
	 *
	 * @return mixed
	 */
	function curl_getinfo($handle, $key = null)
	{
		$shim = cfw_curl_shim();
		if ($shim === null || !is_array($handle)) {
			return cfw_curl_absent();
		}
		return $shim->getinfo($handle, $key);
	}

	/**
	 * @param array<mixed>|false $handle
	 *   The handle curl_init() returned.
	 */
	function curl_reset(&$handle)
	{
		$shim = cfw_curl_shim();
		if ($shim !== null && is_array($handle)) {
			$shim->reset($handle);
		}
	}

	/**
	 * @param array<mixed>|false $handle
	 *   The handle curl_init() returned.
	 *
	 * @return int
	 */
	function curl_errno($handle)
	{
		$shim = cfw_curl_shim();
		// 7 is CURLE_COULDNT_CONNECT, which is what "there was no transport" really is
		if ($shim === null || !is_array($handle)) {
			return 7;
		}
		return $shim->errno($handle);
	}

	/**
	 * @param array<mixed>|false $handle
	 *   The handle curl_init() returned.
	 *
	 * @return string
	 */
	function curl_error($handle)
	{
		$shim = cfw_curl_shim();
		if ($shim === null || !is_array($handle)) {
			return 'drupflare: curl shim unavailable';
		}
		return $shim->error($handle);
	}

	/**
	 * @param array<mixed>|false $handle
	 *   The handle curl_init() returned.
	 */
	function curl_close(&$handle)
	{
		$shim = cfw_curl_shim();
		if ($shim !== null && is_array($handle)) {
			$shim->close($handle);
		}
	}

	/**
	 * Reports a version the way ext-curl does, so a caller's feature test has something to read.
	 *
	 * The version string names this shim rather than a curl release: a caller comparing against
	 * a real curl version must not conclude a feature is present because the number looked new
	 * enough.
	 *
	 * @return array<string, mixed>
	 */
	function curl_version(): array
	{
		return [
			'version' => '0.0.0-drupflare-shim',
			'version_number' => 0,
			'features' => 0,
			'ssl_version' => '',
			'protocols' => ['http', 'https'],
		];
	}
}
