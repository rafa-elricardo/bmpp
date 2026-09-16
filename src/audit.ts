/**
 * BMPP audit trail: the durable record of every policy decision.
 *
 * The audit is the *evidence* half of the plugin. The gate decides; this module
 * writes down what it decided, why, and what the runtime did with it, so a
 * reader can answer "why was this call blocked?" without reading the model's
 * reasoning or the tool arguments.
 *
 * Three properties are load-bearing:
 *
 * 1. **The decision never depends on the audit.** A failing append is reported
 *    and swallowed — a policy plugin that stops enforcing because logging broke
 *    would turn an observability outage into a policy outage.
 * 2. **No content, no arguments, no transcript.** The payload carries tool
 *    *names*, classes, state names and counters. A tool's `arguments` never
 *    reach it, which is why note content and secrets cannot leak through it.
 * 3. **The two turn numbers stay distinct.** `policyTurn` is BMPP's own counter;
 *    `harnessTurn` is the host's when the host exposes one, and is absent
 *    otherwise rather than being synthesized from the other.
 *
 * @module dsh-bmpp/audit
 */

import type { PolicyEvent, PolicySessionState, RecallOutcome } from './state.ts'
import type { ReasonCode } from './reason-codes.ts'
import type { BmppMode, BmppProfile } from './config.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One BMPP policy decision, or one recall settlement.
     *
     * Written by the gate on every `tools/pre-execute` evaluation, and again
     * when a search result settles the recall sub-state. Metadata only: no tool
     * arguments, no note content, no user text, no chain-of-thought.
     */
    'bmpp/policy': BmppPolicyPayload
  }
}

/** What the runtime did with a policy verdict. */
export type BmppEnforcement = 'allowed' | 'denied' | 'asked' | 'overridden'

/** The pre-execute half of the audit trail: one evaluated tool call. */
export interface BmppDecisionPayload {
  readonly kind: 'pre-execute'
  /** Harness turn, when the host exposes one. Absent, never synthesized. */
  readonly harnessTurn?: number
  /**
   * Turns opened by BMPP itself. A different quantity from `harnessTurn`, and
   * meaningful even when the host exposes no turn boundary.
   */
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
  /** True when `mode: 'enforce'` was in effect and the verdict was applied. */
  readonly enforced: boolean
  /** True when the mode recorded a denial without applying it. */
  readonly auditOverride: boolean
  readonly classification: PolicyEvent['classification']
  readonly recallState: PolicyEvent['recallState']
  /** Observation code, present only when one was recorded. */
  readonly observation?: string
  readonly mode: BmppMode
  readonly profile: BmppProfile
  /** Policy version from configuration; the single source of truth for it. */
  readonly policyVersion: string
  /** Version of the plugin that wrote this event. */
  readonly pluginVersion: string
}

/** The tools/result half: a recall attempt reaching a verdict. */
export interface BmppRecallPayload {
  readonly kind: 'recall'
  readonly harnessTurn?: number
  readonly policyTurn: number
  readonly tool: string
  readonly toolClass: 'memory.read'
  /** Recall state AFTER the outcome was applied. */
  readonly recallState: PolicyEvent['recallState']
  /**
   * `ok` or `failed` in practice. `empty` is modelled but unreachable: the MCP
   * bridge advertises no output schema for the search tool, so an empty result
   * is indistinguishable from a populated one and BMPP refuses to parse
   * content text to guess. See `docs/ARCHITECTURE.md` §7.4(a).
   */
  readonly recallOutcome: RecallOutcome
  readonly classification: PolicyEvent['classification']
  readonly mode: BmppMode
  readonly profile: BmppProfile
  readonly policyVersion: string
  readonly pluginVersion: string
}

/** Every `bmpp/policy` event is one of the two halves. */
export type BmppPolicyPayload = BmppDecisionPayload | BmppRecallPayload

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

/** Immutable facts about the session the append targets. */
export interface AuditSession {
  /** The `session.append` surface; absent on a host that cannot persist. */
  readonly append?: (type: 'bmpp/policy', data: BmppPolicyPayload) => unknown
  readonly id: unknown
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
): BmppDecisionPayload {
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
    // `undefined` is not lossless JSON and the session log rejects the event.
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
): BmppRecallPayload {
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

/** Outcome of one attempted audit append. */
export type AuditAppendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/**
 * Append one audit event, never letting the audit break the policy.
 *
 * The payload is JSON by construction — every field is a primitive or an
 * optional number — so the session log's lossless-serialization check has
 * nothing to reject. Everything else is guarded: a host without `append`, a
 * throwing `append`, or a session whose store has already gone are all reported
 * as a non-ok result for the caller to count and surface.
 *
 * @param session - the session to write to.
 * @param payload - the audit payload.
 * @returns whether the event reached the session log.
 */
export function appendAudit(session: AuditSession, payload: BmppPolicyPayload): AuditAppendResult {
  if (typeof session.append !== 'function') {
    return { ok: false, error: 'session has no append surface' }
  }
  try {
    session.append('bmpp/policy', payload)
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
