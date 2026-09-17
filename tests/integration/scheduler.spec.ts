/**
 * Proof of the REAL DSH scheduler semantics the BMPP gate relies on.
 *
 * Every ordering claim below is produced by the installed Harness agent loop and
 * tool runtime, and synchronized with explicit barriers — no sleeps and no
 * timing guesses. Bodies are held open until the test releases them, so "was the
 * write judged before the search finished?" has a definite answer rather than a
 * race.
 *
 * ## The authoritative signal
 *
 * The primary evidence is the **`bmpp/policy` event the gate itself writes into
 * the session log**: it records, durably and in order, what the gate saw when it
 * judged each call. A synthetic listener is secondary evidence only, because a
 * call that is denied never dispatches a body and its listener observation is
 * not guaranteed to be meaningful.
 *
 * ## A note on instrumentation
 *
 * The synthetic PRE/BODY/RESULT listener is useful for the ALLOWED path, where it
 * records the interleaving of running bodies. It is NOT reliable for a DENIED
 * call: a denied call is never dispatched, and in the measurements here its
 * `tools/pre-execute` observation does not appear at all. That is why every
 * denial assertion reads the gate's durable `bmpp/policy` event instead of the
 * synthetic timeline.
 *
 * ## What is proven, and what is NOT assumed
 *
 * Proven:
 *   1. a search and a write in ONE batch: the write is judged while the recall
 *      is still `in_flight` and denied with `MEMORY_LOOKUP_PENDING_IN_BATCH`;
 *   2. the write's body never runs, and the search completes normally;
 *   3. a denial becomes an error result and does NOT abort the group;
 *   4. results commit in MODEL order, not completion order;
 *   5. the same holds when the group exceeds `maxParallelToolCalls`.
 *
 * NOT assumed: that every `tools/pre-execute` in a group completes before any
 * body starts. `packages/core/agent-loop/src/tool-calls.ts` shows `startCall`
 * preparing one call and dispatching it before the next call is prepared, so
 * pre-execute and body execution interleave. Nothing here depends on the
 * stronger, false assumption.
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  batchResponse,
  hasBodyEntered,
  hasBodyExited,
  mountHarness,
  tool,
  waitFor,
  type TimelineEntry,
} from './scheduler-harness.ts'

const SEARCH = 'mcp__basic-memory__search_notes'
const READ = 'mcp__basic-memory__read_note'
const WRITE = 'mcp__basic-memory__write_note'

const CLASSIFY = 'bmpp__classify'

/**
 * The model's classification step.
 *
 * BMPP denies a memory mutation on an UNCLASSIFIED turn with
 * `CLASSIFICATION_REQUIRED`; the recall gate only becomes relevant once the
 * model has declared the turn COMPLEX. Classification is per Harness turn, so a
 * scenario that expects a recall-related reason code must classify in the SAME
 * turn as its batch — that is what `run([classifyStep(), batch])` below does.
 */
function classifyStep(): StreamChunk[] {
  return batchResponse([{ id: 'k', name: CLASSIFY, args: { task: 'complex' } }])
}

/** Render a timeline compactly for reports and failure messages. */
const show = (entries: readonly TimelineEntry[]): string =>
  entries.map(entry => `${entry.phase}:${entry.tool.split('__').pop() ?? entry.tool}`).join(' | ')

/** The gate's judged events, in durable order. */
function decisions(events: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return events.filter(event => event['kind'] === 'pre-execute')
}

/** The judged event for one tool. */
function decisionFor(
  events: readonly Record<string, unknown>[],
  toolName: string,
): Record<string, unknown> | undefined {
  return decisions(events).find(event => String(event['tool']) === toolName)
}

describe('1. a search and a write in ONE batch', () => {
  /**
   * Observed timeline (measured):
   *
   *   PRE:classify | RESULT:classify
   *     | PRE:search_notes | BODY-enter:search_notes | BODY-exit:search_notes
   *     | RESULT:search_notes | RESULT:write_note
   *
   * The write is never dispatched, so it has no PRE and no BODY at all: BMPP
   * judged it and denied it while the search had already started. Its result is
   * committed last, in model order.
   */
  it('judges the write while the recall is in flight and denies it as PENDING_IN_BATCH', async () => {
    const harness = await mountHarness({ tools: [tool(WRITE, { hold: true })] })
    harness.register(tool(SEARCH, { hold: true }))

    const running = harness.run([
      classifyStep(),
      batchResponse([
        { id: 's', name: SEARCH, args: { query: 'example query' } },
        { id: 'w', name: WRITE, args: { title: 'T', directory: 'Projects' } },
      ]),
    ])

    // Wait until the write has actually been judged, holding the search open.
    await waitFor(harness, h => decisionFor(h.policyEvents(), WRITE) !== undefined,
      "the write's policy decision")

    const events = harness.policyEvents()
    const searchEvent = decisionFor(events, SEARCH)
    const writeEvent = decisionFor(events, WRITE)

    // The search was allowed and opened a recall; the write was judged in the
    // same turn while that recall had not yet settled.
    expect(searchEvent?.['decision']).toBe('allow')
    expect(searchEvent?.['reasonCode']).toBe('ALLOW_READ_ONLY')
    expect(searchEvent?.['recallState']).toBe('in_flight')

    expect(writeEvent?.['decision']).toBe('deny')
    expect(writeEvent?.['reasonCode']).toBe('MEMORY_LOOKUP_PENDING_IN_BATCH')
    expect(writeEvent?.['recallState']).toBe('in_flight')
    expect(writeEvent?.['enforcement']).toBe('denied')

    // The write's body never ran, and no result existed for it at that moment.
    expect(hasBodyEntered(harness, WRITE)).toBe(false)

    // Let the open search finish so the turn can settle, and release the write
    // too: a barrier left closed would hang the turn rather than fail the test.
    harness.release(SEARCH)
    harness.release(WRITE)
    await running

    // The search completed normally and its result settled the recall.
    expect(hasBodyExited(harness, SEARCH)).toBe(true)
    expect(hasBodyEntered(harness, WRITE)).toBe(false)

    const recall = harness.policyEvents().find(event => event['kind'] === 'recall')
    expect(recall?.['tool']).toBe(SEARCH)
    expect(recall?.['recallOutcome']).toBe('ok')
    expect(recall?.['recallState']).toBe('succeeded')

    // The durable log shows the search's result arriving after the decision that
    // denied the write: the ordering the gate observed is the durable ordering.
    // The classification step contributed its own result first; the batch's
    // results follow in model order.
    const results = harness.toolResults()
    expect(results.map(result => result.callId)).toEqual(['k', 's', 'w'])
    const batchResults = results.slice(1)
    expect(batchResults.map(result => result.isError)).toEqual([false, true])
    expect(batchResults[1]?.text).toContain('same batch')
  })
})

describe('2. a denial does not abort the group', () => {
  /**
   * Observed timeline (measured):
   *
   *   RESULT:write_note
   *     | PRE:read_note  | BODY-enter:read_note | BODY-exit:read_note
   *     | PRE:bash       | BODY-enter:bash       | BODY-exit:bash
   *     | RESULT:read_note | RESULT:bash
   *
   * The denial is materialized first (it has no body), and the two remaining
   * calls run to completion in the SAME group.
   */
  it('continues the eligible calls and turns the denied one into an error result', async () => {
    const harness = await mountHarness({
      tools: [tool(READ, { hold: true }), tool(WRITE), tool('bash', { hold: true })],
    })

    // The turn is never classified, so the memory write is denied while the
    // memory read and the out-of-scope tool are left alone.
    const running = harness.run([batchResponse([
      { id: 'w', name: WRITE, args: { title: 'T' } },
      { id: 'r', name: READ, args: { identifier: 'n' } },
      { id: 'o', name: 'bash', args: {} },
    ])])
    // Release the two bodies that are meant to run.
    harness.release(READ)
    harness.release('bash')
    await running

    const events = harness.policyEvents()
    // The turn was never classified, so the classification precondition is what
    // refuses the write.
    expect(decisionFor(events, WRITE)?.['decision']).toBe('deny')
    expect(decisionFor(events, WRITE)?.['reasonCode']).toBe('CLASSIFICATION_REQUIRED')
    expect(decisionFor(events, READ)?.['decision']).toBe('allow')
    expect(decisionFor(events, 'bash')?.['reasonCode']).toBe('ALLOW_OUT_OF_SCOPE')

    // The denied call never ran its body; the other two did.
    expect(hasBodyEntered(harness, WRITE)).toBe(false)
    expect(hasBodyExited(harness, READ)).toBe(true)
    expect(hasBodyExited(harness, 'bash')).toBe(true)

    // Exactly one error result, for the denied call, in model order.
    const results = harness.toolResults()
    expect(results.map(result => result.callId)).toEqual(['w', 'r', 'o'])
    expect(results.map(result => result.isError)).toEqual([true, false, false])
    expect(results[0]?.text).toContain('bmpp__classify')
  })
})

describe('3. results commit in MODEL order, not completion order', () => {
  /**
   * Observed timeline (measured), with `slow` held open:
   *
   *   PRE:slow | BODY-enter:slow | PRE:fast | BODY-enter:fast | BODY-exit:fast
   *     … no RESULT yet …
   *   after releasing `slow`:
   *   BODY-exit:slow | RESULT:slow | RESULT:fast
   *
   * `fast` finished first; its result was still committed second.
   */
  it('records the slow first call before the fast second call', async () => {
    const harness = await mountHarness({
      tools: [tool('slow', { hold: true }), tool('fast', { hold: true })],
    })

    const running = harness.run([batchResponse([
      { id: 'a', name: 'slow', args: {} },
      { id: 'b', name: 'fast', args: {} },
    ])])

    // The SECOND call runs and finishes while the first is still held open.
    harness.release('fast')
    await waitFor(harness, h => hasBodyExited(h, 'fast'), 'the fast call to finish')
    expect(hasBodyExited(harness, 'slow')).toBe(false)
    // Nothing was committed yet, because commit order follows the model and the
    // first call has not settled.
    expect(harness.toolResults()).toHaveLength(0)

    harness.release('slow')
    await running

    const results = harness.toolResults()
    expect(results.map(result => result.callId)).toEqual(['a', 'b'])
    expect(results.every(result => result.isError)).toBe(false)

    // The fast body exited BEFORE the slow body, yet its result was committed
    // AFTER the slow call's: that is model-order commit, observed directly.
    const timeline = harness.timeline()
    const fastExit = timeline.findIndex(e => e.phase === 'BODY-exit' && e.tool === 'fast')
    const slowExit = timeline.findIndex(e => e.phase === 'BODY-exit' && e.tool === 'slow')
    const firstResult = timeline.findIndex(e => e.phase === 'RESULT')
    expect(fastExit).toBeGreaterThanOrEqual(0)
    expect(fastExit, `fast did not finish first: ${show(timeline)}`).toBeLessThan(slowExit)
    expect(slowExit, `the first result preceded the slow body's exit: ${show(timeline)}`).toBeLessThan(firstResult)
    expect(timeline[firstResult]?.tool).toBe('slow')
  })
})

describe('4. a group that crosses the parallel pool boundary', () => {
  it('still denies a search+write batch as PENDING_IN_BATCH with more than ten calls', async () => {
    const READS = 11
    const harness = await mountHarness({ tools: [tool(READ)] })
    harness.register(tool(SEARCH, { hold: true }))
    harness.register(tool(WRITE, { hold: true }))

    const calls = [
      { id: 's', name: SEARCH, args: { query: 'example query' } },
      ...Array.from({ length: READS }, (_, index) => ({
        id: `r${index}`, name: READ, args: { identifier: `n${index}` },
      })),
      { id: 'w', name: WRITE, args: { title: 'T', directory: 'Projects' } },
    ]
    // 13 calls in one assistant message: comfortably past the default pool of 10.
    expect(calls).toHaveLength(13)

    const running = harness.run([classifyStep(), batchResponse(calls)])

    // Let the fast reads drain so the pool advances into its second wave, while
    // the search stays open and the recall therefore stays unresolved.
    harness.release(READ)
    await waitFor(harness, h => decisionFor(h.policyEvents(), WRITE) !== undefined,
      "the write's policy decision in the large batch")

    const events = harness.policyEvents()
    const writeEvent = decisionFor(events, WRITE)
    expect(writeEvent?.['reasonCode']).toBe('MEMORY_LOOKUP_PENDING_IN_BATCH')
    expect(writeEvent?.['recallState']).toBe('in_flight')
    expect(writeEvent?.['decision']).toBe('deny')
    expect(hasBodyEntered(harness, WRITE)).toBe(false)

    // The reads that had already been judged all came before the write, so the
    // batch really did span more calls than the pool holds at once.
    const judgedTools = decisions(events).map(event => String(event['tool']))
    const readsBeforeWrite = judgedTools.filter(tool => tool === READ).length
    expect(readsBeforeWrite).toBeGreaterThanOrEqual(1)
    expect(judgedTools.at(-1)).toBe(WRITE)

    harness.release(SEARCH)
    await running

    // The search finally settled, and the write still never ran.
    expect(hasBodyExited(harness, SEARCH)).toBe(true)
    expect(hasBodyEntered(harness, WRITE)).toBe(false)
    const recall = harness.policyEvents().find(event => event['kind'] === 'recall')
    expect(recall?.['recallOutcome']).toBe('ok')
  })

  /**
   * Observed judgement order (measured) for `[classify]` then ten reads + a write:
   *
   *   classify > read_note ×10 > write_note
   *
   * All eleven judged calls keep model order even though the write lands in the
   * second wave of a pool that holds ten at once, and all eleven results are
   * committed — the group is not aborted by the denial.
   */
  it('judges every call of an eleven-call batch in model order across the pool', async () => {
    const harness = await mountHarness({ tools: [tool(READ), tool(WRITE)] })

    // Exactly the pool size of reads, then the write: the write lands in the
    // second wave of the same group.
    const calls = [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `r${index}`, name: READ, args: { identifier: `n${index}` },
      })),
      { id: 'w', name: WRITE, args: { title: 'T' } },
    ]
    const running = harness.run([classifyStep(), batchResponse(calls)])
    harness.release(READ)
    await running

    const events = harness.policyEvents()
    const judged = decisions(events)
      .filter(event => String(event['tool']) !== CLASSIFY)
      .map(event => String(event['tool']).split('__').pop())
    // Every call was judged, in model order, including the one past the pool.
    expect(judged).toEqual([
      'read_note', 'read_note', 'read_note', 'read_note', 'read_note', 'read_note',
      'read_note', 'read_note', 'read_note', 'read_note', 'write_note',
    ])

    // Eleven batch results plus the classification step's own result.
    const results = harness.toolResults()
    expect(results).toHaveLength(12)
    expect(results[0]?.callId).toBe('k')
    const batchResults = results.slice(1)
    expect(batchResults).toHaveLength(11)
    // Ten reads allowed and one write denied: the group was not aborted.
    expect(batchResults.filter(result => result.isError)).toHaveLength(1)
    expect(batchResults[10]?.isError).toBe(true)
    // COMPLEX, no lookup in this batch, and `write_note` creating a note: the
    // create guard is the code that applies — still a denial, but a more
    // specific reason than the unclassified case.
    expect(decisionFor(events, WRITE)?.['reasonCode']).toBe('CREATE_REQUIRES_SEARCH')
    expect(decisionFor(events, WRITE)?.['decision']).toBe('deny')
  })
})
