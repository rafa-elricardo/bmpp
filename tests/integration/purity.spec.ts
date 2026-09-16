/**
 * Structural guarantee for increment 1a: the pure policy modules must not
 * depend on any runtime.
 *
 * This is an architectural constraint, not a style preference. The decision
 * logic is only trustworthy because it is a function of explicit state and
 * explicit inputs: if it could reach a Cordis context, a Harness service or an
 * MCP client, it could start depending on ambient state and stop being provable
 * in isolation.
 *
 * The check reads the EMITTED JavaScript, because that is what actually runs.
 * `import type` is erased by the compiler, which is exactly why this assertion
 * is meaningful: a leaked type import passes, a leaked value import fails.
 *
 * Requires `pnpm run build` to have run since the last source change.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PURE_MODULES = ['state', 'reason-codes'] as const
const BUILD_OUTPUT = new URL('../../lib/', import.meta.url)

/** Every module specifier a CommonJS or ESM module imports or requires. */
function importsOf(source: string): readonly string[] {
  const specifiers: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) specifiers.push(specifier)
    }
  }
  return specifiers
}

describe('the pure policy modules stay pure', () => {
  it('has a build to inspect', () => {
    const built = fileURLToPath(new URL('state.js', BUILD_OUTPUT))
    if (!existsSync(built)) {
      throw new Error('run `pnpm run build` before this suite: lib/state.js is missing')
    }
    expect(existsSync(fileURLToPath(new URL('reason-codes.js', BUILD_OUTPUT)))).toBe(true)
  })

  for (const moduleName of PURE_MODULES) {
    it(`${moduleName}.js imports only relative siblings, if it imports anything`, () => {
      const source = readFileSync(fileURLToPath(new URL(`${moduleName}.js`, BUILD_OUTPUT)), 'utf8')
      // Zero imports is the strongest possible result: `reason-codes.js` is a
      // leaf module.
      for (const specifier of importsOf(source)) {
        expect(specifier.startsWith('./') || specifier.startsWith('../')).toBe(true)
      }
    })

    it(`${moduleName}.js imports nothing from the Harness or Cordis`, () => {
      const source = readFileSync(fileURLToPath(new URL(`${moduleName}.js`, BUILD_OUTPUT)), 'utf8')
      const foreign = importsOf(source).filter(specifier =>
        specifier.startsWith('@deepseek-ai/')
        || specifier.startsWith('@modelcontextprotocol/')
        || specifier.includes('cordis'))
      expect(foreign).toEqual([])
    })

    it(`${moduleName}.js touches no Node builtin`, () => {
      const source = readFileSync(fileURLToPath(new URL(`${moduleName}.js`, BUILD_OUTPUT)), 'utf8')
      const builtins = importsOf(source).filter(specifier => specifier.startsWith('node:'))
      // No clock, no filesystem, no environment: the decision cannot depend on
      // anything but its arguments.
      expect(builtins).toEqual([])
    })
  }
})

describe('the policy module surface is closed', () => {
  it('exposes decide, enforcementFor and the state helpers from state.js', async () => {
    const state = await import('../../src/state.ts')
    for (const name of [
      'decide', 'enforcementFor', 'initialState', 'onSessionStart', 'onTurnStart',
      'onRecallResult', 'decisionContextFrom', 'messageFor', 'CLASSIFY_TOOL',
    ] as const) {
      expect(typeof (state as Record<string, unknown>)[name]).not.toBe('undefined')
    }
  })

  it('exposes the reason-code vocabulary from reason-codes.js', async () => {
    const codes = await import('../../src/reason-codes.ts')
    expect(typeof codes.ReasonCode).toBe('object')
    expect(typeof codes.reasonMessage).toBe('function')
    expect(codes.REASON_CODES.length).toBe(Object.keys(codes.ReasonCode).length)
  })
})
