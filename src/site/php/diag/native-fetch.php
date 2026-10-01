<?php
$b = @file_get_contents(__CFW_TARGET__);
echo json_encode(['bytes' => is_string($b) ? strlen($b) : -1]);
