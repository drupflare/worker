<?php
use Drupal\drupflare\Exec\Router;

echo json_encode(class_exists(Router::class) ? Router::counters() : null);
