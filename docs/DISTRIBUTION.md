# BMPP distribution and loading

This document answers two questions that must not be conflated:

1. **How does BMPP get loaded into a running Harness?** (mechanism)
2. **How does BMPP reach another person's machine?** (distribution)

The answers differ, and choosing the wrong one for the wrong purpose is how a standalone plugin
quietly becomes a fragment of somebody's monorepo.

---

## 1. The mechanism the Harness actually provides

Verified against DSH `0.1.5-rc.2` in the official documentation
(`docs/user/develop/basic/publish.md`, `index.md`) and in the loader source
(`vendor/loader/src/config/tree.ts`, `vendor/include/src/index.ts`).

A Cordis **composition** is a YAML array of rows. Each row names a plugin; the loader resolves that
name and applies the plugin with the row's `config`:

| Row name form | Resolution |
|---|---|
| `cordis:*` | loader builtin |
| starts with `.` or `..` | `new URL(name, ctx.baseUrl)` — `ctx.baseUrl` is the **profile** directory, *not* the patch file's directory |
| anything else | `import(name)` — a bare specifier, resolved by Node from the loader's location |

Two consequences drive every decision below:

- **A patch cannot make a relative path work.** A patch contributes configuration only; it does not
  change the resolution base. A row for an uninstalled project must therefore carry an **absolute
  path**.
- **An installed package resolves like any other dependency**, through the profile's
  `node_modules`.

The Harness implements "install a plugin" as a **bundle**: a package whose `package.json` declares
`dsh.bundle.patch` pointing at a `cordis.patch.yml`. Installing it runs pnpm inside the profile
directory, links the package, and appends the bundle to the profile's ordered `bundles` list.

BMPP is authored as such a bundle. `cordis.patch.yml` and the `dsh.bundle` manifest are therefore
**first-class source artifacts**, not packaging afterthoughts.

---

## 2. Comparison of the forms available

| | A. npm package (bundle) | B. local path via `--patch` | C. tarball (`pnpm pack`) | D. git dependency |
|---|---|---|---|---|
| **Install** | `dsh plugin add dsh-bmpp` | nothing to install | `dsh plugin add ./dsh-bmpp-0.1.0.tgz` | `dsh plugin add github:rafa-elricardo/bmpp` |
| **Dependency resolution** | pnpm resolves peers against the profile | none needed (see §3) | same as A | same as A, but from source |
| **Update** | `dsh plugin add @…@<newer>` | edit the working tree | re-pack and re-add | re-pin the commit |
| **Version compatibility** | declared `dsh.compatibility`; the profile pins one version | whatever is in the tree | exact tarball version | exact commit |
| **Experience for a new user** | best: one command | poor: absolute paths, machine-specific | good, one file to hand over | acceptable, but needs a build allowance |
| **Cordis loading** | bare specifier from the profile | absolute path row | bare specifier after install | bare specifier after install |
| **Testing** | works, but the loop goes through pnpm | fastest loop, direct source | slows the loop | slowest |
| **Build** | `lib/` built at publish time | none (`tsx` consumes `src/` directly) | `lib/` built before `pnpm pack` | needs a `prepare` script and a user-side `allowBuilds` |
| **Publication future** | native fit | n/a | possible but not the goal | n/a |
| **Maintenance** | one artifact and one version line | two configurations to keep in step | an extra artifact per release | a build script to keep working |

Rejected as the *distribution* answer:

- **B** is not distribution at all: it hardcodes an absolute path and requires the user to hand-write
  a patch row. It is, however, the **best development loop**, which is why it is kept for that.
- **D** has a real footgun documented by the Harness itself: a git install fetches **sources, not
  built artifacts**, nothing runs `build`, and pnpm ≥10 refuses a dependency's `prepare` script until
  the user allowlists it. That allowance means "run this package's code on my machine at install
  time", which is a large thing to ask of someone installing a policy plugin.

---

## 3. Recommended: development

**Overlay a patch at the source, and install nothing into any profile.**

```sh
dsh --profile bmpp-dev --patch <bmpp-checkout>/overlay.dev.cordis.yml
```

The overlay (gitignored, because it names this machine's absolute path) is a two-line row pointing at
`<bmpp-checkout>/src/index.ts`. The Harness runs from a TypeScript checkout with `tsx`, so the
source is consumed directly: **edit, restart the row, observe** — no build, no link, no release.

Why this works without any module resolution setup: BMPP's emitted runtime code imports nothing from
the Harness (§4). The loader resolves the plugin's absolute path; the plugin then runs against the
`ctx` it is handed. There is nothing left to resolve.

Use a throwaway profile (`bmpp-dev`) rather than the real one, so an experiment cannot affect a
working setup. To exercise a second Harness version, check that version out on a branch of its own
clone and point `overlay.dev.cordis.yml` at the same plugin path — the plugin is version-agnostic
apart from the envelope check.

---

## 4. Recommended: distribution

**Publish the bundle to a registry (or hand over a tarball).**

```sh
# author
pnpm run build && pnpm pack         # emits dsh-bmpp-0.1.0.tgz with lib/ inside

# user
dsh plugin --profile web add dsh-bmpp                   # registry, once published
dsh plugin --profile web add ./dsh-bmpp-0.1.0.tgz       # tarball
```

What the user gets: one command, no build allowance, no absolute paths, and a plugin that appears in
`dsh --profile web --dump-config` as its own labelled layer.

### Dependency declarations, and why they are unusual

```jsonc
"peerDependencies": {                      // available, but never force-installed
  "@deepseek-ai/cordis":    ">=4.0.2 <5",
  "@deepseek-ai/dsh-tools": ">=0.1.5-rc.2 <0.2.0"
},
"peerDependenciesMeta": {                  // optional: absence is not a resolution failure
  "@deepseek-ai/cordis":    { "optional": true },
  "@deepseek-ai/dsh-tools": { "optional": true }
},
"devDependencies": {                        // exact: development type-checks one known version
  "@deepseek-ai/cordis":    "4.0.2",
  "@deepseek-ai/dsh-tools": "0.1.5-rc.2"
}
```

The `>=0.1.5-rc.2 <0.2.0` range is the verified floor with an exclusive minor ceiling: under `0.x`
a minor bump may break anything, so the envelope names the line this release was exercised against
rather than a hopeful span. `dsh.compatibility` (§COMPATIBILITY.md) carries the same envelope for
readers; the range is what package managers evaluate, and the load-time probe is what actually
decides whether the host is the shape this release was written against.

Three deliberate choices:

1. **Peers are marked optional** so an install never fails because the host already provides them.
   The Harness supplies `ctx` and the `tools` service; installing a second copy would be pointless.
2. **No runtime dependency on any `dsh-*` package.** The emitted code imports nothing from the
   Harness; `@deepseek-ai/*` imports are `import type` and are erased. This is the property that
   makes BMPP standalone rather than monorepo-bound, and the one to defend in review.
3. **Config validation is dependency-free** (`src/config.ts`) rather than pulling in a schema
   library, so even the configuration surface has no install-time coupling. The cost is a
   hand-written validator; the benefit is that the one component spanning the whole rollout cannot
   break because a validator's major version moved.

The published tarballs of `@deepseek-ai/dsh-*` ship `lib/` plus `.d.ts` and do **not** ship `src/`.
That is a hard boundary: treat the documented exports as the only surface, and never import an
internal path.

### What BMPP must never do to be distributable

- **Never** point at a local checkout. A neighbouring clone's `node_modules` is a development
  convenience, not a distribution mechanism: it exists on exactly one machine and couples the plugin
  to an unversioned directory.
- **Never** require the user to install the plugin *inside* the Harness checkout. The checkout stays
  a clean clone of the official repository and is never forked.
- **Never** commit `lib/`. It is build output; consumers install built artifacts from the registry or
  a tarball.

---

## 5. Repository hygiene for a future public release

The repository starts private and must not depend on staying private. Concretely:

- **No secrets, credentials, tokens or `.env` files.** `.gitignore` covers `.env*` and `*.local`.
- **No machine-specific paths in tracked files.** `overlay.dev.cordis.yml` and
  `*.local.cordis.yml` are gitignored precisely because they name absolute paths. `src/` must never
  contain them either — nothing in BMPP hardcodes a home directory or a checkout location.
- **No session dumps, audit logs or conversation content.** BMPP's audit events are metadata; this
  repository ships the code that emits them, never their output.
- **No vendored Harness source.** Copying Harness code would both create a maintenance fork and
  import its authorship; the plugin talks to the public API instead.
- **Documented dependencies and compatibility.** `package.json` and `docs/COMPATIBILITY.md` are the
  contract.
- **A named license** and a `CHANGELOG.md` that records the Harness versions each release was tested
  against.

A pre-publication review should cover exactly: license, documentation, examples, compatibility
claims, local-path references, sensitive data, and internal dependencies.

---

## 6. License and derived work

**Conclusion: BMPP may be licensed MIT (or any license of your choosing); it derives nothing from
the Harness.**

Evidence, gathered from the live system rather than assumed:

| Fact | Source |
|---|---|
| The repository root of DSH is MIT-licensed | `deepseek-harness/package.json` → `license: MIT` |
| Every published `@deepseek-ai/dsh-*` package carries an **MIT** `LICENSE` file | extracted from the published `0.1.5-rc.2` tarballs (`package/LICENSE`) |
| The registry's *packument-level* `license` field reports `BSD-3-Clause` | stale metadata attached to the oldest dist-tag; the **per-version** metadata and the shipped `LICENSE` both say MIT. Do not rely on the packument field — read the tarball |
| `@deepseek-ai/cordis` is MIT | its `package.json` in `vendor/cordis`, and the registry entry |
| `@deepseek-ai/schemastery` is MIT | registry entry |

MIT is permissive: using, depending on, and linking against it imposes no copyleft obligation, and
requires only that the copyright notice travel with copies of *their* code.

BMPP satisfies that trivially:

- **It copies no Harness source.** All Harness interaction is through the public runtime API — the
  `ctx` object, the `tools` service, and event payloads the Harness constructs.
- **It links nothing.** The published `lib/` is not imported at runtime; only `.d.ts` types are read
  at compile time. Type-only use creates no derived work.
- **It redistributes nothing.** `node_modules` is never committed, and no Harness file is vendored.

Attributing the Harness in the README is good practice regardless of obligation. If a future change
did require copying Harness source, that file must carry the upstream MIT notice and the
`THIRD_PARTY_NOTICES` treatment; that is the trigger to revisit this section.

**Decision still required from the project owner:** confirm MIT (recommended, matching the
ecosystem) and choose the copyright holder line in `LICENSE` — it currently reads "BMPP
contributors".
