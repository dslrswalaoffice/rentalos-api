import { sql, query } from '../db.js';

// ============================================================================
// src/lib/tags.ts  (Sub-turn 8a) — shared tag-loading helpers
// ----------------------------------------------------------------------------
// Tags are workspace-scoped labels applied to products / people / orders via
// tag_assignments. These helpers load the active tags for one entity or, in a
// single batch query, for a page of entities (used by list endpoints so we
// don't fan out N queries per page). Only active tags (is_active = true) are
// returned — soft-deleted tags stay in tag_assignments but disappear from view.
// ============================================================================

export type EntityType = 'product' | 'person' | 'order';

export type Tag = {
  id: string;
  name: string;
  color: string;
  sort_order?: number;
};

export async function loadTagsForEntity(
  workspaceId: string,
  entityType: EntityType,
  entityId: string,
): Promise<Tag[]> {
  return await query<Tag>(sql`
    SELECT t.id, t.name, t.color, t.sort_order
    FROM tag_assignments ta
    INNER JOIN tags t ON t.id = ta.tag_id
    WHERE ta.workspace_id = ${workspaceId}::uuid
      AND ta.entity_type = ${entityType}::text
      AND ta.entity_id = ${entityId}::uuid
      AND t.is_active = true
    ORDER BY t.sort_order ASC, t.name ASC
  `);
}

export async function loadTagsForEntities(
  workspaceId: string,
  entityType: EntityType,
  entityIds: string[],
): Promise<Map<string, Tag[]>> {
  const map = new Map<string, Tag[]>();
  if (entityIds.length === 0) return map;
  // Pass the id list as a CSV → uuid[] (the Neon HTTP driver mis-serialises a
  // JS array cast to uuid[], so we go through string_to_array like the rest of
  // the codebase does for enum arrays).
  const csv = entityIds.join(',');
  const rows = await query<{ entity_id: string; id: string; name: string; color: string; sort_order: number }>(sql`
    SELECT ta.entity_id, t.id, t.name, t.color, t.sort_order
    FROM tag_assignments ta
    INNER JOIN tags t ON t.id = ta.tag_id
    WHERE ta.workspace_id = ${workspaceId}::uuid
      AND ta.entity_type = ${entityType}::text
      AND ta.entity_id = ANY(string_to_array(${csv}::text, ',')::uuid[])
      AND t.is_active = true
    ORDER BY t.sort_order ASC, t.name ASC
  `);
  for (const r of rows) {
    if (!map.has(r.entity_id)) map.set(r.entity_id, []);
    map.get(r.entity_id)!.push({ id: r.id, name: r.name, color: r.color });
  }
  return map;
}

/**
 * AND-semantics tag filter for a list endpoint: returns the ids of `entityType`
 * entities that carry ALL of the given tag ids. The Neon HTTP driver can't nest
 * `sql` fragments, so callers run this first and then constrain their main query
 * to `entity_id = ANY(...)`. Returns [] when tagIds is empty (caller decides).
 */
export async function filterEntityIdsByTags(
  workspaceId: string,
  entityType: EntityType,
  tagIds: string[],
): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const csv = tagIds.join(',');
  const rows = await query<{ entity_id: string }>(sql`
    SELECT ta.entity_id
    FROM tag_assignments ta
    INNER JOIN tags t ON t.id = ta.tag_id
    WHERE ta.workspace_id = ${workspaceId}::uuid
      AND ta.entity_type = ${entityType}::text
      AND ta.tag_id = ANY(string_to_array(${csv}::text, ',')::uuid[])
      AND t.is_active = true
    GROUP BY ta.entity_id
    HAVING COUNT(DISTINCT ta.tag_id) = ${tagIds.length}::int
  `);
  return rows.map((r) => r.entity_id);
}

/**
 * Replace ALL tag assignments on one entity with `tagIds` (only tags that
 * belong to the workspace and are active are honoured). No transaction on Neon
 * HTTP — clear then re-insert, idempotent via ON CONFLICT. Shared by the entity
 * PATCH endpoints (product / person / order).
 */
export async function replaceEntityTags(
  workspaceId: string,
  entityType: EntityType,
  entityId: string,
  actorUserId: string,
  tagIds: string[],
): Promise<void> {
  let validIds: string[] = [];
  if (tagIds.length) {
    const csv = tagIds.join(',');
    const rows = await query<{ id: string }>(sql`
      SELECT id FROM tags
      WHERE workspace_id = ${workspaceId}::uuid AND is_active = true
        AND id = ANY(string_to_array(${csv}::text, ',')::uuid[])
    `);
    validIds = rows.map((r) => r.id);
  }
  await sql`
    DELETE FROM tag_assignments
    WHERE workspace_id = ${workspaceId}::uuid
      AND entity_type = ${entityType}::text
      AND entity_id = ${entityId}::uuid
  `;
  for (const tagId of validIds) {
    await sql`
      INSERT INTO tag_assignments (workspace_id, tag_id, entity_type, entity_id, assigned_by_user_id)
      VALUES (${workspaceId}::uuid, ${tagId}::uuid, ${entityType}::text, ${entityId}::uuid, ${actorUserId}::uuid)
      ON CONFLICT (workspace_id, tag_id, entity_type, entity_id) DO NOTHING
    `;
  }
}

/** Parse a repeated/ CSV `tag_ids` query param into a de-duped string list. */
export function parseTagIdsParam(raw: string[] | string | undefined): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = new Set<string>();
  for (const v of arr) {
    for (const piece of String(v).split(',')) {
      const t = piece.trim();
      if (t) out.add(t);
    }
  }
  return [...out];
}
