<?php
$out = ['ok' => true, 'before' => ob_get_level(), 'opening' => __CFW_LEVELS__];
echo json_encode($out);
for ($i = 0; $i < __CFW_LEVELS__; $i++) {
	ob_start();
}
