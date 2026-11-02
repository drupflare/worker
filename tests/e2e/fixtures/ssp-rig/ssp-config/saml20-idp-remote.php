<?php

foreach (
	\SimpleSAML\Metadata\SAMLParser::parseDescriptorsString(file_get_contents(__DIR__ . '/idp.xml'))
	as $id => $entity
) {
	$metadata[$id] = $entity->getMetadata20IdP();
}
