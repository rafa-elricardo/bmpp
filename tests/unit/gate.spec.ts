/**
 * Unit coverage for the integration layer, driven without a Cordis runtime.
 *
 * The gate is exercised through a minimal but complete fake host: a context
 * that resolves `sessionProjections` (or not), captures the listeners `mount()`
 * registers, and records the tool definition it registers. That keeps every
 * mapping rule — mode, profile, audit override, recall settlement, turn reset,
 * cleanup, directive kind — provable in isolation, while the sibling
 * integration suite proves the same behaviour through the real `ToolRuntime`.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type BmppConfig } from '../../src/config.ts'
import { createGate, resolveTurn, type SessionProjectionsLike } from '../../src/gate.ts'
import { ReasonCode } from '../../src/reason-codes.ts'
import { CLASSIFY_TOOL } from '../../src/state.ts'
import type { Context } from '@deepseek-ai/cordis'

const SESSION_ID = 'session-under-test'
const OTHER_SESSION = 'session-other'

/** The listeners a test drives directly, captured from `mount()`. */
interface FakeHost {
  readonly ctx: Context
  preExecute(tool: string, args?: unknown, sessionId?: string): Promise<{ kind: string; reason?: string }>
  result(tool: string, isError: boolean, sessionId?: string): void
  dispose(sessionId: string): void
  readonly registered: { name?: string }[]
}

/**
 * Build a fake Cordis context.
 *
 * `mount()` only needs `ctx.on`, `ctx.tools.register` and `ctx.get`, so the fake
 * provides exactly those and nothing more — a deliberate statement about the
 * surface the gate is allowed to depend on.
 */
function fakeHost(projection?: SessionProjectionsLike): FakeHost {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const registered: { name?: string }[] = []

  const ctx = {
    get: (name: string) => (name === 'sessionProjections' ? projection : undefined),
    on: (event: string, handler: (...args: never[]) => unknown) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    tools: {
      register: (definition: { name?: string }) => {
        registered.push(definition)
        return () => undefined
      },
    },
  } as unknown as Context

  const exec = (tool: string, args: unknown, sessionId: string) => ({
    name: tool,
    arguments: args,
    agent: { session: { id: sessionId } },
  })

  return {
    ctx,
    registered,
    async preExecute(tool, args = {}, sessionId = SESSION_ID) {
      const handler = listeners.get('tools/pre-execute') as unknown as
        | ((e: unknown, next: () => Promise<{ kind: string }>) => Promise<{ kind: string; reason?: string }>)
        | undefined
      if (handler === undefined) throw new Error('no pre-execute listener mounted')
      return await handler(exec(tool, args, sessionId), async () => ({ kind: 'allow' }))
    },
    result(tool, isError, sessionId = SESSION_ID) {
      const handler = listeners.get('tools/result') as unknown as
        | ((e: unknown, r: unknown) => void)
        | undefined
      if (handler === undefined) throw new Error('no tools/result listener mounted')
      handler(exec(tool, {}, sessionId), { isError })
    },
    dispose(sessionId) {
      const handler = listeners.get('session/disposed') as unknown as
        | ((s: unknown) => void)
        | undefined
      if (handler === undefined) throw new Error('no session/disposed listener mounted')
      handler({ id: sessionId })
    },
  }
}

/** A `sessionProjections` stand-in whose reported turn the test controls. */
function fakeProjections(initialTurn = 0): SessionProjectionsLike & { turn: number } {
  const holder = {
    turn: initialTurn,
    stateOf: (_session: object, key: string) => (key === 'turnBoundary' ? { lastTurn: holder.turn } : undefined),
  }
  return holder
}

function configWith(overrides: Partial<BmppConfig> = {}): BmppConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

const SEARCH = 'mcp__basic-memory__search_notes'
const EDIT = 'mcp__basic-memory__edit_note'
const DELETE = 'mcp__basic-memory__delete_note'
const UNKNOWN_MEMORY = 'mcp__basic-memory__brand_new_tool'

describe('mount', () => {
  it('registers the three listeners and the control tool', () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    expect(gate.trackedSessions).toBe(0)
    expect(host.registered.map(def => def.name)).toEqual([CLASSIFY_TOOL])
  })
})

describe('turn resolution and reset', () => {
  it('resets the turn when the Harness turn advances, re-closing the gate', async () => {
    const projections = fakeProjections(1)
    const host = fakeHost(projections)
    // Exactly one gate per host: a second `createGate` would replace the
    // listener and the assertions below would silently test the wrong instance.
    const gate = createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })

    // Turn 1: classify complex, search, then the write is allowed.
    expect(await host.preExecute(CLASSIFY_TOOL, { task: 'complex' })).toEqual({ kind: 'allow' })
    expect(await host.preExecute(SEARCH, { query: 'x' })).toEqual({ kind: 'allow' })
    host.result(SEARCH, false)
    expect(await host.preExecute(EDIT, {})).toEqual({ kind: 'allow' })

    // Turn 2: the same write needs a fresh recall, because the previous turn's
    // classification and recall are discarded.
    projections.turn = 2
    const denied = await host.preExecute(EDIT, {})
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('bmpp__classify')
    expect(gate.stateOf(SESSION_ID)?.turn.harnessTurn).toBe(2)
  })

  it('uses the gate counter when sessionProjections is absent', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    await host.preExecute(SEARCH, { query: 'x' })
    // No projection, so the turn number is the fallback counter.
    expect(gate.stateOf(SESSION_ID)?.turn.harnessTurn).toBe(0)
    // A later call in the same turn keeps the same number.
    await host.preExecute(SEARCH, { query: 'y' })
    expect(gate.stateOf(SESSION_ID)?.turn.harnessTurn).toBe(0)
  })

  it('stamps the Harness turn number onto the session state', async () => {
    const projections = fakeProjections(9)
    const host = fakeHost(projections)
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    await host.preExecute(SEARCH, { query: 'x' })
    expect(gate.stateOf(SESSION_ID)?.turn.harnessTurn).toBe(9)
  })
})

describe('classification through the gate', () => {
  it('records a declared classification and releases a SIMPLE turn', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    expect(await host.preExecute(CLASSIFY_TOOL, { task: 'simple' })).toEqual({ kind: 'allow' })
    expect(gate.stateOf(SESSION_ID)?.turn.classification).toBe('simple')
    expect(await host.preExecute(EDIT, {})).toEqual({ kind: 'allow' })
  })

  it('treats an invalid declaration as no declaration, in enforce mode', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    for (const args of [{}, { task: 'nonsense' }, { task: 7 }, undefined]) {
      expect((await host.preExecute(CLASSIFY_TOOL, args)).kind).toBe('allow')
    }
    expect(gate.stateOf(SESSION_ID)?.turn.classification).toBe('unknown')
    // UNKNOWN still blocks a memory write.
    const denied = await host.preExecute(EDIT, {})
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('bmpp__classify')
  })

  it('lets the latest declaration win', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    await host.preExecute(CLASSIFY_TOOL, { task: 'complex' })
    await host.preExecute(CLASSIFY_TOOL, { task: 'simple' })
    expect(gate.stateOf(SESSION_ID)?.turn.classification).toBe('simple')
  })
})

describe('recall settlement', () => {
  it('satisfies the gate on a successful search', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    await host.preExecute(CLASSIFY_TOOL, { task: 'complex' })
    await host.preExecute(SEARCH, { query: 'x' })
    expect((await host.preExecute(EDIT, {})).kind).toBe('deny') // still in flight
    host.result(SEARCH, false)
    expect((await host.preExecute(EDIT, {})).kind).toBe('allow')
  })

  it('does not satisfy the gate on a failed search, and a retry recovers', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    await host.preExecute(CLASSIFY_TOOL, { task: 'complex' })
    await host.preExecute(SEARCH, { query: 'x' })
    host.result(SEARCH, true)

    const failed = await host.preExecute(EDIT, {})
    expect(failed.kind).toBe('deny')
    expect(failed.reason).toContain('Retry the lookup')

    // A new attempt, this time successful.
    await host.preExecute(SEARCH, { query: 'y' })
    host.result(SEARCH, false)
    expect((await host.preExecute(EDIT, {})).kind).toBe('allow')
  })

  it('ignores a result for a tool that is not a search tool', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    await host.preExecute(CLASSIFY_TOOL, { task: 'complex' })
    host.result('mcp__basic-memory__read_note', false)
    expect(gate.stateOf(SESSION_ID)?.turn.recall.state).toBe('idle')
  })

  it('ignores a result for a session the gate never judged', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    host.result(SEARCH, false, OTHER_SESSION)
    expect(gate.stateOf(OTHER_SESSION)).toBeUndefined()
  })

  it('never produces the empty outcome, because no structured signal exists', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    await host.preExecute(CLASSIFY_TOOL, { task: 'complex' })
    await host.preExecute(SEARCH, { query: 'x' })
    host.result(SEARCH, false)
    expect(gate.stateOf(SESSION_ID)?.turn.recall.outcome).toBe('ok')
    expect(gate.stateOf(SESSION_ID)?.turn.recall.outcome).not.toBe('empty')
  })
})

describe('mode controls enforcement, never the verdict', () => {
  it('audit allows everything and never asks, whatever the profile', async () => {
    for (const profile of ['compat', 'strict'] as const) {
      const host = fakeHost()
      createGate({ ctx: host.ctx, config: configWith({ mode: 'audit', profile }) })
      expect((await host.preExecute(EDIT, {})).kind).toBe('allow')
      expect((await host.preExecute(DELETE, {})).kind).toBe('allow')
      expect((await host.preExecute(UNKNOWN_MEMORY, {})).kind).toBe('allow')
    }
  })

  it('enforce denies an unclassified memory write', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    const denied = await host.preExecute(EDIT, {})
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('bmpp__classify')
  })

  it('enforce + strict turns a destructive denial into an approval request', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce', profile: 'strict' }) })
    const asked = await host.preExecute(DELETE, {})
    expect(asked.kind).toBe('ask')
    expect(asked.reason).toContain('bmpp__classify')
  })

  it('enforce + compat denies a destructive call without asking', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce', profile: 'compat' }) })
    const denied = await host.preExecute(DELETE, {})
    expect(denied.kind).toBe('deny')
  })

  it('audit + strict still never asks', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'audit', profile: 'strict' }) })
    expect((await host.preExecute(DELETE, {})).kind).toBe('allow')
  })

  it('leaves read-only tools alone in enforce mode', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    expect((await host.preExecute('mcp__basic-memory__read_note', {})).kind).toBe('allow')
    expect((await host.preExecute(SEARCH, { query: 'x' })).kind).toBe('allow')
  })

  it('leaves tools outside the memory namespace alone in enforce mode', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    for (const tool of ['bash', 'edit', 'write', 'terminal', 'present']) {
      expect((await host.preExecute(tool, {})).kind).toBe('allow')
    }
  })

  it('fails closed on an unknown memory tool in enforce mode', async () => {
    const host = fakeHost()
    createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    const denied = await host.preExecute(UNKNOWN_MEMORY, {})
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('bmpp__classify')
  })
})

describe('audit override is observable', () => {
  it('reports the policy verdict while the call is allowed', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith({ mode: 'audit' }) })
    const outcome = gate.evaluate({
      name: EDIT, arguments: {}, agent: { session: { id: SESSION_ID } },
    } as never)
    expect(outcome?.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
    expect(outcome?.directive).toBeUndefined()
    expect(outcome?.auditOverride).toBe(true)
  })

  it('reports no override when enforce applies the denial', () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    const outcome = gate.evaluate({
      name: EDIT, arguments: {}, agent: { session: { id: SESSION_ID } },
    } as never)
    expect(outcome?.auditOverride).toBe(false)
    expect(outcome?.directive?.kind).toBe('deny')
  })

  it('reports no override for an allowed call', () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith({ mode: 'audit' }) })
    const outcome = gate.evaluate({
      name: 'bash', arguments: {}, agent: { session: { id: SESSION_ID } },
    } as never)
    expect(outcome?.directive).toBeUndefined()
    expect(outcome?.auditOverride).toBe(false)
  })
})

describe('calls outside the policy scope', () => {
  it('delegates when there is no agent', () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    const outcome = gate.evaluate({ name: EDIT, arguments: {}, agent: undefined } as never)
    expect(outcome).toBeUndefined()
    expect(gate.trackedSessions).toBe(0)
  })

  it('keeps per-session state separate', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    await host.preExecute(CLASSIFY_TOOL, { task: 'simple' }, SESSION_ID)
    // The other session never declared anything, so it is still blocked.
    const denied = await host.preExecute(EDIT, {}, OTHER_SESSION)
    expect(denied.kind).toBe('deny')
    expect(gate.stateOf(SESSION_ID)?.turn.classification).toBe('simple')
    expect(gate.stateOf(OTHER_SESSION)?.turn.classification).toBe('unknown')
  })
})

describe('session cleanup', () => {
  it('releases state when the store reports the session disposed', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    await host.preExecute(EDIT, {})
    expect(gate.trackedSessions).toBe(1)
    host.dispose(SESSION_ID)
    expect(gate.trackedSessions).toBe(0)
    expect(gate.stateOf(SESSION_ID)).toBeUndefined()
  })

  it('is idempotent for an unknown session', () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    expect(() => host.dispose('never-seen')).not.toThrow()
    expect(gate.trackedSessions).toBe(0)
  })
})

describe('classifyTool definition', () => {
  it('declares the contract the registry validates', () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    const tool = gate.classifyTool()
    expect(tool.name).toBe(CLASSIFY_TOOL)
    expect(typeof tool.description).toBe('string')
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['task'] })
    expect(typeof tool.output.schema).toBe('object')
    expect(typeof tool.output.render).toBe('function')
    expect(typeof tool.execute).toBe('function')
  })

  it('renders a truthful message for a recorded and an unusable declaration', () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    const render = gate.classifyTool().output.render
    const recorded = render({}, { recorded: true })
    const unusable = render({}, { recorded: false })
    expect(recorded[0]).toMatchObject({ type: 'text' })
    expect((recorded[0] as { text: string }).text).toContain('recorded')
    expect((unusable[0] as { text: string }).text).toContain('UNKNOWN')
    // A hostile value must render, not throw.
    expect(() => render({}, null)).not.toThrow()
    expect(() => render({}, 'nonsense')).not.toThrow()
  })

  it('reports the recorded declaration without evaluating a second time', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    const tool = gate.classifyTool()
    const exec = {
      callId: 'call-1', rootCallId: 'call-1', name: CLASSIFY_TOOL, arguments: { task: 'complex' },
      agent: { session: { id: SESSION_ID } }, signal: new AbortController().signal,
    }

    // `tools/pre-execute` is where a declaration is applied and counted.
    await host.preExecute(CLASSIFY_TOOL, { task: 'complex' })
    const callsAfterPreExecute = gate.stateOf(SESSION_ID)?.turn.calls.total

    const recorded = await tool.execute({ task: 'complex' }, exec as never)
    expect(recorded).toEqual({ recorded: true })
    expect(gate.stateOf(SESSION_ID)?.turn.classification).toBe('complex')
    // The execution must not re-evaluate: that would double-count the call.
    expect(gate.stateOf(SESSION_ID)?.turn.calls.total).toBe(callsAfterPreExecute)
  })

  it('reports not-recorded when no declaration was applied', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    const exec = {
      callId: 'call-1', rootCallId: 'call-1', name: CLASSIFY_TOOL, arguments: {},
      agent: { session: { id: SESSION_ID } }, signal: new AbortController().signal,
    }
    // An unusable declaration leaves the turn UNKNOWN.
    await host.preExecute(CLASSIFY_TOOL, {})
    expect(await gate.classifyTool().execute({}, exec as never)).toEqual({ recorded: false })

    // A session the gate has never seen also reports not-recorded.
    const other = { ...exec, agent: { session: { id: 'unseen' } } }
    expect(await gate.classifyTool().execute({}, other as never)).toEqual({ recorded: false })
  })
})

describe('evaluate tolerates hostile executions', () => {
  it('never throws for malformed names or arguments', async () => {
    const host = fakeHost()
    const gate = createGate({ ctx: host.ctx, config: configWith({ mode: 'enforce' }) })
    const hostile: unknown[] = [undefined, null, 'x', 42, [], { query: 7 }]
    for (const args of hostile) {
      expect(() => gate.evaluate({ name: EDIT, arguments: args, agent: { session: { id: SESSION_ID } } } as never)).not.toThrow()
    }
    // A missing tool name is not in any namespace and is therefore delegated.
    const outcome = gate.evaluate({ name: '', arguments: {}, agent: { session: { id: SESSION_ID } } } as never)
    expect(outcome?.directive).toBeUndefined()
  })

  it('does not call the logger or throw when the projection is missing', () => {
    const ctx = { get: () => undefined, on: () => () => undefined, tools: { register: () => () => undefined } } as unknown as Context
    expect(() => createGate({ ctx, config: configWith() })).not.toThrow()
  })

  it('spies never fire: the gate performs no logging of its own', () => {
    const host = fakeHost()
    const warn = vi.fn()
    const gate = createGate({ ctx: host.ctx, config: configWith() })
    void gate
    expect(warn).not.toHaveBeenCalled()
  })
})
