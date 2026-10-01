<?php

class PhpWasmSyncFiber
{
	/** @var callable */
	private $callable;
	/** @var mixed */
	private $result = null;
	private bool $started = false;
	/**
	 * answers suspend() inline while a rewritten driver loop is running (canvas); null otherwise
	 *
	 * @var callable|null
	 */
	public static $handler = null;
	public function __construct(callable $callable)
	{
		$this->callable = $callable;
	}
	/** @param mixed ...$args */
	public function start(...$args)
	{
		$this->started = true;
		$this->result = ($this->callable)(...$args);
		return null;
	}
	public function isStarted(): bool
	{
		return $this->started;
	}
	public function isSuspended(): bool
	{
		return false;
	}
	public function isRunning(): bool
	{
		return false;
	}
	public function isTerminated(): bool
	{
		return $this->started;
	}
	/** @param mixed $value */
	public function resume($value = null)
	{
		return null;
	}
	public function throw(Throwable $e)
	{
		throw $e;
	}
	/** @return mixed */
	public function getReturn()
	{
		return $this->result;
	}
	public static function getCurrent(): ?object
	{
		return self::$handler === null ? null : new self(fn() => null);
	}
	/** @param mixed $value */
	public static function suspend($value = null)
	{
		return self::$handler === null ? null : (self::$handler)($value);
	}
}
