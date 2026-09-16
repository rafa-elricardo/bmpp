/**
 * Stable, documented reason codes and observation codes for the BMPP policy.
 *
 * These strings are the machine-readable contract of every allow/deny decision:
 * they appear in the audit trail and in the actionable error the model receives.
 * A code is NEVER reworded once released — a changed meaning gets a new code.
 *
 * The set is closed on purpose. Only codes named in the architecture are
 * declared here; new behaviour introduces a new code deliberately rather than
 * smuggling a meaning into an existing one.
 *
 * Scope: the codes a PURE decision can produce. The secondary guards that need
 * raw arguments plus configuration (`SECRET_PATTERN_DETECTED`,
 * `TEST_FIXTURE_LABEL_IN_PROJECT`) and the internal-failure code
 * (`POLICY_INTERNAL_ERROR`) belong to the guard layer, not to this decision,
 * and are deliberately absent.
 *
 * @module dsh-bmpp/reason-codes
 */

/**
 * Why a call was denied, or why a read was allowed unconditionally.
 *
 * One code per decision, so an audit reader can answer "why?" from a single
 * field.
 */
export const ReasonCode = {
  /** A memory mutation arrived before the turn was classified. */
  CLASSIFICATION_REQUIRED: 'CLASSIFICATION_REQUIRED',
  /** COMPLEX turn, no recall had started yet. */
  MEMORY_LOOKUP_REQUIRED: 'MEMORY_LOOKUP_REQUIRED',
  /** A recall ran and failed; a later successful attempt still opens the gate. */
  MEMORY_LOOKUP_FAILED: 'MEMORY_LOOKUP_FAILED',
  /** A recall is in flight for this same batch, so its result cannot inform this call. */
  MEMORY_LOOKUP_PENDING_IN_BATCH: 'MEMORY_LOOKUP_PENDING_IN_BATCH',
  /** `write_note` creating a note without a recall in this turn. */
  CREATE_REQUIRES_SEARCH: 'CREATE_REQUIRES_SEARCH',
  /** `write_note` with `overwrite: true` without reading that note first. */
  OVERWRITE_REQUIRES_READ: 'OVERWRITE_REQUIRES_READ',
  /** A tool inside the memory namespace that no list classifies. Fail-closed. */
  UNKNOWN_MEMORY_TOOL: 'UNKNOWN_MEMORY_TOOL',
  /** The turn is SIMPLE, so the recall gate is off. */
  ALLOW_SIMPLE: 'ALLOW_SIMPLE',
  /** The call is read-only, and reading is never gated. */
  ALLOW_READ_ONLY: 'ALLOW_READ_ONLY',
  /** A recall completed successfully in this turn. */
  ALLOW_RECALL_OK: 'ALLOW_RECALL_OK',
  /** The call is one of BMPP's own control tools. */
  ALLOW_CONTROL: 'ALLOW_CONTROL',
  /** The tool is outside the memory namespace, so the MVP does not govern it. */
  ALLOW_OUT_OF_SCOPE: 'ALLOW_OUT_OF_SCOPE',
} as const

/** Union of every reason code value. */
export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode]

/** Every reason code, for exhaustiveness checks and audits of the vocabulary. */
export const REASON_CODES: readonly ReasonCode[] = Object.values(ReasonCode)

/** Codes that deny a call. Every other code allows or observes it. */
export const DENY_REASON_CODES: readonly ReasonCode[] = [
  ReasonCode.CLASSIFICATION_REQUIRED,
  ReasonCode.MEMORY_LOOKUP_REQUIRED,
  ReasonCode.MEMORY_LOOKUP_FAILED,
  ReasonCode.MEMORY_LOOKUP_PENDING_IN_BATCH,
  ReasonCode.CREATE_REQUIRES_SEARCH,
  ReasonCode.OVERWRITE_REQUIRES_READ,
  ReasonCode.UNKNOWN_MEMORY_TOOL,
]

/**
 * Why a permitted call still deserves a note in the audit trail.
 *
 * Observations never change a decision. In `audit` mode they are what a reader
 * uses to see which stricter profile WOULD have intervened.
 */
export const ObservationCode = {
  /** The recall returned no matches. A valid, gate-opening outcome. */
  RECALL_EMPTY: 'RECALL_EMPTY',
  /** A read tool ran; reads never satisfy recall on their own. */
  READ_ONLY_NOT_RECALL: 'READ_ONLY_NOT_RECALL',
  /** The recall gate is not active for this call. */
  GATE_INACTIVE: 'GATE_INACTIVE',
  /** The model classified a turn more than once; the latest declaration wins. */
  RECLASSIFIED: 'RECLASSIFIED',
} as const

/** Union of every observation code value. */
export type ObservationCode = (typeof ObservationCode)[keyof typeof ObservationCode]

/** Every observation code, for exhaustiveness checks and vocabulary audits. */
export const OBSERVATION_CODES: readonly ObservationCode[] = Object.values(ObservationCode)

/**
 * The actionable explanation attached to a denial.
 *
 * The text is the model's only channel for self-correction, so it names the
 * missing precondition and the exact next call. It never carries tool
 * arguments, note content, host paths or stack traces.
 */
export const REASON_MESSAGES: Readonly<Record<ReasonCode, string>> = {
  [ReasonCode.CLASSIFICATION_REQUIRED]:
    'this turn has not been classified, so a Basic Memory operation that changes state cannot run. '
    + 'Call bmpp__classify first: {"task":"complex"} to require a memory lookup, or {"task":"simple"} '
    + 'when the turn genuinely needs no recalled context. Reading is always allowed.',
  [ReasonCode.MEMORY_LOOKUP_REQUIRED]:
    'this turn is COMPLEX, so a memory lookup must complete before a Basic Memory operation that '
    + 'changes state. Call mcp__basic-memory__search_notes now (2-3 phrasings), read the result, then '
    + 'retry this call.',
  [ReasonCode.MEMORY_LOOKUP_FAILED]:
    'the memory lookup in this turn failed, so it does not satisfy the recall precondition. Retry the '
    + 'lookup in a new call, then retry this one.',
  [ReasonCode.MEMORY_LOOKUP_PENDING_IN_BATCH]:
    'the memory lookup and this state-changing call are in the same batch, so the lookup result cannot '
    + 'inform this call yet. Wait for the lookup result, then retry this call on its own.',
  [ReasonCode.CREATE_REQUIRES_SEARCH]:
    'creating a note requires searching for the subject first, so an existing note can be updated '
    + 'instead of duplicated. Search, then retry.',
  [ReasonCode.OVERWRITE_REQUIRES_READ]:
    'overwriting a note requires reading that note first. Read it, then retry.',
  [ReasonCode.UNKNOWN_MEMORY_TOOL]:
    'this Basic Memory tool is not classified as read-only, so it is treated as state-changing and '
    + 'no policy list covers it. Treat it as a write: classify the turn, search first, then retry.',
  [ReasonCode.ALLOW_SIMPLE]: 'the turn is SIMPLE, so the recall gate is inactive.',
  [ReasonCode.ALLOW_READ_ONLY]: 'reading is never gated by the memory policy.',
  [ReasonCode.ALLOW_RECALL_OK]: 'a memory lookup completed successfully in this turn.',
  [ReasonCode.ALLOW_CONTROL]: 'this is a BMPP control tool and is always permitted.',
  [ReasonCode.ALLOW_OUT_OF_SCOPE]: 'this tool is outside the Basic Memory namespace the MVP governs.',
}

/**
 * Actionable explanation for a code.
 *
 * @param code - the reason code to explain.
 * @returns the model-facing explanation; never undefined for a known code.
 */
export function reasonMessage(code: ReasonCode): string {
  return REASON_MESSAGES[code]
}
