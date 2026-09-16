import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BMPP_VERSION,
  HARNESS_RANGE,
  POLICY_VERSION,
  VERIFIED_HARNESS_VERSIONS,
  classifyHarnessVersion,
  compareVersions,
  describeCompatibility,
  detectHarnessVersion,
  parseVersion,
} from '../../src/version.ts'
import {
  apply,
  checkToolServiceSurface,
  decideActivation,
  inject,
  name,
  REQUIRED_TOOL_SERVICE_METHODS,
} from '../../src/index.ts'

describe('version parsing', () => {
  it('parses release and prerelease forms', () => {
    expect(parseVersion('0.1.5')).toEqual({ major: 0, minor: 1, patch: 5, prerelease: [] })
    expect(parseVersion('0.1.5-rc.2')).toEqual({
      major: 0, minor: 1, patch: 5, prerelease: ['rc', 2],
    })
    expect(parseVersion('1.2.3-alpha.1.beta')).toEqual({
      major: 1, minor: 2, patch: 3, prerelease: ['alpha', 1, 'beta'],
    })
  })

  it('ignores build metadata and surrounding whitespace', () => {
    expect(parseVersion('  0.1.5+build.7 ')).toEqual({ major: 0, minor: 1, patch: 5, prerelease: [] })
  })

  it('rejects malformed versions', () => {
    for (const bad of ['', '1.2', 'v1.2.3', '1.2.3.4', 'latest', '0.1.x']) {
      expect(parseVersion(bad)).toBeUndefined()
    }
  })
})

describe('semver precedence', () => {
  const parse = (v: string) => parseVersion(v)!
  const cmp = (a: string, b: string) => Math.sign(compareVersions(parse(a), parse(b)))

  it('orders core versions', () => {
    expect(cmp('0.1.4', '0.1.5')).toBe(-1)
    expect(cmp('0.2.0', '0.1.9')).toBe(1)
    expect(cmp('1.0.0', '1.0.0')).toBe(0)
  })

  it('sorts a prerelease before its release', () => {
    expect(cmp('0.1.5-rc.2', '0.1.5')).toBe(-1)
    expect(cmp('0.1.5', '0.1.5-rc.2')).toBe(1)
  })

  it('compares numeric identifiers numerically', () => {
    expect(cmp('0.1.5-rc.2', '0.1.5-rc.10')).toBe(-1)
  })

  it('sorts numeric identifiers before alphanumeric ones', () => {
    expect(cmp('0.1.5-1', '0.1.5-alpha')).toBe(-1)
  })

  it('lets the longer prerelease list win when the prefix is equal', () => {
    expect(cmp('0.1.5-rc', '0.1.5-rc.1')).toBe(-1)
  })

  it('compares alphanumeric identifiers lexically', () => {
    expect(cmp('0.1.5-alpha', '0.1.5-beta')).toBe(-1)
  })
})

describe('compatibility envelope', () => {
  it('accepts the verified version and reports it as verified', () => {
    expect(classifyHarnessVersion('0.1.5-rc.2')).toEqual({
      status: 'compatible', version: '0.1.5-rc.2', verified: true,
    })
  })

  it('accepts an unverified version inside the envelope', () => {
    const verdict = classifyHarnessVersion('0.1.7')
    expect(verdict.status).toBe('compatible')
    if (verdict.status === 'compatible') expect(verdict.verified).toBe(false)
  })

  it('rejects a version below the floor, naming the floor', () => {
    expect(classifyHarnessVersion('0.1.4')).toEqual({
      status: 'too-old', version: '0.1.4', min: HARNESS_RANGE.min,
    })
    expect(classifyHarnessVersion('0.1.5-rc.1').status).toBe('too-old')
  })

  it('rejects a version at or beyond the ceiling', () => {
    expect(classifyHarnessVersion('0.2.0')).toEqual({
      status: 'too-new', version: '0.2.0', max: HARNESS_RANGE.max,
    })
    expect(classifyHarnessVersion('1.0.0').status).toBe('too-new')
  })

  it('treats a missing version as unknown rather than incompatible', () => {
    expect(classifyHarnessVersion(undefined)).toEqual({
      status: 'unknown', version: undefined, reason: 'version-not-detected',
    })
    expect(classifyHarnessVersion('   ').status).toBe('unknown')
  })

  it('reports an unparsable version distinctly', () => {
    expect(classifyHarnessVersion('nightly')).toEqual({ status: 'unparsable', version: 'nightly' })
  })

  it('lists the floor among the verified versions', () => {
    expect(VERIFIED_HARNESS_VERSIONS).toContain(HARNESS_RANGE.min)
  })
})

describe('activation policy', () => {
  it('activates on compatible and unknown', () => {
    expect(decideActivation(classifyHarnessVersion('0.1.5-rc.2'))).toBe('activate')
    expect(decideActivation(classifyHarnessVersion(undefined))).toBe('activate')
  })

  it('refuses on too-old, too-new and unparsable', () => {
    expect(decideActivation(classifyHarnessVersion('0.1.0'))).toBe('refuse')
    expect(decideActivation(classifyHarnessVersion('0.2.0'))).toBe('refuse')
    expect(decideActivation(classifyHarnessVersion('weird'))).toBe('refuse')
  })

  it('explains every verdict in one line', () => {
    for (const version of ['0.1.5-rc.2', '0.1.7', '0.1.0', '0.2.0', 'weird', undefined]) {
      const text = describeCompatibility(classifyHarnessVersion(version))
      expect(text.length).toBeGreaterThan(10)
    }
    expect(describeCompatibility(classifyHarnessVersion('0.1.5-rc.2'))).toContain('verified')
    expect(describeCompatibility(classifyHarnessVersion(undefined))).toContain('not detectable')
  })
})

describe('harness version detection', () => {
  /** Build a throwaway tree exposing one resolvable identity package. */
  function fixture(version: string | undefined, packageName = '@deepseek-ai/dsh-tools'): string {
    const root = mkdtempSync(join(tmpdir(), 'bmpp-detect-'))
    const packageDir = join(root, 'node_modules', ...packageName.split('/'))
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: version ?? '0.0.0',
        exports: { './package.json': './package.json', '.': './index.js' },
      }),
    )
    writeFileSync(join(packageDir, 'index.js'), 'export const x = 1\n')
    return pathToFileURL(join(root, 'probe.js')).href
  }

  it('reads the version of the identity package it resolves against', () => {
    expect(detectHarnessVersion(fixture('0.1.5-rc.2'))).toBe('0.1.5-rc.2')
  })

  it('returns undefined instead of throwing when nothing resolves', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmpp-empty-'))
    expect(detectHarnessVersion(pathToFileURL(join(root, 'probe.js')).href)).toBeUndefined()
  })

  it('ignores a manifest without a usable version', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmpp-bad-'))
    const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'x', exports: { '.': './index.js' } }))
    expect(detectHarnessVersion(pathToFileURL(join(root, 'probe.js')).href)).toBeUndefined()
  })

  it('tolerates an unreadable manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmpp-broken-'))
    const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), '{ not json')
    expect(detectHarnessVersion(pathToFileURL(join(root, 'probe.js')).href)).toBeUndefined()
  })
})

describe('tool service surface probe', () => {
  it('accepts a service exposing every required method', () => {
    const complete = Object.fromEntries(REQUIRED_TOOL_SERVICE_METHODS.map(m => [m, () => undefined]))
    expect(checkToolServiceSurface(complete)).toEqual([])
  })

  it('names every missing member', () => {
    expect(checkToolServiceSurface({ register: () => undefined }))
      .toEqual(REQUIRED_TOOL_SERVICE_METHODS.filter(m => m !== 'register'))
  })

  it('rejects a non-object or a value that is not a function', () => {
    expect(checkToolServiceSurface(undefined)).toEqual([...REQUIRED_TOOL_SERVICE_METHODS])
    expect(checkToolServiceSurface(null)).toEqual([...REQUIRED_TOOL_SERVICE_METHODS])
    expect(checkToolServiceSurface({ ...Object.fromEntries(REQUIRED_TOOL_SERVICE_METHODS.map(m => [m, () => undefined])), guard: 1 }))
      .toEqual(['guard'])
  })
})

/** Minimal Cordis-shaped context; `apply` only uses `get` and `logger`. */
function context(tools: unknown, warnings: string[] = []) {
  return {
    get: () => tools,
    logger: {
      info: () => undefined,
      warn: (message: string) => warnings.push(message),
    },
  } as unknown as Parameters<typeof apply>[0]
}

const completeTools = Object.fromEntries(
  REQUIRED_TOOL_SERVICE_METHODS.map(m => [m, () => undefined]),
)

describe('plugin entry point', () => {
  it('declares its Cordis identity', () => {
    expect(name).toBe('bmpp')
    expect(inject).toEqual(['tools'])
  })

  it('loads with the approved defaults and reports what it decided', () => {
    const warnings: string[] = []
    const report = apply(context(completeTools, warnings))
    expect(report.mode).toBe('audit')
    expect(report.profile).toBe('compat')
    expect(report.bmppVersion).toBe(BMPP_VERSION)
    expect(report.policyVersion).toBe(POLICY_VERSION)
    expect(report.warnings.length).toBeGreaterThan(0)
  })

  it('reports the detected harness verdict without refusing inside the envelope', () => {
    const report = apply(context(completeTools))
    expect(['compatible', 'unknown']).toContain(report.harness.status)
  })

  it('refuses an invalid configuration, naming the offending keys', () => {
    expect(() => apply(context(completeTools), { mode: 'maybe' })).toThrow(/configuration rejected/)
    expect(() => apply(context(completeTools), { strict: true })).toThrow(/AMBIGUOUS_MODE|not a BMPP option/)
    expect(() => apply(context(completeTools), { mode: 'maybe' })).toThrow(/mode/)
  })

  it('refuses when the injected tools service lacks a required member', () => {
    const partial = { register: () => undefined }
    expect(() => apply(context(partial))).toThrow(/missing get, guard, schemas, executionMode/)
  })

  it('logs the load and every configuration warning', () => {
    const warnings: string[] = []
    apply(context(completeTools, warnings), { mode: 'off', profile: 'strict' })
    expect(warnings.length).toBe(2)
  })
})

describe('package manifest agreement', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    version?: string
    dsh?: { compatibility?: { harness?: string; verified?: string[] } }
  }

  it('keeps the package version in step with the code', () => {
    expect(manifest.version).toBe(BMPP_VERSION)
  })

  it('keeps the declared verified list in step with the code', () => {
    expect(manifest.dsh?.compatibility?.verified).toEqual([...VERIFIED_HARNESS_VERSIONS])
  })
})
