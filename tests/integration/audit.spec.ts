/**
 * Integration proof that the audit reaches the REAL session log.
 *
 * These tests mount the genuine `SessionStore` from the installed DSH release,
 * create a real session, drive a real tool call through a real `ToolRuntime`,
 * and then read the durable event log back. That is the whole point: the audit
 * claim is about the session log, so it is asserted against the session log
 * rather than against a double.
 *
 * The complementary failures — a missing append surface, a throwing append —
 * are asserted to change no verdict at all.
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type { BmppDecisionPayload, BmppPolicyPayload, BmppRecallPayload } from '../../src/audit.ts'
import { DEFAULT_CONFIG, type BmppConfig } from '../../src/config.ts'
import { createGate, type SessionProjectionsLike } from '../../src/gate.ts'
import { ReasonCode } from '../../src/reason-codes.ts'
import { CLASSIFY_TOOL } from '../../src/state.ts'

const SESSION = 'audit-integration'
const SEARCH = 'mcp__basic-memory__search_notes'
const WRITE = 'mcp__basic-memory__write_note'
const DELETE = 'mcp__basic-memory__delete_note'
const READ = 'mcp__basic-memory__read_note'
const BASH = 'bash'

const signal = new AbortController().signal

/** A projection double whose turn the test can move. */
function projections(turn = 1): SessionProjectionsLike & { turn: number } {
  const holder = {
    turn,
    stateOf: (_s: object, key: string) => (key === 'turnBoundary' ? { lastTurn: holder.turn } : undefined),
  }
  return holder
}

/** A memory tool fixture that records its own execution. */
function tool(name: string, options: { throws?: boolean } = {}) {
  const calls: string[] = []
  const definition: ToolDefinition = {
    name,
    description: `fixture for ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: () => [{ type: 'text', text: 'ran' }],
    },
    async execute(): Promise<unknown> {
      calls.push(name)
      if (options.throws === true) throw new Error('memory backend unavailable')
      return { ok: true }
    },
  }
  return { definition, calls }
}

/** Everything one audited scenario needs. */
async function harness(options: { config?: Partial<BmppConfig>; session?: 'real' | 'none' } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)

  const projection = projections()
  ctx.provide('sessionProjections', projection)

  const session = options.session === 'none' ? undefined : ctx.sessions.create(SessionId(SESSION))
  const agent = session === undefined
    ? ({ session: { id: SESSION } } as unknown as { session: { id: string } })
    : ({ session } as unknown as { session: { id: string } })

  const config: BmppConfig = { ...DEFAULT_CONFIG, mode: 'enforce', ...options.config }
  const gate = createGate({ ctx, config })

  const tools = new Map<string, ReturnType<typeof tool>>()
  for (const name of [SEARCH, WRITE, DELETE, READ, BASH]) {
    const probe = tool(name)
    tools.set(name, probe)
    ctx.tools.register(probe.definition)
  }

  const execute = (name: string, args: Record<string, unknown> = {}, callId = `call-${name}`) =>
    ctx.tools.execute({
      signal, callId: ToolCallId(callId), name, arguments: args,
      agent: agent as unknown as never,
    })

  /** Every bmpp/policy event in the session log, in order. */
  const audited = (): BmppPolicyPayload[] => {
    if (session === undefined) return []
    return session.snapshotEvents()
      .filter(event => event.type === 'bmpp/policy')
      .map(event => event.data as BmppPolicyPayload)
  }

  return { ctx, gate, session, tools, execute, audited, projection }
}

describe('the audit lands in the real session log', () => {
  it('appends one decision event for one evaluated call', async () => {
    const h = await harness()
    await h.execute(WRITE, { title: 'x' })
    const events = h.audited()
    expect(events).toHaveLength(1)
    const event = events[0] as BmppDecisionPayload
    expect(event.kind).toBe('pre-execute')
    expect(event.tool).toBe(WRITE)
    expect(event.decision).toBe('deny')
    expect(event.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
    expect(event.enforcement).toBe('denied')
    expect(event.enforced).toBe(true)
  })

  it('records the real Harness turn number beside the policy turn', async () => {
    const h = await harness()
    h.projection.turn = 5
    await h.execute(WRITE, {})
    const event = h.audited()[0] as BmppDecisionPayload
    expect(event.harnessTurn).toBe(5)
    // A different quantity from the Harness turn, counted by BMPP from one.
    expect(event.policyTurn).toBe(1)
  })

  it('appends a distinct recall event when a search result settles', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'example query' }, 'call-search')

    const events = h.audited()
    const recall = events.find((event): event is BmppRecallPayload => event.kind === 'recall')
    expect(recall).toBeDefined()
    expect(recall?.tool).toBe(SEARCH)
    expect(recall?.recallState).toBe('succeeded')
    expect(recall?.recallOutcome).toBe('ok')
    expect(recall?.classification).toBe('complex')

    // The classification call and the search each produced a decision event too.
    const decisions = events.filter((event): event is BmppDecisionPayload => event.kind === 'pre-execute')
    expect(decisions.map(event => event.tool)).toEqual([CLASSIFY_TOOL, SEARCH])
  })

  it('records a failed recall as failed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionStore)
    ctx.provide('sessionProjections', projections())
    const session = ctx.sessions.create(SessionId('audit-failure'))
    const gate = createGate({ ctx, config: { ...DEFAULT_CONFIG, mode: 'enforce' } })
    ctx.tools.register(tool(SEARCH, { throws: true }).definition)
    const agent = { session } as unknown as { session: { id: string } }
    const run = (name: string, args: Record<string, unknown> = {}) =>
      ctx.tools.execute({ signal, callId: ToolCallId(`c-${name}`), name, arguments: args, agent: agent as unknown as never })

    await run(CLASSIFY_TOOL, { task: 'complex' })
    const searched = await run(SEARCH, { query: 'x' })
    expect(searched.isError).toBe(true)

    const recall = session.snapshotEvents()
      .filter(event => event.type === 'bmpp/policy')
      .map(event => event.data as BmppPolicyPayload)
      .find((event): event is BmppRecallPayload => event.kind === 'recall')
    expect(recall?.recallOutcome).toBe('failed')
    expect(recall?.recallState).toBe('failed')

    // And the next write is still blocked, for the failure reason.
    const outcome = gate.evaluate({ name: WRITE, arguments: {}, agent: agent as unknown as never } as never)
    expect(outcome?.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_FAILED)
  })

  it('records an approval request as asked, not as denied', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionStore)
    ctx.provide('sessionProjections', projections())
    ctx.provide('approval', { request: async () => 'allowed-once' })
    const session = ctx.sessions.create(SessionId('audit-ask'))
    createGate({ ctx, config: { ...DEFAULT_CONFIG, mode: 'enforce', profile: 'strict' } })
    const probe = tool(DELETE)
    ctx.tools.register(probe.definition)
    const agent = { session } as unknown as { session: { id: string } }

    const result = await ctx.tools.execute({
      signal, callId: ToolCallId('c1'), name: DELETE, arguments: {}, agent: agent as unknown as never,
    })
    expect(result.isError).toBe(false)
    expect(probe.calls).toEqual([DELETE])

    const event = session.snapshotEvents()
      .filter(entry => entry.type === 'bmpp/policy')
      .map(entry => entry.data as BmppPolicyPayload)[0] as BmppDecisionPayload
    expect(event.enforcement).toBe('asked')
    expect(event.profile).toBe('strict')
    expect(event.enforced).toBe(true)
  })

  it('records an audit override in mode audit while the call proceeds', async () => {
    const h = await harness({ config: { mode: 'audit' } })
    const result = await h.execute(WRITE, { title: 'x' })
    expect(result.isError).toBe(false)
    expect(h.tools.get(WRITE)?.calls).toEqual([WRITE])

    const event = h.audited()[0] as BmppDecisionPayload
    expect(event.decision).toBe('deny')
    expect(event.enforcement).toBe('overridden')
    expect(event.enforced).toBe(false)
    expect(event.auditOverride).toBe(true)
    expect(event.mode).toBe('audit')
  })

  it('records the policy version from configuration', async () => {
    const h = await harness({ config: { policyVersion: '9.9.9' } })
    await h.execute(WRITE, {})
    const event = h.audited()[0] as BmppDecisionPayload
    expect(event.policyVersion).toBe('9.9.9')
  })

  it('records every decision of a session, in order, without duplicates', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(CLASSIFY_TOOL, { task: 'simple' }, 'call-reclassify')
    await h.execute(READ, { identifier: 'note' })
    await h.execute(BASH, { command: 'ls' })
    await h.execute(WRITE, { title: 'x' })

    const decisions = h.audited().filter((event): event is BmppDecisionPayload => event.kind === 'pre-execute')
    expect(decisions).toHaveLength(5)
    expect(decisions.map(event => event.tool))
      .toEqual([CLASSIFY_TOOL, CLASSIFY_TOOL, READ, BASH, WRITE])
    // Each event records the state its own decision produced: the first
    // declaration already reads `complex`, the reclassification `simple`, and
    // every later call inherits `simple`.
    expect(decisions.map(event => event.classification))
      .toEqual(['complex', 'simple', 'simple', 'simple', 'simple'])
    // Exactly one event per call: no path emits twice.
    expect(new Set(decisions.map(event => event.reasonCode)).size).toBeGreaterThan(0)
    expect(h.audited()).toHaveLength(5)
  })

  it('records a reclassification as its own event', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(CLASSIFY_TOOL, { task: 'simple' }, 'call-2')
    const decisions = h.audited().filter((event): event is BmppDecisionPayload => event.kind === 'pre-execute')
    expect(decisions[1]?.observation).toBe('RECLASSIFIED')
    // Every decision event records the state that decision PRODUCED, so the
    // first declaration already reads `complex` and the second `simple`.
    expect(decisions[0]?.classification).toBe('complex')
    expect(decisions[0]?.observation).toBeUndefined()
    expect(decisions[1]?.classification).toBe('simple')
  })

  it('records a denied call and leaves the tool unexecuted', async () => {
    const h = await harness()
    const result = await h.execute(WRITE, {})
    expect(result.isError).toBe(true)
    expect(h.tools.get(WRITE)?.calls).toEqual([])
    const event = h.audited()[0] as BmppDecisionPayload
    expect(event.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
  })
})

describe('a broken audit changes no verdict', () => {
  it('keeps enforcing when the session has no append surface', async () => {
    const h = await harness({ session: 'none' })
    const result = await h.execute(WRITE, {})
    expect(result.isError).toBe(true)
    expect(h.tools.get(WRITE)?.calls).toEqual([])
    // The append was attempted, reported, and swallowed.
    expect(h.gate.auditFailureCount).toBe(1)
  })

  it('keeps enforcing when the append itself throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sessionProjections', projections())
    const hostileSession = {
      id: 'hostile',
      append: () => {
        throw new Error('log is read-only')
      },
    }
    const gate = createGate({ ctx, config: { ...DEFAULT_CONFIG, mode: 'enforce' } })
    const probe = tool(WRITE)
    ctx.tools.register(probe.definition)
    const agent = { session: hostileSession } as unknown as { session: { id: string } }

    const result = await ctx.tools.execute({
      signal, callId: ToolCallId('c1'), name: WRITE, arguments: {}, agent: agent as unknown as never,
    })
    // The verdict is unchanged by the failed audit.
    expect(result.isError).toBe(true)
    expect(probe.calls).toEqual([])
    expect(gate.auditFailureCount).toBe(1)
  })

  it('counts a failure per attempt and keeps deciding', async () => {
    const h = await harness({ session: 'none' })
    await h.execute(WRITE, {}, 'c1')
    await h.execute(WRITE, {}, 'c2')
    expect(h.gate.auditFailureCount).toBe(2)
    expect(h.tools.get(WRITE)?.calls).toEqual([])
  })

  it('reports zero failures on a healthy session', async () => {
    const h = await harness()
    await h.execute(WRITE, {})
    expect(h.gate.auditFailureCount).toBe(0)
  })
})

describe('the durable event survives the session log contract', () => {
  it('writes a payload the log accepts as lossless JSON', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'x' }, 'call-search')
    // Reaching this point means `session.append` validated and accepted both
    // event shapes; a non-lossless payload would have thrown at the append site.
    const events = h.audited()
    expect(events.length).toBeGreaterThanOrEqual(3)
    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event)
    }
  })

  it('assigns each event a sequence number inside the session log', async () => {
    const h = await harness()
    await h.execute(WRITE, {})
    const seqs = h.session?.snapshotEvents()
      .filter(event => event.type === 'bmpp/policy')
      .map(event => event.seq) ?? []
    expect(seqs).toHaveLength(1)
    expect(typeof seqs[0]).toBe('number')
  })

  it('never records the tool arguments', async () => {
    const h = await harness()
    const body = 'the note body must never be audited'
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'example query' }, 'call-search')
    await h.execute(WRITE, { content: body, title: 'T' }, 'call-write')
    const serialized = JSON.stringify(h.audited())
    expect(serialized).not.toContain(body)
    expect(serialized).not.toContain('example query')
  })
})
