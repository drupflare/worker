<?php

$GLOBALS['__pw_kernel'] = $kernel;
$GLOBALS['__pw_site_booted'] = true;
// cfw_serve() hands back a Symfony Response, not a string; treating it as one reported -1 bytes
// for a render that had in fact succeeded, which is a broken instrument reading as a broken render
$response = cfw_serve('/');
$body =
	is_object($response) && method_exists($response, 'getContent')
		? (string) $response->getContent()
		: (is_string($response)
			? $response
			: '');
$mark['renderStatus'] =
	is_object($response) && method_exists($response, 'getStatusCode')
		? $response->getStatusCode()
		: null;
$mark['renderBytes'] = strlen($body);
