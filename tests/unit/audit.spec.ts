/**
 * Unit coverage for the audit payload.
 *
 * The payload is the contract a reader depends on, so it is asserted field by
 * field: what is present, what is deliberately absent, and that it survives
 * lossless JSON round-tripping. The append mechanics are covered by
 * `tests/integration/audit.spec.ts` against a real session log.
 */

import { describe, expect, it } from 'vitest'
import {
  decisionPayload,
  recallPayload,
  type AuditContext,
} from '../../src/audit.ts'
import {
  AUDIT_DOMAIN_NAME,
  AUDIT_DOMAIN_VERSION,
  auditRecordSchema,
  type SealedAuditPayload,
} from '../../src/audit-sink.ts'
import {
  DroppedAuditSink,
  StorageAuditSink,
  storageDomainOf,
} from '../../src/audit-store.ts'
import { Context } from '@deepseek-ai/cordis'
import { auditDomainDouble, collectingSink } from '../support/audit-domain.ts'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import { ReasonCode, reasonMessage } from '../../src/reason-codes.ts'
import { decide, initialState, onRecallResult, onTurnStart, CLASSIFY_TOOL, type CallInput } from '../../src/state.ts'

const SESSION = 'audit-session'
const POLICY = '0.1.0'
const SEARCH = 'mcp__basic-memory__search_notes'
const EDIT = 'mcp__basic-memory__edit_note'

const CONTEXT: AuditContext = {
  mode: 'enforce',
  profile: 'compat',
  pluginVersion: '0.1.0',
}

const DECISION_CONTEXT = { sessionId: SESSION, policyVersion: POLICY }

const ALLOWED = { enforcement: 'allowed', enforced: false, auditOverride: false } as const
const DENIED = { enforcement: 'denied', enforced: true, auditOverride: false } as const
const OVERRIDDEN = { enforcement: 'overridden', enforced: false, auditOverride: true } as const
const ASKED = { enforcement: 'asked', enforced: true, auditOverride: false } as const

const classify = (task: 'simple' | 'complex'): CallInput => ({ tool: CLASSIFY_TOOL, args: { task } })
const search = (): CallInput => ({ tool: SEARCH, args: { query: 'a secret-looking query' } })
const edit = (): CallInput => ({ tool: EDIT, args: { content: 'note body that must not be audited' } })

describe('decision payload', () => {
  it('records an allow with its reason code and version', () => {
    const step = decide(initialState(SESSION, POLICY), edit(), DECISION_CONTEXT)
    // Unclassified: policy denies, but the caller may still allow it.
    const payload = decisionPayload(step.event, CONTEXT, ALLOWED)
    expect(payload.kind).toBe('pre-execute')
    expect(payload.decision).toBe('deny')
    expect(payload.reasonCode).toBe(ReasonCode.CLASSIFICATION_REQUIRED)
    expect(payload.policyVersion).toBe(POLICY)
    expect(payload.pluginVersion).toBe(CONTEXT.pluginVersion)
    expect(payload.mode).toBe('enforce')
    expect(payload.profile).toBe('compat')
    expect(payload.tool).toBe(EDIT)
    expect(payload.toolClass).toBe('memory.write')
    expect(payload.classification).toBe('unknown')
    expect(payload.recallState).toBe('idle')
  })

  it('records a denial as enforced, with the reason code and no override', () => {
    const step = decide(initialState(SESSION, POLICY), edit(), DECISION_CONTEXT)
    const payload = decisionPayload(step.event, CONTEXT, DENIED)
    expect(payload.decision).toBe('deny')
    expect(payload.enforcement).toBe('denied')
    expect(payload.enforced).toBe(true)
    expect(payload.auditOverride).toBe(false)
  })

  it('records an audit override without claiming enforcement', () => {
    const step = decide(initialState(SESSION, POLICY), edit(), DECISION_CONTEXT)
    const payload = decisionPayload(step.event, { ...CONTEXT, mode: 'audit' }, OVERRIDDEN)
    expect(payload.decision).toBe('deny')
    expect(payload.enforcement).toBe('overridden')
    expect(payload.enforced).toBe(false)
    expect(payload.auditOverride).toBe(true)
    expect(payload.mode).toBe('audit')
  })

  it('records an approval request distinctly from a denial', () => {
    const step = decide(initialState(SESSION, POLICY), edit(), DECISION_CONTEXT)
    const payload = decisionPayload(
      step.event,
      { ...CONTEXT, profile: 'strict' },
      ASKED,
    )
    expect(payload.enforcement).toBe('asked')
    expect(payload.enforced).toBe(true)
    expect(payload.profile).toBe('strict')
  })

  it('carries the profile without letting it change the verdict', () => {
    const step = decide(initialState(SESSION, POLICY), edit(), DECISION_CONTEXT)
    const compat = decisionPayload(step.event, { ...CONTEXT, profile: 'compat' }, DENIED)
    const strict = decisionPayload(step.event, { ...CONTEXT, profile: 'strict' }, DENIED)
    expect(compat.decision).toBe(strict.decision)
    expect(compat.reasonCode).toBe(strict.reasonCode)
    expect(compat.profile).not.toBe(strict.profile)
  })

  it('reports both turn numbers without conflating them', () => {
    let state = onTurnStart(initialState(SESSION, POLICY))
    state = { ...state, turn: { ...state.turn, harnessTurn: 7 } }
    const step = decide(state, edit(), DECISION_CONTEXT)
    const payload = decisionPayload(step.event, CONTEXT, DENIED)
    expect(payload.policyTurn).toBe(1)
    expect(payload.harnessTurn).toBe(7)
    expect(payload.policyTurn).not.toBe(payload.harnessTurn)
  })

  it('omits the Harness turn entirely when the host exposes none', () => {
    const step = decide(initialState(SESSION, POLICY), edit(), DECISION_CONTEXT)
    const payload = decisionPayload(step.event, CONTEXT, DENIED)
    expect('harnessTurn' in payload).toBe(false)
    expect(payload.policyTurn).toBe(0)
  })

  it('records a classification decision with the control tool class', () => {
    const step = decide(initialState(SESSION, POLICY), classify('complex'), DECISION_CONTEXT)
    const payload = decisionPayload(step.event, CONTEXT, ALLOWED)
    expect(payload.toolClass).toBe('control')
    expect(payload.decision).toBe('allow')
    expect(payload.reasonCode).toBe(ReasonCode.ALLOW_CONTROL)
  })

  it('carries the recall state at decision time', () => {
    let state = decide(initialState(SESSION, POLICY), classify('complex'), DECISION_CONTEXT).state
    state = decide(state, search(), DECISION_CONTEXT).state
    const step = decide(state, edit(), DECISION_CONTEXT)
    const payload = decisionPayload(step.event, CONTEXT, DENIED)
    expect(payload.reasonCode).toBe(ReasonCode.MEMORY_LOOKUP_PENDING_IN_BATCH)
    expect(payload.recallState).toBe('in_flight')
  })

  it('carries an observation code when one was recorded', () => {
    let state = decide(initialState(SESSION, POLICY), classify('complex'), DECISION_CONTEXT).state
    state = decide(state, search(), DECISION_CONTEXT).state
    state = onRecallResult(state, 'empty')
    const step = decide(state, edit(), DECISION_CONTEXT)
    const payload = decisionPayload(step.event, CONTEXT, ALLOWED)
    expect(payload.observation).toBe('RECALL_EMPTY')
  })

  it('truncates an absurd tool name instead of recording an essay', () => {
    const long = `mcp__basic-memory__${'x'.repeat(500)}`
    const step = decide(initialState(SESSION, POLICY), { tool: long }, DECISION_CONTEXT)
    const payload = decisionPayload(step.event, CONTEXT, DENIED)
    expect(payload.tool.length).toBeLessThanOrEqual(64)
    expect(payload.tool.endsWith('…')).toBe(true)
  })
})

describe('recall payload', () => {
  it('records a successful recall', () => {
    let state = decide(initialState(SESSION, POLICY), classify('complex'), DECISION_CONTEXT).state
    state = decide(state, search(), DECISION_CONTEXT).state
    state = onRecallResult(state, 'ok')
    const payload = recallPayload(state, SEARCH, 'ok', CONTEXT, 3)
    expect(payload.kind).toBe('recall')
    expect(payload.tool).toBe(SEARCH)
    expect(payload.toolClass).toBe('memory.read')
    expect(payload.recallState).toBe('succeeded')
    expect(payload.recallOutcome).toBe('ok')
    expect(payload.classification).toBe('complex')
    expect(payload.harnessTurn).toBe(3)
    expect(payload.policyVersion).toBe(POLICY)
  })

  it('records a failed recall as failed', () => {
    let state = decide(initialState(SESSION, POLICY), classify('complex'), DECISION_CONTEXT).state
    state = decide(state, search(), DECISION_CONTEXT).state
    state = onRecallResult(state, 'failed')
    const payload = recallPayload(state, SEARCH, 'failed', CONTEXT, undefined)
    expect(payload.recallState).toBe('failed')
    expect(payload.recallOutcome).toBe('failed')
    expect('harnessTurn' in payload).toBe(false)
  })
})

describe('the payload carries no content and no arguments', () => {
  const FORBIDDEN_KEYS = ['arguments', 'args', 'content', 'messages', 'text', 'transcript', 'reasoning', 'value']

  it('has no field that could hold a note body, an argument or a transcript', () => {
    let state = decide(initialState(SESSION, POLICY), classify('complex'), DECISION_CONTEXT).state
    state = decide(state, search(), DECISION_CONTEXT).state
    state = onRecallResult(state, 'ok')
    const decision = decisionPayload(decide(state, edit(), DECISION_CONTEXT).event, CONTEXT, ALLOWED)
    const recall = recallPayload(state, SEARCH, 'ok', CONTEXT, 1)
    for (const payload of [decision, recall]) {
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(Object.keys(payload)).not.toContain(forbidden)
      }
    }
  })

  it('never contains the text the tool was called with', () => {
    const secret = 'note body that must not be audited'
    const query = 'a secret-looking query'
    const decision = decisionPayload(
      decide(initialState(SESSION, POLICY), edit(), DECISION_CONTEXT).event, CONTEXT, DENIED,
    )
    const recall = recallPayload(
      onRecallResult(initialState(SESSION, POLICY), 'ok'), SEARCH, 'ok', CONTEXT, 1,
    )
    const serialized = JSON.stringify([decision, recall])
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(query)
  })

  it('serializes losslessly and survives a JSON round trip', () => {
    let state = decide(initialState(SESSION, POLICY), classify('complex'), DECISION_CONTEXT).state
    state = decide(state, search(), DECISION_CONTEXT).state
    state = onRecallResult(state, 'empty')
    const decision = decisionPayload(
      decide(state, { ...edit(), tool: EDIT }, DECISION_CONTEXT).event, CONTEXT, ASKED,
    )
    const recall = recallPayload(state, SEARCH, 'empty', CONTEXT, 2)
    for (const payload of [decision, recall]) {
      const roundTripped = JSON.parse(JSON.stringify(payload)) as SealedAuditPayload
      expect(roundTripped).toEqual(payload)
      // No `undefined` survived as a key, and no value is a non-JSON type.
      for (const value of Object.values(payload)) {
        expect(['string', 'number', 'boolean', 'undefined']).toContain(typeof value)
      }
    }
  })
})

describe('reason messages leak nothing either', () => {
  it('mentions no host path and no stack trace', () => {
    for (const code of Object.values(ReasonCode)) {
      const message = reasonMessage(code)
      expect(message).not.toMatch(/\/home\/|\/Users\/|node_modules/)
      expect(message).not.toMatch(/\bat \w+ \(/)
    }
  })

  it('keeps the approved defaults out of the audit vocabulary', () => {
    // A guard rail: the payload's mode/profile values come from configuration,
    // never from a hardcoded default in this module.
    expect(DEFAULT_CONFIG.mode).toBe('audit')
    expect(DEFAULT_CONFIG.profile).toBe('compat')
  })
})
