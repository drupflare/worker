/**
 * `node_field_data` indexes no default workload reads, which the pack and reconciliation drop.
 *
 * Each costs about two charged rows on every node create and revision: all three together took a
 * create 51 -> 45 and a revision 56 -> 50 (`write-amplification.spec.ts`). `type` and `status_type`
 * stay, because listing by content type is the commonest Views shape and without them it is a table
 * scan on every uncached listing. No imports, so `pack-sql.ts` can read it under plain node.
 */
export const UNREAD_NODE_INDEXES = [
	'node_field_data_node__vid',
	'node_field_data_node_field__uid__target_id',
	'node_field_data_node_field__created'
] as const;
