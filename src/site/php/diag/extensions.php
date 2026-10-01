<?php
$e = get_loaded_extensions();
sort($e);
echo json_encode(['v' => PHP_VERSION, 'e' => $e]);
