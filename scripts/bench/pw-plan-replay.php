<?php

/**
 * A compiled render plan, built by recording one render and replayed by position.
 *
 * The unit is the EXECUTION GRAPH rather than the bytes. On the recording pass every
 * decorated call appends its return value to a per-bucket list; on a replay pass the Nth
 * call to that bucket returns the Nth recorded value and the real implementation never runs.
 * If the graph is deterministic for a route, the replayed page is byte-identical, and the
 * saving is what compiling that subsystem away is worth.
 *
 * Each bucket is switchable on its own, so the arms are cumulative rather than one lump:
 * replaying `renderer` subsumes theme, Twig, render cache and cache contexts, which is why
 * the arms are reported separately as well as together.
 *
 * Byte equality is the check that makes an arm mean anything. An arm whose output changes is
 * reporting that the subsystem is NOT replayable on this route, which is a result and not a
 * failure.
 *
 * Loaded by `scripts/bench/bench-plan-arms.php` natively and by
 * `tests/integration/render-plan-arms.spec.ts` in wasm, so both sides run the same code.
 */

if (!function_exists('pw_rewrap')) {
	/**
	 * Copies an object's state into a subclass instance, so a container service can be
	 * decorated after the container is built.
	 *
	 * Duplicated from `pw-probe.php` rather than required from it: that file is gitignored, so
	 * a spec importing it fails to COLLECT on a clean checkout even when the spec itself is
	 * skipped.
	 */
	function pw_rewrap(object $original, string $subclass): object
	{
		$new = (new \ReflectionClass($subclass))->newInstanceWithoutConstructor();
		for ($rc = new \ReflectionClass($original); $rc; $rc = $rc->getParentClass()) {
			foreach ($rc->getProperties() as $p) {
				if ($p->isStatic() || !$p->isInitialized($original)) {
					continue;
				}
				$p->setValue($new, $p->getValue($original));
			}
		}
		return $new;
	}
}

if (!class_exists('PlanReplay', false)) {
	final class PlanReplay
	{
		/** bucket => whether the Nth call replays instead of running */
		public static array $on = [];

		/** bucket => ordered recorded return values */
		public static array $rec = [];

		/** bucket => how many calls this render has made */
		public static array $seq = [];

		/** bucket => calls that wanted a recording and had none */
		public static array $missed = [];

		public static bool $recording = false;

		public static function begin(): void
		{
			self::$seq = [];
			if (self::$recording) {
				self::$rec = [];
			}
		}

		public static function reset(): void
		{
			self::$on = [];
			self::$rec = [];
			self::$seq = [];
			self::$missed = [];
			self::$recording = false;
		}

		/** true when this call should be answered from the plan */
		public static function replaying(string $bucket): bool
		{
			return !empty(self::$on[$bucket]);
		}

		/**
		 * The plan slot for this call: an identity plus how many times that identity has
		 * already occurred in this render.
		 *
		 * NOT a position in the bucket's call list. Replaying an outer call deletes the
		 * inner ones nested inside it, so a positional index means something different on
		 * the replay pass than it did on the recording pass -- measured, and it collapsed
		 * the page to 281 bytes of 13,010 while reporting every slot found.
		 */
		public static function slot(string $bucket, string $key): string
		{
			$k = $bucket . '|' . $key;
			$i = self::$seq[$k] ?? 0;
			self::$seq[$k] = $i + 1;
			return $k . '#' . $i;
		}

		public static function get(string $bucket, string $slot, bool &$found)
		{
			if (array_key_exists($slot, self::$rec[$bucket] ?? [])) {
				$found = true;
				return self::$rec[$bucket][$slot];
			}
			$found = false;
			self::$missed[$bucket] = (self::$missed[$bucket] ?? 0) + 1;
			return null;
		}

		public static function put(string $bucket, string $slot, $value): void
		{
			if (self::$recording) {
				self::$rec[$bucket][$slot] = $value;
			}
		}

		public static function stats(): array
		{
			return [
				'on' => array_keys(array_filter(self::$on)),
				'recorded' => array_map('count', self::$rec),
				'missed' => self::$missed,
			];
		}
	}

	final class RpRenderer extends \Drupal\Core\Render\Renderer
	{
		/**
		 * Records the mutated ARGUMENT as well as the return value.
		 *
		 * `renderRoot()` writes the bubbled `#attached` and `#cache` back into `$elements`, and
		 * the caller reads them to build the head. A plan that stores only the markup produced a
		 * page 9,074 bytes short with no CSS; restoring the argument is what makes the replay a
		 * page rather than a fragment.
		 */
		public function renderRoot(&$elements)
		{
			$i = PlanReplay::slot('renderer', 'root');
			if (PlanReplay::replaying('renderer')) {
				$found = false;
				$v = PlanReplay::get('renderer', $i, $found);
				if ($found) {
					$elements = $v['elements'];
					return $v['markup'];
				}
			}
			$r = parent::renderRoot($elements);
			PlanReplay::put('renderer', $i, ['markup' => $r, 'elements' => $elements]);
			return $r;
		}

		public function renderInIsolation(&$elements)
		{
			$i = PlanReplay::slot('renderer', 'iso');
			if (PlanReplay::replaying('renderer')) {
				$found = false;
				$v = PlanReplay::get('renderer', $i, $found);
				if ($found) {
					$elements = $v['elements'];
					return $v['markup'];
				}
			}
			$r = parent::renderInIsolation($elements);
			PlanReplay::put('renderer', $i, ['markup' => $r, 'elements' => $elements]);
			return $r;
		}
	}

	final class RpThemeManager extends \Drupal\Core\Theme\ThemeManager
	{
		public function render($hook, array $variables)
		{
			$i = PlanReplay::slot('theme', is_array($hook) ? implode('|', $hook) : (string) $hook);
			if (PlanReplay::replaying('theme')) {
				$found = false;
				$v = PlanReplay::get('theme', $i, $found);
				if ($found) {
					return $v;
				}
			}
			$r = parent::render($hook, $variables);
			PlanReplay::put('theme', $i, $r);
			return $r;
		}
	}

	final class RpAssetResolver extends \Drupal\Core\Asset\AssetResolver
	{
		public function getCssAssets(
			\Drupal\Core\Asset\AttachedAssetsInterface $assets,
			$optimize,
			?\Drupal\Core\Language\LanguageInterface $language = null,
		) {
			$i = PlanReplay::slot(
				'assets',
				'css:' . implode(',', $assets->getLibraries()) . ':' . (int) $optimize,
			);
			if (PlanReplay::replaying('assets')) {
				$found = false;
				$v = PlanReplay::get('assets', $i, $found);
				if ($found) {
					return $v;
				}
			}
			$r = parent::getCssAssets($assets, $optimize, $language);
			PlanReplay::put('assets', $i, $r);
			return $r;
		}

		public function getJsAssets(
			\Drupal\Core\Asset\AttachedAssetsInterface $assets,
			$optimize,
			?\Drupal\Core\Language\LanguageInterface $language = null,
		) {
			$i = PlanReplay::slot(
				'assets',
				'js:' . implode(',', $assets->getLibraries()) . ':' . (int) $optimize,
			);
			if (PlanReplay::replaying('assets')) {
				$found = false;
				$v = PlanReplay::get('assets', $i, $found);
				if ($found) {
					return $v;
				}
			}
			$r = parent::getJsAssets($assets, $optimize, $language);
			PlanReplay::put('assets', $i, $r);
			return $r;
		}

		public function getFontAssets(
			\Drupal\Core\Asset\AttachedAssetsInterface $assets,
			?\Drupal\Core\Language\LanguageInterface $language = null,
		): array {
			$i = PlanReplay::slot('assets', 'font:' . implode(',', $assets->getLibraries()));
			if (PlanReplay::replaying('assets')) {
				$found = false;
				$v = PlanReplay::get('assets', $i, $found);
				if ($found) {
					return $v;
				}
			}
			$r = parent::getFontAssets($assets, $language);
			PlanReplay::put('assets', $i, $r);
			return $r;
		}
	}

	final class RpCacheContexts extends \Drupal\Core\Cache\Context\CacheContextsManager
	{
		public function convertTokensToKeys(array $context_tokens)
		{
			$i = PlanReplay::slot('contexts', implode(',', $context_tokens));
			if (PlanReplay::replaying('contexts')) {
				$found = false;
				$v = PlanReplay::get('contexts', $i, $found);
				if ($found) {
					return $v;
				}
			}
			$r = parent::convertTokensToKeys($context_tokens);
			PlanReplay::put('contexts', $i, $r);
			return $r;
		}
	}

	final class RpRenderCache extends \Drupal\Core\Render\PlaceholderingRenderCache
	{
		public function get(array $elements)
		{
			$i = PlanReplay::slot(
				'render_cache',
				'get:' . implode(':', $elements['#cache']['keys'] ?? []),
			);
			if (PlanReplay::replaying('render_cache')) {
				$found = false;
				$v = PlanReplay::get('render_cache', $i, $found);
				if ($found) {
					return $v;
				}
			}
			$r = parent::get($elements);
			PlanReplay::put('render_cache', $i, $r);
			return $r;
		}

		public function getMultiple(array $multiple_elements): array
		{
			$i = PlanReplay::slot('render_cache', 'multi:' . count($multiple_elements));
			if (PlanReplay::replaying('render_cache')) {
				$found = false;
				$v = PlanReplay::get('render_cache', $i, $found);
				if ($found) {
					return $v;
				}
			}
			$r = parent::getMultiple($multiple_elements);
			PlanReplay::put('render_cache', $i, $r);
			return $r;
		}
	}

	/**
	 * The BUBBLE, which is the half a return-value plan loses.
	 *
	 * `Renderer::doRender()` returns markup and writes the accumulated `#attached` and
	 * cacheability back through its argument, so replaying a theme hook's return value gives
	 * the right subtree markup and an empty asset set: the head comes out 9,074 bytes short
	 * and the page has no CSS. Recording the response's attachments at the entry to the
	 * processor and restoring them on replay is what makes a return-value plan produce the
	 * real page.
	 */
	final class RpAttachmentsProcessor extends \Drupal\Core\Render\HtmlResponseAttachmentsProcessor
	{
		public function processAttachments(\Drupal\Core\Render\AttachmentsInterface $response)
		{
			$i = PlanReplay::slot('attach', 'response');
			if (PlanReplay::replaying('attach')) {
				$found = false;
				$v = PlanReplay::get('attach', $i, $found);
				if ($found) {
					$response->setAttachments($v);
				}
			}
			PlanReplay::put('attach', $i, $response->getAttachments());
			return parent::processAttachments($response);
		}
	}

	/** the per-render reset hook; `kernel.request` is the first dispatch of every request */
	final class RpDispatcher extends \Symfony\Component\EventDispatcher\EventDispatcher
	{
		public function dispatch(object $event, ?string $eventName = null): object
		{
			if ($eventName === 'kernel.request') {
				PlanReplay::begin();
			}
			return parent::dispatch($event, $eventName);
		}
	}

	/**
	 * Swaps the plan decorators in, leaf-first.
	 *
	 * @return array<string,string>
	 */
	function pw_install_plan(): array
	{
		$container = \Drupal::getContainer();
		$rp = new \ReflectionProperty(
			\Drupal\Component\DependencyInjection\Container::class,
			'services',
		);
		$already = $rp->getValue($container);
		$map = [
			'cache_contexts_manager' => 'RpCacheContexts',
			'theme.manager' => 'RpThemeManager',
			'asset.resolver' => 'RpAssetResolver',
			'render_cache' => 'RpRenderCache',
			'renderer' => 'RpRenderer',
			'html_response.attachments_processor' => 'RpAttachmentsProcessor',
			'event_dispatcher' => 'RpDispatcher',
		];
		$out = [];
		foreach ($map as $id => $cls) {
			try {
				$original = $container->get($id);
				if ($original instanceof $cls) {
					$out[$id] = 'already';
					continue;
				}
				$container->set($id, pw_rewrap($original, $cls));
				$out[$id] = isset($already[$id]) ? 'preexisting' : 'swapped';
			} catch (\Throwable $e) {
				$out[$id] = 'ERR ' . get_class($e) . ': ' . substr($e->getMessage(), 0, 120);
			}
		}
		return $out;
	}
}
