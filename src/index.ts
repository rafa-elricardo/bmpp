/**
 * BMPP — Basic Memory Policy Plugin.
 *
 * A native Cordis plugin for the DeepSeek Harness that turns the mechanically
 * checkable parts of the memory policy into invariants the runtime enforces,
 * while leaving every semantic judgement to the model.
 *
 * STATUS: the gate is mounted. This module validates its configuration, checks
 * its host surface, reports compatibility, and mounts the integration layer
 * (`./gate.ts`) that connects the pure policy machine to `tools/pre-execute`,
 * `tools/result` and the `bmpp__classify` control tool.
 *
 * Audit events (`bmpp/policy`) and the secondary guards are NOT part of this
 * increment; see `docs/ARCHITECTURE.md` §27 for the phase plan.
 *
 * Design: `docs/ARCHITECTURE.md`. Compatibility: `docs/COMPATIBILITY.md`.
 *
 * @module dsh-bmpp
 */

import type { Context } from '@deepseek-ai/cordis'
import { validateConfig, type BmppConfig } from './config.ts'
import { createGate, type BmppGate } from './gate.ts'
import {
  BMPP_VERSION,
  classifyHarnessVersion,
  detectHarnessVersion,
  describeCompatibility,
  type HarnessCompatibility,
} from './version.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bmpp'

/**
 * Hard dependency on the tool registry: the plugin is meaningless without the
 * seams it exists to police.
 */
export const inject = ['tools']

/**
 * ToolRuntime methods BMPP relies on.
 *
 * Declared as data so the load-time probe and its tests share one list. A
 * missing member means the host is not the shape this release was written
 * against, and the plugin refuses to load rather than mis-enforce.
 */
export const REQUIRED_TOOL_SERVICE_METHODS: readonly string[] = [
  'register',
  'get',
  'guard',
  'schemas',
  'executionMode',
]

/** What one BMPP load decided; also returned by {@link apply} for tests. */
export interface BmppLoadReport {
  readonly bmppVersion: string
  readonly policyVersion: string
  readonly mode: BmppConfig['mode']
  readonly profile: BmppConfig['profile']
  readonly harness: HarnessCompatibility
  readonly warnings: readonly string[]
  /**
   * The mounted gate, or `undefined` in `mode: 'off'`.
   *
   * Exposed so a test can read tracked state and drive the gate directly,
   * without reaching into module internals.
   */
  readonly gate: BmppGate | undefined
  /** Whether the host provides the `sessionProjections` service. */
  readonly hasSessionProjections: boolean
}

/**
 * Decide what to do about the detected Harness version.
 *
 * The verdict is a POLICY kept separate from detection, so both are testable
 * in isolation:
 *
 * - `compatible` and `unknown` — proceed. An undetectable version is normal
 *   under a packaged executable and must not block a working runtime.
 * - `too-old` / `too-new` / `unparsable` — refuse. BMPP binds to exact event
 *   names and result shapes; on an unverified Harness line it would silently
 *   mis-enforce, which is worse than not loading.
 *
 * @param harness - classification from {@link classifyHarnessVersion}.
 */
export function decideActivation(harness: HarnessCompatibility): 'activate' | 'refuse' {
  return harness.status === 'compatible' || harness.status === 'unknown' ? 'activate' : 'refuse'
}

/**
 * Verify the injected `tools` service exposes the surface BMPP programs against.
 *
 * A structural check, not a version check: it is what makes compatibility
 * claims falsifiable at load time instead of at first interception.
 *
 * @param tools - the injected service, as an unknown value from the context.
 * @returns the names of required members that are missing, empty when healthy.
 */
export function checkToolServiceSurface(tools: unknown): readonly string[] {
  if (typeof tools !== 'object' || tools === null) return [...REQUIRED_TOOL_SERVICE_METHODS]
  const record = tools as Record<string, unknown>
  return REQUIRED_TOOL_SERVICE_METHODS.filter(member => typeof record[member] !== 'function')
}

/**
 * Mount BMPP.
 *
 * @param ctx - Cordis context; `tools` is injected before this runs.
 * @param rawConfig - composition-supplied configuration, validated here.
 * @returns the load report, so a test can assert what the load decided.
 * @throws when the configuration is invalid, when the injected surface is
 *   incomplete, or when the Harness is outside the supported envelope. All
 *   three are deliberate fail-loud outcomes: a policy plugin that cannot trust
 *   its configuration or its host must not activate.
 */
export function apply(ctx: Context, rawConfig: unknown = {}): BmppLoadReport {
  const validation = validateConfig(rawConfig)
  if (!validation.ok) {
    const detail = validation.errors
      .map(error => `  - ${error.path === '' ? '<root>' : error.path}: ${error.message}`)
      .join('\n')
    throw new Error(`BMPP configuration rejected:\n${detail}`)
  }
  const config = validation.config

  const missing = checkToolServiceSurface(ctx.get('tools'))
  if (missing.length > 0) {
    throw new Error(
      `BMPP ${BMPP_VERSION} refused to load: the injected "tools" service is missing ${missing.join(', ')}`,
    )
  }

  const harness = classifyHarnessVersion(detectHarnessVersion())
  if (decideActivation(harness) === 'refuse') {
    throw new Error(`BMPP ${BMPP_VERSION} refused to load: ${describeCompatibility(harness)}`)
  }

  const hasSessionProjections = ctx.get('sessionProjections') !== undefined

  // `mode: 'off'` means off: nothing is registered and no decision is taken.
  const gate = config.mode === 'off' ? undefined : createGate({ ctx, config })

  // Warnings are collected before the report so the report is the complete
  // record of what this load decided, not a partial one.
  const warnings = [...validation.warnings]
  if (!hasSessionProjections) {
    warnings.push(
      'sessionProjections is unavailable, so turn numbers come from the gate counter; '
      + 'turn resets still work but lose the Harness turn number',
    )
  }

  const report: BmppLoadReport = {
    bmppVersion: BMPP_VERSION,
    policyVersion: config.policyVersion,
    mode: config.mode,
    profile: config.profile,
    harness,
    warnings,
    gate,
    hasSessionProjections,
  }

  ctx.logger?.info(
    'bmpp %s loaded (policy %s, mode %s, profile %s); %s; %s; %s',
    report.bmppVersion,
    report.policyVersion,
    report.mode,
    report.profile,
    describeCompatibility(harness),
    gate === undefined ? 'policy off, nothing registered' : 'gate mounted on tools/pre-execute + tools/result',
    hasSessionProjections ? 'turn boundary from sessionProjections' : 'turn boundary from the internal counter',
  )
  for (const warning of warnings) ctx.logger?.warn('bmpp: %s', warning)

  return report
}
