/**
 * Integration proof that the audit reaches the DURABLE SIDECAR, and no longer
 * the session log.
 *
 * These tests mount the genuine `SessionStore` and `ToolRuntime` from the
 * installed DSH release, create a real session, drive real tool calls, and then
 * read the audit records back out of the storage domain. Two claims are load
 * bearing and both are asserted here:
 *
 * 1. the audit lands, complete and in order, in the plugin's own domain; and
 * 2. the session log stays free of any `bmpp/policy` event, which is what keeps
 *    the session observable and resumable.
 *
 * The complementary failures — storage unavailable, a medium that rejects the
 * write — are asserted to change no verdict at all.
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type { SealedDecisionPayload, SealedRecallPayload } from '../../src/audit-sink.ts'
import { DEFAULT_CONFIG, type BmppConfig } from '../../src/config.ts'
import { type SessionProjectionsLike } from '../../src/gate.ts'
import { apply } from '../../src/index.ts'
import { ReasonCode } from '../../src/reason-codes.ts'
import { CLASSIFY_TOOL } from '../../src/state.ts'
import { auditDomainDouble, EXPECTED_DOMAIN } from '../support/audit-domain.ts'

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
async function harness(options: {
  config?: Partial<BmppConfig>
  withStorage?: boolean
  session?: 'real' | 'none'
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)

  const projection = projections()
  ctx.provide('sessionProjections', projection)

  // The audit domain is the only durable sink; a harness without it exercises
  // the storage-unavailable path.
  const audit = options.withStorage === false ? undefined : auditDomainDouble()
  if (audit !== undefined) ctx.provide('storageDomain' as never, audit.facility as never)

  const session = options.session === 'none' ? undefined : ctx.sessions.create(SessionId(SESSION))
  const agent = session === undefined
    ? ({ session: { id: SESSION } } as unknown as { session: { id: string } })
    : ({ session } as unknown as { session: { id: string } })

  const config: BmppConfig = { ...DEFAULT_CONFIG, mode: 'enforce', ...options.config }
  // The REAL plugin entry point, so the harness exercises the same resolution,
  // sink attachment and mounting order that production does.
  const report = await apply(ctx, config)
  const gate = report.gate
  if (gate === undefined) throw new Error('the gate must mount in enforce mode')

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

  /**
   * Every audit payload in the sidecar, oldest first.
   *
   * Flushes first: the sink is write-behind, so without this the assertion would
   * race the medium rather than test it.
   */
  const audited = async (): Promise<(SealedDecisionPayload | SealedRecallPayload)[]> => {
    // Wait for the storage handoff to settle before reading: the sink starts as
    // a buffer and takes over once the optional service activates.
    await gate.settleAudit()
    await gate.flushAudit()
    return (audit?.records ?? []).map(record => record.payload)
  }

  /** Event types actually persisted in the session log. */
  const sessionEventTypes = (): string[] =>
    session === undefined ? [] : session.snapshotEvents().map(event => event.type)

  return { ctx, gate, report, session, tools, execute, audited, sessionEventTypes, audit, projection }
}

describe('the audit lands in the plugin-owned sidecar', () => {
  it('records one decision for one evaluated call', async () => {
    const h = await harness()
    await h.execute(WRITE, { title: 'x' })
    const events = await h.audited()
    expect(events).toHaveLength(1)
    const event = events[0] as SealedDecisionPayload
    expect(event.kind).toBe('pre-execute')
    expect(event.tool).toBe(WRITE)
    expect(event.decision).toBe('deny')
    expect(event.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
    expect(event.enforcement).toBe('denied')
    expect(event.enforced).toBe(true)
    // The session log is untouched: this is the whole point of the sidecar.
    expect(h.sessionEventTypes()).not.toContain('bmpp/policy')
  })

  it('stamps every record with its session id and a monotonic sequence', async () => {
    const h = await harness()
    await h.execute(WRITE, {})
    await h.execute(READ, { identifier: 'n' }, 'call-read')
    expect(h.audit?.records.map(record => record.sessionId)).toEqual([SESSION, SESSION])
    expect(h.audit?.records.map(record => record.seq)).toEqual([1, 2])
    expect(h.audit?.records.every(record => record.recordedAt > 0)).toBe(true)
  })

  it('records the real Harness turn number beside the policy turn', async () => {
    const h = await harness()
    h.projection.turn = 5
    await h.execute(WRITE, {})
    const event = (await h.audited())[0] as SealedDecisionPayload
    expect(event.harnessTurn).toBe(5)
    // A different quantity from the Harness turn, counted by BMPP from one.
    expect(event.policyTurn).toBe(1)
  })

  it('records a distinct recall settlement when a search result lands', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'example query' }, 'call-search')

    const events = await h.audited()
    const recall = events.find((event): event is SealedRecallPayload => event.kind === 'recall')
    expect(recall).toBeDefined()
    expect(recall?.tool).toBe(SEARCH)
    expect(recall?.recallState).toBe('succeeded')
    expect(recall?.recallOutcome).toBe('ok')
    expect(recall?.classification).toBe('complex')

    // The classification call and the search each produced a decision too.
    const decisions = events.filter((event): event is SealedDecisionPayload => event.kind === 'pre-execute')
    expect(decisions.map(event => event.tool)).toEqual([CLASSIFY_TOOL, SEARCH])
  })

  it('records a failed recall as failed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionStore)
    ctx.provide('sessionProjections', projections())
    const audit = auditDomainDouble()
    ctx.provide('storageDomain' as never, audit.facility as never)
    const session = ctx.sessions.create(SessionId('audit-failure'))
    const report = await apply(ctx, { ...DEFAULT_CONFIG, mode: 'enforce' })
    const gate = report.gate
    if (gate === undefined) throw new Error('the gate must mount')
    ctx.tools.register(tool(SEARCH, { throws: true }).definition)
    const agent = { session } as unknown as { session: { id: string } }
    const run = (name: string, args: Record<string, unknown> = {}) =>
      ctx.tools.execute({ signal, callId: ToolCallId(`c-${name}`), name, arguments: args, agent: agent as unknown as never })

    await run(CLASSIFY_TOOL, { task: 'complex' })
    const searched = await run(SEARCH, { query: 'x' })
    expect(searched.isError).toBe(true)

    await gate.flushAudit()
    const recall = audit.records
      .map(record => record.payload)
      .find((event): event is SealedRecallPayload => event.kind === 'recall')
    expect(audit.records.length).toBeGreaterThan(0)
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
    const audit = auditDomainDouble()
    ctx.provide('storageDomain' as never, audit.facility as never)
    const session = ctx.sessions.create(SessionId('audit-ask'))
    const report = await apply(ctx, { ...DEFAULT_CONFIG, mode: 'enforce', profile: 'strict' })
    const gate = report.gate
    if (gate === undefined) throw new Error('the gate must mount')
    const probe = tool(DELETE)
    ctx.tools.register(probe.definition)
    const agent = { session } as unknown as { session: { id: string } }

    const result = await ctx.tools.execute({
      signal, callId: ToolCallId('c1'), name: DELETE, arguments: {}, agent: agent as unknown as never,
    })
    expect(result.isError).toBe(false)
    expect(probe.calls).toEqual([DELETE])

    await gate.flushAudit()
    const event = audit.records[0]?.payload as SealedDecisionPayload
    expect(event.enforcement).toBe('asked')
    expect(event.profile).toBe('strict')
    expect(event.enforced).toBe(true)
  })

  it('records an audit override in mode audit while the call proceeds', async () => {
    const h = await harness({ config: { mode: 'audit' } })
    const result = await h.execute(WRITE, { title: 'x' })
    expect(result.isError).toBe(false)
    expect(h.tools.get(WRITE)?.calls).toEqual([WRITE])

    const event = (await h.audited())[0] as SealedDecisionPayload
    expect(event.decision).toBe('deny')
    expect(event.enforcement).toBe('overridden')
    expect(event.enforced).toBe(false)
    expect(event.auditOverride).toBe(true)
    expect(event.mode).toBe('audit')
  })

  it('records the policy version from configuration', async () => {
    const h = await harness({ config: { policyVersion: '9.9.9' } })
    await h.execute(WRITE, {})
    const event = (await h.audited())[0] as SealedDecisionPayload
    expect(event.policyVersion).toBe('9.9.9')
  })

  it('records every decision of a session, in order, without duplicates', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(CLASSIFY_TOOL, { task: 'simple' }, 'call-reclassify')
    await h.execute(READ, { identifier: 'note' })
    await h.execute(BASH, { command: 'ls' })
    await h.execute(WRITE, { title: 'x' })

    const events = await h.audited()
    const decisions = events.filter((event): event is SealedDecisionPayload => event.kind === 'pre-execute')
    expect(decisions).toHaveLength(5)
    expect(decisions.map(event => event.tool))
      .toEqual([CLASSIFY_TOOL, CLASSIFY_TOOL, READ, BASH, WRITE])
    // Each record carries the state its own decision produced: the first
    // declaration already reads `complex`, the reclassification `simple`, and
    // every later call inherits `simple`.
    expect(decisions.map(event => event.classification))
      .toEqual(['complex', 'simple', 'simple', 'simple', 'simple'])
    // Exactly one record per call: no path emits twice.
    expect(events).toHaveLength(5)
  })

  it('records a reclassification as its own record', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(CLASSIFY_TOOL, { task: 'simple' }, 'call-2')
    const decisions = (await h.audited())
      .filter((event): event is SealedDecisionPayload => event.kind === 'pre-execute')
    expect(decisions[1]?.observation).toBe('RECLASSIFIED')
    // Every record captures the state that decision PRODUCED, so the first
    // declaration already reads `complex` and the second `simple`.
    expect(decisions[0]?.classification).toBe('complex')
    expect(decisions[0]?.observation).toBeUndefined()
    expect(decisions[1]?.classification).toBe('simple')
  })

  it('records a denied call and leaves the tool unexecuted', async () => {
    const h = await harness()
    const result = await h.execute(WRITE, {})
    expect(result.isError).toBe(true)
    expect(h.tools.get(WRITE)?.calls).toEqual([])
    const event = (await h.audited())[0] as SealedDecisionPayload
    expect(event.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
  })
})

describe('a broken audit changes no verdict', () => {
  it('keeps enforcing when the host provides no storage service', async () => {
    const h = await harness({ withStorage: false })
    // The composition has no storage rows, so the wait ends here rather than at
    // teardown; the buffered record is reported and the verdict stands.
    h.gate.abandonAudit()
    const result = await h.execute(WRITE, {})
    expect(result.isError).toBe(true)
    expect(h.tools.get(WRITE)?.calls).toEqual([])
    await h.gate.settleAudit()
    expect(h.gate.auditFailureCount).toBe(1)
  })

  it('counts a medium that rejects the write, and keeps deciding', async () => {
    const h = await harness()
    if (h.audit === undefined) throw new Error('this scenario needs storage')
    h.audit.failWrites = true
    const before = h.gate.auditFailureCount
    const result = await h.execute(WRITE, {})
    // The verdict is unaffected by the failing medium.
    expect(result.isError).toBe(true)
    expect(h.tools.get(WRITE)?.calls).toEqual([])
    await h.gate.settleAudit()
    await h.gate.flushAudit()
    expect(h.gate.auditFailureCount).toBe(before + 1)
  })

  it('counts a drop per attempt and keeps deciding', async () => {
    const h = await harness({ withStorage: false })
    h.gate.abandonAudit()
    await h.gate.settleAudit()
    await h.execute(WRITE, {}, 'c1')
    await h.execute(WRITE, {}, 'c2')
    expect(h.gate.auditFailureCount).toBe(2)
    expect(h.tools.get(WRITE)?.calls).toEqual([])
  })

  it('reports zero failures with a healthy store', async () => {
    const h = await harness()
    await h.execute(WRITE, {})
    await h.gate.settleAudit()
    await h.gate.flushAudit()
    expect(h.gate.auditFailureCount).toBe(0)
  })
})

describe('the durable record survives the storage contract', () => {
  it('writes a payload that round-trips through JSON exactly', async () => {
    const h = await harness()
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'x' }, 'call-search')
    const events = await h.audited()
    expect(events.length).toBeGreaterThanOrEqual(3)
    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event)
    }
  })

  it('declares the audit domain version explicitly', async () => {
    const h = await harness()
    await h.execute(WRITE, {})
    const spec = h.audit?.openedSpecs[0] as { name?: unknown; version?: unknown } | undefined
    expect(spec?.name).toBe(EXPECTED_DOMAIN.name)
    expect(spec?.version).toBe(EXPECTED_DOMAIN.version)
  })

  it('never records the tool arguments', async () => {
    const h = await harness()
    const body = 'the note body must never be audited'
    await h.execute(CLASSIFY_TOOL, { task: 'complex' })
    await h.execute(SEARCH, { query: 'example query' }, 'call-search')
    await h.execute(WRITE, { content: body, title: 'T' }, 'call-write')
    const serialized = JSON.stringify(await h.audited())
    expect(serialized).not.toContain(body)
    expect(serialized).not.toContain('example query')
  })
})
