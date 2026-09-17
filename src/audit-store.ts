/**
 * The storage-backed audit sink, and the fallback that reports what it drops.
 *
 * Writes go through the Harness's public `storageDomain` service, which is the
 * sanctioned home for durable host-side state that must not become a session
 * event. Two properties shape this file:
 *
 * 1. **The hot path never waits.** `record()` only appends to an in-process
 *    queue; the durable `put` runs on a drain that nobody awaits, and `flush()`
 *    is where lifecycle code waits for durability. A verdict is therefore never
 *    delayed by the medium.
 * 2. **Storage is optional.** When the service is absent the sink still answers
 *    `record()` and reports a drop, so a composition without the storage rows
 *    keeps enforcing exactly as it did — it just loses the evidence, and says so.
 *
 * @module dsh-bmpp/audit-store
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  AUDIT_DOMAIN_SPEC,
  AUDIT_TABLE,
  type AuditDropReason,
  type AuditRecordResult,
  type AuditRecordValue,
  type AuditSink,
  type SealedAuditRecord,
} from './audit-sink.ts'

/**
 * The slice of `ctx.storageDomain` this module uses.
 *
 * Declared structurally on purpose: BMPP resolves the service with `ctx.get`,
 * so it needs the method it calls, not the owning package's module identity.
 * That keeps the DSH packages out of BMPP's runtime imports entirely.
 */
export interface AuditTableLike {
  readonly size: number
  /** Synchronous in-memory read; present for inspection and tests. */
  get(key: string): AuditRecordValue | undefined
  entries(): IterableIterator<[string, AuditRecordValue]>
  /** Durable insert or overwrite; resolves after durability. */
  put(key: string, value: AuditRecordValue): Promise<void>
}

/** One opened audit domain. */
export interface AuditDomainLike {
  readonly name: string
  table(name: string): AuditTableLike
  /** Drain queued writes, release the backend unit, free the domain name. */
  close(): Promise<void>
}

/** The storage-domain facility, as BMPP uses it. */
export interface StorageDomainLike {
  open(spec: unknown): Promise<AuditDomainLike>
}

/**
 * Bound on queued-but-unwritten records.
 *
 * A medium that stops draining must degrade the audit, not exhaust the process:
 * past this depth the oldest pending record is dropped and reported, which keeps
 * the newest decisions — the ones a reader is actually chasing — buffered.
 */
const MAX_PENDING = 1024

/**
 * The `per-record` document key for one audit record.
 *
 * A per-record backend requires a path-safe key (`^[a-zA-Z0-9_-]+$`), so the
 * session and the sequence are joined by a hyphen and the sequence is
 * zero-padded: the session id stays a readable prefix, and keys sort in the
 * order the decisions happened.
 *
 * @param record - the record to name.
 * @returns the storage key.
 */
export function auditRecordKey(record: SealedAuditRecord): string {
  return `${record.sessionId}-${String(record.seq).padStart(12, '0')}`
}

/**
 * A sink over an opened audit domain.
 *
 * One instance owns one domain per plugin mount; the domain's `per-record`
 * layout keeps each session's trail addressable by its key prefix, so no
 * cross-session state is held here at all.
 */
export class StorageAuditSink implements AuditSink {
  private readonly pending: SealedAuditRecord[] = []
  private readonly domain: AuditDomainLike
  private readonly table: AuditTableLike
  private draining: Promise<void> | undefined
  private closed = false
  private storageFailures = 0

  private readonly onDrop: (error?: string) => void

  /**
   * Opens the audit domain and returns a sink writing into it.
   * @param domain - the storage-domain facility.
   * @param onDrop - called once per write the medium rejected, so the plugin can
   *   count and surface a durable-store outage. The sink cannot report it any
   *   other way: `record()` returns as soon as a record is queued.
   */
  static async open(
    domain: StorageDomainLike,
    onDrop: (error?: string) => void = () => undefined,
  ): Promise<StorageAuditSink> {
    const opened = await domain.open(AUDIT_DOMAIN_SPEC)
    return new StorageAuditSink(opened, opened.table(AUDIT_TABLE), onDrop)
  }

  constructor(domain: AuditDomainLike, table: AuditTableLike, onDrop: (error?: string) => void = () => undefined) {
    this.domain = domain
    this.table = table
    this.onDrop = onDrop
  }

  /** Records dropped because the medium rejected or the domain closed. */
  get writeFailures(): number {
    return this.storageFailures
  }

  /** Records still queued for the medium; exposed for leak and flush assertions. */
  get pendingCount(): number {
    return this.pending.length
  }

  record(record: SealedAuditRecord): AuditRecordResult {
    if (this.closed) return { ok: false, reason: 'closed' }
    if (this.pending.length >= MAX_PENDING) {
      this.pending.shift()
      const overflow = { ok: false, reason: 'queue-overflow' } as const
      this.startDrain()
      return overflow
    }
    this.pending.push(record)
    this.startDrain()
    return { ok: true }
  }

  async whenSettled(): Promise<void> {
    // Already durable: nothing is waiting on the mount order.
  }

  async flush(): Promise<void> {
    // The in-flight drain first, then whatever it left behind. A single await
    // would miss records enqueued while the previous drain was finishing.
    while (this.draining !== undefined || this.pending.length > 0) {
      const inFlight = this.draining
      if (inFlight !== undefined) {
        await inFlight
        continue
      }
      this.startDrain()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Drain before releasing the unit; `domain.close()` also drains what it
    // already accepted, but a record still in our queue was never handed over.
    await this.flush()
    try {
      await this.domain.close()
    } catch (error: unknown) {
      this.storageFailures += 1
      this.onDrop(error instanceof Error ? error.message : String(error))
    }
  }

  /** Start a drain unless one is already running. Never rejects. */
  private startDrain(): void {
    if (this.draining !== undefined || this.closed) return
    this.draining = this.drain().finally(() => {
      this.draining = undefined
    })
  }

  /**
   * Write queued records in order until the queue is empty.
   *
   * A failing `put` is counted and skipped rather than retried: retrying a
   * record the medium keeps refusing would stall the queue behind it, and the
   * policy has already moved on. The caller reports the count.
   */
  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const record = this.pending.shift()
      if (record === undefined) return
      try {
        await this.table.put(auditRecordKey(record), record)
      } catch (error: unknown) {
        this.storageFailures += 1
        this.onDrop(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

/**
 * Refuses every record, and reports nothing itself.
 *
 * Used when the storage service is unavailable and, with `reason`, when the
 * domain could not be opened. Reporting is the gate's job: it already reacts to
 * the non-ok result, so a sink that also reported would count each drop twice.
 * This sink therefore stays inert and only supplies the reason.
 */
export class DroppedAuditSink implements AuditSink {
  private readonly reason: AuditDropReason
  private closed = false
  private dropped = 0

  constructor(reason: AuditDropReason) {
    this.reason = reason
  }

  /** Records this sink refused, for diagnostics and tests. */
  get droppedRecords(): number {
    return this.dropped
  }

  record(_record: SealedAuditRecord): AuditRecordResult {
    if (this.closed) return { ok: false, reason: 'closed' }
    this.dropped += 1
    return { ok: false, reason: this.reason }
  }

  async whenSettled(): Promise<void> {
    // Nothing is pending: every record was refused at `record()` time.
  }

  async flush(): Promise<void> {
    // Nothing is buffered: every record was refused at `record()` time.
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/**
 * Buffers records until a durable sink is available, then hands them over.
 *
 * The plugin mounts synchronously — Cordis does not accept an async `apply` —
 * while the optional storage service arrives later, once its own plugins
 * activate. This sink closes that gap: records made before storage exists are
 * held in order and forwarded, so no decision is lost to mount ordering. If no
 * durable sink ever arrives, `close()` reports every buffered record as dropped.
 */
export class HandoffAuditSink implements AuditSink {
  private readonly buffer: SealedAuditRecord[] = []
  private readonly onDrop: (error?: string) => void
  private readonly capacity: number
  private target: AuditSink | undefined
  private closed = false
  private dropped = 0
  private readonly settled: Promise<void>
  private markSettled: () => void = () => undefined

  constructor(onDrop: (error?: string) => void, capacity = MAX_PENDING) {
    this.onDrop = onDrop
    this.capacity = capacity
    this.settled = new Promise<void>(resolve => {
      this.markSettled = resolve
    })
  }

  /**
   * Resolve when the wait for storage ends.
   *
   * Either a durable sink takes over or `attach` never comes and `close`
   * abandons the buffer; both settle this, so a caller never waits on storage
   * that will not arrive.
   */
  whenSettled(): Promise<void> {
    return this.settled
  }

  /** Records still waiting for a durable sink. */
  get bufferedCount(): number {
    return this.buffer.length
  }

  /** Whether a real sink has taken over. */
  get attached(): boolean {
    return this.target !== undefined
  }

  /** Records released to a dropping target after the handoff. */
  get droppedRecords(): number {
    return this.dropped
  }

  /**
   * Stop waiting for storage and report every buffered record.
   *
   * Callers use this when the service had its chance to arrive and did not, so
   * the loss is surfaced at a known point instead of at teardown. Later records
   * are refused immediately, which is visible as a drop at `record()` time.
   */
  abandon(): void {
    if (this.target !== undefined || this.closed) return
    this.closed = true
    this.markSettled()
    const stranded = this.buffer.length
    this.buffer.length = 0
    for (let index = 0; index < stranded; index += 1) {
      this.dropped += 1
      this.onDrop('storage-unavailable')
    }
  }

  /**
   * Forward every buffered record to `sink` and route later ones to it.
   *
   * Called once, when the storage service resolves. Records already accepted
   * keep their order, so the audit reads the same either way.
   *
   * @param sink - the durable sink taking over.
   */
  attach(sink: AuditSink): void {
    if (this.target !== undefined || this.closed) return
    this.target = sink
    this.markSettled()
    while (this.buffer.length > 0) {
      const record = this.buffer.shift()
      if (record === undefined) break
      const result = sink.record(record)
      if (!result.ok) {
        this.dropped += 1
        this.onDrop(result.error ?? result.reason)
      }
    }
  }

  record(record: SealedAuditRecord): AuditRecordResult {
    if (this.closed) return { ok: false, reason: 'closed' }
    if (this.target !== undefined) return this.target.record(record)
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift()
      this.dropped += 1
      return { ok: false, reason: 'queue-overflow' }
    }
    this.buffer.push(record)
    return { ok: true }
  }

  async flush(): Promise<void> {
    if (this.target !== undefined) {
      await this.target.flush()
      return
    }
    // Nothing durable to flush into yet: the records stay buffered, and
    // `close()` is where they are reported as dropped if storage never comes.
  }

  async close(): Promise<void> {
    // `abandon` already reported anything stranded, so a closed handoff has
    // nothing left to release.
    if (!this.closed) this.abandon()
    if (this.target !== undefined) await this.target.close()
  }
}

/** What the audit sink resolved to at mount, plus the reason when it did not. */
export interface AuditSinkResolution {
  readonly sink: AuditSink
  /** True when a durable sink was opened. */
  readonly durable: boolean
  /** Why no durable sink exists; absent when one was opened. */
  readonly reason?: AuditDropReason
}

/**
 * Resolve the audit sink against the host's optional storage service.
 *
 * Resolution never throws: a host without `storageDomain`, a domain that fails
 * to open, or a backend misconfiguration all land on a {@link DroppedAuditSink}
 * so the policy keeps deciding. The gate registers disposal for whichever sink
 * comes back, which is why the failure path still returns a closable sink.
 *
 * @param ctx - the host context the plugin was mounted with.
 * @param report - drop reporter, called once per dropped record.
 * @returns the sink and whether it persists.
 */
export async function resolveAuditSink(
  ctx: Context,
  report: (reason: AuditDropReason, error?: string) => void,
): Promise<AuditSinkResolution> {
  const domain = storageDomainOf(ctx)
  if (domain === undefined) {
    return { sink: new DroppedAuditSink('storage-unavailable'), durable: false, reason: 'storage-unavailable' }
  }
  try {
    return { sink: await StorageAuditSink.open(domain, error => report('write-failed', error)), durable: true }
  } catch (error: unknown) {
    // A domain that will not open is a configuration fault, not a per-record
    // one, so it is reported here even though the sink itself stays silent.
    const message = error instanceof Error ? error.message : String(error)
    report('write-failed', message)
    return { sink: new DroppedAuditSink('write-failed'), durable: false, reason: 'write-failed' }
  }
}

/**
 * The `storageDomain` service, accepted structurally and only when it can open.
 *
 * Read with `ctx.get` rather than declared as an injection: the policy must work
 * on a host that mounts no storage, exactly as it works without
 * `sessionProjections`.
 *
 * @param ctx - the host context.
 * @returns the facility, or `undefined` when the host provides no usable one.
 */
export function storageDomainOf(ctx: Context): StorageDomainLike | undefined {
  const service = ctx.get('storageDomain' as never)
  if (typeof service !== 'object' || service === null) return undefined
  const open = (service as { open?: unknown }).open
  return typeof open === 'function' ? (service as unknown as StorageDomainLike) : undefined
}
