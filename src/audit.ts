/**
 * BMPP audit trail: the durable record of every policy decision.
 *
 * The audit is the *evidence* half of the plugin. The gate decides; this module
 * builds down what it decided, why, and what the runtime did with it, so a
 * reader can answer "why was this call blocked?" without reading the model's
 * reasoning or the tool arguments.
 *
 * Four properties are load-bearing:
 *
 * 1. **The decision never depends on the audit.** A failing write is reported
 *    and swallowed — a policy plugin that stops enforcing because logging broke
 *    would turn an observability outage into a policy outage.
 * 2. **No content, no arguments, no transcript.** The payload carries tool
 *    *names*, classes, state names and counters. A tool's `arguments` never
 *    reach it, which is why note content and secrets cannot leak through it.
 * 3. **The two turn numbers stay distinct.** `policyTurn` is BMPP's own counter;
 *    `harnessTurn` is the host's when the host exposes one, and is absent
 *    otherwise rather than being synthesized from the other.
 * 4. **It is not a session event.** The record shape and its storage live in
 *    {@link ./audit-sink.ts}; this module only builds payloads and hands them to
 *    the sink. A plugin-invented session event would be required-on-read for the
 *    Harness and would make the session unresumable.
 *
 * @module dsh-bmpp/audit
 */

import type { PolicyEvent, PolicySessionState, RecallOutcome } from './state.ts'
import type { BmppMode, BmppProfile } from './config.ts'
import type {
  BmppEnforcement,
  SealedDecisionPayload,
  SealedRecallPayload,
} from './audit-sink.ts'

export type {
  AuditDropReason,
  AuditRecordResult,
  AuditSink,
  BmppEnforcement,
  SealedAuditPayload,
  SealedAuditRecord,
  SealedDecisionPayload,
  SealedRecallPayload,
} from './audit-sink.ts'

/** Configuration facts every payload carries. */
export interface AuditContext {
  readonly mode: BmppMode
  readonly profile: BmppProfile
  readonly pluginVersion: string
}

/** How one verdict materialized, as computed by the gate. */
export interface EnforcementRecord {
  readonly enforcement: BmppEnforcement
  readonly enforced: boolean
  readonly auditOverride: boolean
}

/** Longest tool name recorded; a name is metadata, an essay is not. */
const MAX_TOOL_NAME_CHARS = 64

/** Truncate a tool name, marking the cut so the value is not mistaken for exact. */
function toolName(tool: string): string {
  return tool.length <= MAX_TOOL_NAME_CHARS ? tool : `${tool.slice(0, MAX_TOOL_NAME_CHARS - 1)}…`
}

/** Include `harnessTurn` only when the host actually reported one. */
function harnessTurnOf(turn: number | undefined): { harnessTurn?: number } {
  return turn === undefined ? {} : { harnessTurn: turn }
}

/**
 * Build the audit payload for one evaluated call.
 *
 * @param event - the policy event the pure decision produced.
 * @param context - mode, profile and plugin version.
 * @param record - what the runtime did with the verdict.
 */
export function decisionPayload(
  event: PolicyEvent,
  context: AuditContext,
  record: EnforcementRecord,
): SealedDecisionPayload {
  return {
    kind: 'pre-execute',
    ...harnessTurnOf(event.turn),
    policyTurn: event.policyTurn,
    tool: toolName(event.tool),
    toolClass: event.toolClass,
    policyState: event.policyState,
    decision: event.decision,
    reasonCode: event.reasonCode,
    enforcement: record.enforcement,
    enforced: record.enforced,
    auditOverride: record.auditOverride,
    classification: event.classification,
    recallState: event.recallState,
    // Present only when there is something to observe. A key holding
    // `undefined` is not lossless JSON, so the record omits it entirely.
    ...(event.observation === undefined ? {} : { observation: event.observation.code }),
    mode: context.mode,
    profile: context.profile,
    policyVersion: event.policyVersion,
    pluginVersion: context.pluginVersion,
  }
}

/**
 * Build the audit payload for one recall settlement.
 *
 * A recall settlement is a distinct audit fact from the pre-execute decision
 * that opened it, so it is its own record rather than a mutation of the earlier
 * one.
 *
 * @param state - the session state after the outcome was applied.
 * @param tool - the search tool whose result settled the recall.
 * @param outcome - `ok` or `failed`.
 * @param context - mode, profile and plugin version.
 * @param harnessTurn - the host turn, when known.
 */
export function recallPayload(
  state: PolicySessionState,
  tool: string,
  outcome: RecallOutcome,
  context: AuditContext,
  harnessTurn: number | undefined,
): SealedRecallPayload {
  return {
    kind: 'recall',
    ...harnessTurnOf(harnessTurn),
    policyTurn: state.turn.policyTurn,
    tool: toolName(tool),
    toolClass: 'memory.read',
    recallState: state.turn.recall.state,
    recallOutcome: outcome,
    classification: state.turn.classification,
    mode: context.mode,
    profile: context.profile,
    policyVersion: state.policyVersion,
    pluginVersion: context.pluginVersion,
  }
}
