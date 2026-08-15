<?php

/**
 * Runs the exact PHP source from src/cpu-bench.js natively, so the wasm:native
 * ratio is measured rather than assumed. Reading the source from the same file
 * the Worker uses: a hand-copied duplicate would drift.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off bench-cpu.php [n] [reps]
 */

$n = (int) ($argv[1] ?? 200000);
$reps = (int) ($argv[2] ?? 5);

$jsPath = dirname(__DIR__) . '/src/cpu-bench.js';
$js = file_get_contents($jsPath);
if ($js === false) {
	fwrite(STDERR, "cannot read $jsPath\n");
	exit(1);
}

// pull the template literal body
$start = strpos($js, '`');
$end = strrpos($js, '`');
if ($start === false || $end === false || $end <= $start) {
	fwrite(STDERR, "no template literal found in cpu-bench.js\n");
	exit(1);
}
$src = substr($js, $start + 1, $end - $start - 1);

// undo JS backslash escaping, then substitute the iteration count
$src = str_replace('\\\\', '\\', $src);
$src = str_replace('__N__', (string) $n, $src);

// strip the opening tag; we eval the body
$src = preg_replace('/^\s*<\?php\s*/', '', $src, 1);

function cpuNow(): float
{
	$r = getrusage();
	return $r['ru_utime.tv_sec'] +
		$r['ru_utime.tv_usec'] / 1e6 +
		($r['ru_stime.tv_sec'] + $r['ru_stime.tv_usec'] / 1e6);
}

$runs = [];
$output = null;

for ($i = 0; $i < $reps; $i++) {
	$c0 = cpuNow();
	$w0 = microtime(true);

	ob_start();
	eval($src);
	$output = ob_get_clean();

	$runs[] = [
		'cpuMs' => round((cpuNow() - $c0) * 1000, 1),
		'wallMs' => round((microtime(true) - $w0) * 1000, 1),
	];
}

$cpus = array_column($runs, 'cpuMs');
sort($cpus);

echo json_encode(
	[
		'php' => PHP_VERSION,
		'intSize' => PHP_INT_SIZE,
		'opcache' => function_exists('opcache_get_status') && @opcache_get_status() !== false,
		'n' => $n,
		'reps' => $reps,
		'output' => $output,
		'runs' => $runs,
		'medianCpuMs' => $cpus[intdiv(count($cpus), 2)],
		'minCpuMs' => $cpus[0],
		'peakMemoryMb' => round(memory_get_peak_usage(true) / 1048576, 1),
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
