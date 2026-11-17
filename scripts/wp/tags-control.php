<?php

// installed as a must-use plugin after the host's own, so a control run can take one hook away
$hook = getenv('CFW_REMOVE_HOOK');
if (is_string($hook) && $hook !== '' && function_exists('drupflare_tags_hooks')) {
	foreach (drupflare_tags_hooks() as [$name, $handler]) {
		if (in_array($name, explode(',', $hook), true)) {
			remove_action($name, $handler, 10);
		}
	}
}
