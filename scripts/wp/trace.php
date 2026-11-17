<?php

// logs every path PHP opens or stats under WP_ROOT, so a pack list can be checked against what runs
final class CfwTrace
{
	public $context;
	private $handle;
	private $dir;

	private static function swap(callable $fn): mixed
	{
		stream_wrapper_restore('file');
		try {
			return $fn();
		} finally {
			stream_wrapper_unregister('file');
			stream_wrapper_register('file', self::class);
		}
	}

	private static function note(string $kind, string $path): void
	{
		$root = (string) getenv('WP_ROOT');
		if ($root !== '' && str_starts_with($path, $root)) {
			self::swap(
				fn() => file_put_contents(
					getenv('CFW_TRACE'),
					$kind . ' ' . substr($path, strlen($root) + 1) . "\n",
					FILE_APPEND,
				),
			);
		}
	}

	public function stream_open($path, $mode, $options, &$opened)
	{
		self::note('open', $path);
		$this->handle = self::swap(fn() => @fopen($path, $mode));
		return $this->handle !== false;
	}

	public function stream_read($n)
	{
		return fread($this->handle, $n);
	}

	public function stream_write($d)
	{
		return fwrite($this->handle, $d);
	}

	public function stream_eof()
	{
		return feof($this->handle);
	}

	public function stream_close()
	{
		fclose($this->handle);
	}

	public function stream_stat()
	{
		return fstat($this->handle);
	}

	public function stream_seek($o, $w)
	{
		return fseek($this->handle, $o, $w) === 0;
	}

	public function stream_tell()
	{
		return ftell($this->handle);
	}

	public function stream_flush()
	{
		return fflush($this->handle);
	}

	public function stream_lock($op)
	{
		return flock($this->handle, $op);
	}

	public function stream_set_option($o, $a, $b)
	{
		return false;
	}

	public function stream_cast($as)
	{
		return false;
	}

	public function url_stat($path, $flags)
	{
		self::note('stat', $path);
		return self::swap(fn() => @stat($path));
	}

	public function dir_opendir($path, $options)
	{
		self::note('dir', $path);
		$this->dir = self::swap(fn() => @opendir($path));
		return $this->dir !== false;
	}

	public function dir_readdir()
	{
		return readdir($this->dir);
	}

	public function dir_closedir()
	{
		closedir($this->dir);
		return true;
	}

	public function dir_rewinddir()
	{
		rewinddir($this->dir);
		return true;
	}

	public function mkdir($path, $mode, $options)
	{
		return self::swap(fn() => @mkdir($path, $mode, (bool) ($options & STREAM_MKDIR_RECURSIVE)));
	}

	public function rename($from, $to)
	{
		return self::swap(fn() => rename($from, $to));
	}

	public function rmdir($path, $options)
	{
		return self::swap(fn() => @rmdir($path));
	}

	public function unlink($path)
	{
		return self::swap(fn() => @unlink($path));
	}
}

if (getenv('CFW_TRACE') !== false && getenv('CFW_TRACE') !== '') {
	stream_wrapper_unregister('file');
	stream_wrapper_register('file', CfwTrace::class);
}
