<?php

// and separately, what turning those bytes into an object graph costs. Split from the read because
// "reading 479 KB is slow" and "unserialising 479 KB is slow" are different problems with different
// fixes, and the container cache is the only place either would show up.
$graph = $blob === '' ? null : @unserialize($blob);
$mark['unserialized'] = $graph !== false && $graph !== null;
$mark['unserializedType'] = get_debug_type($graph);
