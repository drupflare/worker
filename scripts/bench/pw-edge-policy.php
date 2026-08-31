<?php

/**
 * Makes a native CLI run model the edge's page-cache behaviour.
 *
 * `CommandLineOrUnsafeMethod::isCli()` reads `PHP_SAPI === 'cli'`, which is true here and
 * false in wasm (php-wasm reports `embed`). So natively both `page_cache` and
 * `dynamic_page_cache` answer DENY on every request and a ladder that purges those bins
 * measures the same full render in every arm. Dropping that one rule from the two chain
 * policies is what makes a native arm comparable with the shipping one.
 *
 * @return array<string,int> policy service id => rules removed
 */
function pw_edge_page_policy(): array
{
	$out = [];
	foreach (['page_cache_request_policy', 'dynamic_page_cache_request_policy'] as $id) {
		try {
			$policy = \Drupal::service($id);
		} catch (\Throwable $e) {
			$out[$id] = -1;
			continue;
		}
		$rp = new \ReflectionProperty(\Drupal\Core\PageCache\ChainRequestPolicy::class, 'rules');
		$rules = $rp->getValue($policy);
		$kept = array_values(
			array_filter(
				$rules,
				fn($r) => !(
					$r instanceof \Drupal\Core\PageCache\RequestPolicy\CommandLineOrUnsafeMethod
				),
			),
		);
		$rp->setValue($policy, $kept);
		$out[$id] = count($rules) - count($kept);
	}
	return $out;
}
