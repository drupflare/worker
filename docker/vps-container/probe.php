<?php

// read-only process and cgroup readings for the floor rig; served at /__probe
header('content-type: application/json');
header('cache-control: no-store');

function slurp(string $path): ?string
{
	$raw = @file_get_contents($path);
	return $raw === false ? null : trim($raw);
}

function keyed(?string $text): array
{
	$out = [];
	foreach (explode("\n", (string) $text) as $line) {
		$parts = preg_split('/\s+/', trim($line));
		if (count($parts) >= 2 && is_numeric($parts[1])) {
			$out[$parts[0]] = (int) $parts[1];
		}
	}
	return $out;
}

$procs = [];
foreach (glob('/proc/[0-9]*') ?: [] as $dir) {
	$status = @file_get_contents("$dir/status");
	if ($status === false) {
		continue;
	}
	preg_match('/^Name:\s+(\S+)/m', $status, $name);
	preg_match('/^VmRSS:\s+(\d+)/m', $status, $rss);
	$row = [
		'pid' => (int) basename($dir),
		'name' => $name[1] ?? '?',
		'rssKb' => (int) ($rss[1] ?? 0),
	];
	$rollup = @file_get_contents("$dir/smaps_rollup");
	if ($rollup !== false) {
		foreach (['Pss', 'Pss_Anon', 'Pss_File', 'Pss_Shmem', 'Private_Dirty'] as $key) {
			if (preg_match("/^$key:\s+(\d+)/m", $rollup, $m)) {
				$row[$key . 'Kb'] = (int) $m[1];
			}
		}
	}
	$procs[] = $row;
}

$cg = '/sys/fs/cgroup';
echo json_encode([
	'at' => microtime(true),
	'php' => PHP_VERSION,
	'meminfo' => keyed(str_replace(':', '', (string) slurp('/proc/meminfo'))),
	'cgroup' => [
		'memoryCurrent' => slurp("$cg/memory.current"),
		'memoryPeak' => slurp("$cg/memory.peak"),
		'memoryMax' => slurp("$cg/memory.max"),
		'memoryEvents' => keyed(slurp("$cg/memory.events")),
		'memoryStat' => array_intersect_key(
			keyed(slurp("$cg/memory.stat")),
			array_flip(['anon', 'file', 'shmem', 'kernel', 'slab']),
		),
		'cpuStat' => keyed(slurp("$cg/cpu.stat")),
		'cpuMax' => slurp("$cg/cpu.max"),
	],
	'procStat' => slurp('/proc/stat') === null ? null : strtok((string) slurp('/proc/stat'), "\n"),
	'loadavg' => slurp('/proc/loadavg'),
	'procs' => $procs,
]);
