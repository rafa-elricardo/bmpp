# BMPP — Basic Memory Policy Plugin

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that moves the
**mechanically checkable** parts of an agent's memory policy into the runtime, while leaving every
**semantic** decision to the model.

BMPP stands between the model and the `mcp__basic-memory__*` tools and enforces the invariants that
can be proved from runtime events — that a memory lookup actually completed before a turn mutates
memory, that a blocked call is explained instead of swallowed, that every allow/deny decision is
auditable — without ever pretending it understands the project better than the model does.

> **Status: foundation (phase 0).** The project loads, validates its configuration and reports
> compatibility. It registers **no** tool interception and **no** enforcement yet; each later phase
> lands as its own commit. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §26 for the phase plan.

---

## What this project is, and what it is not

`dsh-bmpp` is an **independent, third-party plugin**. It is not part of the DeepSeek Harness
repository, it is not maintained by DeepSeek, and it is not affiliated with or endorsed by the
DeepSeek project. It is a separate repository that happens to extend the Harness through the public
plugin API the Harness documents for third-party authors.

The Harness is consumed as a **dependency**, never forked: the local checkout of
`deepseek-ai/deepseek-harness` stays a clean clone of the official repository, untouched by this
project. Compatibility between the two is expressed by an explicit version envelope
([docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)), because the two version lines are independent —
BMPP's version says nothing about the Harness version it needs.

## Design in one paragraph

Two kinds of memory rule exist. The first is semantic: is this information worth persisting, does
this note already cover it, is the recalled value still true. Those stay with the model, in
`AGENTS.md` and the memory policy note. The second is mechanical: had a memory search completed
before this write, did that search fail, is this the same write twice in one turn, was a lookup and
a mutation bundled into one parallel batch. Those are decided by events the runtime already emits,
so BMPP decides them deterministically and enforces them. **The plugin never infers meaning from the
user's text, and it never reads note content.**

The policy is one policy, expressed in three places:

| Layer | Responsibility |
|---|---|
| `AGENTS.md` + the memory policy note | semantic instructions for the model |
| **BMPP** | mechanically verifiable policy |
| `mcp__basic-memory__*` | storage and retrieval |
| the test suite | proof that the invariants hold |
| `bmpp/policy` audit events | evidence of every allow/block decision |

## Configuration

Two **independent** dimensions. There is no `strict` boolean and no second way to configure the same
thing.

```yaml
- insert:
    - id: bmpp
      name: 'dsh-bmpp'
      config:
        mode: audit        # off | audit | enforce
        profile: compat    # compat | strict
```

| | Meaning |
|---|---|
| `mode: off` | Registers nothing. No decisions, no events. |
| `mode: audit` | Decides everything and records the decision, but **allows** every call. Never denies, never asks. |
| `mode: enforce` | Applies the decision. The only mode that can deny or ask. |
| `profile: compat` | Secondary guards warn; destructive operations go through the normal gate. |
| `profile: strict` | Secondary guards deny; destructive operations ask for approval. |

Normative rules:

1. **`profile` never changes `mode`.**
2. **`mode: audit` never denies and never asks**, whatever the profile says — it records the `deny`
   it *would* have applied.
3. No ambiguous combinations: the schema rejects unknown keys and invalid values at load.

**Defaults: `mode: audit` + `profile: compat`.** The approved rollout is
`audit+compat` → `enforce+compat` → (evaluate) `enforce+strict`; each step is one line and reverting
is one line. Exactly what `strict` changes, and where it deliberately changes nothing, is
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §13.3.1.

## Scope

BMPP governs **only** `mcp__basic-memory__*` tools. It does not block `bash`, `edit`, `write`,
`terminal`, the filesystem, or any other mutating tool, and it is not a general agent-security
policy. Widening the scope is a separate decision with its own document, not a configuration value.

## Compatibility

BMPP versions independently of the Harness and declares an explicit envelope:

```
BMPP 0.1.0   →   DSH >= 0.1.5-rc.2 < 0.2.0   (verified: 0.1.5-rc.2)
```

The envelope is declared in `package.json` (`dsh.compatibility`) and `src/version.ts`, detected at
load, and enforced structurally: BMPP probes the injected `tools` service for the exact methods it
programs against and **refuses to load** on an unverified Harness line rather than mis-enforcing.
Full strategy, including what BMPP deliberately does not depend on:
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Try it without installing anything

A patch overlay contributes configuration only, so an uninstalled checkout can be loaded by absolute
path — nothing is written into a profile:

```sh
dsh --profile bmpp-dev --patch <bmpp-checkout>/overlay.dev.cordis.yml
```

`overlay.dev.cordis.yml` is machine-local and gitignored; `examples/` holds distributable
configuration snippets.

## Install into a profile

```sh
# from a registry, once the package is published under a public name
dsh plugin --profile <profile> add dsh-bmpp
# from a locally built tarball — works today, no registry needed
pnpm run build && pnpm pack
dsh plugin --profile <profile> add ./dsh-bmpp-0.1.0.tgz
```

Installation, update, dependency resolution and the reasoning behind the chosen distribution form
are in [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

## Development

```sh
pnpm install      # or npm install
pnpm run typecheck
pnpm test
pnpm run build    # emits lib/ for publication; lib/ is never committed
```

The plugin is written so that **its emitted runtime code imports nothing from the Harness**. The
`@deepseek-ai/*` packages are used for types only, which is what makes BMPP genuinely standalone
rather than a fragment of a monorepo. `docs/DISTRIBUTION.md` explains why that matters.

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full design: extension points, responsibility split, state machine, tool matrix, hard/soft policy, error contract, state lifecycle, audit format, security, test strategy, migration, risks, phases |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Version envelope, detection, load-time decisions, how to re-verify on a new DSH release |
| [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) | Development vs distribution mechanisms, option comparison, installation and publication |

## License

MIT — see [LICENSE](LICENSE). The analysis behind that choice, including what BMPP may and may not
do relative to the Harness, is recorded in [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md#license-and-derived-work).
