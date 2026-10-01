<?php

/**
 * Describes a collected listener without calling it.
 *
 * @param callable|array|object|string $c
 *   A collected listener.
 */
function cfw_listener_shape($c): string
{
	if (is_array($c)) {
		return (is_object($c[0]) ? get_class($c[0]) : (string) $c[0]) . '::' . $c[1];
	}
	if ($c instanceof Closure) {
		return 'Closure';
	}
	if (is_object($c)) {
		return get_class($c) . '::__invoke';
	}
	return gettype($c);
}
