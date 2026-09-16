import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  DEFAULT_MUTATING_TOOLS,
  DEFAULT_READ_TOOLS,
  DEFAULT_SEARCH_TOOLS,
  MEMORY_NAMESPACE,
  PROFILE_INVARIANT_OPTIONS,
  PROFILE_VARIANT_OPTIONS,
  STRICT_PROFILE_OVERRIDES,
  resolveProfile,
  validateConfig,
} from '../../src/config.ts'

function firstError(raw: unknown): string {
  const result = validateConfig(raw)
  if (result.ok) throw new Error(`expected rejection, got ${JSON.stringify(result.config)}`)
  return result.errors[0]!.code
}

describe('approved defaults', () => {
  it('observes rather than imposes, at every level', () => {
    expect(DEFAULT_CONFIG.mode).toBe('audit')
    expect(DEFAULT_CONFIG.profile).toBe('compat')
    expect(DEFAULT_CONFIG.overwriteRequiresRead).toBe('warn')
    expect(DEFAULT_CONFIG.secretPatternGuard).toBe('warn')
    expect(DEFAULT_CONFIG.testFixtureGuard).toBe('warn')
  })

  it('keeps an unclassified turn on the conservative path', () => {
    expect(DEFAULT_CONFIG.onMissingClassification).toBe('treat_complex')
    expect(DEFAULT_CONFIG.unknownMemoryToolPolicy).toBe('deny')
    expect(DEFAULT_CONFIG.createRequiresSearch).toBe(true)
    expect(DEFAULT_CONFIG.duplicateWriteGuard).toBe(true)
  })

  it('classifies only memory-namespace tools, and reads recent_activity as non-search', () => {
    for (const tool of [...DEFAULT_READ_TOOLS, ...DEFAULT_MUTATING_TOOLS]) {
      expect(tool.startsWith(MEMORY_NAMESPACE)).toBe(true)
    }
    expect(DEFAULT_SEARCH_TOOLS).not.toContain(`${MEMORY_NAMESPACE}recent_activity`)
    expect(DEFAULT_READ_TOOLS).toContain(`${MEMORY_NAMESPACE}recent_activity`)
  })

  it('an empty configuration resolves to the approved defaults', () => {
    const result = validateConfig({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config).toEqual(DEFAULT_CONFIG)
  })
})

describe('mode', () => {
  it('accepts exactly the three modes', () => {
    for (const mode of ['off', 'audit', 'enforce'] as const) {
      const result = validateConfig({ mode })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.config.mode).toBe(mode)
    }
  })

  it('rejects anything else', () => {
    expect(firstError({ mode: 'yes' })).toBe('INVALID_ENUM')
    expect(firstError({ mode: true })).toBe('INVALID_ENUM')
    expect(firstError({ mode: 'Enforce' })).toBe('INVALID_ENUM')
  })
})

describe('profile', () => {
  it('accepts exactly the two profiles', () => {
    for (const profile of ['compat', 'strict'] as const) {
      const result = validateConfig({ profile })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.config.profile).toBe(profile)
    }
  })

  it('rejects anything else', () => {
    expect(firstError({ profile: 'hard' })).toBe('INVALID_ENUM')
  })

  it('never changes mode, in either direction', () => {
    for (const mode of ['off', 'audit', 'enforce'] as const) {
      for (const profile of ['compat', 'strict'] as const) {
        const result = validateConfig({ mode, profile })
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.config.mode).toBe(mode)
          expect(result.config.profile).toBe(profile)
        }
      }
    }
  })

  it('applies strict overrides without inventing authority over mode', () => {
    expect(resolveProfile('strict', {}).mode).toBeUndefined()
    expect(resolveProfile('strict', { mode: 'audit' }).mode).toBe('audit')
    expect(resolveProfile('compat', { mode: 'audit' })).toEqual({ mode: 'audit' })
  })
})

describe('what strict changes', () => {
  it('raises exactly the three documented guards to deny', () => {
    expect(STRICT_PROFILE_OVERRIDES).toEqual({
      overwriteRequiresRead: 'deny',
      secretPatternGuard: 'deny',
      testFixtureGuard: 'deny',
    })
  })

  it('leaves every profile-invariant option untouched', () => {
    const compat = validateConfig({ profile: 'compat' })
    const strict = validateConfig({ profile: 'strict' })
    expect(compat.ok && strict.ok).toBe(true)
    if (!compat.ok || !strict.ok) return
    for (const option of PROFILE_INVARIANT_OPTIONS) {
      expect(strict.config[option]).toEqual(compat.config[option])
    }
  })

  it('describes the two option sets as disjoint and complete for the rigor fields', () => {
    expect(PROFILE_VARIANT_OPTIONS).toEqual([
      'overwriteRequiresRead',
      'secretPatternGuard',
      'testFixtureGuard',
    ])
    for (const option of PROFILE_VARIANT_OPTIONS) {
      expect(PROFILE_INVARIANT_OPTIONS).not.toContain(option)
    }
    expect(PROFILE_INVARIANT_OPTIONS).toContain('createRequiresSearch')
    expect(PROFILE_INVARIANT_OPTIONS).toContain('duplicateWriteGuard')
    expect(PROFILE_INVARIANT_OPTIONS).toContain('onMissingClassification')
    expect(PROFILE_INVARIANT_OPTIONS).toContain('unknownMemoryToolPolicy')
  })

  it('lets an explicit caller value win over the profile default', () => {
    const result = validateConfig({ profile: 'strict', secretPatternGuard: 'warn' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.secretPatternGuard).toBe('warn')
      expect(result.config.testFixtureGuard).toBe('deny')
      expect(result.config.overwriteRequiresRead).toBe('deny')
    }
  })
})

describe('ambiguous or duplicated configuration', () => {
  it('rejects a second mechanism for the same thing', () => {
    expect(firstError({ strict: true })).toBe('AMBIGUOUS_MODE')
    expect(firstError({ gateScope: ['bash'] })).toBe('AMBIGUOUS_MODE')
    expect(firstError({ preset: 'strict' })).toBe('AMBIGUOUS_MODE')
  })

  it('rejects unknown keys instead of ignoring typos', () => {
    expect(firstError({ profiles: 'strict' })).toBe('UNKNOWN_KEY')
    expect(firstError({ mod: 'audit' })).toBe('UNKNOWN_KEY')
  })

  it('refuses to loosen the unclassified-turn path', () => {
    expect(firstError({ onMissingClassification: 'allow' })).toBe('INVALID_ENUM')
    expect(validateConfig({ onMissingClassification: 'treat_complex' }).ok).toBe(true)
  })

  it('rejects non-object configuration outright', () => {
    const result = validateConfig('audit')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.code).toBe('NOT_AN_OBJECT')
    }
    expect(validateConfig(null).ok).toBe(false)
    expect(validateConfig([]).ok).toBe(false)
  })
})

describe('per-key validation', () => {
  it('checks guard levels', () => {
    expect(validateConfig({ secretPatternGuard: 'off' }).ok).toBe(true)
    expect(validateConfig({ secretPatternGuard: 'deny' }).ok).toBe(true)
    expect(firstError({ secretPatternGuard: 'block' })).toBe('INVALID_ENUM')
    expect(firstError({ overwriteRequiresRead: 'yes' })).toBe('INVALID_ENUM')
    expect(firstError({ testFixtureGuard: 1 })).toBe('INVALID_ENUM')
    expect(firstError({ unknownMemoryToolPolicy: 'fail' })).toBe('INVALID_ENUM')
  })

  it('checks audit and redaction enums', () => {
    expect(validateConfig({ auditLevel: 'verbose' }).ok).toBe(true)
    expect(firstError({ auditLevel: 'all' })).toBe('INVALID_ENUM')
    expect(validateConfig({ pathRedaction: 'hash' }).ok).toBe(true)
    expect(firstError({ pathRedaction: 'mask' })).toBe('INVALID_ENUM')
  })

  it('checks booleans, numbers and strings', () => {
    expect(firstError({ testMode: 'true' })).toBe('INVALID_TYPE')
    expect(firstError({ createRequiresSearch: 1 })).toBe('INVALID_TYPE')
    expect(firstError({ duplicateWriteGuard: null })).toBe('INVALID_TYPE')
    expect(validateConfig({ maxPathChars: 1 }).ok).toBe(true)
    expect(firstError({ maxPathChars: 0 })).toBe('INVALID_NUMBER')
    expect(firstError({ maxPathChars: 12.5 })).toBe('INVALID_NUMBER')
    expect(firstError({ policyVersion: '' })).toBe('INVALID_LENGTH')
    expect(firstError({ policyVersion: 2 })).toBe('INVALID_LENGTH')
  })

  it('checks string arrays', () => {
    expect(validateConfig({ testFixtureAllowedPrefixes: ['tests/'] }).ok).toBe(true)
    expect(firstError({ testFixtureAllowedPrefixes: 'tests/' })).toBe('INVALID_TYPE')
    expect(firstError({ searchTools: ['search_notes', 7] })).toBe('INVALID_TYPE')
  })

  it('reports every problem at once rather than the first', () => {
    const result = validateConfig({ mode: 'maybe', profile: 'hard', maxPathChars: -1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('warnings', () => {
  it('flags tools outside the memory namespace without rejecting them', () => {
    const result = validateConfig({ searchTools: ['bash', `${MEMORY_NAMESPACE}search_notes`] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some(warning => warning.includes('searchTools'))).toBe(true)
  })

  it('states plainly that audit never denies', () => {
    const result = validateConfig({ mode: 'audit' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some(warning => warning.includes('never denies'))).toBe(true)
  })

  it('explains that off ignores a strict profile', () => {
    const result = validateConfig({ mode: 'off', profile: 'strict' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some(warning => warning.includes('ignores profile'))).toBe(true)
  })

  it('notes that off emits no audit events', () => {
    const result = validateConfig({ mode: 'off' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some(warning => warning.includes('auditLevel has no effect'))).toBe(true)
  })

  it('is silent for the approved default', () => {
    const result = validateConfig({ mode: 'audit', profile: 'compat' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toHaveLength(1)
  })
})

describe('package manifest agreement', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    dsh?: { compatibility?: { harness?: string } }
  }

  it('declares the same envelope the code enforces', async () => {
    const { HARNESS_RANGE } = await import('../../src/version.ts')
    expect(manifest.dsh?.compatibility?.harness)
      .toBe(`>=${HARNESS_RANGE.min} <${HARNESS_RANGE.max}`)
  })
})
