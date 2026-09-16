/**
 * BMPP configuration: schema, validation and the `mode` × `profile` model.
 *
 * Two independent dimensions describe the plugin's behaviour:
 *
 * - `mode`    — is the policy OFF, WATCHING (audit), or IMPOSING (enforce)?
 * - `profile` — how RIGOROUS is the policy (compat or strict)?
 *
 * Normative rules (see docs/ARCHITECTURE.md §12.2.1 and §13.3):
 *
 * 1. `profile` NEVER changes `mode`.
 * 2. `mode: 'audit'` never denies and never asks for approval, whatever the
 *    profile says. It records the decision it WOULD have applied.
 * 3. Only `mode: 'enforce'` denies; only `enforce` + `strict` may ask.
 * 4. There is no second mechanism that configures the same thing: no `strict`
 *    boolean, no `gateScope`, no preset that rewrites `mode`.
 *
 * The validator is dependency-free on purpose: it is the only code that must
 * keep working unchanged across the whole rollout, so it has no install-time
 * or version-coupled surface.
 *
 * @module dsh-bmpp/config
 */

/** Whether the policy is off, watching, or imposing. */
export type BmppMode = 'off' | 'audit' | 'enforce'

/** How rigorous the policy is. */
export type BmppProfile = 'compat' | 'strict'

/** Tri-state severity a secondary guard can be configured to. */
export type GuardLevel = 'off' | 'warn' | 'deny'

/** How paths appear in audit events. */
export type PathRedaction = 'truncate' | 'hash' | 'full' | 'omit'

/** How much the audit trail records. */
export type AuditLevel = 'off' | 'decision' | 'verbose'

/** Fully resolved, validated BMPP configuration. */
export interface BmppConfig {
  readonly mode: BmppMode
  readonly profile: BmppProfile
  /** Recall precondition: how an unclassified turn is treated. */
  readonly onMissingClassification: 'treat_complex'
  /** Public tool names whose successful, non-error result satisfies recall. */
  readonly searchTools: readonly string[]
  /** Public tool names classified as read-only memory access. */
  readonly readTools: readonly string[]
  /** Public tool names classified as state-changing memory access. */
  readonly mutatingTools: readonly string[]
  /** How a tool inside the memory namespace but absent from every list is treated. */
  readonly unknownMemoryToolPolicy: GuardLevel
  /** `write_note` requires a completed recall in the same turn. */
  readonly createRequiresSearch: boolean
  /** `write_note` with `overwrite: true` without reading the note first. */
  readonly overwriteRequiresRead: GuardLevel
  /** Block a second identical write in the same turn. */
  readonly duplicateWriteGuard: boolean
  /** Heuristic detection of obvious secret shapes in write arguments. */
  readonly secretPatternGuard: GuardLevel
  /** `[test-fixture]` in a note outside the allowed prefixes. */
  readonly testFixtureGuard: GuardLevel
  /** Path prefixes where `[test-fixture]` is legitimate. */
  readonly testFixtureAllowedPrefixes: readonly string[]
  /** Tools that are destructive; `enforce` + `strict` asks before them. */
  readonly destructiveTools: readonly string[]
  readonly auditLevel: AuditLevel
  readonly pathRedaction: PathRedaction
  readonly maxPathChars: number
  /** Policy version stamped on every audit event. */
  readonly policyVersion: string
  /** Relaxes nothing that matters for production; enables fixture-oriented behaviour. */
  readonly testMode: boolean
}

/** Namespace prefix of every tool the MVP governs (docs/ARCHITECTURE.md §6.4). */
export const MEMORY_NAMESPACE = 'mcp__basic-memory__'

/** Read-only memory tools (from the server's MCP `readOnlyHint` annotations). */
export const DEFAULT_READ_TOOLS: readonly string[] = [
  `${MEMORY_NAMESPACE}search_notes`,
  `${MEMORY_NAMESPACE}search`,
  `${MEMORY_NAMESPACE}build_context`,
  `${MEMORY_NAMESPACE}recent_activity`,
  `${MEMORY_NAMESPACE}read_note`,
  `${MEMORY_NAMESPACE}read_content`,
  `${MEMORY_NAMESPACE}view_note`,
  `${MEMORY_NAMESPACE}list_directory`,
  `${MEMORY_NAMESPACE}list_memory_projects`,
  `${MEMORY_NAMESPACE}list_workspaces`,
  `${MEMORY_NAMESPACE}fetch`,
  `${MEMORY_NAMESPACE}basic_memory_diagnostics`,
  `${MEMORY_NAMESPACE}schema_infer`,
  `${MEMORY_NAMESPACE}schema_validate`,
  `${MEMORY_NAMESPACE}schema_diff`,
]

/**
 * Read tools that satisfy the recall precondition.
 *
 * `recent_activity` is deliberately absent: activity is not a subject search.
 */
export const DEFAULT_SEARCH_TOOLS: readonly string[] = [
  `${MEMORY_NAMESPACE}search_notes`,
  `${MEMORY_NAMESPACE}search`,
  `${MEMORY_NAMESPACE}build_context`,
]

/** State-changing memory tools. Unknown memory tools fail closed to this class. */
export const DEFAULT_MUTATING_TOOLS: readonly string[] = [
  `${MEMORY_NAMESPACE}write_note`,
  `${MEMORY_NAMESPACE}edit_note`,
  `${MEMORY_NAMESPACE}move_note`,
  `${MEMORY_NAMESPACE}delete_note`,
  `${MEMORY_NAMESPACE}create_memory_project`,
  `${MEMORY_NAMESPACE}delete_project`,
]

/** Destructive memory tools: `enforce` + `strict` asks before these. */
export const DEFAULT_DESTRUCTIVE_TOOLS: readonly string[] = [
  `${MEMORY_NAMESPACE}delete_note`,
  `${MEMORY_NAMESPACE}delete_project`,
]

/**
 * The approved defaults: observe and audit, impose nothing.
 *
 * `audit` + `compat` records the full decision for every gated call while
 * allowing all of them, which makes the first rollout step pure evidence.
 */
export const DEFAULT_CONFIG: BmppConfig = {
  mode: 'audit',
  profile: 'compat',
  onMissingClassification: 'treat_complex',
  searchTools: DEFAULT_SEARCH_TOOLS,
  readTools: DEFAULT_READ_TOOLS,
  mutatingTools: DEFAULT_MUTATING_TOOLS,
  unknownMemoryToolPolicy: 'deny',
  createRequiresSearch: true,
  overwriteRequiresRead: 'warn',
  duplicateWriteGuard: true,
  secretPatternGuard: 'warn',
  testFixtureGuard: 'warn',
  testFixtureAllowedPrefixes: ['tests/', 'archive/policy-tests/'],
  destructiveTools: DEFAULT_DESTRUCTIVE_TOOLS,
  auditLevel: 'decision',
  pathRedaction: 'truncate',
  maxPathChars: 64,
  policyVersion: '0.1.0',
  testMode: false,
}

/**
 * Exactly what `profile: 'strict'` overrides, relative to `compat`.
 *
 * Everything absent from this table is IDENTICAL in both profiles. That is
 * deliberate and documented (§13.3.1): `onMissingClassification`,
 * `unknownMemoryToolPolicy`, `createRequiresSearch` and `duplicateWriteGuard`
 * already sit at their most conservative value under `compat`, so `strict`
 * adds no rigor there.
 */
export const STRICT_PROFILE_OVERRIDES: Readonly<Partial<BmppConfig>> = {
  overwriteRequiresRead: 'deny',
  secretPatternGuard: 'deny',
  testFixtureGuard: 'deny',
}

/** Options whose value `strict` changes; every other option is profile-invariant. */
export const PROFILE_VARIANT_OPTIONS: readonly (keyof BmppConfig)[] = [
  'overwriteRequiresRead',
  'secretPatternGuard',
  'testFixtureGuard',
]

/** Options identical in both profiles — `strict` adds no rigor for these. */
export const PROFILE_INVARIANT_OPTIONS: readonly (keyof BmppConfig)[] = [
  'onMissingClassification',
  'unknownMemoryToolPolicy',
  'createRequiresSearch',
  'duplicateWriteGuard',
  'destructiveTools',
  'searchTools',
  'readTools',
  'mutatingTools',
  'auditLevel',
  'pathRedaction',
  'maxPathChars',
]

/** A rejected configuration, with one machine-readable code per problem. */
export interface ConfigError {
  /** Dotted path of the offending key, or `''` for the whole object. */
  readonly path: string
  /** Stable code a caller or test can assert on. */
  readonly code: ConfigErrorCode
  readonly message: string
}

/** Stable machine-readable configuration error codes. */
export type ConfigErrorCode =
  | 'NOT_AN_OBJECT'
  | 'UNKNOWN_KEY'
  | 'INVALID_ENUM'
  | 'INVALID_TYPE'
  | 'INVALID_LENGTH'
  | 'INVALID_NUMBER'
  | 'AMBIGUOUS_MODE'

/** Result of {@link validateConfig}: either a resolved config or the errors. */
export type ConfigValidation =
  | { readonly ok: true; readonly config: BmppConfig; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly ConfigError[] }

const MODES: readonly string[] = ['off', 'audit', 'enforce']
const PROFILES: readonly string[] = ['compat', 'strict']
const GUARD_LEVELS: readonly string[] = ['off', 'warn', 'deny']
const AUDIT_LEVELS: readonly string[] = ['off', 'decision', 'verbose']
const PATH_REDACTIONS: readonly string[] = ['truncate', 'hash', 'full', 'omit']

/** Keys a caller may set. Any other key is rejected — silent typos are defects. */
const CONFIG_KEYS: readonly string[] = Object.keys(DEFAULT_CONFIG)

/** Keys that would configure the same thing twice and are therefore forbidden. */
const FORBIDDEN_KEYS: readonly string[] = ['strict', 'gateScope', 'preset']

/**
 * Apply a profile to a partial configuration.
 *
 * `mode` is copied through untouched: this function can never change it.
 *
 * @param profile - the selected profile.
 * @param partial - caller-supplied overrides, already validated per key.
 */
export function resolveProfile(profile: BmppProfile, partial: Partial<BmppConfig>): Partial<BmppConfig> {
  if (profile !== 'strict') return partial
  // Explicit caller values win over profile defaults. `mode` is carried through
  // untouched — conditionally, so an absent value stays absent rather than
  // becoming an explicit `undefined`.
  return {
    ...STRICT_PROFILE_OVERRIDES,
    ...partial,
    ...(partial.mode === undefined ? {} : { mode: partial.mode }),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertEnum(
  errors: ConfigError[],
  key: string,
  value: unknown,
  allowed: readonly string[],
): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push({
      path: key,
      code: 'INVALID_ENUM',
      message: `"${key}" must be one of ${allowed.map(v => `'${v}'`).join(', ')}; received ${JSON.stringify(value)}`,
    })
  }
}

/**
 * Validate and normalize a raw configuration object.
 *
 * Never throws: an invalid configuration is a value, so callers (and tests) can
 * assert on the exact codes. `profile` is applied only after per-key validation,
 * so an invalid value can never be masked by a profile override.
 *
 * @param raw - the configuration as it arrived from the composition layer.
 */
export function validateConfig(raw: unknown): ConfigValidation {
  const errors: ConfigError[] = []
  const warnings: string[] = []

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '', code: 'NOT_AN_OBJECT', message: 'BMPP config must be an object' }] }
  }

  for (const key of FORBIDDEN_KEYS) {
    if (key in raw) {
      errors.push({
        path: key,
        code: 'AMBIGUOUS_MODE',
        message: `"${key}" is not a BMPP option: mode/profile are the only policy dimensions`,
      })
    }
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key) && !FORBIDDEN_KEYS.includes(key)) {
      errors.push({ path: key, code: 'UNKNOWN_KEY', message: `unknown BMPP config key "${key}"` })
    }
  }

  const mode = raw['mode'] ?? DEFAULT_CONFIG.mode
  const profile = raw['profile'] ?? DEFAULT_CONFIG.profile
  assertEnum(errors, 'mode', mode, MODES)
  assertEnum(errors, 'profile', profile, PROFILES)

  if (raw['onMissingClassification'] !== undefined
    && raw['onMissingClassification'] !== 'treat_complex') {
    errors.push({
      path: 'onMissingClassification',
      code: 'INVALID_ENUM',
      message: '"onMissingClassification" is fixed to \'treat_complex\'; an unclassified turn must never unlock writes',
    })
  }

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'mode':
      case 'profile':
      case 'onMissingClassification':
        break
      case 'unknownMemoryToolPolicy':
      case 'overwriteRequiresRead':
      case 'secretPatternGuard':
      case 'testFixtureGuard':
        assertEnum(errors, key, value, GUARD_LEVELS)
        break
      case 'auditLevel':
        assertEnum(errors, key, value, AUDIT_LEVELS)
        break
      case 'pathRedaction':
        assertEnum(errors, key, value, PATH_REDACTIONS)
        break
      case 'createRequiresSearch':
      case 'duplicateWriteGuard':
      case 'testMode':
        if (typeof value !== 'boolean') {
          errors.push({ path: key, code: 'INVALID_TYPE', message: `"${key}" must be a boolean` })
        }
        break
      case 'maxPathChars':
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          errors.push({ path: key, code: 'INVALID_NUMBER', message: '"maxPathChars" must be a positive integer' })
        }
        break
      case 'policyVersion':
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push({ path: key, code: 'INVALID_LENGTH', message: '"policyVersion" must be a non-empty string' })
        }
        break
      case 'searchTools':
      case 'readTools':
      case 'mutatingTools':
      case 'testFixtureAllowedPrefixes':
      case 'destructiveTools': {
        if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
          errors.push({ path: key, code: 'INVALID_TYPE', message: `"${key}" must be an array of strings` })
          break
        }
        const outside = value.filter(entry => !entry.startsWith(MEMORY_NAMESPACE))
        if (outside.length > 0 && key !== 'testFixtureAllowedPrefixes') {
          warnings.push(`"${key}" lists tools outside the memory namespace, which the MVP never governs: ${outside.join(', ')}`)
        }
        break
      }
      default:
        break
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const partial: Partial<BmppConfig> = { ...(raw as Partial<BmppConfig>) }
  const resolved: BmppConfig = {
    ...DEFAULT_CONFIG,
    ...resolveProfile(profile as BmppProfile, partial),
    mode: mode as BmppMode,
    profile: profile as BmppProfile,
  }

  if (resolved.mode === 'off' && resolved.profile === 'strict') {
    warnings.push("mode 'off' ignores profile 'strict': the plugin registers nothing and takes no decision")
  }
  if (resolved.mode === 'audit') {
    warnings.push("mode 'audit' never denies and never asks for approval, whatever the profile says")
  }
  if (resolved.mode === 'off' && resolved.auditLevel !== 'off') {
    warnings.push("mode 'off' emits no audit events; auditLevel has no effect")
  }

  return { ok: true, config: resolved, warnings }
}
