/**
 * BMPP audit record: the durable sidecar shape, and the port the gate writes through.
 *
 * BMPP deliberately keeps its audit out of the session event log. A session
 * event type a third-party plugin invents is "required-on-read" for the Harness
 * unless its envelope carries `ignorable: true`, and `Session.append` exposes no
 * way to set that marker, so a persisted `bmpp/policy` event makes the session
 * unobservable and unresumable. This module owns the replacement: one
 * schema-validated record per decision, stored through the Harness's public
 * `storageDomain` service, with the session id as the record key prefix so a
 * session's trail stays addressable.
 *
 * The policy state machine knows nothing about this module beyond
 * {@link AuditSink}: `record()` is a non-blocking enqueue, and `flush()` and
 * `close()` are lifecycle. A sink that cannot persist reports it and the verdict
 * stands — the audit is evidence, never authority.
 *
 * @module dsh-bmpp/audit-sink
 */

import { z } from 'zod'
import type { BmppMode, BmppProfile } from './config.ts'
import type { ReasonCode } from './reason-codes.ts'
import type { PolicyEvent, RecallOutcome } from './state.ts'

/**
 * Domain name for the audit sidecar.
 *
 * Must match the storage layer's unit-name rule `^[a-z][a-z0-9_]*$`, which
 * forbids hyphens — hence `bmpp_audit`, not `bmpp-audit`.
 */
export const AUDIT_DOMAIN_NAME = 'bmpp_audit'

/** Domain format version; reads and writes are stamped with it. */
export const AUDIT_DOMAIN_VERSION = 1

/** Table holding one record per audit event. */
export const AUDIT_TABLE = 'events'

/** What the runtime did with a policy verdict. */
export type BmppEnforcement = 'allowed' | 'denied' | 'asked' | 'overridden'

/**
 * One sealed audit record: the payload plus the coordinates that make it
 * readable without the session log.
 *
 * `recordedAt` is when BMPP wrote it, not when the decision happened; the
 * decision's own ordering lives in `policyTurn`. `seq` is a plugin-local
 * monotonic counter, so records sort deterministically within a session.
 */
export interface SealedAuditRecord {
  /** Session the decision belongs to; also the record-key prefix. */
  readonly sessionId: string
  /** Plugin-local insertion counter, unique and ordered within the process. */
  readonly seq: number
  /** Unix epoch milliseconds at record time. */
  readonly recordedAt: number
  readonly payload: SealedAuditPayload
}

/** The two halves of the audit trail, discriminated by `kind`. */
export type SealedAuditPayload = SealedDecisionPayload | SealedRecallPayload

/** The pre-execute half: one evaluated tool call. */
export interface SealedDecisionPayload {
  readonly kind: 'pre-execute'
  /** Harness turn, when the host exposes one. Absent, never synthesized. */
  readonly harnessTurn?: number
  /** Turns opened by BMPP itself, a different quantity from `harnessTurn`. */
  readonly policyTurn: number
  readonly tool: string
  readonly toolClass: PolicyEvent['toolClass']
  /** Name of the state the machine was in while deciding. */
  readonly policyState: string
  /** The policy verdict, before `mode` applied it. */
  readonly decision: 'allow' | 'deny'
  readonly reasonCode: ReasonCode
  /** What the configured mode actually did with the verdict. */
  readonly enforcement: BmppEnforcement
  /** True when the verdict was applied. */
  readonly enforced: boolean
  /** True when the mode recorded a denial without applying it. */
  readonly auditOverride: boolean
  readonly classification: PolicyEvent['classification']
  readonly recallState: PolicyEvent['recallState']
  /** Observation code, present only when one was recorded. */
  readonly observation?: string
  readonly mode: BmppMode
  readonly profile: BmppProfile
  readonly policyVersion: string
  readonly pluginVersion: string
}

/** The tools/result half: a recall attempt reaching a verdict. */
export interface SealedRecallPayload {
  readonly kind: 'recall'
  readonly harnessTurn?: number
  readonly policyTurn: number
  readonly tool: string
  readonly toolClass: 'memory.read'
  /** Recall state AFTER the outcome was applied. */
  readonly recallState: PolicyEvent['recallState']
  readonly recallOutcome: RecallOutcome
  readonly classification: PolicyEvent['classification']
  readonly mode: BmppMode
  readonly profile: BmppProfile
  readonly policyVersion: string
  readonly pluginVersion: string
}

/** True when a value is plain JSON, the only shape the medium may hold. */
function isJsonValue(value: unknown): boolean {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(value as Record<string, unknown>).every(isJsonValue)
  }
  return false
}

/**
 * Reject a payload that is not lossless JSON before it reaches the medium.
 *
 * The stored record is read back and re-validated on the next open, so a value
 * that cannot survive JSON would surface as a corrupt-record refusal at boot
 * instead of at the write that caused it. This check moves that failure to the
 * append site, which is the only place with the offending payload in hand.
 */
function isSealedAuditPayload(value: unknown): value is SealedAuditPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const kind = (value as { kind?: unknown }).kind
  if (kind !== 'pre-execute' && kind !== 'recall') return false
  return isJsonValue(value)
}

/**
 * Validates one stored audit record at the durable boundary.
 *
 * `z.custom` carries the payload through typed while the predicate still
 * enforces JSON-serializability; the surrounding object keeps every envelope
 * field explicit, so a records file that lost `sessionId` or `seq` is rejected
 * at open rather than silently read as an unaddressable record.
 */
export const auditRecordSchema = z.object({
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  recordedAt: z.number().int().nonnegative(),
  payload: z.custom<SealedAuditPayload>(isSealedAuditPayload, {
    message: 'audit payload must be a JSON-serializable pre-execute or recall record',
  }),
})

/** The stored shape, derived from the schema so the two cannot drift. */
export type AuditRecordValue = z.infer<typeof auditRecordSchema>

/**
 * The declared audit domain.
 *
 * `per-record` layout: each decision is its own durable document, so a session's
 * trail grows without rewriting one large value and a single unreadable record
 * can be moved aside instead of costing the open. `invalidRecords` is left at
 * its rejecting default — unlike a derived cache, an audit record that no longer
 * validates is evidence BMPP must not silently discard.
 *
 * Declared as a plain structural spec rather than through the
 * `@deepseek-ai/dsh-storage-domain` helper: BMPP consumes the service through
 * `ctx.get('storageDomain')`, so it needs the spec's shape, not that package's
 * module identity. That also keeps BMPP off a DSH package whose published
 * versions do not line up with the Harness releases it supports.
 */
export const AUDIT_DOMAIN_SPEC = {
  name: AUDIT_DOMAIN_NAME,
  version: AUDIT_DOMAIN_VERSION,
  layout: 'per-record',
  tables: { [AUDIT_TABLE]: { valueSchema: auditRecordSchema } },
} as const

/** Why a record did not reach the medium. */
export type AuditDropReason = 'storage-unavailable' | 'queue-overflow' | 'write-failed' | 'closed'

/** Outcome of handing one record to a sink. */
export type AuditRecordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AuditDropReason; readonly error?: string }

/**
 * The port the gate writes audit through.
 *
 * Separated from the storage-backed implementation so the pure decision path can
 * be exercised against an in-memory double, and so `storage` stays an optional
 * dependency of the plugin rather than a prerequisite of its policy.
 */
export interface AuditSink {
  /**
   * Enqueue one record. Non-blocking and never throwing: the caller is the
   * `tools/pre-execute` hot path, and a sink failure must not delay, deny, or
   * admit a tool call.
   * @param record - the sealed record to persist.
   * @returns whether it was accepted for persistence.
   */
  record(record: SealedAuditRecord): AuditRecordResult

  /** Resolve once every accepted record is durable. */
  flush(): Promise<void>

  /**
   * Stop waiting for a durable target and report anything still buffered.
   *
   * Only a buffering sink implements this; a sink that already persists leaves
   * it undefined, which is why it is optional.
   */
  abandon?(): void

  /**
   * Resolve once this sink has stopped waiting for a durable target.
   *
   * A sink that persists immediately resolves right away. A sink still waiting
   * for the optional storage service resolves when that wait ends — either handoff
   * or abandonment — which is what lets a caller observe the audit
   * deterministically instead of racing the mount order.
   */
  whenSettled(): Promise<void>

  /** Flush, release the domain, and stop accepting records. */
  close(): Promise<void>
}
