/**
 * BMPP version and DSH compatibility envelope.
 *
 * BMPP versions independently of the DeepSeek Harness. The two version lines
 * are related only by an explicit, declared envelope — never by equality.
 *
 * @module dsh-bmpp/version
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/** BMPP's own package version (kept in step with `package.json`). */
export const BMPP_VERSION = '0.1.0'

/** Version of the POLICY this release implements; stamped on every audit event. */
export const POLICY_VERSION = '0.1.0'

/**
 * Supported DeepSeek Harness range, `[min, max)`.
 *
 * `0.x` makes every minor bump potentially breaking, so the envelope is
 * deliberately narrow: it covers only the Harness line this plugin has actually
 * been exercised against.
 */
export const HARNESS_RANGE = {
  min: '0.1.5-rc.2',
  max: '0.2.0',
} as const

/** Harness versions this exact BMPP release has been verified against. */
export const VERIFIED_HARNESS_VERSIONS: readonly string[] = ['0.1.5-rc.2']

/**
 * Package whose manifest names the Harness application.
 *
 * This is the canonical product identity: `apps/cli/src/bin.ts` reads this same
 * manifest, by this same relative hop from its own module, to print `dsh --version`.
 */
const HARNESS_APP_PACKAGE = '@deepseek-ai/dsh'

/**
 * Packages the fallback reads when the application manifest is unreachable.
 *
 * They are Harness runtime packages, so an installed copy answers for the
 * Harness that installed it. A plugin's own pinned copy of one of these — which
 * is exactly what the primary read exists to avoid — is never consulted while a
 * Harness application manifest is in reach.
 */
const HARNESS_IDENTITY_PACKAGES: readonly string[] = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm']

/** Outcome of comparing a Harness version against {@link HARNESS_RANGE}. */
export type HarnessCompatibility =
  | { readonly status: 'compatible'; readonly version: string; readonly verified: boolean }
  | { readonly status: 'unknown'; readonly version: undefined; readonly reason: 'version-not-detected' }
  | { readonly status: 'too-old'; readonly version: string; readonly min: string }
  | { readonly status: 'too-new'; readonly version: string; readonly max: string }
  | { readonly status: 'unparsable'; readonly version: string }

/** Parsed semver core plus prerelease identifiers, or `undefined` when invalid. */
interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Prerelease identifiers, or an empty array for a release version. */
  readonly prerelease: readonly (string | number)[]
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse `major.minor.patch[-prerelease]`, ignoring build metadata. */
export function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER.exec(version.trim())
  if (match === null) return undefined
  const prerelease = match[4] === undefined
    ? []
    : match[4].split('.').map(identifier => /^\d+$/.test(identifier) ? Number(identifier) : identifier)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

/**
 * Compare two parsed versions by semver precedence.
 *
 * A prerelease sorts BEFORE its release (`0.1.5-rc.2 < 0.1.5`). Identifier
 * comparison follows semver: numeric identifiers compare numerically and sort
 * before alphanumeric ones, which compare lexically.
 *
 * @returns a negative number, zero, or a positive number.
 */
export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  const leftPre = left.prerelease
  const rightPre = right.prerelease
  if (leftPre.length === 0 && rightPre.length === 0) return 0
  // A release outranks any prerelease of the same core version.
  if (leftPre.length === 0) return 1
  if (rightPre.length === 0) return -1
  const length = Math.max(leftPre.length, rightPre.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftPre[index]
    const b = rightPre[index]
    // A shorter prerelease list wins when every preceding identifier is equal.
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = typeof a === 'number'
    const bNumeric = typeof b === 'number'
    if (aNumeric && bNumeric) return a - b
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  return 0
}

/**
 * Resolve the module URL of the running Harness application entry point.
 *
 * The entry point is the only version anchor that belongs to the host rather
 * than to the plugin: `process.argv[1]` is what the launcher actually executed,
 * and the shipped CLI, the Python SDK runtime and the desktop host all pass a
 * file inside the Harness installation.
 *
 * @param entry - diagnostic override as a `file:` URL or an absolute path;
 *   `undefined` resolves the live process entry.
 * @returns the entry URL, or `undefined` when no usable one exists.
 */
function harnessEntryUrl(entry?: string): string | undefined {
  if (entry === undefined) {
    const entryPath = process.argv[1]
    return typeof entryPath === 'string' && isAbsolute(entryPath) ? pathToFileURL(entryPath).href : undefined
  }
  if (typeof entry !== 'string' || entry.length === 0) return undefined
  if (entry.startsWith('file:')) return entry
  return isAbsolute(entry) ? pathToFileURL(entry).href : undefined
}

/**
 * Read the version from the Harness application manifest, one directory above
 * the entry point.
 *
 * `@deepseek-ai/dsh` declares no `exports`, so it has no importable
 * `package.json` subpath and must be read as a file. The manifest's own `name`
 * is checked, so a launcher that is not the Harness can never contribute a
 * version here.
 *
 * @param entryUrl - module URL of the Harness entry point.
 * @returns the declared version, or `undefined` when this is not the Harness app.
 */
function versionFromAppManifest(entryUrl: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', entryUrl), 'utf8'))
    if (typeof manifest !== 'object' || manifest === null) return undefined
    if ((manifest as { name?: unknown }).name !== HARNESS_APP_PACKAGE) return undefined
    const version = (manifest as { version?: unknown }).version
    return typeof version === 'string' && version.length > 0 ? version : undefined
  } catch {
    // A missing, unreadable or malformed manifest is "not detectable this way".
    return undefined
  }
}

/**
 * Best-effort detection of the RUNNING Harness version.
 *
 * The Harness exposes no version service on the Cordis context (verified
 * against 0.1.5-rc.2 and 0.1.6-alpha.1), so the version is read from the
 * application that is hosting this plugin. Anchoring on the entry point matters:
 * resolving from this module instead would read BMPP's OWN pinned copy of a
 * Harness package and report the development dependency as the host version.
 *
 * The application manifest is authoritative, and the identity packages are only
 * a fallback for a launcher that runs the Harness without publishing its app
 * manifest. Every step is guarded: detection failure returns `undefined` and is
 * never fatal.
 *
 * @param entryUrl - Harness entry point as a `file:` URL or an absolute path;
 *   defaults to the running process entry.
 * @returns the detected version, or `undefined` when undetectable.
 */
export function detectHarnessVersion(entryUrl?: string): string | undefined {
  const entry = harnessEntryUrl(entryUrl)
  if (entry === undefined) return undefined

  const declared = versionFromAppManifest(entry)
  if (declared !== undefined) return declared

  let require: NodeJS.Require
  try {
    require = createRequire(entry)
  } catch {
    return undefined
  }
  for (const packageName of HARNESS_IDENTITY_PACKAGES) {
    try {
      const manifestPath = require.resolve(`${packageName}/package.json`)
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest === 'object' && manifest !== null) {
        const version = (manifest as { version?: unknown }).version
        if (typeof version === 'string' && version.length > 0) return version
      }
    } catch {
      // Fall through to the next candidate; an unresolvable identity package
      // simply means "not detectable this way".
    }
  }
  return undefined
}

/**
 * Classify a detected Harness version against {@link HARNESS_RANGE}.
 *
 * A pure decision: it never logs, never throws (except on a malformed local
 * constant) and never loads Harness code. The caller decides what to do.
 *
 * @param detected - Harness version string, or `undefined` when not detectable.
 */
export function classifyHarnessVersion(detected: string | undefined): HarnessCompatibility {
  if (detected === undefined || detected.trim() === '') {
    return { status: 'unknown', version: undefined, reason: 'version-not-detected' }
  }
  const parsed = parseVersion(detected)
  if (parsed === undefined) return { status: 'unparsable', version: detected }

  const min = parseVersion(HARNESS_RANGE.min)
  const max = parseVersion(HARNESS_RANGE.max)
  if (min === undefined || max === undefined) {
    // A malformed local constant is a build defect, not a caller error.
    throw new Error('BMPP: HARNESS_RANGE contains an unparsable version')
  }
  if (compareVersions(parsed, min) < 0) {
    return { status: 'too-old', version: detected, min: HARNESS_RANGE.min }
  }
  if (compareVersions(parsed, max) >= 0) {
    return { status: 'too-new', version: detected, max: HARNESS_RANGE.max }
  }
  return {
    status: 'compatible',
    version: detected,
    verified: VERIFIED_HARNESS_VERSIONS.includes(detected),
  }
}

/** Human-readable one-line explanation of a compatibility verdict. */
export function describeCompatibility(harness: HarnessCompatibility): string {
  switch (harness.status) {
    case 'compatible':
      return harness.verified
        ? `DSH ${harness.version} (verified)`
        : `DSH ${harness.version} (within range, not in the verified list)`
    case 'unknown':
      return 'DSH version not detectable; proceeding without a version check'
    case 'too-old':
      return `DSH ${harness.version} is older than the supported minimum ${harness.min}`
    case 'too-new':
      return `DSH ${harness.version} is at or beyond ${harness.max}; this BMPP release is not verified against it`
    case 'unparsable':
      return `DSH version "${harness.version}" could not be parsed`
  }
}
