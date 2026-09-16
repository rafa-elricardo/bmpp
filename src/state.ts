/**
 * BMPP policy state machine — pure, deterministic, runtime-free.
 *
 * This module answers one question for every tool call: *may this call proceed
 * under the memory policy?* It answers it from explicit state and explicit
 * inputs only. There is no Cordis context, no Harness service, no MCP client and
 * no clock here: the whole decision is a function of the values passed in, which
 * is what makes every rule unit-testable in isolation.
 *
 * What this module does NOT do — by design:
 *
 * - it does not read the user's text, and never infers `SIMPLE` / `COMPLEX`;
 * - it does not inspect note content, and never judges whether memory is
 *   relevant, true or worth keeping;
 * - it does not apply `mode` / `profile` to the runtime: `decide` returns the
 *   POLICY verdict, and {@link enforcementFor} maps that verdict onto a mode.
 *   A caller that records without enforcing is exactly `mode: audit`.
 *
 * State lifetime: the session owns the machine; the turn sub-state is replaced
 * wholesale on {@link onTurnStart}, so nothing leaks between turns.
 *
 * @module dsh-bmpp/state
 */

import {
  DEFAULT_MUTATING_TOOLS,
  DEFAULT_READ_TOOLS,
  DEFAULT_SEARCH_TOOLS,
  DEFAULT_DESTRUCTIVE_TOOLS,
  type BmppConfig,
  type BmppMode,
  type BmppProfile,
} from './config.ts'
import {
  DENY_REASON_CODES,
  ObservationCode,
  ReasonCode,
  reasonMessage,
  type ObservationCode as ObservationCodeValue,
} from './reason-codes.ts'

/** The control tool the model calls to declare a turn's classification. */
export const CLASSIFY_TOOL = 'bmpp__classify'

/** Declaration a turn carries; `unknown` is the initial, conservative value. */
export type Classification = 'unknown' | 'simple' | 'complex'

/** How far the mandatory recall has progressed. */
export type RecallState = 'idle' | 'in_flight' | 'succeeded' | 'failed'

/** The outcome of the mandatory recall, once one completed. */
export type RecallOutcome = 'ok' | 'empty' | 'failed'

/** Inputs the machine needs to classify and judge one call. */
export interface CallInput {
  /** Model-facing tool name, e.g. `mcp__basic-memory__write_note`. */
  readonly tool: string
  /** Parsed arguments, or `undefined` when malformed or absent. */
  readonly args?: unknown
}

/**
 * Why a permitted call deserves a note. Never changes the decision.
 *
 * `undefined` means the call is unremarkable and needs no explanation beyond
 * its reason code.
 */
export type Observation =
  | { readonly code: ObservationCodeValue; readonly detail?: string }
  | undefined

/** The recall sub-state of one turn. */
export interface RecallStateView {
  readonly state: RecallState
  readonly outcome: RecallOutcome | undefined
  /** How many recall attempts this turn made. */
  readonly attempts: number
  /** The last recall tool called, if any. */
  readonly lastTool: string | undefined
  /** True once any recall tool has run this turn. */
  readonly attempted: boolean
}

/** The tool-call bookkeeping of one turn. */
export interface ToolCallState {
  readonly total: number
  readonly blocked: number
}

/** State of one turn. Replaced wholesale on `turn/start`. */
export interface PolicyTurnState {
  readonly turnId: number
  readonly classification: Classification
  readonly recall: RecallStateView
  readonly calls: ToolCallState
  /** Note paths written this turn, keyed by tool and path. */
  readonly writes: Readonly<Record<string, number>>
  /** Note paths read this turn, used by the overwrite guard. */
  readonly readNotes: readonly string[]
}

/** State of one agent session. */
export interface PolicySessionState {
  readonly sessionId: string
  readonly policyVersion: string
  /** The active turn sub-state. */
  readonly turn: PolicyTurnState
}

/** Inputs that describe the session a decision belongs to. */
export interface DecisionContext {
  readonly sessionId: string
  readonly policyVersion: string
  /** Tool classification lists; defaults to the approved configuration. */
  readonly readTools?: readonly string[]
  readonly searchTools?: readonly string[]
  readonly mutatingTools?: readonly string[]
  readonly destructiveTools?: readonly string[]
  /** `write_note` without `overwrite` requires a prior recall. */
  readonly createRequiresSearch?: boolean
  /** Overwrite-without-read behaviour; `off` disables the check. */
  readonly overwriteRequiresRead?: 'off' | 'warn' | 'deny'
}

/** The policy's own state at the moment of a decision, for the audit trail. */
export type PolicyStateName =
  | 'SIMPLE'
  | 'UNKNOWN'
  | 'RECALL_REQUIRED'
  | 'RECALL_IN_FLIGHT'
  | 'RECALL_OK'
  | 'RECALL_FAILED'
  | 'OUT_OF_SCOPE'

/** The policy verdict, before any mode applies it. */
export type PolicyDecision = 'allow' | 'deny'

/** Durable audit record of one decision. Never contains arguments or content. */
export interface PolicyEvent {
  readonly phase: 'pre-execute'
  readonly tool: string
  readonly toolClass: 'memory.read' | 'memory.write' | 'control' | 'other'
  readonly policyState: PolicyStateName
  readonly decision: PolicyDecision
  readonly reasonCode: ReasonCode
  readonly classification: Classification
  readonly recallState: RecallState
  readonly observation: Observation
  readonly policyVersion: string
  /** Turn sequence within this session, not the Harness turn number. */
  readonly turnId: number
}

/**
 * One evaluation: the verdict, why, the audit event, and the next state.
 *
 * `state` is the updated machine. It differs from the input for any call that
 * advances the machine (a classification, a recall attempt, a recorded write)
 * and is the same object reference otherwise, so a caller can compare identity.
 */
export interface PolicyStep {
  readonly decision: PolicyDecision
  readonly reasonCode: ReasonCode
  readonly event: PolicyEvent
  readonly state: PolicySessionState
}

/** What the enforcing layer should do once `mode` has been applied. */
export type EnforcementAction = 'allow' | 'deny' | 'ask'

/** How a policy verdict materializes under one mode. */
export interface Enforcement {
  readonly action: EnforcementAction
  /**
   * True when the policy wanted to deny or warn but the mode recorded the
   * decision instead of applying it. `mode: audit` always sets this.
   */
  readonly auditOverride: boolean
}

/**
 * A fresh session, before any turn has started.
 *
 * `classification` is `unknown` on purpose: an unclassified turn permits reads
 * and blocks memory mutations, which is the conservative default the design
 * approves. A restart therefore fails closed rather than inheriting authority.
 *
 * @param sessionId - opaque session identity.
 * @param policyVersion - policy version stamped on every event.
 */
export function initialState(sessionId: string, policyVersion: string): PolicySessionState {
  return {
    sessionId,
    policyVersion,
    turn: {
      turnId: 0,
      classification: 'unknown',
      recall: { state: 'idle', outcome: undefined, attempts: 0, lastTool: undefined, attempted: false },
      calls: { total: 0, blocked: 0 },
      writes: {},
      readNotes: [],
    },
  }
}

/** Reset for a new session; identical to a fresh machine. */
export function onSessionStart(sessionId: string, policyVersion: string): PolicySessionState {
  return initialState(sessionId, policyVersion)
}

/**
 * Reset for a new turn.
 *
 * Classification, recall and per-turn bookkeeping are all discarded: a new turn
 * starts unclassified and must justify itself again. This is the reset the test
 * suite asserts on, and the reason a stale recall can never authorize a later
 * turn.
 *
 * @param state - the current session state.
 */
export function onTurnStart(state: PolicySessionState): PolicySessionState {
  return {
    ...state,
    turn: {
      turnId: state.turn.turnId + 1,
      classification: 'unknown',
      recall: { state: 'idle', outcome: undefined, attempts: 0, lastTool: undefined, attempted: false },
      calls: { total: 0, blocked: 0 },
      writes: {},
      readNotes: [],
    },
  }
}

/**
 * Record the result of a mandatory recall.
 *
 * Only a non-error result opens the gate, and an empty result still counts as a
 * completion: refusing to reward an honest empty search would teach the model to
 * invent hits. A failed attempt leaves the gate closed and can be retried.
 *
 * @param state - the current session state.
 * @param outcome - `ok`, `empty` (both satisfying) or `failed`.
 */
export function onRecallResult(
  state: PolicySessionState,
  outcome: RecallOutcome,
): PolicySessionState {
  const succeeded = outcome !== 'failed'
  return {
    ...state,
    turn: {
      ...state.turn,
      recall: {
        ...state.turn.recall,
        state: succeeded ? 'succeeded' : 'failed',
        outcome,
      },
    },
  }
}

/** Fresh decision inputs with the approved defaults applied. */
function resolveContext(context: DecisionContext): Required<DecisionContext> {
  return {
    sessionId: context.sessionId,
    policyVersion: context.policyVersion,
    readTools: context.readTools ?? DEFAULT_READ_TOOLS,
    searchTools: context.searchTools ?? DEFAULT_SEARCH_TOOLS,
    mutatingTools: context.mutatingTools ?? DEFAULT_MUTATING_TOOLS,
    destructiveTools: context.destructiveTools ?? DEFAULT_DESTRUCTIVE_TOOLS,
    createRequiresSearch: context.createRequiresSearch ?? true,
    overwriteRequiresRead: context.overwriteRequiresRead ?? 'warn',
  }
}

/** Extract a string field from possibly-malformed tool arguments. */
function readStringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Extract a boolean flag from possibly-malformed tool arguments. */
function readBooleanArg(args: unknown, key: string): boolean {
  if (typeof args !== 'object' || args === null) return false
  return (args as Record<string, unknown>)[key] === true
}

/** Matched tool classes for one call. */
interface ToolClass {
  readonly control: boolean
  readonly inNamespace: boolean
  readonly read: boolean
  readonly search: boolean
  readonly mutate: boolean
  readonly known: boolean
  readonly destructive: boolean
}

function classifyTool(tool: string, context: Required<DecisionContext>): ToolClass {
  const control = tool === CLASSIFY_TOOL
  const inNamespace = tool.startsWith('mcp__basic-memory__')
  const read = inNamespace && context.readTools.includes(tool)
  const search = read && context.searchTools.includes(tool)
  const knownWrite = inNamespace && context.mutatingTools.includes(tool)
  // An unlisted tool inside the memory namespace is treated as a write:
  // a server that publishes something new must not open a hole.
  const mutate = knownWrite || (inNamespace && !read)
  return {
    control,
    inNamespace,
    read,
    search,
    mutate,
    known: read || knownWrite,
    destructive: inNamespace && context.destructiveTools.includes(tool),
  }
}

/** The policy-state name the machine is in for one call. */
function policyStateName(
  toolClass: ToolClass,
  turn: PolicyTurnState,
  preferred: PolicyStateName | undefined,
): PolicyStateName {
  if (preferred !== undefined) return preferred
  // A control tool is evaluated outside the memory namespace but still reports
  // the turn's real policy state: `OUT_OF_SCOPE` would disguise the fact that
  // the gate is closed on this turn.
  if (!toolClass.inNamespace && !toolClass.control) return 'OUT_OF_SCOPE'
  if (turn.classification === 'simple') return 'SIMPLE'
  if (turn.classification === 'unknown') return 'UNKNOWN'
  switch (turn.recall.state) {
    case 'in_flight': return 'RECALL_IN_FLIGHT'
    case 'succeeded': return 'RECALL_OK'
    case 'failed': return 'RECALL_FAILED'
    case 'idle': return 'RECALL_REQUIRED'
  }
}

/** Assemble the audit event for one decision. */
function buildEvent(
  context: Required<DecisionContext>,
  tool: string,
  toolClass: ToolClass,
  turn: PolicyTurnState,
  decision: PolicyDecision,
  reasonCode: ReasonCode,
  observation: Observation,
  overrideState?: PolicyStateName,
): PolicyEvent {
  const kind: PolicyEvent['toolClass'] = toolClass.control
    ? 'control'
    : toolClass.mutate
      ? 'memory.write'
      : toolClass.read
        ? 'memory.read'
        : 'other'
  return {
    phase: 'pre-execute',
    tool,
    toolClass: kind,
    policyState: policyStateName(toolClass, turn, overrideState),
    decision,
    reasonCode,
    classification: turn.classification,
    recallState: turn.recall.state,
    observation,
    policyVersion: context.policyVersion,
    turnId: turn.turnId,
  }
}

/**
 * Decide whether one tool call may proceed under the memory policy.
 *
 * Pure: the same `(state, call, context)` always yields the same verdict, and
 * malformed input yields a decision rather than an exception — a call with
 * unusable arguments falls back to the conservative reading of its tool.
 *
 * Gate precedence, first match winning:
 *
 * 1. BMPP's own control tool — always allowed.
 * 2. Non-memory tools — allowed; the MVP does not govern them.
 * 3. Read-only memory tools — always allowed; reads are never gated.
 * 4. Unclassified turn + memory write — denied, `CLASSIFICATION_REQUIRED`.
 * 5. No recall attempt yet + memory write — denied, `MEMORY_LOOKUP_REQUIRED`
 *    (or `CREATE_REQUIRES_SEARCH` for a new note).
 * 6. Recall in flight in this batch + memory write — denied,
 *    `MEMORY_LOOKUP_PENDING_IN_BATCH`.
 * 7. Recall failed + memory write — denied, `MEMORY_LOOKUP_FAILED`.
 * 8. Overwrite without having read the note — denied, `OVERWRITE_REQUIRES_READ`.
 * 9. Otherwise — allowed, `ALLOW_RECALL_OK` or `ALLOW_SIMPLE`.
 *
 * @param state - current session state.
 * @param call - the tool call being evaluated.
 * @param context - session identity and tool classification lists.
 * @returns the verdict, its reason, the audit event, and the next state.
 */
export function decide(
  state: PolicySessionState,
  call: CallInput,
  context: DecisionContext,
): PolicyStep {
  const resolved = resolveContext(context)
  const toolClass = classifyTool(call.tool, resolved)
  const turn = state.turn
  const calls = { ...turn.calls, total: turn.calls.total + 1 }
  const base: PolicyTurnState = { ...turn, calls }

  if (toolClass.control) return decideControl(state, base, call, toolClass, resolved)
  if (!toolClass.inNamespace) return decideOutOfScope(state, base, call, toolClass, resolved)
  if (toolClass.read) return decideMemoryRead(state, base, call, toolClass, resolved)
  if (toolClass.mutate) return decideMemoryWrite(state, base, call, toolClass, resolved)
  return decideUnknownMemory(state, base, call, toolClass, resolved)
}

/** Step 1: BMPP's own control tool is always permitted. */
function decideControl(
  state: PolicySessionState,
  turn: PolicyTurnState,
  call: CallInput,
  toolClass: ToolClass,
  context: Required<DecisionContext>,
): PolicyStep {
  const classification = readStringArg(call.args, 'task')
  const reclassified = classification === 'simple' || classification === 'complex'
    ? turn.classification !== 'unknown' && turn.classification !== classification
    : false
  const nextClassification: Classification = classification === 'simple' || classification === 'complex'
    ? classification
    : turn.classification

  const observation: Observation = classification === 'simple' || classification === 'complex'
    ? reclassified
      ? { code: ObservationCode.RECLASSIFIED }
      : undefined
    : undefined

  const nextTurn: PolicyTurnState = {
    ...turn,
    classification: nextClassification,
    // A recall already earned in this turn is not discarded by reclassifying.
    recall: turn.recall,
  }
  // Only claim the SIMPLE policy state when the declaration actually made the
  // turn simple; an unusable declaration must not make the audit trail lie.
  const controlState: PolicyStateName | undefined = nextClassification === 'simple'
    ? 'SIMPLE'
    : nextClassification === 'complex'
      ? 'RECALL_REQUIRED'
      : undefined
  const event = buildEvent(context, call.tool, toolClass, nextTurn, 'allow',
    ReasonCode.ALLOW_CONTROL, observation, controlState)
  return { decision: 'allow', reasonCode: ReasonCode.ALLOW_CONTROL, event, state: { ...state, turn: nextTurn } }
}

/** Step 2: a tool outside the memory namespace is out of the MVP's scope. */
function decideOutOfScope(
  state: PolicySessionState,
  turn: PolicyTurnState,
  call: CallInput,
  toolClass: ToolClass,
  context: Required<DecisionContext>,
): PolicyStep {
  const event = buildEvent(context, call.tool, toolClass, turn, 'allow',
    ReasonCode.ALLOW_OUT_OF_SCOPE, undefined, 'OUT_OF_SCOPE')
  return { decision: 'allow', reasonCode: ReasonCode.ALLOW_OUT_OF_SCOPE, event, state: { ...state, turn } }
}

/**
 * Step 3: reads are never gated.
 *
 * A read-only tool satisfies recall only when it is one of the configured
 * search tools, and even then only its RESULT settles the gate. Everything else
 * is recorded as read-only so an audit can tell a lookup from an inspection.
 */
function decideMemoryRead(
  state: PolicySessionState,
  turn: PolicyTurnState,
  call: CallInput,
  toolClass: ToolClass,
  context: Required<DecisionContext>,
): PolicyStep {
  const opensRecall = toolClass.search && turn.classification !== 'simple'
  const observation: Observation = toolClass.search
    ? undefined
    : { code: ObservationCode.READ_ONLY_NOT_RECALL }

  const notePath = call.tool === 'mcp__basic-memory__read_note'
    ? readStringArg(call.args, 'identifier')
    : undefined
  const readNotes = notePath !== undefined && !turn.readNotes.includes(notePath)
    ? [...turn.readNotes, notePath]
    : turn.readNotes

  const nextTurn: PolicyTurnState = {
    ...turn,
    readNotes,
    ...(opensRecall
      ? {
          recall: {
            ...turn.recall,
            // A repeat search must not regress an already-earned success.
            state: turn.recall.state === 'succeeded' ? 'succeeded' as const : 'in_flight' as const,
            attempted: true,
            attempts: turn.recall.attempts + 1,
            lastTool: call.tool,
          },
        }
      : {}),
  }

  const event = buildEvent(context, call.tool, toolClass, nextTurn, 'allow',
    ReasonCode.ALLOW_READ_ONLY, observation)
  return { decision: 'allow', reasonCode: ReasonCode.ALLOW_READ_ONLY, event, state: { ...state, turn: nextTurn } }
}

/** Step 4-9: the recall precondition on a memory mutation. */
function decideMemoryWrite(
  state: PolicySessionState,
  turn: PolicyTurnState,
  call: CallInput,
  toolClass: ToolClass,
  context: Required<DecisionContext>,
): PolicyStep {
  const recall = turn.recall
  const path = readStringArg(call.args, 'file_path') ?? readStringArg(call.args, 'identifier')
  const isCreate = call.tool === 'mcp__basic-memory__write_note' && !readBooleanArg(call.args, 'overwrite')

  const denial = findWriteDenial(turn, context, recall, isCreate, call.args, path)
  if (denial !== undefined) {
    const blockedTurn: PolicyTurnState = { ...turn, calls: { ...turn.calls, blocked: turn.calls.blocked + 1 } }
    const event = buildEvent(context, call.tool, toolClass, blockedTurn, 'deny', denial, undefined)
    return { decision: 'deny', reasonCode: denial, event, state: { ...state, turn: blockedTurn } }
  }

  const writeKey = `${call.tool}\u0000${path ?? '<unknown>'}`
  const writes = { ...turn.writes }
  writes[writeKey] = (writes[writeKey] ?? 0) + 1
  const allowedTurn: PolicyTurnState = { ...turn, writes }

  const reasonCode = turn.classification === 'simple'
    ? ReasonCode.ALLOW_SIMPLE
    : ReasonCode.ALLOW_RECALL_OK
  const observation: Observation = recall.outcome === 'empty'
    ? { code: ObservationCode.RECALL_EMPTY }
    : undefined
  const event = buildEvent(context, call.tool, toolClass, allowedTurn, 'allow', reasonCode, observation)
  return { decision: 'allow', reasonCode, event, state: { ...state, turn: allowedTurn } }
}

/**
 * The first unmet precondition for a memory mutation, or `undefined` when every
 * gate is satisfied. Order matters: it produces the most specific actionable
 * instruction the model can act on.
 */
function findWriteDenial(
  turn: PolicyTurnState,
  context: Required<DecisionContext>,
  recall: RecallStateView,
  isCreate: boolean,
  args: unknown,
  path: string | undefined,
): ReasonCode | undefined {
  // A SIMPLE turn turns the whole gate off. This is the only path that skips the
  // classification requirement, and it requires an explicit declaration.
  if (turn.classification === 'simple') return undefined
  if (turn.classification === 'unknown') return ReasonCode.CLASSIFICATION_REQUIRED
  if (!recall.attempted) {
    return isCreate && context.createRequiresSearch
      ? ReasonCode.CREATE_REQUIRES_SEARCH
      : ReasonCode.MEMORY_LOOKUP_REQUIRED
  }
  if (recall.state === 'in_flight') return ReasonCode.MEMORY_LOOKUP_PENDING_IN_BATCH
  if (recall.state === 'failed') return ReasonCode.MEMORY_LOOKUP_FAILED
  // Recall succeeded: the remaining checks are the secondary guards.
  if (context.overwriteRequiresRead !== 'off'
    && readBooleanArg(args, 'overwrite')
    && path !== undefined
    && !turn.readNotes.includes(path)) {
    return ReasonCode.OVERWRITE_REQUIRES_READ
  }
  return undefined
}

/**
 * A tool inside the memory namespace that no list classifies.
 *
 * Fail-closed is the whole point: a server that starts publishing a new tool
 * must not silently acquire an ungoverned write path. The call is judged by the
 * same recall precondition as a known write.
 */
function decideUnknownMemory(
  state: PolicySessionState,
  turn: PolicyTurnState,
  call: CallInput,
  toolClass: ToolClass,
  context: Required<DecisionContext>,
): PolicyStep {
  const denial = turn.classification === 'simple'
    ? undefined
    : turn.classification === 'unknown'
      ? ReasonCode.CLASSIFICATION_REQUIRED
      : !turn.recall.attempted
        ? ReasonCode.MEMORY_LOOKUP_REQUIRED
        : turn.recall.state === 'in_flight'
          ? ReasonCode.MEMORY_LOOKUP_PENDING_IN_BATCH
          : turn.recall.state === 'failed'
            ? ReasonCode.MEMORY_LOOKUP_FAILED
            : undefined

  if (denial !== undefined) {
    const blockedTurn: PolicyTurnState = { ...turn, calls: { ...turn.calls, blocked: turn.calls.blocked + 1 } }
    const event = buildEvent(context, call.tool, toolClass, blockedTurn, 'deny', denial, undefined)
    return { decision: 'deny', reasonCode: denial, event, state: { ...state, turn: blockedTurn } }
  }

  const reasonCode = turn.classification === 'simple' ? ReasonCode.ALLOW_SIMPLE : ReasonCode.ALLOW_RECALL_OK
  const event = buildEvent(context, call.tool, toolClass, turn, 'allow', reasonCode, undefined)
  return { decision: 'allow', reasonCode, event, state: { ...state, turn } }
}

/** What the model must do to satisfy a denial, before mode applies. */
export interface PolicyDirective {
  readonly reasonCode: ReasonCode
  /** `ask` is reserved for destructive tools under `enforce` + `strict`. */
  readonly kind: 'deny' | 'ask'
}

/**
 * Map a policy verdict onto one `mode` and `profile`.
 *
 * This is the ONLY place `mode` and `profile` influence an outcome, which keeps
 * the rule "`profile` never changes `mode`" structurally true:
 *
 * - `off` allows without deciding anything further;
 * - `audit` records the denial and allows anyway, reporting `auditOverride`;
 * - `enforce` applies a denial, and turns it into `ask` only when the profile is
 *   `strict` and the denial concerns a destructive tool.
 *
 * @param reasonCode - the policy verdict's reason.
 * @param mode - the configured mode.
 * @param profile - the configured profile.
 * @param isDestructive - whether the call is a destructive memory operation.
 * @returns the action to take and whether the policy decision was overridden.
 */
export function enforcementFor(
  reasonCode: ReasonCode,
  mode: BmppMode,
  profile: BmppProfile,
  isDestructive: boolean,
): Enforcement {
  const denies = DENY_REASON_CODES.includes(reasonCode)
  if (mode === 'off' || !denies) return { action: 'allow', auditOverride: mode === 'audit' && denies }
  if (mode === 'audit') return { action: 'allow', auditOverride: true }
  if (profile === 'strict' && isDestructive) return { action: 'ask', auditOverride: false }
  return { action: 'deny', auditOverride: false }
}

/** The model-facing explanation for a policy verdict. */
export function messageFor(reasonCode: ReasonCode): string {
  return reasonMessage(reasonCode)
}

/** Configuration-derived decision inputs, so callers share one mapping. */
export function decisionContextFrom(
  config: BmppConfig,
  sessionId: string,
): DecisionContext {
  return {
    sessionId,
    policyVersion: config.policyVersion,
    readTools: config.readTools,
    searchTools: config.searchTools,
    mutatingTools: config.mutatingTools,
    destructiveTools: config.destructiveTools,
    createRequiresSearch: config.createRequiresSearch,
    overwriteRequiresRead: config.overwriteRequiresRead,
  }
}
