/**
 * `node_field_data` indexes no default workload reads, dropped by the pack and reconciliation.
 * Each costs about two charged rows per node create and revision (all three: create 51 -> 45,
 * revision 56 -> 50). `type` and `status_type` stay: without them a content-type listing is a table
 * scan. No imports, so `pack-sql.ts` can read it under plain node.
 */
export const UNREAD_NODE_INDEXES = [
	'node_field_data_node__vid',
	'node_field_data_node_field__uid__target_id',
	'node_field_data_node_field__created'
] as const;
