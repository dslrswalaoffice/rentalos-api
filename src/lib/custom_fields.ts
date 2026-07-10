import { sql, query } from '../db.js';

// ============================================================================
// src/lib/custom_fields.ts  (Sub-turn 6g)
// ----------------------------------------------------------------------------
// Shared helpers so the custom-fields route AND the order/person/product routes
// read + write custom field data through one path. Values are stored as text;
// callers/frontend parse per the definition's field_type.
// ============================================================================

export type CustomFieldEntity = 'order' | 'person' | 'product';

export type CustomFieldValueRow = {
  definition_id: string;
  field_key: string;
  label: string;
  field_type: string;
  options: string[] | null;
  is_required: boolean;
  help_text: string | null;
  sort_order: number;
  value: string | null;
};

// All active definitions for the entity type, left-joined with this record's
// values (null when unset). Ordered for stable form rendering.
export async function loadCustomFieldValues(
  workspaceId: string,
  entityType: CustomFieldEntity,
  entityId: string,
): Promise<CustomFieldValueRow[]> {
  return query<CustomFieldValueRow>(sql`
    SELECT d.id AS definition_id, d.field_key, d.label, d.field_type, d.options,
           d.is_required, d.help_text, d.sort_order, v.value
    FROM custom_field_definitions d
    LEFT JOIN custom_field_values v
      ON v.definition_id = d.id
     AND v.entity_id = ${entityId}::uuid
     AND v.workspace_id = ${workspaceId}::uuid
    WHERE d.workspace_id = ${workspaceId}::uuid
      AND d.entity_type = ${entityType}::text
      AND d.is_active = true
    ORDER BY d.sort_order ASC, d.created_at ASC
  `);
}

// Bulk upsert values for one entity. Definitions are validated against the
// workspace + entity_type (foreign IDs are silently skipped). A null/empty value
// deletes the row (clear). Returns how many items were applied.
export async function upsertCustomFieldValues(args: {
  workspaceId: string;
  entityType: CustomFieldEntity;
  entityId: string;
  actorUserId: string;
  values: Array<{ definition_id: string; value: string | null }>;
}): Promise<{ applied: number }> {
  if (!args.values.length) return { applied: 0 };

  const defIds = [...new Set(args.values.map((v) => v.definition_id))];
  const defs = await query<{ id: string }>(sql`
    SELECT id FROM custom_field_definitions
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND entity_type = ${args.entityType}::text
      AND id = ANY(string_to_array(${defIds.join(',')}::text, ',')::uuid[])
  `);
  const valid = new Set(defs.map((d) => d.id));

  let applied = 0;
  for (const item of args.values) {
    if (!valid.has(item.definition_id)) continue;
    if (item.value === null || item.value === '') {
      await sql`
        DELETE FROM custom_field_values
        WHERE workspace_id = ${args.workspaceId}::uuid
          AND definition_id = ${item.definition_id}::uuid
          AND entity_id = ${args.entityId}::uuid
      `;
    } else {
      await sql`
        INSERT INTO custom_field_values
          (workspace_id, definition_id, entity_type, entity_id, value, updated_by_user_id)
        VALUES (
          ${args.workspaceId}::uuid, ${item.definition_id}::uuid, ${args.entityType}::text,
          ${args.entityId}::uuid, ${item.value}::text, ${args.actorUserId}::uuid
        )
        ON CONFLICT (workspace_id, definition_id, entity_id)
        DO UPDATE SET value = EXCLUDED.value, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      `;
    }
    applied++;
  }
  return { applied };
}
