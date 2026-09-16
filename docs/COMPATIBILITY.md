# BMPP ↔ DeepSeek Harness compatibility

BMPP versions independently of the DeepSeek Harness (DSH). The two version lines are related **only**
by the explicit envelope declared in this document, `package.json` (`dsh.compatibility`) and
`src/version.ts` (`HARNESS_RANGE`). They are never assumed equal.

## The model

```
BMPP 0.1.0   ──compatible with──▶   DSH >= 0.1.5-rc.2 < 0.2.0
                                     verified against: 0.1.5-rc.2
```

- The Harness is at `0.x`. Under semver, `0.x` minor bumps may break anything, so the envelope is
  deliberately narrow: it names the **line BMPP has actually been exercised against**, not a
  hopeful range.
- `max` is exclusive. `>=0.1.5-rc.2 <0.2.0` says: any `0.1.x` at or above the verified floor.
- Prerelease ordering follows semver, so `0.1.5-rc.2 < 0.1.5`. A later `0.1.5` release stays inside
  the envelope and is treated as "within range, not verified".

## Where the envelope is declared

| Location | Field | Purpose |
|---|---|---|
| `package.json` | `dsh.compatibility.harness` | machine-readable claim, readable by tooling and by users before installing |
| `package.json` | `dsh.compatibility.verified` | the exact versions CI and manual verification covered |
| `src/version.ts` | `HARNESS_RANGE`, `VERIFIED_HARNESS_VERSIONS` | the runtime copy used by the load-time decision |

The two copies must move together; `tests/unit/version.spec.ts` asserts they agree, so the claim
cannot drift from the code that enforces it.

## How the Harness version is detected

The Harness exposes **no version service** on the Cordis context (verified against `0.1.5-rc.2`).
BMPP therefore reads the version of an identity package it already resolves against —
`@deepseek-ai/dsh-tools`, falling back to `@deepseek-ai/dsh-llm` — via `createRequire` and
`package.json`. Every step is guarded:

- resolution or read failure → `undefined`, never an exception;
- an undetectable version is an expected condition (packaged executables, exotic resolution), not an
  error.

`detectHarnessVersion(resolveFrom)` accepts a resolution base so tests can point it at a fixture.

## Feature probe — the check that actually matters

A version string is a claim; the API surface is the fact. At load, BMPP verifies that the injected
`tools` service exposes the exact members it programs against:

```
register · get · guard · schemas · executionMode
```

This is what makes the compatibility claim falsifiable at **load time** instead of at first
interception, hours into a session, when a missing method would silently disable the policy.

### A dependency discovered while validating this release

`ToolRuntime` declares `static inject = ['systemPrompt']` (verified in
`packages/core/tools/src/index.ts` of `0.1.5-rc.2`). The `tools` service therefore only registers
**after** `SystemPrompt` is mounted — mounting the registry alone leaves `ctx.get('tools')`
undefined.

BMPP is unaffected in a real Harness, because it declares `inject: ['tools']` and so waits for the
service rather than assuming it. The fact is recorded here because it is the first thing that bites
when writing a test harness by hand, and because it is the kind of ordering assumption that a
compatibility check should be able to explain. `tests/integration/loader.spec.ts` mounts the real
`SystemPrompt` + `ToolRuntime` pair for exactly this reason.

## Load-time decisions

| Detected | Verdict | Why |
|---|---|---|
| inside the envelope | **activate** | the supported case |
| not detectable | **activate** with an informational log | refusing here would break working installs for a cosmetic reason |
| outside the envelope (older or newer) | **refuse to load**, with the concrete reason | an unverified event API would let BMPP *silently mis-enforce* — the worst outcome for a policy plugin, worse than not loading |
| unparsable version | **refuse to load** | an unreadable claim cannot be checked |
| required `tools` member missing | **refuse to load**, naming the missing members | the host is not the shape this release was written against |

Refusal is a thrown error from `apply`, so the Cordis loader reports the failing row and the message
reaches the operator. Nothing fails silently, and nothing half-activates.

The decision itself is a pure function (`decideActivation`) kept separate from detection, so both
are unit-testable without a Harness process.

## What BMPP deliberately does not depend on

The emitted runtime code imports **nothing** from the Harness. `@deepseek-ai/*` packages are used
for types only (`import type`), which is erased at compile time.

This is a compatibility decision, not an aesthetic one:

- the plugin receives everything it needs through Cordis (`ctx`, the `tools` service, the event
  seam) and through event payloads the Harness already constructs;
- consequently there is no second module instance of `@deepseek-ai/dsh-tools` to fall out of step
  with the host, and no dependency-resolution failure mode in which the plugin silently talks to a
  different copy of the runtime;
- and BMPP cannot be broken by a resolution problem it does not create.

`package.json` still declares the packages as **optional peers** (so a bundler or type-check has
them available) and as **exact devDependencies** (so development type-checks against a known
version). Neither makes them a runtime requirement.

**Do not** import the Harness's internal modules, take a dependency on a `dsh-*` package's private
paths, or read its `src/` — the published tarballs ship `lib/` and `.d.ts` only, and reaching past
the documented surface is exactly the coupling that makes a plugin a fork.

## Adding a Harness version to the supported envelope

**A new Harness version is never added to the envelope or to the `verified` list on the strength of
it existing.** Every version that enters `HARNESS_RANGE` or `VERIFIED_HARNESS_VERSIONS` must first
pass the re-verification procedure below, on this project, with the full suite.

Until that happens the new version is simply **not supported**: BMPP refuses to load on it rather
than enforcing a policy it has not been checked against. Widening the envelope is a deliberate,
tested change to `package.json` and `src/version.ts` together — never a side effect of a release.

The `verified` list names only what has actually been exercised. It currently contains exactly one
version: `0.1.5-rc.2`.

## Re-verifying on a new Harness release

When DSH publishes a version BMPP must support:

1. Install that Harness version and run `pnpm run typecheck`. A type-level change appears here first.
2. Run the full suite against it. The load-time probe and every gate test run against the real
   `ToolRuntime`, so a moved seam fails loudly.
3. If the release is additive and compatible: add the version to `VERIFIED_HARNESS_VERSIONS` and
   widen `HARNESS_RANGE` correspondingly, in `package.json` **and** `src/version.ts`.
4. If a seam moved or a payload changed: that is a **breaking** change for BMPP — release a new
   minor (`0.x`) and narrow the envelope so the old release refuses to load on the new Harness
   rather than mis-enforcing.
5. Record the outcome in `CHANGELOG.md` under the exact Harness versions tested.

A compatibility claim that is not backed by a test run is documentation, not a guarantee. Treat the
`verified` list as the set of versions the suite has actually passed on.
