<?php

// 3.1's suspect, isolated. This is the row $kernel->boot() reads, fetched the same way -- across
// the host bridge, which encodes every value through json_encode(pw_encode()). Selecting data
// rather than LENGTH(data): the question is what carrying half a megabyte through that
// bridge costs, and LENGTH() would answer it with an integer.
$rows = cfw_sql('SELECT cid, data FROM cache_container LIMIT 1');
$row = is_array($rows) && isset($rows['rows'][0]) ? $rows['rows'][0] : null;
$blob = is_array($row) ? (string) ($row['data'] ?? '') : '';
$mark['containerRowFound'] = $row !== null;
$mark['containerCid'] = is_array($row) ? substr((string) ($row['cid'] ?? ''), 0, 80) : null;
$mark['containerBytes'] = strlen($blob);
