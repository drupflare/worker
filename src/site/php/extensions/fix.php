<?php

if (!function_exists('cfw_extensions_installed')) {
	function cfw_extensions_installed(): bool
	{
		return true;
	}

	// __CFW_EXTENSION_TABLE__

	/**
	 * @param string $extension
	 *   An extension name, in any case.
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
	 * @param string $extension
	 *   An extension name, in any case.
	 *
	 * @return array<int, string>|false
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
