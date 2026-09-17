/**
 * Integration proof that the gate works through the REAL Harness tool registry.
 *
 * These tests mount the genuine `ToolRuntime` from the installed DSH release and
 * drive calls through `ctx.tools.execute`, so the assertions cover the actual
 * pipeline: the `tools/pre-execute` waterfall, the materialized error result the
 * model receives, `tools/result`, tool registration, and the approval seam.
 *
 * `tests/integration/purity.spec.ts` covers the complementary property that the
 * gate imports no Harness VALUE, only types and injected services.
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type BmppConfig } from '../../src/config.ts'
import { createGate, type SessionProjectionsLike } from '../../src/gate.ts'
import { ReasonCode } from '../../src/reason-codes.ts'
import { CLASSIFY_TOOL } from '../../src/state.ts'
import { apply } from '../../src/index.ts'

const SESSION = 'integration-session'
const SEARCH = 'mcp__basic-memory__search_notes'
const WRITE = 'mcp__basic-memory__write_note'
const DELETE = 'mcp__basic-memory__delete_note'
const READ = 'mcp__basic-memory__read_note'

const signal = new AbortController().signal

/**
 * A fake agent carrying only what the gate reads.
 *
 * The realAgent interface is broad; casting once here keeps every call site
 * honest about the fact that BMPP depends on `session.id` and nothing else.
 */
function fakeAgent(sessionId = SESSION): { session: { id: string } } {
  return { session: { id: sessionId } }
}

/**
 * The registry types `agent` as the full `Agent`; BMPP's contract reads only
 * `session.id`, so the fixture narrows deliberately rather than reimplementing
 * an interface the plugin never touches.
 */
const asAgent = (agent: { session: { id: string } }) => agent as unknown as never

/** A tool that records whether it actually ran. */
interface Probe {
  readonly definition: ToolDefinition
  readonly calls: string[]
}

function memoryTool(name: string): Probe {
  const calls: string[] = []
  return {
    calls,
    definition: {
      name,
      description: `fixture for ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        render: () => [{ type: 'text', text: 'ran' }],
      },
      async execute(): Promise<unknown> {
        calls.push(name)
        return { ok: true }
      },
    },
  }
}

/** A projection double whose turn the test can move. */
function projections(turn = 1): SessionProjectionsLike & { turn: number } {
  const holder = {
    turn,
    stateOf: (_s: object, key: string) => (key === 'turnBoundary' ? { lastTurn: holder.turn } : undefined),
  }
  return holder
}

/** Everything one mounted scenario needs to drive calls. */
async function harness(options: {
  config?: Partial<BmppConfig>
  withAgent?: boolean
  withProjections?: boolean
  approval?: (request: unknown) => Promise<string>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const projection = options.withProjections === false ? undefined : projections()
  if (projection !== undefined) ctx.provide('sessionProjections', projection)
  if (options.approval !== undefined) ctx.provide('approval', { request: options.approval })

  const config: BmppConfig = { ...DEFAULT_CONFIG, mode: 'enforce', ...options.config }
  // The REAL entry point: it resolves the audit store and mounts the listeners.
  // The gate is read off the report, which is the only supported way to reach it.
  const report = await apply(ctx, config)
  const gate = report.gate
  if (gate === undefined) throw new Error('the gate must mount in enforce mode')

  const probes = new Map<string, Probe>()
  for (const name of [SEARCH, WRITE, DELETE, READ, 'bash']) {
    const probe = memoryTool(name)
    probes.set(name, probe)
    ctx.tools.register(probe.definition)
  }

  const agent = options.withAgent === false ? undefined : fakeAgent()

  const execute = (name: string, args: Record<string, unknown> = {}, callId = `call-${name}`) =>
    ctx.tools.execute({
      signal, callId: ToolCallId(callId), name, arguments: args,
      ...(agent === undefined ? {} : { agent: asAgent(agent) }),
    })

  return { ctx, gate, probes, execute, projection, config }
}

describe('the deny contract reaches the runtime', () => {
  it('blocks the call and returns an isError result the model can read', async () => {
    const h = await harness()
    const result = await h.execute(WRITE, { title: 'x' })
    expect(result.isError).toBe(true)
    // The tool body never ran: the registry materializes the denial.
    expect(h.probes.get(WRITE)?.calls).toEqual([])
    const text = JSON.stringify(result.content)
    expect(text).toContain('bmpp__classify')
    if (result.isError) expect(result.error.message).toContain('bmpp__classify')
  })

  it('lets the call run once the precondition is satisfied', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'example query' }, 'call-search')
    const result = await h.execute(WRITE, { title: 'x' }, 'call-write')
    expect(result.isError).toBe(false)
    expect(h.probes.get(WRITE)?.calls).toEqual([WRITE])
  })

  it('never blocks a read, even unclassified', async () => {
    const h = await harness()
    const result = await h.execute(READ, { identifier: 'note' })
    expect(result.isError).toBe(false)
    expect(h.probes.get(READ)?.calls).toEqual([READ])
  })

  it('never blocks a tool outside the memory namespace', async () => {
    const h = await harness()
    const result = await h.execute('bash', { command: 'ls' })
    expect(result.isError).toBe(false)
  })

  it('fails closed on an unregistered memory tool name', async () => {
    const h = await harness()
    // The registry rejects an unknown tool before policy; the gate still denies
    // a KNOWN tool that policy classifies as an unlisted memory write.
    const result = await h.execute(WRITE, {})
    expect(result.isError).toBe(true)
  })
})

describe('mode audit records without blocking', () => {
  it('allows the same call enforce would deny', async () => {
    const h = await harness({ config: { mode: 'audit' } })
    const result = await h.execute(WRITE, { title: 'x' })
    expect(result.isError).toBe(false)
    expect(h.probes.get(WRITE)?.calls).toEqual([WRITE])
  })

  it('still records the policy verdict it would have applied', async () => {
    const h = await harness({ config: { mode: 'audit' } })
    const outcome = h.gate.evaluate({
      name: WRITE, arguments: {}, agent: fakeAgent(),
    } as never)
    expect(outcome?.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
    expect(outcome?.auditOverride).toBe(true)
    expect(outcome?.directive).toBeUndefined()
  })
})

describe('ask is requested only where the design allows it', () => {
  it('never asks in audit, whatever the profile', async () => {
    let asked = false
    const h = await harness({
      config: { mode: 'audit', profile: 'strict' },
      approval: async () => { asked = true; return 'allowed-once' },
    })
    const result = await h.execute(DELETE, { identifier: 'n' })
    expect(result.isError).toBe(false)
    expect(asked).toBe(false)
  })

  it('asks for a destructive call under enforce + strict', async () => {
    let asked = false
    const h = await harness({
      config: { mode: 'enforce', profile: 'strict' },
      approval: async () => { asked = true; return 'allowed-once' },
    })
    const result = await h.execute(DELETE, { identifier: 'n' })
    expect(asked).toBe(true)
    // `allowed-once` lets the call through.
    expect(result.isError).toBe(false)
    expect(h.probes.get(DELETE)?.calls).toEqual([DELETE])
  })

  it('denies a destructive call under enforce + compat without asking', async () => {
    let asked = false
    const h = await harness({
      config: { mode: 'enforce', profile: 'compat' },
      approval: async () => { asked = true; return 'allowed-once' },
    })
    const result = await h.execute(DELETE, { identifier: 'n' })
    expect(result.isError).toBe(true)
    expect(asked).toBe(false)
  })

  it('denies when the approval channel rejects', async () => {
    const h = await harness({
      config: { mode: 'enforce', profile: 'strict' },
      approval: async () => 'rejected',
    })
    const result = await h.execute(DELETE, { identifier: 'n' })
    expect(result.isError).toBe(true)
    expect(h.probes.get(DELETE)?.calls).toEqual([])
  })

  it('denies a destructive ask with no approval service at all', async () => {
    const h = await harness({ config: { mode: 'enforce', profile: 'strict' } })
    const result = await h.execute(DELETE, { identifier: 'n' })
    // The seam turns an unsupported ask into a denial, which is fail-closed.
    expect(result.isError).toBe(true)
    expect(h.probes.get(DELETE)?.calls).toEqual([])
  })
})

describe('recall settlement through the real result pipeline', () => {
  it('satisfies the gate from an isError:false result', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'x' }, 'call-s1')
    expect(h.gate.stateOf(SESSION)?.turn.recall.state).toBe('succeeded')
    expect((await h.execute(WRITE, {})).isError).toBe(false)
  })

  it('does not satisfy the gate from a failing search', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sessionProjections', projections())
    const report = await apply(ctx, { ...DEFAULT_CONFIG, mode: 'enforce' })
    const gate = report.gate
    if (gate === undefined) throw new Error('the gate must mount')
    ctx.tools.register({
      name: SEARCH,
      description: 'failing search',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        render: () => [{ type: 'text', text: 'nope' }],
      },
      async execute(): Promise<unknown> {
        throw new Error('memory backend unavailable')
      },
    })
    const agent = fakeAgent()
    const run = (name: string, args: Record<string, unknown> = {}) =>
      ctx.tools.execute({ signal, callId: ToolCallId(`c-${name}`), name, arguments: args, agent: asAgent(agent) })

    await run(CLASSIFY_TOOL, { task: 'complex' })
    const searched = await run(SEARCH, { query: 'x' })
    expect(searched.isError).toBe(true)
    expect(gate.stateOf(SESSION)?.turn.recall.state).toBe('failed')
    // The next write is still blocked, and for the failure reason.
    const outcome = gate.evaluate({ name: WRITE, arguments: {}, agent: agent as never } as never)
    expect(outcome?.directive?.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_FAILED)
  })
})

describe('turn reset through the real pipeline', () => {
  it('re-closes the gate when the Harness turn advances', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'x' }, 'call-s1')
    expect((await h.execute(WRITE, {})).isError).toBe(false)

    if (h.projection === undefined) throw new Error('this scenario needs projections')
    h.projection.turn = 2
    const blocked = await h.execute(WRITE, {}, 'call-write-2')
    expect(blocked.isError).toBe(true)
    expect(h.gate.stateOf(SESSION)?.turn.harnessTurn).toBe(2)
  })
})

describe('the control tool is registered and usable', () => {
  it('registers bmpp__classify on the real registry', async () => {
    const h = await harness()
    expect(h.ctx.tools.get(CLASSIFY_TOOL)).toBeDefined()
  })

  it('executes through the registry and records the declaration', async () => {
    const h = await harness()
    const result = await h.execute(CLASSIFY_TOOL, { task: 'simple' })
    expect(result.isError).toBe(false)
    expect(h.gate.stateOf(SESSION)?.turn.classification).toBe('simple')
    // SIMPLE releases memory writes with no lookup at all.
    expect((await h.execute(WRITE, {})).isError).toBe(false)
  })

  it('is permitted even while the gate is closed for writes', async () => {
    const h = await harness()
    const result = await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    expect(result.isError).toBe(false)
  })
})

describe('host without the services the gate can live without', () => {
  it('works with no sessionProjections, using the counter', async () => {
    const h = await harness({ withProjections: false })
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'x' }, 'call-s1')
    expect(h.gate.stateOf(SESSION)?.turn.harnessTurn).toBe(0)
    expect((await h.execute(WRITE, {})).isError).toBe(false)
  })

  it('delegates when the execution carries no agent', async () => {
    const h = await harness({ withAgent: false })
    const result = await h.execute(WRITE, {})
    // No agent means no session, so BMPP does not judge the call.
    expect(result.isError).toBe(false)
    expect(h.gate.trackedSessions).toBe(0)
  })
})

describe('the plugin entry point mounts the gate', () => {
  it('mounts when applied through apply() and blocks an unclassified write', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sessionProjections', projections())
    const report = await apply(ctx, { mode: 'enforce', profile: 'compat' })
    expect(report.gate).toBeDefined()
    expect(report.hasSessionProjections).toBe(true)

    const probe = memoryTool(WRITE)
    ctx.tools.register(probe.definition)
    const agent = fakeAgent()
    const result = await ctx.tools.execute({
      signal, callId: ToolCallId('c1'), name: WRITE, arguments: {}, agent: asAgent(agent),
    })
    expect(result.isError).toBe(true)
    expect(probe.calls).toEqual([])
  })

  it('registers nothing in mode off', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const report = await apply(ctx, { mode: 'off' })
    expect(report.gate).toBeUndefined()
    expect(ctx.tools.get(CLASSIFY_TOOL)).toBeUndefined()

    const probe = memoryTool(WRITE)
    ctx.tools.register(probe.definition)
    const agent = fakeAgent()
    const result = await ctx.tools.execute({
      signal, callId: ToolCallId('c1'), name: WRITE, arguments: {}, agent: asAgent(agent),
    })
    expect(result.isError).toBe(false)
    expect(probe.calls).toEqual([WRITE])
  })
})
