/**
 * Test harness for proving the REAL DSH scheduler semantics.
 *
 * This harness mounts the genuine agent loop, session store, tool registry,
 * system prompt and session projections from the installed Harness release, and
 * then drives them with a scripted model adapter. Nothing here is a double for
 * the scheduler: the ordering these tests assert is produced by the real
 * `tool-calls.ts` pool, the real `ToolRuntime` pipeline and the real
 * `tools/call` → `tools/result` durable sequence.
 *
 * ## Synchronization contract
 *
 * Ordering is proved with **barriers**, never with sleeps:
 *
 * - a body records `BODY-enter`, then awaits its own barrier before recording
 *   `BODY-exit`;
 * - a test releases a barrier explicitly, so "did the write body run before the
 *   search finished?" has a definite answer instead of a timing race;
 * - the adapter is scripted, so there is no model latency to race either.
 *
 * ## What this harness deliberately does NOT assume
 *
 * It does not assume that every `tools/pre-execute` in a group completes before
 * any tool body starts. The reconnaissance of `packages/core/agent-loop/src/
 * tool-calls.ts` shows a rolling pool: `startCall` prepares one call and
 * dispatches it before the next call is prepared, so pre-execute and body
 * execution can interleave. The tests in this directory assert only the
 * guarantees the code actually provides:
 *
 * 1. a call's own pre-execute runs before its own dispatch;
 * 2. results commit in MODEL order, not completion order;
 * 3. a denial turns into an error result and does not abort the group.
 *
 * @module tests/integration/scheduler-harness
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { apply, type BmppLoadReport } from '../../src/index.ts'

/** One recorded step of the observed interleaving. */
export interface TimelineEntry {
  readonly phase: 'PRE' | 'BODY-enter' | 'BODY-exit' | 'RESULT'
  readonly tool: string
  readonly label: string
}

/** A barrier a body must pass before it may finish. */
export interface Barrier {
  wait(): Promise<void>
  release(): void
  released(): boolean
}

/**
 * A gate a body awaits, released explicitly by the test.
 *
 * `release()` is idempotent: releasing an already-open barrier is a no-op, so a
 * test may release optimistically without racing the body.
 */
export function barrier(): Barrier {
  let open = false
  let notify: (() => void) | undefined
  const opened = new Promise<void>((resolve) => { notify = resolve })
  return {
    async wait(): Promise<void> {
      if (open) return
      await opened
    },
    release(): void {
      if (open) return
      open = true
      notify?.()
    },
    released(): boolean {
      return open
    },
  }
}

/**
 * A tool the harness registers.
 *
 * `hold: true` makes the body wait for an explicit `harness.release()` — that is
 * how a test proves ordering. The default is auto-release, so a test that does
 * not care about a body's lifetime cannot hang on it.
 */
export interface ToolSpec {
  readonly name: string
  readonly hold?: boolean
  readonly body?: (args: Record<string, unknown>, gate: Barrier) => Promise<unknown>
}

/** Declare a tool whose body the test can control and observe. */
export function tool(
  name: string,
  options: { readonly hold?: boolean; readonly body?: ToolSpec['body'] } = {},
): ToolSpec {
  // Spread conditionally: an explicit `undefined` is not the same as an absent
  // key under `exactOptionalPropertyTypes`.
  return {
    name,
    ...(options.hold === undefined ? {} : { hold: options.hold }),
    ...(options.body === undefined ? {} : { body: options.body }),
  }
}

/** One scripted assistant message carrying several tool calls at once. */
export function batchResponse(
  calls: readonly { id: string; name: string; args?: Record<string, unknown> }[],
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    const argumentsJson = JSON.stringify(call.args ?? {})
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: ToolCallId(call.id), name: call.name, argumentsDelta: argumentsJson },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: argumentsJson } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/** A plain text assistant message, used to end a turn. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A scripted adapter: each model call consumes the next entry.
 *
 * Reimplemented here rather than imported from the Harness checkout: the
 * package under test must not depend on the checkout's test sources, and this
 * keeps `pnpm test` runnable from the BMPP repository alone.
 */
class ScriptedAdapter extends LlmAdapter {
  /** Entries appended by the test; shifted by each model call. */
  readonly script: StreamChunk[][] = []

  constructor() {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    void options
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of entry) yield chunk
  }
}

/** Options for mounting the harness. */
export interface HarnessOptions {
  /** BMPP config; defaults to `mode: enforce` + `profile: compat`. */
  readonly bmpp?: Record<string, unknown>
  /** Tool names BMPP must treat as memory reads/writes, with their specs. */
  readonly tools: readonly ToolSpec[]
}

/** The mounted harness: real runtime, scripted model, observable timeline. */
export interface Harness {
  readonly ctx: Context
  readonly report: BmppLoadReport
  /** Recorded interleaving, in the order it happened. */
  timeline(): readonly TimelineEntry[]
  /** Timeline restricted to one tool label. */
  timelineFor(label: string): readonly TimelineEntry[]
  /** Every `bmpp/policy` payload the gate wrote, in durable order. */
  policyEvents(): readonly Record<string, unknown>[]
  /** Tool result messages in durable (model) order, with their error flag. */
  toolResults(): readonly { readonly callId: string; readonly isError: boolean; readonly text: string }[]
  /**
   * Start ONE Harness turn that walks through several model steps.
   *
   * Each entry is one assistant message: `steps[0]` is the turn's first step,
   * `steps[1]` its continuation after the first step's tool results, and so on.
   * They share a single `turn/start`, which matters because BMPP's
   * classification is per turn — a test that wants a COMPLEX turn and a write in
   * the same turn must put both in one call.
   *
   * The returned promise settles when the turn reaches quiescence. A test that
   * must release a barrier MID-turn awaits it only after releasing, which is
   * what makes the interleaving assertions deterministic.
   */
  run(steps: readonly StreamChunk[][]): Promise<void>
  /** Bodies that have entered but not yet exited, at the moment of the call. */
  inFlightAt(index: number): readonly string[]
  /**
   * Release one tool's barrier, letting its body finish.
   *
   * @param toolName - the registered tool whose body may now exit.
   */
  release(toolName: string): void
  /** Whether one tool's barrier has already been released. */
  isReleased(toolName: string): boolean
  /**
   * Register an extra fixture tool after mounting.
   *
   * A scenario that needs a classification turn first has no tools to run at
   * mount time, so registration has to stay available afterwards.
   *
   * @param spec - the tool to register.
   */
  register(spec: ToolSpec): void
}

/**
 * Mount the real pipeline and run scripted steps against it.
 *
 * @param options - BMPP configuration and the tools to register.
 */
export async function mountHarness(options: HarnessOptions): Promise<Harness> {
  const timeline: TimelineEntry[] = []
  const gates = new Map<string, Barrier>()

  /** Phases recorded for correlation with body lifetimes. */
  const timeline_snapshot = (): readonly TimelineEntry[] => [...timeline]

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })

  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['scripted'], adapter)

  const report = apply(ctx, options.bmpp ?? { mode: 'enforce', profile: 'compat', policyVersion: '0.1.0' })

  /** Register one fixture tool whose body the harness records and gates. */
  const register = (spec: ToolSpec): void => {
    const hold = spec.hold === true
    const gate = barrier()
    gates.set(spec.name, gate)
    // An auto-released tool's body never waits: the barrier is already open.
    if (!hold) gate.release()
    ctx.tools.register(defineContentToolFixture({
      name: spec.name,
      description: `fixture for ${spec.name}`,
      // No declared arguments: the scheduler, not the schema, is under test.
      parameters: {},
      isConcurrencySafe: () => true,
      async execute(args: unknown): Promise<ContentBlock[]> {
        const label = spec.name
        timeline.push({ phase: 'BODY-enter', tool: spec.name, label })
        await gate.wait()
        timeline.push({ phase: 'BODY-exit', tool: spec.name, label })
        const produced = spec.body === undefined
          ? undefined
          : await spec.body((args ?? {}) as Record<string, unknown>, gate)
        return produced === undefined
          ? [{ type: 'text', text: 'ok' }]
          : produced as ContentBlock[]
      },
    }))
  }

  for (const spec of options.tools) register(spec)

  ctx.on('tools/pre-execute', (exec, next) => {
    timeline.push({ phase: 'PRE', tool: exec.name, label: exec.name })
    return next()
  })
  ctx.on('tools/result', (exec) => {
    timeline.push({ phase: 'RESULT', tool: exec.name, label: exec.name })
  })

  const sessionId = SessionId('scheduler-probe')
  let session: Session | undefined

  /**
   * Every event in the session log, in durable order.
   *
   * The log is read whole rather than incrementally: this harness owns exactly
   * one session, and a reader that filters by `type` does not need a cursor to
   * be correct.
   */
  const drain = (): readonly { type: string; data: unknown }[] => {
    if (session === undefined) return []
    return session.snapshotEvents() as readonly { type: string; data: unknown }[]
  }

  let agent: Awaited<ReturnType<typeof ctx.agentLoop.create>> | undefined

  return {
    ctx,
    report,
    timeline: timeline_snapshot,
    timelineFor: (label: string) => timeline.filter(entry => entry.label === label),
    policyEvents: () => drain()
      .filter(event => event.type === 'bmpp/policy')
      .map(event => event.data as Record<string, unknown>),
    toolResults: () => drain()
      .filter(event => event.type === 'tool/result')
      .map((event) => {
        const data = event.data as { message: { content: { toolCallId?: string; isError?: boolean; content?: { text?: string }[] }[] } }
        const block = data.message.content[0]
        return {
          callId: String(block?.toolCallId ?? ''),
          isError: block?.isError === true,
          text: block?.content?.map(part => part.text ?? '').join('') ?? '',
        }
      }),
    register,
    release: (toolName: string) => {
      gates.get(toolName)?.release()
    },
    isReleased: (toolName: string) => gates.get(toolName)?.released() ?? false,
    run(steps: readonly StreamChunk[][]): Promise<void> {
      for (const step of steps) adapter.script.push(step)
      // A closing text step is always queued, so a turn always terminates once
      // the test releases every barrier it left closed.
      adapter.script.push(textResponse('done'))
      const running = (async (): Promise<void> => {
        if (agent === undefined) {
          agent = await ctx.agentLoop.create(sessionId, { provider: 'scripted', model: 'scripted' })
        }
        session = agent.session
        agent.followup({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } } as never)
        await agent.whenIdle()
      })()
      return running
    },
    inFlightAt: (index: number) => {
      const entered = new Set<string>()
      const exited = new Set<string>()
      timeline.slice(0, index).forEach((entry) => {
        if (entry.phase === 'BODY-enter') entered.add(entry.tool)
        if (entry.phase === 'BODY-exit') exited.add(entry.tool)
      })
      return [...entered].filter(name => !exited.has(name))
    },
  }
}

/** Index of the first timeline entry matching a predicate. */
export function indexOf(
  entries: readonly TimelineEntry[],
  predicate: (entry: TimelineEntry) => boolean,
): number {
  return entries.findIndex(predicate)
}


/**
 * Wait until the recorded timeline satisfies a predicate.
 *
 * Deterministic in the sense that matters: it does not guess a duration, it
 * waits for the observable fact it needs and fails loudly if the fact never
 * arrives. The loop yields to the event loop between checks so the real
 * scheduler can make progress.
 *
 * @param harness - the mounted harness.
 * @param predicate - condition the timeline must satisfy.
 * @param what - description used in the failure message.
 */
export async function waitFor(
  harness: Harness,
  predicate: (harness: Harness) => boolean,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate(harness)) return
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  throw new Error(`timed out waiting for: ${what}\ntimeline: ${harness.timeline().map(entry => `${entry.phase}:${entry.tool}`).join(' | ')}`)
}

/** Whether a tool's body has entered and not yet exited. */
export function hasBodyEntered(harness: Harness, toolName: string): boolean {
  return harness.timeline().some(entry => entry.phase === 'BODY-enter' && entry.tool === toolName)
}

/** Whether a tool's body has exited. */
export function hasBodyExited(harness: Harness, toolName: string): boolean {
  return harness.timeline().some(entry => entry.phase === 'BODY-exit' && entry.tool === toolName)
}
