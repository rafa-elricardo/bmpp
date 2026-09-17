/**
 * BMPP integration layer — the only module that touches the runtime.
 *
 * It wires the pure policy machine (`./state.ts`) onto the real Harness seams:
 *
 * - `tools/pre-execute` decides allow / deny / ask before a call is dispatched;
 * - `tools/result` settles the recall sub-state from the real outcome;
 * - `session/disposed` releases per-session state when the store really drops it;
 * - `bmpp__classify` is the model's explicit classification control.
 *
 * Two properties this module defends deliberately:
 *
 * 1. **No value import from the Harness.** Everything comes from the injected
 *    `ctx`, and every `@deepseek-ai/*` import is `import type`, erased at
 *    compile time. A runtime import would risk a second module instance of a
 *    Harness package, which is a failure mode BMPP refuses to inherit.
 *    `tests/integration/purity.spec.ts` enforces this against the emitted code.
 * 2. **`decide()` stays mode-agnostic.** `mode` and `profile` are applied here,
 *    after the verdict, so "profile never changes mode" cannot be violated by
 *    the decision logic itself.
 *
 * @module dsh-bmpp/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { BmppConfig } from './config.ts'
import {
  decisionPayload,
  recallPayload,
  type AuditContext,
  type EnforcementRecord,
} from './audit.ts'
import {
  type AuditDropReason,
  type AuditSink,
  type SealedAuditPayload,
} from './audit-sink.ts'
import { DroppedAuditSink, resolveAuditSink } from './audit-store.ts'
import {
  CLASSIFY_TOOL,
  decide,
  decisionContextFrom,
  initialState,
  onRecallResult,
  onTurnStart,
  type CallInput,
  type DecisionContext,
  type PolicySessionState,
} from './state.ts'
import { ReasonCode, reasonMessage } from './reason-codes.ts'
import { BMPP_VERSION } from './version.ts'

/**
 * Structural view of the `sessionProjections` service.
 *
 * Declared locally instead of importing the package: the service is resolved
 * through `ctx.get` at runtime, so BMPP needs its shape, not its module. This
 * keeps the read optional and the dependency soft, which is what lets a host
 * without the projection registry still run the policy.
 */
export interface SessionProjectionsLike {
  stateOf: (session: object, key: string) => unknown
}

/** The only field BMPP reads from the `turnBoundary` projection. */
interface TurnBoundaryLike {
  readonly lastTurn?: unknown
}

/** Result of resolving the current Harness turn for one session. */
export type TurnResolution =
  | { readonly kind: 'turn'; readonly turn: number; readonly source: 'projection' }
  | { readonly kind: 'fallback'; readonly turn: number; readonly source: 'counter' }

/** A denial or approval request the runtime will act on. */
export interface GateDirective {
  readonly kind: 'deny' | 'ask'
  readonly reasonCode: ReasonCode
  /** Model-facing, actionable explanation. */
  readonly reason: string
}

/** Everything one call decided, returned for tests and for later audit wiring. */
export interface GateOutcome {
  readonly reasonCode: ReasonCode
  readonly directive: GateDirective | undefined
  /**
   * True when the policy wanted to deny but the mode recorded the decision
   * instead of applying it. Only `mode: 'audit'` produces this.
   */
  readonly auditOverride: boolean
}

/** Per-session bookkeeping: the policy state plus the Harness turn it belongs to. */
interface SessionEntry {
  state: PolicySessionState
  /** Last Harness turn number observed, or `undefined` before the first call. */
  harnessTurn: number | undefined
}

/** Options for {@link createGate}: the resolved config plus the host context. */
export interface GateOptions {
  readonly ctx: Context
  readonly config: BmppConfig
  /**
   * Audit sink to write through. Omitted builds a dropping sink, so a caller
   * that has not resolved the optional storage service still gets a working
   * gate that reports what it could not persist.
   */
  readonly auditSink?: AuditSink
  /**
   * Whether to register listeners immediately. `false` builds the gate without
   * mounting it, which is what the plugin's own load path needs: the audit sink
   * must be resolved before the listeners start producing records.
   */
  readonly mount?: boolean
}

/** Model-facing description of the classification tool. */
const CLASSIFY_DESCRIPTION = [
  'Declare whether the current turn is SIMPLE or COMPLEX for the memory policy.',
  'A COMPLEX turn requires a completed memory lookup before any Basic Memory',
  'operation that changes state; a SIMPLE turn releases that requirement.',
  'Omitting or invalidating the declaration leaves the turn UNKNOWN, which',
  'permits reads and blocks memory writes.',
].join(' ')

/** JSON Schema of `bmpp__classify` arguments, hand-written like the definition. */
const CLASSIFY_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      enum: ['simple', 'complex'],
      description: 'simple releases the recall gate; complex requires a completed memory lookup.',
    },
  },
  required: ['task'],
  additionalProperties: false,
}

/** Canonical output schema: one boolean saying whether a declaration was recorded. */
const CLASSIFY_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { recorded: { type: 'boolean' } },
  required: ['recorded'],
  additionalProperties: false,
}

/**
 * Read the current Harness turn for one session.
 *
 * The `turnBoundary` projection is the sanctioned source. It is optional: a
 * host without `sessionProjections`, or without the `agent-loop` that registers
 * the projection, falls back to the last turn number the gate itself saw, which
 * is deterministic and never invents a signal.
 *
 * @param projections - the resolved `sessionProjections` service, if present.
 * @param session - the agent's session.
 * @param previous - the last turn number this gate observed, if any.
 */
export function resolveTurn(
  projections: SessionProjectionsLike | undefined,
  session: object,
  previous: number | undefined,
): TurnResolution {
  if (projections !== undefined) {
    try {
      const boundary = projections.stateOf(session, 'turnBoundary') as TurnBoundaryLike | undefined
      const lastTurn = boundary?.lastTurn
      if (typeof lastTurn === 'number' && Number.isFinite(lastTurn)) {
        return { kind: 'turn', turn: lastTurn, source: 'projection' }
      }
    } catch {
      // A throwing projection must not break a tool call: fall through.
    }
  }
  return { kind: 'fallback', turn: previous ?? 0, source: 'counter' }
}

/** The gate: one instance per mounted plugin, owning every per-session state. */
export class BmppGate {
  private readonly ctx: Context
  private readonly config: BmppConfig
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly audit: AuditContext
  private auditSink: AuditSink
  private auditFailures = 0
  /** Plugin-local audit ordering; monotonic across every session in the process. */
  private sequence = 0

  constructor(options: GateOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.audit = {
      mode: options.config.mode,
      profile: options.config.profile,
      pluginVersion: BMPP_VERSION,
    }
    // Until the mount path resolves storage, records are reported as dropped
    // rather than silently lost. A gate built directly (tests, diagnostics)
    // therefore behaves exactly like a host without the storage service.
    this.auditSink = options.auditSink ?? new DroppedAuditSink('storage-unavailable')
  }

  /** Number of sessions currently tracked; exposed for leak assertions. */
  get trackedSessions(): number {
    return this.sessions.size
  }

  /**
   * How many audit records were dropped.
   *
   * A non-zero value means decisions happened without a durable record, which
   * is worth surfacing — but it never changed a verdict, by design.
   */
  get auditFailureCount(): number {
    return this.auditFailures
  }

  /**
   * The sink the gate writes audit through.
   *
   * Defaults to the dropping sink so a gate constructed without storage still
   * decides normally and reports what it lost. The mount path replaces it with
   * a durable sink once the optional storage service has been resolved.
   *
   * @param sink - the sink to persist audit records through.
   */
  setAuditSink(sink: AuditSink): void {
    this.auditSink = sink
  }

  /** Resolve once every accepted audit record is durable. */
  flushAudit(): Promise<void> {
    return this.auditSink.flush()
  }

  /**
   * Resolve once the sink has stopped waiting for the storage service.
   *
   * Independent of `flushAudit`: a sink that is still buffering has nothing to
   * flush yet, so a caller that wants the audit settled waits here first. A
   * host that never provides storage would wait forever, which is why
   * {@link abandonAudit} exists for a caller that knows the composition.
   */
  settleAudit(): Promise<void> {
    return this.auditSink.whenSettled()
  }

  /**
   * Declare that the storage service is not coming, reporting what was buffered.
   *
   * The composition knows this and the plugin does not: a host either mounts the
   * storage rows or it does not. Calling this stops the wait and surfaces the
   * loss at a known point instead of at teardown. It is idempotent, and a sink
   * that already persists ignores it.
   */
  abandonAudit(): void {
    this.auditSink.abandon?.()
  }

  /**
   * Seal one audit payload with its session coordinates and enqueue it.
   *
   * The policy must not become less reliable because the audit store did: a
   * dropped record is counted and reported, and the verdict stands. Nothing
   * here awaits the medium, so no tool call is delayed by it.
   */
  private emit(sessionId: string, payload: SealedAuditPayload): void {
    this.sequence += 1
    const result = this.auditSink.record({
      sessionId,
      seq: this.sequence,
      recordedAt: Date.now(),
      payload,
    })
    if (!result.ok) this.reportAuditDrop(result.reason, result.error)
  }

  /**
   * Count one dropped audit record and say why, once per drop.
   *
   * Reported rather than thrown: the caller is the tool-call path, and an audit
   * outage must never surface as a tool failure.
   */
  reportAuditDrop(reason: AuditDropReason, error?: string): void {
    this.auditFailures += 1
    this.ctx.logger?.warn(
      'bmpp: audit event dropped (%s)%s',
      reason,
      error === undefined ? '' : `: ${error}`,
    )
  }

  /**
   * The policy state currently held for one session, if any.
   *
   * Exposed for tests and diagnostics: the gate is the only owner of this
   * state, so a caller must not reach into module internals to inspect it.
   *
   * @param sessionId - string form of the session identity.
   */
  stateOf(sessionId: string): PolicySessionState | undefined {
    return this.sessions.get(sessionId)?.state
  }

  /** The `sessionProjections` service when the host provides one. */
  private projections(): SessionProjectionsLike | undefined {
    const service = this.ctx.get('sessionProjections')
    if (typeof service !== 'object' || service === null) return undefined
    const stateOf = (service as { stateOf?: unknown }).stateOf
    return typeof stateOf === 'function' ? (service as SessionProjectionsLike) : undefined
  }

  /** The decision inputs for one session, derived from the validated config. */
  decisionContext(sessionId: string): DecisionContext {
    return decisionContextFrom(this.config, sessionId)
  }

  /**
   * Evaluate one pending tool call.
   *
   * Called from `tools/pre-execute`. Returns the directive the runtime should
   * act on, or `undefined` to delegate unchanged.
   *
   * @param exec - the pending call.
   */
  evaluate(exec: ToolExecution): GateOutcome | undefined {
    const agent = exec.agent
    // Without an agent there is no session and therefore no policy scope: the
    // call is delegated rather than judged, which is the documented no-op.
    if (agent === undefined) return undefined

    const session = agent.session
    const sessionId = String(session.id)
    const entry = this.sessions.get(sessionId) ?? { state: initialState(sessionId, this.config.policyVersion), harnessTurn: undefined }

    const resolution = resolveTurn(this.projections(), session, entry.harnessTurn)
    // A new Harness turn discards the previous turn's authority and re-numbers
    // the session state to match, so the audit trail uses the Harness turn.
    const state = resolution.turn !== entry.harnessTurn
      ? withTurn(onTurnStart(entry.state), resolution.turn)
      : entry.state

    const call: CallInput = { tool: exec.name, args: exec.arguments }
    const step = decide(state, call, this.decisionContext(sessionId))
    this.sessions.set(sessionId, { state: step.state, harnessTurn: resolution.turn })

    const directive = step.decision === 'deny' ? this.directiveFor(exec, step.reasonCode) : undefined
    // `mode: 'audit'` produces no directive, so the call proceeds while the
    // event still records the denial the policy wanted.
    const auditOverride = step.decision === 'deny' && directive === undefined
    const record: EnforcementRecord = {
      enforcement: directive === undefined
        ? auditOverride ? 'overridden' : 'allowed'
        : directive.kind === 'ask' ? 'asked' : 'denied',
      enforced: directive !== undefined,
      auditOverride,
    }
    this.emit(sessionId, decisionPayload(step.event, this.audit, record))

    return { reasonCode: step.reasonCode, directive, auditOverride }
  }

  /**
   * Map a policy denial onto what the runtime should do, honouring `mode` and
   * `profile`.
   *
   * - `off` and `audit` never deny and never ask; `audit` records the override.
   * - `enforce` denies, turning the denial into `ask` only for a destructive
   *   memory operation under `profile: strict`.
   */
  private directiveFor(exec: ToolExecution, reasonCode: ReasonCode): GateDirective | undefined {
    if (this.config.mode !== 'enforce') return undefined
    const destructive = this.config.destructiveTools.includes(exec.name)
    const kind = this.config.profile === 'strict' && destructive ? 'ask' : 'deny'
    return { kind, reasonCode, reason: reasonMessage(reasonCode) }
  }

  /**
   * Settle the recall sub-state from a real tool outcome.
   *
   * `isError === false` satisfies the recall precondition; `isError === true`
   * does not. An empty result is indistinguishable from a populated one here —
   * the MCP bridge advertises no output schema, so the only structured signal is
   * the error flag — and BMPP refuses to parse content text to guess. The state
   * machine still models `empty`; the adapter simply cannot produce it.
   *
   * @param exec - the call that just settled.
   * @param result - its frozen outcome.
   */
  settle(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const agent = exec.agent
    if (agent === undefined) return
    const sessionId = String(agent.session.id)
    const entry = this.sessions.get(sessionId)
    // A result for a session this gate never judged is not policy-relevant.
    if (entry === undefined) return
    if (!this.config.searchTools.includes(exec.name)) return

    const outcome = result.isError === true ? 'failed' : 'ok'
    const state = onRecallResult(entry.state, outcome)
    this.sessions.set(sessionId, { ...entry, state })
    // A recall settlement is a distinct audit fact from the pre-execute
    // decision that opened it, so it is its own event rather than a mutation of
    // the earlier one.
    const resolution = resolveTurn(this.projections(), agent.session, entry.harnessTurn)
    this.emit(sessionId, recallPayload(state, exec.name, outcome, this.audit, resolution.turn))
  }

  /** Release per-session state when the store reports the session gone. */
  forget(session: object): void {
    this.sessions.delete(String((session as { id?: unknown }).id))
  }

  /** Register every listener and the control tool; disposers ride the caller's fiber. */
  mount(): void {
    this.ctx.on('tools/pre-execute', async (exec, next) => {
      const outcome = this.evaluate(exec)
      if (outcome?.directive === undefined) return next()
      return outcome.directive.kind === 'ask'
        ? { kind: 'ask', reason: outcome.directive.reason }
        : { kind: 'deny', reason: outcome.directive.reason }
    })

    this.ctx.on('tools/result', (exec, result) => {
      this.settle(exec, result)
    })

    this.ctx.on('session/disposed', (session) => {
      this.forget(session)
    })

    this.ctx.tools.register(this.classifyTool())
  }

  /**
   * Release the audit store on plugin disposal.
   *
   * The sink drains before the domain is closed, so a plugin stopped between a
   * decision and its write still lands that record. Registered as its own effect
   * rather than folded into {@link mount} so the store's lifecycle is visible
   * where it is owned.
   */
  disposeAudit(): Promise<void> {
    return this.auditSink.close()
  }

  /**
   * Build `bmpp__classify` by hand rather than through the Harness `defineTool`
   * helper, so the plugin keeps zero value imports from the Harness.
   *
   * The registry validates only `output.schema` and `output.render`, and the
   * policy already treats unusable arguments as an absent declaration, so the
   * helper's argument validation buys nothing here and would cost a runtime
   * module identity.
   */
  classifyTool(): ToolDefinition {
    const gate = this
    return {
      name: CLASSIFY_TOOL,
      description: CLASSIFY_DESCRIPTION,
      parameters: CLASSIFY_PARAMETERS,
      output: {
        schema: CLASSIFY_OUTPUT_SCHEMA,
        render(_args: unknown, value: unknown): ContentBlock[] {
          const recorded = typeof value === 'object' && value !== null
            ? (value as { recorded?: unknown }).recorded === true
            : false
          return [{
            type: 'text',
            text: recorded
              ? 'BMPP classification recorded for this turn.'
              : 'BMPP could not record a classification: pass {"task":"simple"} or {"task":"complex"}. The turn stays UNKNOWN, which blocks Basic Memory writes but permits reads.',
          }]
        },
      },
      async execute(_args: unknown, exec): Promise<unknown> {
        // The control tool is already recorded by its own `tools/pre-execute`
        // pass, which is where the declaration is applied and counted. This
        // execution only reports what that decision produced, so it must NOT
        // evaluate again: doing so would double-count the call and let the
        // second pass observe a turn the first one already advanced.
        const state = gate.stateOf(String(exec.agent?.session.id ?? ''))
        return { recorded: state !== undefined && state.turn.classification !== 'unknown' }
      },
    }
  }
}

/**
 * Return `state` with its Harness turn recorded.
 *
 * The machine's own turn counter is untouched: `withTurn` only annotates which
 * host turn the sub-state belongs to.
 */
function withTurn(state: PolicySessionState, turn: number): PolicySessionState {
  return { ...state, turn: { ...state.turn, harnessTurn: turn } }
}

/**
 * Build an UNMOUNTED gate.
 *
 * The caller attaches an audit sink and then calls `mount()`. That ordering is
 * deliberate: a listener registered before the sink is set could audit a
 * decision into the dropping sink and lose it silently.
 *
 * @param options - the host context, the validated configuration and an optional sink.
 * @returns the gate, so a test can inspect its state and drive it directly.
 */
export function createGate(options: GateOptions): BmppGate {
  return new BmppGate(options)
}
