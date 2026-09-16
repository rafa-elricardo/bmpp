/**
 * Exhaustive unit coverage for the pure policy state machine.
 *
 * Every decision this file asserts requires no Cordis context, no Harness, no
 * MCP server and no clock: `decide()` is a function of explicit state and
 * explicit inputs, so the whole policy is provable here.
 *
 * The scenarios are numbered as in `docs/ARCHITECTURE.md` §15.2. The ones this
 * layer cannot own — anything that needs a real tool pipeline — are marked and
 * deferred to the L2/L3 suites.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import {
  DENY_REASON_CODES,
  OBSERVATION_CODES,
  REASON_CODES,
  ReasonCode,
  ObservationCode,
  reasonMessage,
} from '../../src/reason-codes.ts'
import {
  CLASSIFY_TOOL,
  decide,
  decisionContextFrom,
  enforcementFor,
  initialState,
  onRecallResult,
  onSessionStart,
  onTurnStart,
  type CallInput,
  type DecisionContext,
  type PolicySessionState,
} from '../../src/state.ts'

const SESSION = 'session-1'
const POLICY = '0.1.0'

/** A fresh machine with an optional turn already open. */
function machine(turns = 0): PolicySessionState {
  let state = initialState(SESSION, POLICY)
  for (let index = 0; index < turns; index += 1) state = onTurnStart(state)
  return state
}

const CONTEXT: DecisionContext = { sessionId: SESSION, policyVersion: POLICY }

const classify = (task: 'simple' | 'complex'): CallInput => ({ tool: CLASSIFY_TOOL, args: { task } })
const search = (phrasing = 'example topic'): CallInput => ({
  tool: 'mcp__basic-memory__search_notes',
  args: { query: phrasing },
})
const read = (identifier = 'Example Topic Decision'): CallInput => ({
  tool: 'mcp__basic-memory__read_note',
  args: { identifier },
})
const write = (filePath = 'Projects/Example/Example Project.md', overwrite = false): CallInput => ({
  tool: 'mcp__basic-memory__write_note',
  args: { title: 'Example Project', content: 'x', directory: 'Projects/Example', file_path: filePath, overwrite },
})
const edit = (filePath = 'Projects/Example/Example Project.md'): CallInput => ({
  tool: 'mcp__basic-memory__edit_note',
  args: { identifier: filePath, operation: 'append', content: 'y' },
})
const move = (): CallInput => ({ tool: 'mcp__basic-memory__move_note', args: { identifier: 'n', destination_path: 'archive/n.md' } })
const remove = (): CallInput => ({ tool: 'mcp__basic-memory__delete_note', args: { identifier: 'n' } })

/** Drive a sequence of calls through the machine, returning the final step. */
function run(
  state: PolicySessionState,
  calls: readonly CallInput[],
  context: DecisionContext = CONTEXT,
) {
  let current = state
  let last = decide(current, calls[0]!, context)
  current = last.state
  for (const call of calls.slice(1)) {
    last = decide(current, call, context)
    current = last.state
  }
  return last
}

/** A turn that has completed a successful recall: the gate is open. */
function complexWithRecall(outcome: 'ok' | 'empty' | 'failed' = 'ok'): PolicySessionState {
  const classified = decide(machine(), classify('complex'), CONTEXT).state
  const searching = decide(classified, search(), CONTEXT).state
  return onRecallResult(searching, outcome)
}

describe('initial state and resets', () => {
  it('starts unclassified, idle and empty', () => {
    const state = machine()
    expect(state.sessionId).toBe(SESSION)
    expect(state.policyVersion).toBe(POLICY)
    expect(state.turn.turnId).toBe(0)
    expect(state.turn.classification).toBe('unknown')
    expect(state.turn.recall).toEqual({
      state: 'idle', outcome: undefined, attempts: 0, lastTool: undefined, attempted: false,
    })
    expect(state.turn.calls).toEqual({ total: 0, blocked: 0 })
    expect(state.turn.writes).toEqual({})
    expect(state.turn.readNotes).toEqual([])
  })

  it('scenario 8 — turn/start resets classification and recall, so the gate re-closes', () => {
    const open = complexWithRecall('ok')
    expect(decide(open, edit(), CONTEXT).decision).toBe('allow')

    const nextTurn = onTurnStart(open)
    expect(nextTurn.turn.turnId).toBe(open.turn.turnId + 1)
    expect(nextTurn.turn.classification).toBe('unknown')
    expect(nextTurn.turn.recall.state).toBe('idle')
    expect(nextTurn.turn.recall.attempted).toBe(false)
    expect(nextTurn.turn.calls).toEqual({ total: 0, blocked: 0 })
    expect(nextTurn.turn.writes).toEqual({})
    expect(nextTurn.turn.readNotes).toEqual([])
    // The recall earned in the previous turn authorizes nothing now.
    expect(decide(nextTurn, edit(), CONTEXT).reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
  })

  it('scenario 9 — session start yields a fresh machine that inherits nothing', () => {
    const open = complexWithRecall('ok')
    const fresh = onSessionStart('session-2', POLICY)
    expect(fresh.sessionId).toBe('session-2')
    expect(fresh.turn.turnId).toBe(0)
    expect(fresh.turn.classification).toBe('unknown')
    expect(fresh.turn.recall.attempted).toBe(false)
    expect(open.turn.recall.state).toBe('succeeded')
    expect(decide(fresh, edit(), CONTEXT).reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
  })

  it('restart semantics — an unclassified machine blocks a write and permits a read', () => {
    const restarted = machine()
    expect(decide(restarted, search(), CONTEXT).decision).toBe('allow')
    expect(decide(restarted, edit(), CONTEXT).decision).toBe('deny')
  })
})

describe('scope: tools outside the memory namespace', () => {
  it('never govern bash, edit, write, terminal or filesystem tools', () => {
    for (const tool of ['bash', 'edit', 'write', 'terminal', 'read', 'glob', 'grep', 'read_image', 'present']) {
      const step = decide(machine(), { tool, args: {} }, CONTEXT)
      expect(step.decision).toBe('allow')
      expect(step.reasonCode).toBe(ReasonCode.ALLOW_OUT_OF_SCOPE)
      expect(step.event.toolClass).toBe('other')
      expect(step.event.policyState).toBe('OUT_OF_SCOPE')
    }
  })

  it('does not gate a tool that merely resembles a memory tool', () => {
    const step = decide(machine(), { tool: 'basic-memory__write_note' }, CONTEXT)
    expect(step.reasonCode).toBe(ReasonCode.ALLOW_OUT_OF_SCOPE)
  })
})

describe('reads are never gated', () => {
  it('permits every read-only memory tool on an unclassified turn', () => {
    const reads: CallInput[] = [
      search(), read(), { tool: 'mcp__basic-memory__search', args: {} },
      { tool: 'mcp__basic-memory__build_context', args: {} },
      { tool: 'mcp__basic-memory__recent_activity', args: {} },
      { tool: 'mcp__basic-memory__read_content', args: {} },
      { tool: 'mcp__basic-memory__view_note', args: {} },
      { tool: 'mcp__basic-memory__list_directory', args: {} },
    ]
    for (const call of reads) {
      expect(decide(machine(), call, CONTEXT).decision).toBe('allow')
    }
  })

  it('records a read that is not a search as read-only, not as recall', () => {
    const step = decide(machine(), read(), CONTEXT)
    expect(step.reasonCode).toBe(ReasonCode.ALLOW_READ_ONLY)
    expect(step.event.observation).toEqual({ code: ObservationCode.READ_ONLY_NOT_RECALL })
    expect(step.event.toolClass).toBe('memory.read')
    // A read does not start a recall, so the gate is still untouched.
    expect(step.state.turn.recall.attempted).toBe(false)
  })

  it('opens a recall when a configured search tool runs on a non-simple turn', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    const step = decide(complex, search(), CONTEXT)
    expect(step.reasonCode).toBe(ReasonCode.ALLOW_READ_ONLY)
    expect(step.state.turn.recall.state).toBe('in_flight')
    expect(step.state.turn.recall.attempted).toBe(true)
    expect(step.state.turn.recall.attempts).toBe(1)
    expect(step.state.turn.recall.lastTool).toBe('mcp__basic-memory__search_notes')
    expect(step.event.policyState).toBe('RECALL_IN_FLIGHT')
  })

  it('does not open a recall on a SIMPLE turn', () => {
    const simple = decide(machine(), classify('simple'), CONTEXT).state
    const step = decide(simple, search(), CONTEXT)
    expect(step.decision).toBe('allow')
    expect(step.state.turn.recall.attempted).toBe(false)
    expect(step.event.policyState).toBe('SIMPLE')
  })
})

describe('classification is an explicit act of the model', () => {
  it('always permits the control tool', () => {
    for (const args of [{ task: 'simple' }, { task: 'complex' }, {}, { task: 'nonsense' }]) {
      const step = decide(machine(), { tool: CLASSIFY_TOOL, args }, CONTEXT)
      expect(step.decision).toBe('allow')
      expect(step.reasonCode).toBe(ReasonCode.ALLOW_CONTROL)
      expect(step.event.toolClass).toBe('control')
    }
  })

  it('scenario 1 — SIMPLE releases memory mutations', () => {
    const simple = decide(machine(), classify('simple'), CONTEXT).state
    const step = decide(simple, write(), CONTEXT)
    expect(step.decision).toBe('allow')
    expect(step.reasonCode).toBe(ReasonCode.ALLOW_SIMPLE)
    expect(step.event.policyState).toBe('SIMPLE')
  })

  it('can arrive at any point in the turn, after other reads and calls', () => {
    const afterRead = decide(machine(), read(), CONTEXT).state
    const afterBash = decide(afterRead, { tool: 'bash', args: {} }, CONTEXT).state
    // Still unclassified, so a write is still refused...
    expect(decide(afterBash, edit(), CONTEXT).reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
    // ...and classifying late is just as valid as classifying first.
    const simple = decide(afterBash, classify('simple'), CONTEXT).state
    expect(decide(simple, edit(), CONTEXT).reasonCode).toBe(ReasonCode.ALLOW_SIMPLE)
  })

  it('scenario 22 — the latest classification wins, and reclassification is permitted', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    expect(decide(complex, edit(), CONTEXT).reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)

    const reclassified = decide(complex, classify('simple'), CONTEXT)
    expect(reclassified.decision).toBe('allow')
    expect(reclassified.event.observation).toEqual({ code: ObservationCode.RECLASSIFIED })
    expect(reclassified.state.turn.classification).toBe('simple')
    expect(decide(reclassified.state, edit(), CONTEXT).reasonCode).toBe(ReasonCode.ALLOW_SIMPLE)

    const backToComplex = decide(reclassified.state, classify('complex'), CONTEXT).state
    expect(decide(backToComplex, edit(), CONTEXT).reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)
  })

  it('does not claim a SIMPLE state when the declaration was unusable', () => {
    const step = decide(machine(), { tool: CLASSIFY_TOOL, args: {} }, CONTEXT)
    expect(step.decision).toBe('allow')
    expect(step.state.turn.classification).toBe('unknown')
    // The control tool is not "out of scope": it reports the turn it acts on.
    expect(step.event.policyState).toBe('UNKNOWN')
    expect(step.event.toolClass).toBe('control')
  })

  it('reports the recall-required state when a complex declaration opens the gate', () => {
    const step = decide(machine(), classify('complex'), CONTEXT)
    expect(step.event.policyState).toBe('RECALL_REQUIRED')
  })

  it('does not record a reclassification when the declaration is unchanged', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    const again = decide(complex, classify('complex'), CONTEXT)
    expect(again.event.observation).toBeUndefined()
  })

  it('never infers a classification from anything but the declaration', () => {
    // A turn that only ever ran reads and unrelated tools stays unknown.
    let state = machine()
    for (const call of [read(), search(), { tool: 'bash', args: {} }]) {
      state = decide(state, call, CONTEXT).state
    }
    expect(state.turn.classification).toBe('unknown')
    expect(decide(state, edit(), CONTEXT).reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
  })
})

describe('the recall gate on memory mutations', () => {
  it('scenario 3 — UNKNOWN blocks a memory mutation', () => {
    for (const call of [write(), edit(), move(), remove()]) {
      const step = decide(machine(), call, CONTEXT)
      expect(step.decision).toBe('deny')
      expect(step.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
      expect(step.event.policyState).toBe('UNKNOWN')
      expect(step.event.toolClass).toBe('memory.write')
    }
  })

  it('scenario 3 — UNKNOWN permits reads at the same time', () => {
    const state = machine()
    expect(decide(state, read(), CONTEXT).decision).toBe('allow')
    expect(decide(state, search(), CONTEXT).decision).toBe('allow')
  })

  it('COMPLEX with no lookup at all is denied as MEMORY_LOOKUP_REQUIRED', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    const step = decide(complex, edit(), CONTEXT)
    expect(step.decision).toBe('deny')
    expect(step.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)
    expect(step.event.policyState).toBe('RECALL_REQUIRED')
  })

  it('scenario 2 — COMPLEX with a successful lookup releases the mutation', () => {
    const step = decide(complexWithRecall('ok'), edit(), CONTEXT)
    expect(step.decision).toBe('allow')
    expect(step.reasonCode).toBe(ReasonCode.ALLOW_RECALL_OK)
    expect(step.event.policyState).toBe('RECALL_OK')
  })

  it('scenario 5 — an empty lookup still releases the mutation', () => {
    const step = decide(complexWithRecall('empty'), edit(), CONTEXT)
    expect(step.decision).toBe('allow')
    expect(step.reasonCode).toBe(ReasonCode.ALLOW_RECALL_OK)
    expect(step.event.observation).toEqual({ code: ObservationCode.RECALL_EMPTY })
    expect(step.state.turn.recall.outcome).toBe('empty')
  })

  it('scenario 4 — a failed lookup does not satisfy the gate, and a retry can', () => {
    const failed = complexWithRecall('failed')
    const denied = decide(failed, edit(), CONTEXT)
    expect(denied.decision).toBe('deny')
    expect(denied.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_FAILED)
    expect(denied.event.policyState).toBe('RECALL_FAILED')

    // Reading is still permitted while the gate is closed.
    expect(decide(failed, read(), CONTEXT).decision).toBe('allow')

    // A retry opens the recall again, and this time it succeeds.
    const retried = decide(failed, search('second phrasing'), CONTEXT).state
    expect(retried.turn.recall.state).toBe('in_flight')
    expect(retried.turn.recall.attempts).toBe(2)
    const recovered = onRecallResult(retried, 'ok')
    expect(decide(recovered, edit(), CONTEXT).reasonCode).toBe(ReasonCode.ALLOW_RECALL_OK)
  })

  it('scenario 6 — a repeated search is permitted and never regresses a success', () => {
    const succeeded = complexWithRecall('ok')
    const repeated = decide(succeeded, search('another phrasing'), CONTEXT)
    expect(repeated.decision).toBe('allow')
    expect(repeated.state.turn.recall.state).toBe('succeeded')
    expect(repeated.state.turn.recall.attempts).toBe(2)
    expect(decide(repeated.state, edit(), CONTEXT).reasonCode).toBe(ReasonCode.ALLOW_RECALL_OK)
  })

  it('scenario 10 — a lookup and a mutation in one batch is denied as PENDING_IN_BATCH', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    // Ordered pre-execute: the search runs first, so the write sees in_flight.
    const afterSearch = decide(complex, search(), CONTEXT)
    expect(afterSearch.decision).toBe('allow')
    const mutation = decide(afterSearch.state, write(), CONTEXT)
    expect(mutation.decision).toBe('deny')
    expect(mutation.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_PENDING_IN_BATCH)
    expect(mutation.event.policyState).toBe('RECALL_IN_FLIGHT')
  })

  it('scenario 10 — two reads in one batch are both permitted', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    const first = decide(complex, search(), CONTEXT)
    const second = decide(first.state, read(), CONTEXT)
    expect(first.decision).toBe('allow')
    expect(second.decision).toBe('allow')
  })

  it('scenario 7 — repeating a blocked call yields the identical denial', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    const first = decide(complex, edit(), CONTEXT)
    const second = decide(first.state, edit(), CONTEXT)
    expect(first.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)
    expect(second.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)
    expect(second.decision).toBe('deny')
    expect(second.event.policyState).toBe(first.event.policyState)
    expect(first.state.turn.calls.blocked).toBe(1)
    expect(second.state.turn.calls.blocked).toBe(2)
  })

  it('counts every evaluated call, whether it was blocked or allowed', () => {
    // The control call is evaluated too, so the turn's total includes it: the
    // counter describes the audit trail, not a subset somebody has to explain.
    const classified = decide(machine(), classify('complex'), CONTEXT)
    expect(classified.state.turn.calls).toEqual({ total: 1, blocked: 0 })

    const blocked = decide(classified.state, edit(), CONTEXT)
    expect(blocked.state.turn.calls).toEqual({ total: 2, blocked: 1 })

    // `complexWithRecall` already evaluated the control call and the search,
    // so the edit is the turn's third evaluated call.
    const proceeded = decide(complexWithRecall('ok'), edit(), CONTEXT)
    expect(proceeded.state.turn.calls).toEqual({ total: 3, blocked: 0 })
  })
})

describe('create and overwrite guards', () => {
  it('a new note without any lookup is denied as CREATE_REQUIRES_SEARCH', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    const step = decide(complex, write('Projects/Example/New Note.md', false), CONTEXT)
    expect(step.decision).toBe('deny')
    expect(step.reasonCode).toBe(ReasonCode.CREATE_REQUIRES_SEARCH)
  })

  it('an edit is denied as MEMORY_LOOKUP_REQUIRED, not as a create', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    expect(decide(complex, edit(), CONTEXT).reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)
    expect(decide(complex, move(), CONTEXT).reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)
  })

  it('does not raise the create guard when createRequiresSearch is disabled', () => {
    const context: DecisionContext = { ...CONTEXT, createRequiresSearch: false }
    const complex = decide(machine(), classify('complex'), context).state
    const step = decide(complex, write('x.md', false), context)
    expect(step.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)
  })

  it('an overwrite after a successful lookup but without reading is denied', () => {
    const step = decide(complexWithRecall('ok'), write('Projects/Example/Example Project.md', true), CONTEXT)
    expect(step.decision).toBe('deny')
    expect(step.reasonCode).toBe(ReasonCode.OVERWRITE_REQUIRES_READ)
  })

  it('an overwrite is permitted once that exact note was read in the turn', () => {
    const target = 'Projects/Example/Example Project.md'
    const readFirst = decide(complexWithRecall('ok'), read(target), CONTEXT)
    expect(readFirst.decision).toBe('allow')
    expect(readFirst.state.turn.readNotes).toEqual([target])
    const step = decide(readFirst.state, write(target, true), CONTEXT)
    expect(step.decision).toBe('allow')
    expect(step.reasonCode).toBe(ReasonCode.ALLOW_RECALL_OK)
  })

  it('reading a different note does not authorize the overwrite', () => {
    const withOtherRead = decide(complexWithRecall('ok'), read('Other Note'), CONTEXT).state
    const step = decide(withOtherRead, write('Projects/Example/Example Project.md', true), CONTEXT)
    expect(step.reasonCode).toBe(ReasonCode.OVERWRITE_REQUIRES_READ)
  })

  it('disables the overwrite guard when configured off', () => {
    const context: DecisionContext = { ...CONTEXT, overwriteRequiresRead: 'off' }
    const state = complexWithRecall('ok')
    const step = decide(state, write('target.md', true), context)
    expect(step.decision).toBe('allow')
  })

  it('records writes per tool and path, without touching note content', () => {
    const step = decide(complexWithRecall('ok'), write('a.md'), CONTEXT)
    expect(step.state.turn.writes).toEqual({ 'mcp__basic-memory__write_note\u0000a.md': 1 })
    const second = decide(step.state, write('a.md'), CONTEXT)
    expect(second.state.turn.writes).toEqual({ 'mcp__basic-memory__write_note\u0000a.md': 2 })
    expect(JSON.stringify(second.event)).not.toContain('content')
  })
})

describe('unknown memory tools fail closed', () => {
  it('scenario 19 — an unlisted tool inside the namespace is treated as a write', () => {
    const unclassified = decide(machine(), { tool: 'mcp__basic-memory__brand_new_tool', args: {} }, CONTEXT)
    expect(unclassified.decision).toBe('deny')
    expect(unclassified.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
    expect(unclassified.event.toolClass).toBe('memory.write')

    const complex = decide(machine(), classify('complex'), CONTEXT).state
    expect(decide(complex, { tool: 'mcp__basic-memory__brand_new_tool' }, CONTEXT).reasonCode)
      .toBe(ReasonCode.MEMORY_LOOKUP_REQUIRED)

    const afterRecall = decide(complexWithRecall('ok'), { tool: 'mcp__basic-memory__brand_new_tool' }, CONTEXT)
    expect(afterRecall.decision).toBe('allow')
    expect(afterRecall.reasonCode).toBe(ReasonCode.ALLOW_RECALL_OK)
  })

  it('never returns UNKNOWN_MEMORY_TOOL for a classified tool', () => {
    const step = decide(machine(), write(), CONTEXT)
    expect(step.reasonCode).not.toBe(ReasonCode.UNKNOWN_MEMORY_TOOL)
    // The code exists and is a denial, reserved for the guard layer to raise
    // when a caller distinguishes `known` explicitly.
    expect(DENY_REASON_CODES).toContain(ReasonCode.UNKNOWN_MEMORY_TOOL)
  })

  it('scenario 19 — malformed arguments are decided, never thrown on', () => {
    const hostile: unknown[] = [undefined, null, 'string', 42, [], { file_path: 7 }, { overwrite: 'yes' }]
    for (const args of hostile) {
      const calls: CallInput[] = [
        { tool: 'mcp__basic-memory__write_note', args },
        { tool: 'mcp__basic-memory__edit_note', args },
        { tool: 'mcp__basic-memory__read_note', args },
        { tool: 'mcp__basic-memory__search_notes', args },
      ]
      for (const call of calls) {
        expect(() => decide(machine(), call, CONTEXT)).not.toThrow()
        expect(decide(machine(), call, CONTEXT).decision).toBeTypeOf('string')
      }
    }
  })

  it('treats a non-boolean overwrite flag as not-an-overwrite', () => {
    const state = complexWithRecall('ok')
    const step = decide(state, { tool: 'mcp__basic-memory__write_note', args: { file_path: 'a.md', overwrite: 'yes' } }, CONTEXT)
    expect(step.decision).toBe('allow')
  })

  it('treats a write with no usable path as unremarkable', () => {
    const state = complexWithRecall('ok')
    const step = decide(state, { tool: 'mcp__basic-memory__write_note', args: { overwrite: true } }, CONTEXT)
    expect(step.decision).toBe('allow')
    expect(step.state.turn.writes).toEqual({ 'mcp__basic-memory__write_note\u0000<unknown>': 1 })
  })
})

describe('events carry the audit contract and no content', () => {
  it('stamps the documented fields on every decision', () => {
    const step = decide(machine(), edit(), CONTEXT)
    expect(step.event).toMatchObject({
      phase: 'pre-execute',
      tool: 'mcp__basic-memory__edit_note',
      toolClass: 'memory.write',
      policyState: 'UNKNOWN',
      decision: 'deny',
      reasonCode: ReasonCode.CLASSIFICATION_REQUIRED,
      classification: 'unknown',
      recallState: 'idle',
      policyVersion: POLICY,
      turnId: 0,
    })
  })

  it('carries the policy version from the decision context, not a constant', () => {
    const step = decide(machine(), edit(), { ...CONTEXT, policyVersion: '9.9.9' })
    expect(step.event.policyVersion).toBe('9.9.9')
  })

  it('never records tool arguments or note content', () => {
    const secret = 'content containing a SECRET-VALUE'
    const step = decide(complexWithRecall('ok'), {
      tool: 'mcp__basic-memory__write_note',
      args: { file_path: 'a.md', content: secret, title: 'T' },
    }, CONTEXT)
    const serialized = JSON.stringify(step.event)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('SECRET-VALUE')
    expect(Object.keys(step.event)).not.toContain('arguments')
    expect(Object.keys(step.event)).not.toContain('args')
  })

  it('reports the turn sequence, which advances only on turn/start', () => {
    const first = decide(machine(), edit(), CONTEXT)
    expect(first.event.turnId).toBe(0)
    const second = decide(onTurnStart(first.state), edit(), CONTEXT)
    expect(second.event.turnId).toBe(1)
  })
})

describe('scenario 22 — mode and profile apply to the verdict, never the reverse', () => {
  const denyCode = ReasonCode.MEMORY_LOOKUP_REQUIRED
  const allowCode = ReasonCode.ALLOW_RECALL_OK

  it('audit never denies and never asks, whatever the profile says', () => {
    for (const profile of ['compat', 'strict'] as const) {
      for (const destructive of [true, false]) {
        expect(enforcementFor(denyCode, 'audit', profile, destructive))
          .toEqual({ action: 'allow', auditOverride: true })
      }
    }
  })

  it('off allows without applying anything', () => {
    expect(enforcementFor(denyCode, 'off', 'strict', true)).toEqual({ action: 'allow', auditOverride: false })
  })

  it('enforce applies the denial in both profiles', () => {
    expect(enforcementFor(denyCode, 'enforce', 'compat', false)).toEqual({ action: 'deny', auditOverride: false })
    expect(enforcementFor(denyCode, 'enforce', 'strict', false)).toEqual({ action: 'deny', auditOverride: false })
  })

  it('scenario 24 — ask exists only for destructive tools under enforce + strict', () => {
    expect(enforcementFor(denyCode, 'enforce', 'strict', true)).toEqual({ action: 'ask', auditOverride: false })
    expect(enforcementFor(denyCode, 'enforce', 'compat', true)).toEqual({ action: 'deny', auditOverride: false })
    expect(enforcementFor(denyCode, 'audit', 'strict', true)).toEqual({ action: 'allow', auditOverride: true })
  })

  it('never denies an allowed verdict, in any mode or profile', () => {
    for (const mode of ['off', 'audit', 'enforce'] as const) {
      for (const profile of ['compat', 'strict'] as const) {
        expect(enforcementFor(allowCode, mode, profile, true).action).toBe('allow')
      }
    }
  })

  it('derives the policy verdict the same way for every mode', () => {
    const complex = decide(machine(), classify('complex'), CONTEXT).state
    const step = decide(complex, edit(), CONTEXT)
    // decide() has no mode parameter at all: the verdict cannot depend on it.
    expect(decide.length).toBe(3)
    expect(step.decision).toBe('deny')
    expect(enforcementFor(step.reasonCode, 'audit', 'strict', false).action).toBe('allow')
  })
})

describe('reason codes and messages', () => {
  it('exposes a closed vocabulary with no duplicates', () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length)
    expect(new Set(OBSERVATION_CODES).size).toBe(OBSERVATION_CODES.length)
    expect(REASON_CODES.length).toBeGreaterThanOrEqual(12)
  })

  it('uses the codes the architecture already named', () => {
    for (const code of [
      'CLASSIFICATION_REQUIRED', 'MEMORY_LOOKUP_REQUIRED', 'MEMORY_LOOKUP_FAILED',
      'MEMORY_LOOKUP_PENDING_IN_BATCH', 'CREATE_REQUIRES_SEARCH', 'OVERWRITE_REQUIRES_READ',
      'UNKNOWN_MEMORY_TOOL',
    ]) {
      expect(REASON_CODES).toContain(code)
      expect(DENY_REASON_CODES).toContain(code)
    }
  })

  it('does not claim codes that belong to the guard layer', () => {
    for (const foreign of ['SECRET_PATTERN_DETECTED', 'TEST_FIXTURE_LABEL_IN_PROJECT', 'POLICY_INTERNAL_ERROR']) {
      expect(REASON_CODES).not.toContain(foreign)
    }
  })

  it('splits denial codes from permitting codes exhaustively', () => {
    // Explicit, because a code's name is not a reliable classifier: both
    // `CREATE_REQUIRES_SEARCH` and `OVERWRITE_REQUIRES_READ` deny, yet neither
    // contains "REQUIRED".
    const expectedDenials = [
      ReasonCode.CLASSIFICATION_REQUIRED,
      ReasonCode.MEMORY_LOOKUP_REQUIRED,
      ReasonCode.MEMORY_LOOKUP_FAILED,
      ReasonCode.MEMORY_LOOKUP_PENDING_IN_BATCH,
      ReasonCode.CREATE_REQUIRES_SEARCH,
      ReasonCode.OVERWRITE_REQUIRES_READ,
      ReasonCode.UNKNOWN_MEMORY_TOOL,
    ]
    expect([...DENY_REASON_CODES].sort()).toEqual([...expectedDenials].sort())

    const permitting = REASON_CODES.filter(code => !DENY_REASON_CODES.includes(code))
    expect(permitting).toEqual([
      ReasonCode.ALLOW_SIMPLE,
      ReasonCode.ALLOW_READ_ONLY,
      ReasonCode.ALLOW_RECALL_OK,
      ReasonCode.ALLOW_CONTROL,
      ReasonCode.ALLOW_OUT_OF_SCOPE,
    ])
    expect(permitting.length + DENY_REASON_CODES.length).toBe(REASON_CODES.length)
  })

  it('gives every code an actionable message that leaks nothing', () => {
    for (const code of REASON_CODES) {
      const message = reasonMessage(code)
      expect(message.length).toBeGreaterThan(20)
      expect(message).not.toMatch(/\/home\/|\/Users\//)
      expect(message).not.toMatch(/at \w+ \(/) // no stack traces
    }
  })

  it('never mixes a reason code into the observation vocabulary', () => {
    for (const code of OBSERVATION_CODES) {
      expect(REASON_CODES).not.toContain(code)
    }
  })
})

describe('decision context derived from configuration', () => {
  it('maps the approved configuration onto decision inputs', () => {
    const context = decisionContextFrom(DEFAULT_CONFIG, SESSION)
    expect(context.policyVersion).toBe(DEFAULT_CONFIG.policyVersion)
    expect(context.readTools).toEqual(DEFAULT_CONFIG.readTools)
    expect(context.searchTools).toEqual(DEFAULT_CONFIG.searchTools)
    expect(context.mutatingTools).toEqual(DEFAULT_CONFIG.mutatingTools)
    expect(context.destructiveTools).toEqual(DEFAULT_CONFIG.destructiveTools)
    expect(context.createRequiresSearch).toBe(true)
    expect(context.overwriteRequiresRead).toBe('warn')
  })

  it('honours a custom tool classification', () => {
    const context: DecisionContext = {
      ...CONTEXT,
      searchTools: ['mcp__basic-memory__custom_search'],
      readTools: ['mcp__basic-memory__custom_search'],
    }
    let state = decide(machine(), { tool: CLASSIFY_TOOL, args: { task: 'complex' } }, context).state
    const custom = decide(state, { tool: 'mcp__basic-memory__custom_search' }, context)
    expect(custom.state.turn.recall.attempted).toBe(true)
    // The built-in search tool is no longer classified as a search at all.
    state = decide(machine(), { tool: CLASSIFY_TOOL, args: { task: 'complex' } }, context).state
    expect(decide(state, search(), context).state.turn.recall.attempted).toBe(false)
  })
})
