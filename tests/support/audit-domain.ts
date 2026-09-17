/**
 * Test doubles for the audit sidecar's storage seam.
 *
 * The audit is durable host-side state, so its tests need a domain that behaves
 * like the real one: synchronous validated reads, durable writes that resolve
 * only when the record is stored, and a close that rejects further writes. These
 * doubles keep that contract without a backend, and one of them can be told to
 * fail a write so the fail-soft path is exercised for real.
 *
 * @module tests/support/audit-domain
 */

import type {
  AuditDomainLike,
  AuditTableLike,
  StorageDomainLike,
} from '../../src/audit-store.ts'
import type {
  AuditRecordResult,
  AuditSink,
  SealedAuditRecord,
} from '../../src/audit-sink.ts'
import {
  AUDIT_DOMAIN_NAME,
  AUDIT_DOMAIN_VERSION,
  AUDIT_TABLE,
  type AuditRecordValue,
} from '../../src/audit-sink.ts'

/**
 * A sink that keeps every record in memory, synchronously.
 *
 * Tests that read the audit right after a call need the record present without
 * awaiting a drain, so this double records at `record()` time instead of
 * deferring. Use {@link auditDomainDouble} when the storage path itself — the
 * write-behind queue and the durable put — is what the test is about.
 *
 * @returns the sink plus its recorded events, in order.
 */
export function collectingSink(): AuditSink & { readonly records: readonly SealedAuditRecord[] } {
  const records: SealedAuditRecord[] = []
  let closed = false
  return {
    records,
    record(record: SealedAuditRecord): AuditRecordResult {
      if (closed) return { ok: false, reason: 'closed' }
      records.push(record)
      return { ok: true }
    },
    async whenSettled() {
      // Nothing waits on mount order: records are kept synchronously.
    },
    async flush() {
      // Nothing is buffered: every record was kept at `record()` time.
    },
    async close() {
      closed = true
    },
  }
}

/** What one double recorded, and how it behaved. */
export interface AuditDomainDouble {
  readonly facility: StorageDomainLike
  /** Every stored record, in write order. */
  readonly records: AuditRecordValue[]
  /** Domain specs the sink opened, so a test can assert the declared version. */
  readonly openedSpecs: unknown[]
  /** Writes attempted after `close()`. */
  rejectedAfterClose: number
  /** Fail every write while true, to exercise the fail-soft path. */
  failWrites: boolean
  /** How many times the domain was closed. */
  closes: number
  /** Records stored for one session, oldest first. */
  forSession(sessionId: string): AuditRecordValue[]
}

/**
 * An in-memory stand-in for `ctx.storageDomain`.
 *
 * `put` resolves after the record is visible, mirroring the real contract that a
 * write is durable before it resolves — which is what lets a test assert flush
 * semantics without a medium.
 */
export function auditDomainDouble(): AuditDomainDouble {
  const records: AuditRecordValue[] = []
  const openedSpecs: unknown[] = []
  let closed = false

  const table: AuditTableLike = {
    get size() {
      return records.length
    },
    get(key: string) {
      return records.find(record => record.sessionId === key)
    },
    *entries() {
      for (const record of records) yield [`${record.sessionId}#${record.seq}`, record] as const
    },
    async put(_key: string, value: AuditRecordValue) {
      if (closed) throw new Error('domain is closed')
      if (double.failWrites) throw new Error('medium rejected the write')
      records.push(value)
    },
  }

  const domain: AuditDomainLike = {
    name: AUDIT_DOMAIN_NAME,
    table: (name: string) => {
      if (name !== AUDIT_TABLE) throw new Error(`unknown table ${name}`)
      return table
    },
    async close() {
      closed = true
      double.closes += 1
    },
  }

  const double: AuditDomainDouble = {
    facility: {
      async open(spec: unknown) {
        openedSpecs.push(spec)
        return domain
      },
    },
    records,
    openedSpecs,
    rejectedAfterClose: 0,
    failWrites: false,
    closes: 0,
    forSession(sessionId: string) {
      return records.filter(record => record.sessionId === sessionId)
    },
  }
  return double
}

/** The domain version a test should expect the plugin to declare. */
export const EXPECTED_DOMAIN = {
  name: AUDIT_DOMAIN_NAME,
  version: AUDIT_DOMAIN_VERSION,
  table: AUDIT_TABLE,
} as const
