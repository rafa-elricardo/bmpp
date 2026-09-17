/**
 * Snapshot of the REAL Basic Memory MCP surface.
 *
 * Transcribed from a live `tools/list` against the installed Basic Memory
 * 0.23.2 that this machine's DSH bridges, so the tests exercise the exact
 * identities the plugin will see at runtime rather than names invented for the
 * test. `tests/integration/bm-contract.spec.ts` asserts this snapshot against
 * the DSH bridge's naming rule, which is what makes it a contract rather than a
 * wish list.
 *
 * Nothing here writes to the knowledge base: the catalogue is data, and the
 * fixtures that serve it are local.
 *
 * @module tests/integration/basic-memory-catalog
 */

/** One tool exactly as the MCP server advertises it. */
export interface CatalogEntry {
  /** Raw MCP tool name, as sent on the wire. */
  readonly rawName: string
  /** `annotations.readOnlyHint`. */
  readonly readOnly: boolean
  /** `annotations.destructiveHint`. */
  readonly destructive: boolean
  /** Properties listed in the advertised input schema's `required`. */
  readonly required: readonly string[]
}

/**
 * The 21 tools of Basic Memory 0.23.2, with their real annotations.
 *
 * Every one of them advertises **no `outputSchema`** (`outputSchema: null` in the
 * live listing), which is why the bridge hands the model text blocks and why an
 * empty-but-successful search cannot be distinguished structurally. See
 * `docs/COMPATIBILITY.md`.
 */
export const BASIC_MEMORY_CATALOG: readonly CatalogEntry[] = [
  // --- read-only (15) ---
  { rawName: 'basic_memory_diagnostics', readOnly: true, destructive: false, required: [] },
  { rawName: 'build_context', readOnly: true, destructive: false, required: ['url'] },
  { rawName: 'fetch', readOnly: true, destructive: false, required: ['id'] },
  { rawName: 'list_directory', readOnly: true, destructive: false, required: [] },
  { rawName: 'list_memory_projects', readOnly: true, destructive: false, required: [] },
  { rawName: 'list_workspaces', readOnly: true, destructive: false, required: [] },
  { rawName: 'read_content', readOnly: true, destructive: false, required: ['path'] },
  { rawName: 'read_note', readOnly: true, destructive: false, required: ['identifier'] },
  { rawName: 'recent_activity', readOnly: true, destructive: false, required: [] },
  { rawName: 'schema_diff', readOnly: true, destructive: false, required: ['note_type'] },
  { rawName: 'schema_infer', readOnly: true, destructive: false, required: ['note_type'] },
  { rawName: 'schema_validate', readOnly: true, destructive: false, required: [] },
  { rawName: 'search', readOnly: true, destructive: false, required: ['query'] },
  { rawName: 'search_notes', readOnly: true, destructive: false, required: [] },
  { rawName: 'view_note', readOnly: true, destructive: false, required: ['identifier'] },

  // --- state-changing (6) ---
  { rawName: 'create_memory_project', readOnly: false, destructive: false, required: ['project_name', 'project_path'] },
  { rawName: 'delete_note', readOnly: false, destructive: true, required: ['identifier'] },
  { rawName: 'delete_project', readOnly: false, destructive: true, required: ['project_name'] },
  { rawName: 'edit_note', readOnly: false, destructive: true, required: ['identifier', 'operation', 'content'] },
  { rawName: 'move_note', readOnly: false, destructive: false, required: ['identifier'] },
  { rawName: 'write_note', readOnly: false, destructive: true, required: ['title', 'content', 'directory'] },
]

/** MCP server name from the DSH profile row; sets the tool-name prefix. */
export const SERVER_NAME = 'basic-memory'

/** Model-facing public name of one raw MCP tool. */
export function publicName(rawName: string): string {
  return `mcp__${SERVER_NAME}__${rawName}`
}

/** Every model-facing name in catalogue order. */
export const PUBLIC_NAMES: readonly string[] = BASIC_MEMORY_CATALOG.map(entry => publicName(entry.rawName))

/** Catalogue entries that advertise `readOnlyHint: true`. */
export const READ_ONLY_ENTRIES: readonly CatalogEntry[] =
  BASIC_MEMORY_CATALOG.filter(entry => entry.readOnly)

/** Catalogue entries that advertise `destructiveHint: true`. */
export const DESTRUCTIVE_ENTRIES: readonly CatalogEntry[] =
  BASIC_MEMORY_CATALOG.filter(entry => entry.destructive)
