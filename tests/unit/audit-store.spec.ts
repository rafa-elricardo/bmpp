/**
 * Unit coverage for the audit sidecar: the storage-backed sink, the fallback
 * when the host provides no storage, and the domain declaration.
 *
 * These are the properties a reader of the audit depends on: records reach the
 * medium, they never mix between sessions, pending records land before teardown,
 * and a storage outage changes no verdict.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_DOMAIN_NAME,
  AUDIT_DOMAIN_SPEC,
  AUDIT_DOMAIN_VERSION,
  AUDIT_TABLE,
  auditRecordSchema,
  type SealedAuditRecord,
} from '../../src/audit-sink.ts'
import {
  auditRecordKey,
  DroppedAuditSink,
  StorageAuditSink,
  storageDomainOf,
} from '../../src/audit-store.ts'
import { auditDomainDouble } from '../support/audit-domain.ts'

/** One minimal sealed record for a session. */
function record(sessionId: string, seq = 1): SealedAuditRecord {
  return {
    sessionId,
    seq,
    recordedAt: 1_700_000_000_000,
    payload: {
      kind: 'pre-execute',
      policyTurn: 1,
      tool: 'mcp__basic-memory__write_note',
      toolClass: 'memory.write',
      policyState: 'RECALL_REQUIRED',
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
  }
}

describe('the audit domain declaration', () => {
  it('names the domain the storage layer will accept', () => {
    // The storage layer's unit-name rule is `^[a-z][a-z0-9_]*$`, so a hyphenated
    // name would be rejected at open.
    expect(AUDIT_DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('declares its version explicitly and uses the per-record layout', () => {
    expect(AUDIT_DOMAIN_VERSION).toBe(1)
    expect(AUDIT_DOMAIN_SPEC.version).toBe(AUDIT_DOMAIN_VERSION)
    expect(AUDIT_DOMAIN_SPEC.layout).toBe('per-record')
    expect(Object.keys(AUDIT_DOMAIN_SPEC.tables)).toEqual([AUDIT_TABLE])
  })

  it('validates the stored envelope, refusing a record with no session', () => {
    expect(auditRecordSchema.safeParse(record('s')).success).toBe(true)
    const missingSession = { ...record('s'), sessionId: undefined }
    expect(auditRecordSchema.safeParse(missingSession).success).toBe(false)
  })

  it('refuses a payload that could not survive a JSON round trip', () => {
    const unserializable = {
      ...record('s'),
      payload: { kind: 'pre-execute', tool: () => undefined },
    }
    expect(auditRecordSchema.safeParse(unserializable).success).toBe(false)
  })

  it('refuses a payload that is not one of the two audit halves', () => {
    const wrongKind = { ...record('s'), payload: { kind: 'something-else' } }
    expect(auditRecordSchema.safeParse(wrongKind).success).toBe(false)
  })
})

describe('the storage-backed sink', () => {
  it('builds a path-safe per-record key the backend accepts', () => {
    // A `per-record` backend rejects any key outside `^[a-zA-Z0-9_-]+$`, so a
    // separator like `#` fails the write at the medium rather than here.
    const key = auditRecordKey(record('session-abc', 7))
    expect(key).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(key.startsWith('session-abc')).toBe(true)
    // Zero-padded, so keys sort in decision order for one session.
    expect(auditRecordKey(record('s', 2)) < auditRecordKey(record('s', 10))).toBe(true)
  })

  it('persists a record and flush resolves after it is stored', async () => {
    const domain = auditDomainDouble()
    const sink = await StorageAuditSink.open(domain.facility)
    expect(sink.record(record('s1'))).toEqual({ ok: true })
    await sink.flush()
    expect(domain.records).toHaveLength(1)
    expect(domain.records[0]?.sessionId).toBe('s1')
  })

  it('opens the declared domain spec, version included', async () => {
    const domain = auditDomainDouble()
    await StorageAuditSink.open(domain.facility)
    expect(domain.openedSpecs).toHaveLength(1)
    const spec = domain.openedSpecs[0] as { name: string; version: number }
    expect(spec.name).toBe(AUDIT_DOMAIN_NAME)
    expect(spec.version).toBe(AUDIT_DOMAIN_VERSION)
  })

  it('keeps sessions isolated: each record carries its own session id', async () => {
    const domain = auditDomainDouble()
    const sink = await StorageAuditSink.open(domain.facility)
    sink.record(record('session-a', 1))
    sink.record(record('session-b', 2))
    sink.record(record('session-a', 3))
    await sink.flush()
    expect(domain.forSession('session-a').map(r => r.seq)).toEqual([1, 3])
    expect(domain.forSession('session-b').map(r => r.seq)).toEqual([2])
  })

  it('drains records enqueued while a previous drain was still running', async () => {
    const domain = auditDomainDouble()
    const sink = await StorageAuditSink.open(domain.facility)
    for (let seq = 1; seq <= 25; seq += 1) {
      sink.record(record('s', seq))
      // Interleave a flush so a record lands mid-drain on some iterations.
      if (seq % 5 === 0) await sink.flush()
    }
    await sink.flush()
    expect(domain.records).toHaveLength(25)
  })

  it('counts a rejected write and keeps accepting later ones', async () => {
    const domain = auditDomainDouble()
    const sink = await StorageAuditSink.open(domain.facility)
    domain.failWrites = true
    sink.record(record('s', 1))
    await sink.flush()
    expect(sink.writeFailures).toBe(1)

    domain.failWrites = false
    sink.record(record('s', 2))
    await sink.flush()
    expect(domain.records).toHaveLength(1)
    expect(domain.records[0]?.seq).toBe(2)
  })

  it('bounds the queue instead of growing without limit', async () => {
    const domain = auditDomainDouble()
    const sink = await StorageAuditSink.open(domain.facility)
    domain.failWrites = true
    // Nothing drains while the medium refuses, so the bound is what stops it.
    let overflowed: { ok: boolean } | undefined
    for (let seq = 1; seq <= 1100; seq += 1) {
      const result = sink.record(record('s', seq))
      if (!result.ok) overflowed = result
    }
    expect(overflowed).toBeDefined()
    expect(overflowed && 'reason' in overflowed ? overflowed.reason : undefined).toBe('queue-overflow')
    expect(sink.pendingCount).toBeLessThanOrEqual(1024)
  })

  it('flushes before releasing the domain, and rejects records after close', async () => {
    const domain = auditDomainDouble()
    const sink = await StorageAuditSink.open(domain.facility)
    sink.record(record('s', 1))
    await sink.close()
    expect(domain.records).toHaveLength(1)
    expect(domain.closes).toBe(1)
    expect(sink.record(record('s', 2))).toEqual({ ok: false, reason: 'closed' })
  })
})

describe('the dropping sink refuses without persisting', () => {
  it('counts every refused record and closes idempotently', async () => {
    const sink = new DroppedAuditSink('storage-unavailable')
    expect(sink.record(record('s'))).toEqual({ ok: false, reason: 'storage-unavailable' })
    expect(sink.record(record('s'))).toEqual({ ok: false, reason: 'storage-unavailable' })
    expect(sink.droppedRecords).toBe(2)
    await sink.flush()
    await sink.close()
    await sink.close()
    expect(sink.record(record('s'))).toEqual({ ok: false, reason: 'closed' })
  })

  it('reports nothing itself, so the gate counts each drop exactly once', async () => {
    // The gate reacts to the non-ok result; a sink that also reported would
    // double-count every drop.
    const sink = new DroppedAuditSink('write-failed')
    sink.record(record('s'))
    expect(sink.droppedRecords).toBe(1)
  })
})

describe('resolving the storage service', () => {
  it('finds the facility when the host provides one', async () => {
    const ctx = new Context()
    const domain = auditDomainDouble()
    ctx.provide('storageDomain' as never, domain.facility as never)
    expect(storageDomainOf(ctx)).toBeDefined()
  })

  it('reports absence when the host mounts no storage', () => {
    expect(storageDomainOf(new Context())).toBeUndefined()
  })

  it('rejects a service that is not a usable facility', () => {
    const ctx = new Context()
    ctx.provide('storageDomain' as never, { notOpen: true } as never)
    expect(storageDomainOf(ctx)).toBeUndefined()
  })
})
