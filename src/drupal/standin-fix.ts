/**
 * Stand-ins for extensions the build does not carry, and declared degradations for functions a
 * Worker cannot honour.
 *
 * `ZipArchive`, `finfo` and `Transliterator` are classes in the `drupflare` module, aliased to the
 * global names by an autoloader on first use. `exif_read_data()`, the `finfo_*` functions and
 * `transliterator_transliterate()` are declared here and resolve the module class when called,
 * because this fragment runs before Drupal's autoloader exists.
 * @module
 */

import { STANDIN_FIX_PHP } from '../site/generated/assets';
import { renderTemplate } from '../util/template';

/**
 * Built-ins removed through `disable_functions` (PHP 8 unregisters them) so the stand-ins can bind.
 *
 * - sleep, usleep, time_nanosleep and time_sleep_until wait through the park (the host awaits a
 *   timer, billing no CPU; the clock does not advance inside a run). Past the invocation's
 *   allowance, or outside a parked run, a sleep returns at once.
 * - uniqid steps past its last id: the built-in polls `gettimeofday()` until the microsecond
 *   changes, which never happens on a frozen clock.
 * - exec and the process family answer as a failed launch (there is no process table).
 *
 * Each degraded call keeps its name, so feature detection passes, and records a status-report row
 * through `Degradation::record()`.
 */
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
 * Drupal yields after one second but the clock reads 0 inside a run, so a count is needed. Twenty
 * keeps heavy batches inside one invocation without round trips dominating batches of cheap ones.
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

/** the stand-in PHP fragment with the gd constants and wrappers filled in */
export const STANDIN_FIX = renderTemplate(STANDIN_FIX_PHP, { GD: gdPhp() });
