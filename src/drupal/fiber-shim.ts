/**
 * The synchronous stand-in for \Fiber that the patched tree expects.
 *
 * PHP builds Fibers on ucontext when --disable-fiber-asm is set and emscripten
 * has no ucontext, so a real Fiber aborts the runtime with
 * "Aborted(missing function: getcontext)". scripts/patch-drupal.mjs rewrites
 * core's five call sites to this class; it has to exist before Drupal loads.
 *
 * One definition for every fragment: the `class_exists` guard lets whichever fragment runs first
 * declare the class, so a cron or update fragment with its own copy left canvas without `$handler`.
 */
export const FIBER_SHIM = String.raw`
if (!class_exists('PhpWasmSyncFiber', false)) { eval('
class PhpWasmSyncFiber {
  private $callable;
  private $result = null;
  private $started = false;
  /** answers suspend() inline while a rewritten driver loop is running (canvas); null otherwise */
  public static $handler = null;
  public function __construct(callable $callable) { $this->callable = $callable; }
  public function start(...$args) { $this->started = true; $this->result = ($this->callable)(...$args); return null; }
  public function isStarted(): bool { return $this->started; }
  public function isSuspended(): bool { return false; }
  public function isRunning(): bool { return false; }
  public function isTerminated(): bool { return $this->started; }
  public function resume($value = null) { return null; }
  public function throw(\\Throwable $e) { throw $e; }
  public function getReturn() { return $this->result; }
  public static function getCurrent(): ?object { return self::$handler === null ? null : new self(fn() => null); }
  public static function suspend($value = null) { return self::$handler === null ? null : (self::$handler)($value); }
}
'); }
`;
