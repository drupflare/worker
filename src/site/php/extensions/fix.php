<?php

if (!function_exists('cfw_extensions_installed')) {
	/**
	 * Marks that the extension functions below are in place.
	 *
	 * @return bool
	 *   Always TRUE.
	 */
	function cfw_extensions_installed(): bool
	{
		return true;
	}

	// __CFW_EXTENSION_TABLE__

	/**
	 * Tells whether an extension is loaded, counting the gated shims.
	 *
	 * @param string $extension
	 *   An extension name, in any case.
	 *
	 * @return bool
	 *   TRUE when the extension is built in or a gated shim covers its whole API.
	 */
	function extension_loaded($extension): bool
	{
		static $seen = [];
		$key = strtolower((string) $extension);
		if (isset($GLOBALS['__cfw_ext_shims'][$key])) {
			return true;
		}
		if (!isset($seen[$key])) {
			try {
				new ReflectionExtension($key);
				$seen[$key] = true;
			} catch (ReflectionException $e) {
				$seen[$key] = false;
			}
		}
		return $seen[$key];
	}

	/**
	 * Answers from a catalog of extension names, because the built-in that listed them is gone.
	 *
	 * @param bool $zend_extensions
	 *   Whether to list Zend extensions instead.
	 *
	 * @return array<int, string>
	 *   The extension names.
	 */
	function get_loaded_extensions($zend_extensions = false): array
	{
		if ($zend_extensions) {
			try {
				new ReflectionZendExtension('Zend OPcache');
				return ['Zend OPcache'];
			} catch (ReflectionException $e) {
				return [];
			}
		}
		$out = [];
		foreach ($GLOBALS['__cfw_ext_catalog'] as $name) {
			if (extension_loaded($name)) {
				$out[] = $name;
			}
		}
		foreach ($GLOBALS['__cfw_ext_shims'] as $name => $funcs) {
			if (!in_array($name, array_map('strtolower', $out), true)) {
				$out[] = $name;
			}
		}
		return $out;
	}

	/**
	 * Lists the functions an extension provides, counting the gated shims.
	 *
	 * @param string $extension
	 *   An extension name, in any case.
	 *
	 * @return array<int, string>|false
	 *   The function names, or FALSE when the extension is unknown or has none.
	 */
	function get_extension_funcs($extension)
	{
		$key = strtolower((string) $extension);
		if (isset($GLOBALS['__cfw_ext_shims'][$key])) {
			return $GLOBALS['__cfw_ext_shims'][$key];
		}
		try {
			$funcs = array_keys((new ReflectionExtension($key))->getFunctions());
		} catch (ReflectionException $e) {
			return false;
		}
		return $funcs === [] ? false : $funcs;
	}
}
