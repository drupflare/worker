<?php

use Drupal\drupflare\Degradation;
use Drupal\drupflare\DrupflareServiceProvider;
use Drupal\drupflare\Exec\Functions;
use Drupal\drupflare\Http\Park;
use Drupal\drupflare\Http\SymfonyClient;
use Drupal\drupflare\Shim\Exif;

if (!function_exists('cfw_standins_installed')) {
	function cfw_standins_installed(): bool
	{
		return true;
	}

	/**
	 * @param string $capability
	 *   The capability that degraded.
	 * @param string $why
	 *   Why it did.
	 * @param string $state
	 *   The module table's word for it: verified, untested or blocked.
	 */
	function cfw_degraded($capability, $why, $state = 'blocked'): void
	{
		if (class_exists(Degradation::class)) {
			Degradation::record($capability, $why, $state);
		}
	}

	/**
	 * Whether _batch_process() should end this request, read after every operation.
	 *
	 * Yields on the operation count or when the host reports the isolate near its ceiling,
	 * whichever comes first; memory_get_usage() reads 0 in this build, so the host is asked.
	 *
	 * @param int $ops
	 *   Operations run so far in this request.
	 */
	function cfw_batch_yield($ops): bool
	{
		if ($ops >= 20) {
			return true;
		}
		$fn = function_exists('vrzno_env') ? vrzno_env('cfwStats') : null;
		$stats = $fn !== null ? json_decode($fn(), true) : null;
		return is_array($stats) && ($stats['oversized'] ?? false) === true;
	}

	/**
	 * The transport a Guzzle client built with no handler gets, read by the pack's chooseHandler().
	 *
	 * @return object|null
	 *   A handler, or NULL when the drupflare module is not loaded.
	 */
	function cfw_guzzle_handler()
	{
		if (!class_exists(DrupflareServiceProvider::class)) {
			return null;
		}
		$class = DrupflareServiceProvider::pickHandlerClass();
		return new $class();
	}

	/**
	 * What a delivered symfony/http-client's HttpClient::create() answers with, once rewritten.
	 *
	 * @param array<string, mixed> $defaultOptions
	 *   The options the caller passed to create().
	 *
	 * @return object|null
	 *   A client, or NULL when the drupflare module is not loaded.
	 */
	function cfw_symfony_http_client($defaultOptions = [])
	{
		if (!class_exists(SymfonyClient::class)) {
			return null;
		}
		return SymfonyClient::create((array) $defaultOptions);
	}

	spl_autoload_register(static function ($class) {
		$map = [
			'ziparchive' => 'Drupal\drupflare\Shim\ZipArchive',
			'finfo' => 'Drupal\drupflare\Shim\Finfo',
			'transliterator' => 'Drupal\drupflare\Shim\Transliterator',
			'gdimage' => 'Drupal\drupflare\Shim\GdImage',
		];
		$target = $map[strtolower(ltrim($class, '\\'))] ?? null;
		if ($target !== null && class_exists($target)) {
			class_alias($target, $class);
		}
	});

	if (!function_exists('exif_read_data')) {
		/**
		 * @param string|resource $file
		 *   A path or an open stream.
		 * @param string|null $required_sections
		 *   Comma-separated sections the result must carry.
		 * @param bool $as_arrays
		 *   Return sections as arrays.
		 * @param bool $read_thumbnail
		 *   Also read the embedded thumbnail.
		 *
		 * @return array<string, mixed>|false
		 */
		function exif_read_data(
			$file,
			$required_sections = null,
			$as_arrays = false,
			$read_thumbnail = false,
		) {
			if (!class_exists(Exif::class)) {
				cfw_degraded(
					'exif_read_data',
					'the drupflare module is not loaded, so there is no Exif reader',
				);
				return false;
			}
			return Exif::read($file, $required_sections, (bool) $as_arrays, (bool) $read_thumbnail);
		}
	}

	if (!function_exists('transliterator_transliterate')) {
		/**
		 * @param string $id
		 *   A transliterator rule id.
		 * @param int $direction
		 *   0 for forward.
		 *
		 * @return object|null
		 */
		function transliterator_create($id, $direction = 0)
		{
			return class_exists('Transliterator')
				? Transliterator::create((string) $id, (int) $direction)
				: null;
		}
		/**
		 * @param object|string $transliterator
		 *   A transliterator or a rule id.
		 * @param string $string
		 *   The text to transliterate.
		 * @param int $start
		 *   First byte to transliterate.
		 * @param int $end
		 *   One past the last byte, or -1 for the rest.
		 *
		 * @return string|false
		 */
		function transliterator_transliterate($transliterator, $string, $start = 0, $end = -1)
		{
			$t = is_object($transliterator)
				? $transliterator
				: transliterator_create((string) $transliterator);
			return $t === null
				? false
				: $t->transliterate((string) $string, (int) $start, (int) $end);
		}
	}

	if (!function_exists('finfo_open')) {
		if (!defined('FILEINFO_NONE')) {
			define('FILEINFO_NONE', 0);
		}
		if (!defined('FILEINFO_MIME_TYPE')) {
			define('FILEINFO_MIME_TYPE', 16);
		}
		if (!defined('FILEINFO_MIME_ENCODING')) {
			define('FILEINFO_MIME_ENCODING', 1024);
		}
		if (!defined('FILEINFO_MIME')) {
			define('FILEINFO_MIME', 1040);
		}
		if (!defined('FILEINFO_EXTENSION')) {
			define('FILEINFO_EXTENSION', 16777216);
		}
		/**
		 * @param int $flags
		 *   FILEINFO_* flags.
		 * @param string|null $magic_database
		 *   Ignored.
		 *
		 * @return object|false
		 */
		function finfo_open($flags = 0, $magic_database = null)
		{
			return class_exists('finfo') ? new finfo((int) $flags) : false;
		}
		/**
		 * @param object $finfo
		 *   The finfo instance.
		 * @param string $filename
		 *   A path.
		 * @param int $flags
		 *   FILEINFO_* flags.
		 * @param resource|null $context
		 *   Ignored.
		 *
		 * @return string|false
		 */
		function finfo_file($finfo, $filename, $flags = 0, $context = null)
		{
			return $finfo->file((string) $filename, (int) $flags);
		}
		/**
		 * @param object $finfo
		 *   The finfo instance.
		 * @param string $string
		 *   The bytes to inspect.
		 * @param int $flags
		 *   FILEINFO_* flags.
		 * @param resource|null $context
		 *   Ignored.
		 *
		 * @return string|false
		 */
		function finfo_buffer($finfo, $string, $flags = 0, $context = null)
		{
			return $finfo->buffer((string) $string, (int) $flags);
		}
		/**
		 * @param object $finfo
		 *   The finfo instance.
		 * @param int $flags
		 *   FILEINFO_* flags.
		 */
		function finfo_set_flags($finfo, $flags)
		{
			return $finfo->set_flags((int) $flags);
		}
		/**
		 * @param object $finfo
		 *   The finfo instance.
		 */
		function finfo_close($finfo): bool
		{
			return true;
		}
		/**
		 * @param string|resource $filename
		 *   A path or an open stream.
		 *
		 * @return string|false
		 */
		function mime_content_type($filename)
		{
			$finfo = finfo_open(FILEINFO_MIME_TYPE);
			if ($finfo === false) {
				return false;
			}
			if (is_resource($filename)) {
				return $finfo->buffer((string) stream_get_contents($filename, -1, 0));
			}
			return $finfo->file((string) $filename);
		}
	}

	// #region gd, routed to the image engine
	// __CFW_GD__
	// #endregion

	// #region the sleep family, which waits through the park
	/**
	 * Waits through the host, or returns at once and records how short it fell.
	 *
	 * @param float|int $ms
	 *   How long to wait, in milliseconds.
	 * @param string $fn
	 *   The PHP function the caller used, for the degradation row.
	 *
	 * @return bool
	 *   Whether the whole wait happened.
	 */
	function cfw_sleep_ms($ms, $fn): bool
	{
		$ms = max(0, (int) ceil($ms));
		if ($ms === 0) {
			return true;
		}
		$waited = class_exists(Park::class) ? Park::sleep($ms) : ['slept' => 0, 'remaining' => 0];
		if ($waited['slept'] >= $ms) {
			return true;
		}
		cfw_degraded(
			$fn,
			sprintf(
				'asked to wait %d ms and waited %d ms: the wait runs through the host, and either no parked run was in progress or the invocation had %d ms of its waiting allowance left',
				$ms,
				$waited['slept'],
				$waited['remaining'],
			),
			'untested',
		);
		return false;
	}
	if (!function_exists('sleep')) {
		/** @param int $seconds */
		function sleep($seconds): int
		{
			cfw_sleep_ms($seconds * 1000, 'sleep');
			return 0;
		}
	}
	if (!function_exists('usleep')) {
		/** @param int $microseconds */
		function usleep($microseconds): void
		{
			cfw_sleep_ms($microseconds / 1000, 'usleep');
		}
	}
	if (!function_exists('time_nanosleep')) {
		/**
		 * @param int $seconds
		 *   Whole seconds.
		 * @param int $nanoseconds
		 *   Nanoseconds past the seconds.
		 */
		function time_nanosleep($seconds, $nanoseconds): bool
		{
			cfw_sleep_ms($seconds * 1000 + $nanoseconds / 1e6, 'time_nanosleep');
			return true;
		}
	}
	if (!function_exists('time_sleep_until')) {
		/** @param float $timestamp */
		function time_sleep_until($timestamp): bool
		{
			return cfw_sleep_ms(($timestamp - microtime(true)) * 1000, 'time_sleep_until');
		}
	}
	// #endregion

	// #region uniqid, which cannot wait for the clock to move
	if (!function_exists('uniqid')) {
		function uniqid(string $prefix = '', bool $more_entropy = false): string
		{
			// function-static, so it stays ahead across runs the way the C prev_tv did
			static $last = 0;
			$last = max((int) floor(microtime(true) * 1000000), $last + 1);
			$id = sprintf('%s%08x%05x', $prefix, intdiv($last, 1000000), $last % 1000000);
			return $more_entropy ? $id . sprintf('%.8F', random_int(0, 999999999) / 1e8) : $id;
		}
	}
	// #endregion

	// #region the process family, which the exec router answers and which otherwise fails like a failed launch
	if (!function_exists('exec')) {
		/**
		 * @param string $command
		 *   The command line.
		 * @param array<string>|null $output
		 *   Set to the output lines.
		 * @param int|null $result_code
		 *   Set to the exit code.
		 *
		 * @return string|false
		 */
		function exec($command, &$output = null, &$result_code = null)
		{
			if (class_exists(Functions::class)) {
				return Functions::exec($command, $output, $result_code);
			}
			cfw_degraded('exec', 'a Worker has no process table, so no command can run');
			if (!is_array($output)) {
				$output = [];
			}
			$result_code = 127;
			return false;
		}
	}
	if (!function_exists('shell_exec')) {
		/**
		 * @param string $command
		 *   The command line.
		 *
		 * @return string|false|null
		 */
		function shell_exec($command)
		{
			if (class_exists(Functions::class)) {
				return Functions::shellExec($command);
			}
			cfw_degraded('shell_exec', 'a Worker has no process table, so no command can run');
			return false;
		}
	}
	if (!function_exists('system')) {
		/**
		 * @param string $command
		 *   The command line.
		 * @param int|null $result_code
		 *   Set to the exit code.
		 *
		 * @return string|false
		 */
		function system($command, &$result_code = null)
		{
			if (class_exists(Functions::class)) {
				return Functions::system($command, $result_code);
			}
			cfw_degraded('system', 'a Worker has no process table, so no command can run');
			$result_code = 127;
			return false;
		}
	}
	if (!function_exists('passthru')) {
		/**
		 * @param string $command
		 *   The command line.
		 * @param int|null $result_code
		 *   Set to the exit code.
		 *
		 * @return false|null
		 */
		function passthru($command, &$result_code = null)
		{
			if (class_exists(Functions::class)) {
				return Functions::passthru($command, $result_code);
			}
			cfw_degraded('passthru', 'a Worker has no process table, so no command can run');
			$result_code = 127;
			return false;
		}
	}
	if (!function_exists('proc_open')) {
		/**
		 * @param array<int, string>|string $command
		 *   The command line.
		 * @param array<int, mixed> $descriptor_spec
		 *   The pipes to open.
		 * @param array<int, resource> $pipes
		 *   Set to the opened pipes.
		 * @param string|null $cwd
		 *   Working directory.
		 * @param array<string, string>|null $env_vars
		 *   Environment.
		 * @param array<string, mixed>|null $options
		 *   Platform options.
		 *
		 * @return resource|false
		 */
		function proc_open(
			$command,
			$descriptor_spec,
			&$pipes,
			$cwd = null,
			$env_vars = null,
			$options = null,
		) {
			if (class_exists(Functions::class)) {
				return Functions::procOpen(
					$command,
					$descriptor_spec,
					$pipes,
					$cwd,
					$env_vars,
					$options,
				);
			}
			cfw_degraded('proc_open', 'a Worker cannot fork, so there is no child process');
			$pipes = [];
			return false;
		}
	}
	if (!function_exists('popen')) {
		/**
		 * @param string $command
		 *   The command line.
		 * @param string $mode
		 *   r or w.
		 *
		 * @return resource|false
		 */
		function popen($command, $mode)
		{
			if (class_exists(Functions::class)) {
				return Functions::popen($command, $mode);
			}
			cfw_degraded('popen', 'a Worker cannot fork, so there is no child process');
			return false;
		}
	}
	if (!function_exists('pclose')) {
		/** @param resource $handle */
		function pclose($handle): int
		{
			return class_exists(Functions::class) ? Functions::pclose($handle) : -1;
		}
	}
	if (!function_exists('proc_get_status')) {
		/**
		 * @param resource $process
		 *   A handle from proc_open().
		 *
		 * @return array<string, mixed>|false
		 */
		function proc_get_status($process)
		{
			return class_exists(Functions::class) ? Functions::procGetStatus($process) : false;
		}
	}
	if (!function_exists('proc_close')) {
		/** @param resource $process */
		function proc_close($process): int
		{
			return class_exists(Functions::class) ? Functions::procClose($process) : -1;
		}
	}
	if (!function_exists('proc_terminate')) {
		/**
		 * @param resource $process
		 *   A handle from proc_open().
		 * @param int $signal
		 *   The signal number.
		 */
		function proc_terminate($process, $signal = 15): bool
		{
			return class_exists(Functions::class)
				? Functions::procTerminate($process, $signal)
				: false;
		}
	}
	// #endregion
}
