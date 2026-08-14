/**
 * A PHP workload shaped like Drupal bootstrap rather than like a microbenchmark:
 * class construction and method dispatch, associative-array churn, string
 * building, preg matching, and serialization. Deliberately allocation-heavy,
 * because that is where an interpreter without opcache spends its time.
 *
 * The identical source runs natively via scripts/bench/bench-cpu.php, so the ratio
 * between the two is measured rather than assumed.
 */
export const CPU_BENCH = `<?php
$n = __N__;

// guarded because the PHP instance persists across Worker requests, so the
// class table survives and a bare declaration fatals on the second request
if (!class_exists('Node', false)) {
	eval('class Node {
		public array $fields = [];
		public function __construct(public int $id, public string $title) {}
		public function set(string $k, $v): static { $this->fields[$k] = $v; return $this; }
		public function render(): string { return $this->id . ":" . $this->title; }
	}');
}

$map = [];
$out = 0;
$pattern = '/^node-(\\\\d+)-([a-z]+)$/';

for ($i = 0; $i < $n; $i++) {
	$key = 'node-' . $i . '-' . chr(97 + ($i % 26));

	$node = new Node($i, $key);
	$node->set('created', $i * 7)->set('status', $i % 2);

	$map[$key] = $node->render();

	if (preg_match($pattern, $key, $m)) {
		$out += (int) $m[1] % 13;
	}

	if (($i % 1000) === 0) {
		$out += strlen(serialize(array_slice($map, -8, 8, true)));
		if (count($map) > 4000) { $map = array_slice($map, -1000, 1000, true); }
	}
}

echo $out, '|', count($map);
`;
