<?php

// __CFW_ICONV_STRRPOS__

if (!extension_loaded('iconv')) {
	/**
	 * @param string $haystack
	 *   The text to search.
	 * @param string $needle
	 *   What to look for.
	 * @param string|null $encoding
	 *   The charset of both, or NULL for the polyfill's internal one.
	 *
	 * @return int|false
	 */
	function iconv_strrpos($haystack, $needle, $encoding = null)
	{
		return cfw_iconv_strrpos($haystack, $needle, $encoding);
	}
}
