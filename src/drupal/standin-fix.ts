/**
 * Stand-ins for extensions the build does not carry, and declared degradations for functions a
 * Worker cannot honour.
 *
 * `ZipArchive`, `finfo` and `Transliterator` are classes in the `drupflare` module, aliased to the
 * global names by an autoloader on first use, so a subclass compiles against them the way it would
 * against the extension. `exif_read_data()`, the `finfo_*` functions and
 * `transliterator_transliterate()` are declared here and resolve the module class when called,
 * because this fragment runs before Drupal's autoloader exists.
 *
 * The degraded functions keep their names so feature detection still passes, and each call records
 * a status-report row through `Degradation::record()` instead of failing silently or fatally:
 *
 * - **sleep, usleep, time_nanosleep, time_sleep_until** wait through the park: the host awaits a
 *   timer, which bills no CPU. The clock does not advance inside a PHP run, so PHP cannot wait by
 *   itself. Past the invocation's allowance, or outside a parked run, a sleep returns at once.
 * - **uniqid** steps past the last id it returned. The built-in polls `gettimeofday()` until the
 *   microsecond changes, and on a clock that does not advance inside a run that poll never ends.
 * - **exec and the process family** answer as a failed launch. There is no process table.
 *
 * The real sleep and exec families are removed through `disable_functions` ({@link DISABLED}),
 * which in PHP 8 unregisters them so these declarations can bind.
 */

/** built-ins removed so the declarations below can take their names */
export const DISABLED = [
	'sleep',
	'usleep',
	'time_nanosleep',
	'time_sleep_until',
	'uniqid',
	'exec',
	'shell_exec',
	'system',
	'passthru',
	'proc_open',
	'popen',
	'pclose',
	'proc_get_status',
	'proc_close',
	'proc_terminate'
] as const;

/**
 * Operations a progressive batch runs in one request before it yields.
 *
 * Drupal yields after one second, and the clock reads 0 inside a run, so without a count every
 * batch ran to completion in one invocation. Twenty is small enough that a VBO or search index
 * batch of heavy operations stays well inside one invocation, and large enough that a batch of
 * cheap ones is not dominated by round trips.
 */
export const BATCH_YIELD_OPS = 20;

/**
 * The gd constants, copied from `Gd::CONSTANTS` in the drupflare module because this fragment runs
 * before any class can load. `standins.spec.ts` compares the two so a drift fails there.
 */
export const GD_CONSTANTS: Record<string, number> = {
	IMG_GIF: 1,
	IMG_JPG: 2,
	IMG_JPEG: 2,
	IMG_PNG: 4,
	IMG_WEBP: 32,
	IMG_BELL: 1,
	IMG_BESSEL: 2,
	IMG_BILINEAR_FIXED: 3,
	IMG_BICUBIC: 4,
	IMG_BICUBIC_FIXED: 5,
	IMG_BLACKMAN: 6,
	IMG_BOX: 7,
	IMG_BSPLINE: 8,
	IMG_CATMULLROM: 9,
	IMG_GAUSSIAN: 10,
	IMG_GENERALIZED_CUBIC: 11,
	IMG_HERMITE: 12,
	IMG_HAMMING: 13,
	IMG_HANNING: 14,
	IMG_MITCHELL: 15,
	IMG_NEAREST_NEIGHBOUR: 16,
	IMG_POWER: 17,
	IMG_QUADRATIC: 18,
	IMG_SINC: 19,
	IMG_TRIANGLE: 20,
	IMG_WEIGHTED4: 21
};

/** the gd functions routed to `Shim\Gd`: name, PHP parameters, and the arguments passed on */
export const GD_FUNCTIONS: readonly (readonly [string, string, string])[] = [
	['imagecreatefromstring', '$data', '$data'],
	['imagecreatefromjpeg', '$filename', '$filename'],
	['imagecreatefrompng', '$filename', '$filename'],
	['imagecreatefromwebp', '$filename', '$filename'],
	['imagecreatefromgif', '$filename', '$filename'],
	['imagecreatetruecolor', '$width, $height', '$width, $height'],
	['imagesx', '$image', '$image'],
	['imagesy', '$image', '$image'],
	['imagedestroy', '$image', '$image'],
	['imagealphablending', '$image, $enable', '$image, $enable'],
	['imagesavealpha', '$image, $enable', '$image, $enable'],
	[
		'imagecopyresampled',
		'$dst_image, $src_image, $dst_x, $dst_y, $src_x, $src_y, $dst_width, $dst_height, $src_width, $src_height',
		'$dst_image, $src_image, $dst_x, $dst_y, $src_x, $src_y, $dst_width, $dst_height, $src_width, $src_height'
	],
	[
		'imagecopyresized',
		'$dst_image, $src_image, $dst_x, $dst_y, $src_x, $src_y, $dst_width, $dst_height, $src_width, $src_height',
		'$dst_image, $src_image, $dst_x, $dst_y, $src_x, $src_y, $dst_width, $dst_height, $src_width, $src_height'
	],
	['imagescale', '$image, $width, $height = -1, $mode = 3', '$image, $width, $height, $mode'],
	['imagecrop', '$image, $rectangle', '$image, $rectangle'],
	[
		'imagerotate',
		'$image, $angle, $background_color = 0, $ignore_transparent = false',
		'$image, $angle, $background_color, $ignore_transparent'
	],
	['imagejpeg', '$image, $file = null, $quality = -1', '$image, $file, $quality'],
	[
		'imagepng',
		'$image, $file = null, $quality = -1, $filters = -1',
		'$image, $file, $quality, $filters'
	],
	['imagewebp', '$image, $file = null, $quality = -1', '$image, $file, $quality'],
	['imagegif', '$image, $file = null', '$image, $file']
];

const gdPhp = (): string => {
	const defines = Object.entries(GD_CONSTANTS)
		.map(([name, value]) => `\t\tif (!defined('${name}')) { define('${name}', ${value}); }`)
		.join('\n');
	const wrappers = GD_FUNCTIONS.map(
		([name, params, args]) =>
			`\t\tfunction ${name}(${params}) {\n` +
			`\t\t\tif (!class_exists('Drupal\\drupflare\\Shim\\Gd')) {\n` +
			`\t\t\t\tcfw_degraded('${name}', 'the drupflare module is not loaded, so there is no gd shim');\n` +
			`\t\t\t\treturn false;\n\t\t\t}\n` +
			`\t\t\treturn Drupal\\drupflare\\Shim\\Gd::${name}(${args});\n\t\t}`
	).join('\n');
	return `\tif (!extension_loaded('gd') && !function_exists('imagecreatefromstring')) {\n${defines}\n${wrappers}\n\t}`;
};

export const STANDIN_FIX = String.raw`
if (!function_exists('cfw_standins_installed')) {
	function cfw_standins_installed() { return true; }

	function cfw_degraded($capability, $why, $state = 'blocked') {
		if (class_exists('Drupal\drupflare\Degradation')) {
			Drupal\drupflare\Degradation::record($capability, $why, $state);
		}
	}

	/**
	 * Whether _batch_process() should end this request, read after every operation.
	 *
	 * Yields on the operation count or when the host reports the isolate near its ceiling,
	 * whichever comes first; memory_get_usage() reads 0 in this build, so the host is asked.
	 */
	function cfw_batch_yield($ops) {
		if ($ops >= ${BATCH_YIELD_OPS}) { return true; }
		$fn = function_exists('vrzno_env') ? vrzno_env('cfwStats') : null;
		$stats = $fn !== null ? json_decode($fn(), true) : null;
		return is_array($stats) && ($stats['oversized'] ?? false) === true;
	}

	/**
	 * The transport a Guzzle client built with no handler gets, read by the pack's chooseHandler().
	 */
	function cfw_guzzle_handler() {
		if (!class_exists('Drupal\drupflare\DrupflareServiceProvider')) { return null; }
		$class = Drupal\drupflare\DrupflareServiceProvider::pickHandlerClass();
		return new $class();
	}

	/**
	 * What a delivered symfony/http-client's HttpClient::create() answers with, once rewritten.
	 */
	function cfw_symfony_http_client($defaultOptions = []) {
		if (!class_exists('Drupal\drupflare\Http\SymfonyClient')) { return null; }
		return Drupal\drupflare\Http\SymfonyClient::create((array) $defaultOptions);
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
		function exif_read_data($file, $required_sections = null, $as_arrays = false, $read_thumbnail = false) {
			if (!class_exists('Drupal\drupflare\Shim\Exif')) {
				cfw_degraded('exif_read_data', 'the drupflare module is not loaded, so there is no Exif reader');
				return false;
			}
			return Drupal\drupflare\Shim\Exif::read($file, $required_sections, (bool) $as_arrays, (bool) $read_thumbnail);
		}
	}

	if (!function_exists('transliterator_transliterate')) {
		function transliterator_create($id, $direction = 0) {
			return class_exists('Transliterator') ? Transliterator::create((string) $id, (int) $direction) : null;
		}
		function transliterator_transliterate($transliterator, $string, $start = 0, $end = -1) {
			$t = is_object($transliterator) ? $transliterator : transliterator_create((string) $transliterator);
			return $t === null ? false : $t->transliterate((string) $string, (int) $start, (int) $end);
		}
	}

	if (!function_exists('finfo_open')) {
		if (!defined('FILEINFO_NONE')) { define('FILEINFO_NONE', 0); }
		if (!defined('FILEINFO_MIME_TYPE')) { define('FILEINFO_MIME_TYPE', 16); }
		if (!defined('FILEINFO_MIME_ENCODING')) { define('FILEINFO_MIME_ENCODING', 1024); }
		if (!defined('FILEINFO_MIME')) { define('FILEINFO_MIME', 1040); }
		if (!defined('FILEINFO_EXTENSION')) { define('FILEINFO_EXTENSION', 16777216); }
		function finfo_open($flags = 0, $magic_database = null) {
			return class_exists('finfo') ? new finfo((int) $flags) : false;
		}
		function finfo_file($finfo, $filename, $flags = 0, $context = null) {
			return $finfo->file((string) $filename, (int) $flags);
		}
		function finfo_buffer($finfo, $string, $flags = 0, $context = null) {
			return $finfo->buffer((string) $string, (int) $flags);
		}
		function finfo_set_flags($finfo, $flags) {
			return $finfo->set_flags((int) $flags);
		}
		function finfo_close($finfo) {
			return true;
		}
		function mime_content_type($filename) {
			$finfo = finfo_open(FILEINFO_MIME_TYPE);
			if ($finfo === false) { return false; }
			if (is_resource($filename)) {
				return $finfo->buffer((string) stream_get_contents($filename, -1, 0));
			}
			return $finfo->file((string) $filename);
		}
	}

	// #region gd, routed to the image engine
${gdPhp()}
	// #endregion

	// #region the sleep family, which waits through the park
	/**
	 * Waits through the host, or returns at once and records how short it fell.
	 *
	 * @return bool
	 *   Whether the whole wait happened.
	 */
	function cfw_sleep_ms($ms, $fn) {
		$ms = max(0, (int) ceil($ms));
		if ($ms === 0) { return true; }
		$waited = class_exists('Drupal\drupflare\Http\Park')
			? Drupal\drupflare\Http\Park::sleep($ms)
			: ['slept' => 0, 'remaining' => 0];
		if ($waited['slept'] >= $ms) { return true; }
		cfw_degraded(
			$fn,
			sprintf('asked to wait %d ms and waited %d ms: the wait runs through the host, and either no parked run was in progress or the invocation had %d ms of its waiting allowance left', $ms, $waited['slept'], $waited['remaining']),
			'untested'
		);
		return false;
	}
	if (!function_exists('sleep')) {
		function sleep($seconds) {
			cfw_sleep_ms($seconds * 1000, 'sleep');
			return 0;
		}
	}
	if (!function_exists('usleep')) {
		function usleep($microseconds) {
			cfw_sleep_ms($microseconds / 1000, 'usleep');
		}
	}
	if (!function_exists('time_nanosleep')) {
		function time_nanosleep($seconds, $nanoseconds) {
			cfw_sleep_ms($seconds * 1000 + $nanoseconds / 1e6, 'time_nanosleep');
			return true;
		}
	}
	if (!function_exists('time_sleep_until')) {
		function time_sleep_until($timestamp) {
			return cfw_sleep_ms(($timestamp - microtime(true)) * 1000, 'time_sleep_until');
		}
	}
	// #endregion

	// #region uniqid, which cannot wait for the clock to move
	if (!function_exists('uniqid')) {
		function uniqid(string $prefix = '', bool $more_entropy = false): string {
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
		function exec($command, &$output = null, &$result_code = null) {
			if (class_exists('Drupal\drupflare\Exec\Functions')) {
				return Drupal\drupflare\Exec\Functions::exec($command, $output, $result_code);
			}
			cfw_degraded('exec', 'a Worker has no process table, so no command can run');
			$output = is_array($output) ? $output : [];
			$result_code = 127;
			return false;
		}
	}
	if (!function_exists('shell_exec')) {
		function shell_exec($command) {
			if (class_exists('Drupal\drupflare\Exec\Functions')) {
				return Drupal\drupflare\Exec\Functions::shellExec($command);
			}
			cfw_degraded('shell_exec', 'a Worker has no process table, so no command can run');
			return false;
		}
	}
	if (!function_exists('system')) {
		function system($command, &$result_code = null) {
			if (class_exists('Drupal\drupflare\Exec\Functions')) {
				return Drupal\drupflare\Exec\Functions::system($command, $result_code);
			}
			cfw_degraded('system', 'a Worker has no process table, so no command can run');
			$result_code = 127;
			return false;
		}
	}
	if (!function_exists('passthru')) {
		function passthru($command, &$result_code = null) {
			if (class_exists('Drupal\drupflare\Exec\Functions')) {
				return Drupal\drupflare\Exec\Functions::passthru($command, $result_code);
			}
			cfw_degraded('passthru', 'a Worker has no process table, so no command can run');
			$result_code = 127;
			return false;
		}
	}
	if (!function_exists('proc_open')) {
		function proc_open($command, $descriptor_spec, &$pipes, $cwd = null, $env_vars = null, $options = null) {
			if (class_exists('Drupal\drupflare\Exec\Functions')) {
				return Drupal\drupflare\Exec\Functions::procOpen($command, $descriptor_spec, $pipes, $cwd, $env_vars, $options);
			}
			cfw_degraded('proc_open', 'a Worker cannot fork, so there is no child process');
			$pipes = [];
			return false;
		}
	}
	if (!function_exists('popen')) {
		function popen($command, $mode) {
			if (class_exists('Drupal\drupflare\Exec\Functions')) {
				return Drupal\drupflare\Exec\Functions::popen($command, $mode);
			}
			cfw_degraded('popen', 'a Worker cannot fork, so there is no child process');
			return false;
		}
	}
	if (!function_exists('pclose')) {
		function pclose($handle) {
			return class_exists('Drupal\drupflare\Exec\Functions')
				? Drupal\drupflare\Exec\Functions::pclose($handle)
				: -1;
		}
	}
	if (!function_exists('proc_get_status')) {
		function proc_get_status($process) {
			return class_exists('Drupal\drupflare\Exec\Functions')
				? Drupal\drupflare\Exec\Functions::procGetStatus($process)
				: false;
		}
	}
	if (!function_exists('proc_close')) {
		function proc_close($process) {
			return class_exists('Drupal\drupflare\Exec\Functions')
				? Drupal\drupflare\Exec\Functions::procClose($process)
				: -1;
		}
	}
	if (!function_exists('proc_terminate')) {
		function proc_terminate($process, $signal = 15) {
			return class_exists('Drupal\drupflare\Exec\Functions')
				? Drupal\drupflare\Exec\Functions::procTerminate($process, $signal)
				: false;
		}
	}
	// #endregion

}
`;
