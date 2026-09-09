<?php

/**
 * Gives the VPS arm back what the wasm build patched out of core.
 *
 * `drupal-src` is the build input for the shipping pack, not stock Drupal: core's `Fiber` use in
 * `AccessPolicyProcessor` is rewritten to `PhpWasmSyncFiber`, a synchronous stand-in the interpreter
 * defines at boot because the wasm build has no fibers. Mounting that tree into native PHP therefore
 * fatals with `Class "PhpWasmSyncFiber" not found`.
 *
 * This maps the name onto the REAL `Fiber`, so the VPS arm gets stock Drupal's concurrent semantics
 * while drupflare keeps its inline shim. Each runtime then does what it does in production, against
 * the same tree and the same content.
 *
 * Loaded through `auto_prepend_file` rather than by editing `drupal-src`, which is gitignored and is
 * the pack's build input; a local edit there is the silent-drift shape the project has been bitten by.
 *
 * DELEGATION RATHER THAN INHERITANCE, because `Fiber` is final.
 */
if (!class_exists('PhpWasmSyncFiber', false)) {
	class PhpWasmSyncFiber
	{
		private Fiber $fiber;

		public function __construct(callable $callable)
		{
			$this->fiber = new Fiber($callable);
		}

		public function start(...$args)
		{
			return $this->fiber->start(...$args);
		}

		public function isStarted(): bool
		{
			return $this->fiber->isStarted();
		}

		public function isSuspended(): bool
		{
			return $this->fiber->isSuspended();
		}

		public function isRunning(): bool
		{
			return $this->fiber->isRunning();
		}

		public function isTerminated(): bool
		{
			return $this->fiber->isTerminated();
		}

		public function resume($value = null)
		{
			return $this->fiber->resume($value);
		}

		public function throw(Throwable $e)
		{
			return $this->fiber->throw($e);
		}

		public function getReturn()
		{
			return $this->fiber->getReturn();
		}

		public static function getCurrent(): ?Fiber
		{
			return Fiber::getCurrent();
		}

		public static function suspend($value = null)
		{
			return Fiber::suspend($value);
		}
	}
}
