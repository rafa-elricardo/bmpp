/**
 * Regression proof for the session-compatibility defect.
 *
 * BMPP originally wrote its audit as a `bmpp/policy` session event. The Harness
 * treats an event type it does not know as required-on-read, so a persisted
 * `bmpp/policy` made the session impossible to observe, resume, or replay. These
 * tests exercise the REAL persistence backend and the REAL reader:
 *
 * 1. the historical artifact still refuses, which is the defect being fixed; and
 * 2. a session carrying BMPP activity persists, reloads, and resumes, with the
 *    audit present in the sidecar and absent from the log.
 *
 * The second test is the regression guard: it fails against the old
 * implementation, which appended `bmpp/policy` into the log.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { materializeCreateHeader } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import { createGate } from '../../src/gate.ts'
import { AUDIT_DOMAIN_NAME } from '../../src/audit-sink.ts'
import { StorageAuditSink } from '../../src/audit-store.ts'
import { CLASSIFY_TOOL } from '../../src/state.ts'
import { auditDomainDouble } from '../support/audit-domain.ts'

const WRITE = 'mcp__basic-memory__write_note'

/** A fresh on-disk persistence backend under a throwaway directory. */
async function backend(): Promise<{ ctx: Context; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'bmpp-session-'))
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root })
  return { ctx, root }
}

/** The stored header for a session created by this test. */
function header(id: string): SessionHeader {
  return materializeCreateHeader({
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
    isSeeded: false,
  })
}

/** A minimal session event, used to make a log that the reader must accept. */
function turnStart(seq: number, turn = 1): SessionEvent {
  return { type: 'turn/start', seq: seq as never, time: Date.now(), data: { turn } } as unknown as SessionEvent
}

/**
 * The historical artifact: an audit event written into the session log.
 *
 * Reproduces exactly what the previous implementation persisted. The reader
 * refuses it because BMPP cannot mark its own event type ignorable through
 * `Session.append`, so the Harness has no way to know whether skipping it is
 * safe.
 */
function legacyPolicyEvent(seq: number): SessionEvent {
  return {
    type: 'bmpp/policy',
    seq: seq as never,
    time: Date.now(),
    data: {
      kind: 'pre-execute',
      policyTurn: 1,
      tool: WRITE,
      toolClass: 'memory.write',
      policyState: 'unknown',
      decision: 'deny',
      reasonCode: 'CLASSIFICATION_REQUIRED',
      enforcement: 'denied',
      enforced: true,
      auditOverride: false,
      classification: 'unknown',
      recallState: 'idle',
      mode: 'enforce',
      profile: 'compat',
      policyVersion: '0.1.0',
      pluginVersion: '0.1.0',
    },
  } as unknown as SessionEvent
}

/** Persist a batch of events, then read the session back through the backend. */
async function persistAndReopen(
  ctx: Context,
  id: string,
  events: readonly SessionEvent[],
): Promise<{ readonly eventTypes: string[]; readonly reopened: boolean }> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('the JSONL backend did not register')

  const write = await persistence.create(header(id), {})
  await write.append(events)
  await write.flush()
  await write.close()

  // A NEW handle, exactly as a resume or an observation opens the stored log.
  const read = await persistence.open(SessionId(id), 'read')
  try {
    const result = await read.read()
    return { eventTypes: result.events.map(event => event.type), reopened: true }
  } finally {
    await read.close()
  }
}

describe('the historical artifact still refuses', () => {
  it('rejects a stored session whose log carries bmpp/policy', async () => {
    const { ctx } = await backend()
    await expect(
      persistAndReopen(ctx, 'legacy-audit-session', [turnStart(0), legacyPolicyEvent(1)]),
    ).rejects.toThrow(/bmpp\/policy[\s\S]*not marked ignorable|unknown to this harness/)
    await ctx.fiber.dispose()
  })

  it('accepts the same session once the audit event is not in the log', async () => {
    const { ctx } = await backend()
    const result = await persistAndReopen(ctx, 'clean-audit-session', [turnStart(0), turnStart(1, 2)])
    expect(result.reopened).toBe(true)
    expect(result.eventTypes).toEqual(['turn/start', 'turn/start'])
    await ctx.fiber.dispose()
  })
})

describe('a session with BMPP activity persists and resumes', () => {
  it('reopens with no bmpp/policy event while the sidecar holds the audit', async () => {
    const { ctx } = await backend()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionStore)

    const projection = { turn: 1, stateOf: () => ({ lastTurn: 1 }) }
    ctx.provide('sessionProjections', projection as never)

    // The real storage-backed sink, so the audit lands where production puts it.
    const audit = auditDomainDouble()
    ctx.provide('storageDomain' as never, audit.facility as never)
    const sink = await StorageAuditSink.open(audit.facility)

    const session = ctx.sessions.create(SessionId('bmpp-activity'))
    // `createGate` builds an unmounted gate; the caller mounts it after
    // attaching the audit sink, which is the same order the plugin uses.
    const gate = createGate({ ctx, config: { ...DEFAULT_CONFIG, mode: 'enforce' }, auditSink: sink })
    gate.mount()

    ctx.tools.register({
      name: WRITE,
      description: 'fixture',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        render: () => [{ type: 'text', text: 'ran' }],
      },
      async execute(): Promise<unknown> {
        return { ok: true }
      },
    } as never)

    const agent = { session } as unknown as never
    // One classified call and one denied mutation: both are audited.
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('c1'),
      name: CLASSIFY_TOOL,
      arguments: { task: 'simple' },
      agent,
    })
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('c2'),
      name: WRITE,
      arguments: { title: 'x' },
      agent,
    })

    await gate.settleAudit()
    await gate.flushAudit()
    expect(audit.records.length).toBeGreaterThanOrEqual(2)

    // Persist the session's own truthful log, then open it again.
    const persisted = session.snapshotEvents()
    const result = await persistAndReopen(ctx, 'bmpp-activity', persisted)

    expect(result.reopened).toBe(true)
    // The regression: the log must carry no event the Harness cannot interpret.
    expect(result.eventTypes).not.toContain('bmpp/policy')
    // And the audit was not lost: it is in the plugin-owned domain.
    expect(audit.records.map(record => record.payload.kind)).toEqual(['pre-execute', 'pre-execute'])
    expect(audit.openedSpecs).toHaveLength(1)

    await gate.disposeAudit()
    await ctx.fiber.dispose()
  })
})
