# BMPP — Basic Memory Policy Plugin for DeepSeek Harness

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that moves
the **mechanically checkable** part of an agent's memory policy into the runtime, while leaving every
**semantic** decision to the model.

> **Status: experimental / alpha.** BMPP works and is covered by an automated test suite, but its
> API and configuration model may still change between releases. It is not a production-hardened
> product and it is not affiliated with or endorsed by the DeepSeek project.

---

## What is BMPP?

An agent that uses a memory system has a policy for it: *search before you write*, *do not duplicate
an existing note*, *do not trust a recalled value without checking the live system*. Some of that
policy can only be judged by a model — whether a memory is worth keeping, whether a note already
covers it, whether a recalled fact is still true. **BMPP does not touch that part.** It leaves
semantic judgement where it belongs and never reads note content or user text.

The rest of the policy is mechanical: *did a memory search actually complete before this write?*
*did that search fail?* *is this the same write twice in one turn?* Those questions are answered by
events the runtime already emits, so BMPP decides them deterministically and enforces them.

BMPP sits between the model and the
[`mcp__basic-memory__*`](https://github.com/basicmachines-co/basic-memory) tools. When the model tries
to change memory, BMPP checks the preconditions and either lets the call through or blocks it with an
explanation the model can act on.

**Scope:** BMPP governs only the `mcp__basic-memory__*` namespace. It does not block `bash`, `edit`,
`write`, the filesystem, or any other tool, and it is not a general agent-security policy.

---

## How it works

Every turn has a **classification**, and BMPP's gate is a function of it.

| Classification | Meaning | Effect on memory writes | Effect on reads |
|---|---|---|---|
| `unknown` | the model has not declared anything yet | **blocked** | allowed |
| `simple` | the model declared the turn trivial | **allowed**, no lookup required | allowed |
| `complex` | the model declared the turn needs memory | **allowed only after a successful lookup in the same turn** | allowed |

The model declares the classification with BMPP's own control tool, `bmpp__classify`:

```json
{"task": "complex"}
```

It may be called at any point in the turn — it does not have to be the first call — and a turn that
never declares anything stays `unknown`, which permits reads and blocks writes.

**Recall.** For a `complex` turn BMPP watches the memory search tools
(`search_notes`, `search`, `build_context`). A search that completes successfully satisfies the
recall precondition; a search that fails leaves the gate closed and the model is told to retry. BMPP
does not parse the search results — it reads the structured error flag the runtime already provides,
so an honest empty result still counts as a completed lookup.

**The mutation gate.** A memory write is checked against, in order:

1. the classification (`unknown` → blocked);
2. whether a lookup completed, and whether it succeeded;
3. whether a lookup and a write were bundled into one parallel batch;
4. whether an existing note is being overwritten without having been read first.

Every decision carries a stable **reason code** (`CLASSIFICATION_REQUIRED`,
`CREATE_REQUIRES_SEARCH`, `MEMORY_LOOKUP_REQUIRED`, `MEMORY_LOOKUP_FAILED`,
`MEMORY_LOOKUP_PENDING_IN_BATCH`, `OVERWRITE_REQUIRES_READ`, …) so a blocked call is explained rather
than swallowed.

**Turn lifecycle.** BMPP's state is per session and per turn. When the Harness turn advances, the
previous turn's classification and recall state are discarded, so authority earned in one turn is
never reused in the next. Sessions BMPP has not judged are not affected at all.

---

## Modes

`mode` decides whether the verdict is *applied* or merely *recorded*.

| Mode | Decides | Applies | Can deny or ask? |
|---|---|---|---|
| `off` | no | no | no — registers nothing |
| `audit` | yes | no | **never** — every call proceeds, and the denial it wanted is recorded |
| `enforce` | yes | yes | yes — the only mode that blocks |

**`audit` never blocks, whatever the profile says.** It is the safe first step: you get the complete
evidence of what BMPP *would* have done, with no behaviour change.

## Profiles

`profile` decides how rigorous the policy is. It never changes `mode`.

| Profile | Effect |
|---|---|
| `compat` | secondary guards warn; destructive operations go through the normal gate |
| `strict` | secondary guards deny; destructive operations ask for approval instead of denying outright |

Only three options differ between the profiles. Everything else — including when `unknown` blocks
writes and when a create requires a search — is identical in both.

**Defaults: `mode: audit` + `profile: compat`.**

---

## Supported DSH versions

```
BMPP 0.1.0  →  DSH >= 0.1.5-rc.2 < 0.2.0
```

| | |
|---|---|
| Range | `>=0.1.5-rc.2 <0.2.0` |
| Verified | `0.1.5-rc.2`, `0.1.6-alpha.1` |

Compatibility is declared as an explicit envelope in `package.json` (`dsh.compatibility`) and
`src/version.ts`. At load, BMPP detects the running Harness version and classifies it:

- **inside the range** → activate (a version inside the range but absent from the verified list is
  reported as "within range, not verified");
- **outside the range** (older or newer) → refuse to load, with the concrete reason;
- **undetectable** → activate and say so.

The `verified` list is *evidence*, not a second barrier — adding a version to it changes no
behaviour, only the reported status. BMPP also probes the injected `tools` service for the exact
methods it programs against, so a Harness that changed its tool-registry surface fails loudly at load
instead of mis-enforcing later.

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the full strategy.

---

## Installation

BMPP is a DSH **bundle** (a package whose `package.json` declares `dsh.bundle.patch`), and it can
also be loaded without installing anything.

### Try it without installing

A `--patch` overlay contributes configuration only, so an uninstalled checkout can be loaded by
absolute path — nothing is written into a profile:

```sh
dsh --profile bmpp-dev --patch /absolute/path/to/bmpp/overlay.dev.cordis.yml "<task>"
```

The overlay is machine-local and gitignored. `examples/` holds distributable configuration snippets.

### Install into a profile

```sh
# from a local checkout or a packed tarball
pnpm run build && pnpm pack
dsh plugin --profile <profile> add ./dsh-bmpp-0.1.0.tgz
```

`dsh plugin add` runs pnpm inside the profile, links the package and appends the bundle to the
profile's ordered bundle list. BMPP is **not yet published to a package registry**, so a local path
or tarball is how you install it today.

Mechanism, alternatives and the reasoning behind the bundle form:
[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

---

## Configuration

Two independent dimensions, configured in one row. There is no `strict` boolean and no second way to
set the same thing.

```yaml
- insert:
    - id: bmpp
      name: 'dsh-bmpp'
      config:
        mode: audit        # off | audit | enforce
        profile: compat    # compat | strict
```

The schema rejects unknown keys and invalid values at load, so a typo fails the boot rather than
silently disabling a guard.

`examples/` contains a ready snippet per combination: `config.off.yml`, `config.audit.yml`,
`config.enforce.yml`, `config.strict.yml`.

---

## Examples

**A turn that never classifies → writes are blocked, reads are not.**

```
model:  mcp__basic-memory__read_note   { identifier: "some-note" }
        → allowed            (reads are never blocked)

model:  mcp__basic-memory__write_note  { title: "New note", … }
        → denied             CLASSIFICATION_REQUIRED
        → "this turn has not been classified … call bmpp__classify first"
```

**A `simple` turn → writes are allowed with no lookup.**

```
model:  bmpp__classify                 { task: "simple" }
        → allowed            ALLOW_CONTROL

model:  mcp__basic-memory__write_note  { title: "New note", … }
        → allowed            ALLOW_SIMPLE
```

**A `complex` turn that writes without searching → blocked.**

```
model:  bmpp__classify                 { task: "complex" }
        → allowed            ALLOW_CONTROL

model:  mcp__basic-memory__write_note  { title: "New note", … }
        → denied             CREATE_REQUIRES_SEARCH
        → "creating a note requires searching for the subject first … Search, then retry."
```

**A `complex` turn that searches first → the write is allowed.**

```
model:  bmpp__classify                  { task: "complex" }
        → allowed            ALLOW_CONTROL

model:  mcp__basic-memory__search_notes { query: "…" }
        → allowed            ALLOW_READ_ONLY
        → recall settled: succeeded

model:  mcp__basic-memory__write_note   { title: "New note", … }
        → allowed            ALLOW_RECALL_OK
```

> In `mode: audit` every one of the "denied" lines above is recorded as a denial and **still
> allowed**. Real blocking requires `mode: enforce`.

---

## Architecture

BMPP is a Cordis plugin registered through the Harness's public plugin API. It consumes the Harness as
a dependency and never forks it.

| Piece | Role |
|---|---|
| `src/state.ts` | the **pure policy state machine**: `decide()` returns the verdict, the reason and a decision event. `mode` and `profile` are deliberately absent from its inputs, so the machine cannot be influenced by enforcement settings. |
| `src/gate.ts` | the **integration layer**: subscribes to `tools/pre-execute` and `tools/result`, resolves the current turn, applies `mode`/`profile` *after* the verdict, and registers the `bmpp__classify` control tool. |
| `src/config.ts` | the validated `mode` × `profile` model and the tool-class lists. |
| `src/version.ts` | BMPP's own version line and the Harness compatibility envelope, detection and classification. |
| `src/audit-sink.ts`, `src/audit-store.ts` | the audit record schema and the durable sidecar store. |
| `src/index.ts` | the Cordis entry point: configuration validation, the load-time surface probe, the compatibility decision, and mounting. |

**Tool interception.** BMPP classifies a call by the tool name it already receives. Calls outside the
memory namespace are delegated untouched; reads are allowed; writes and destructive operations are
gated. It inspects tool arguments only as far as a guard needs (a target path and an `overwrite`
flag), and never the note content.

**Turn lifecycle.** The current Harness turn is read from the `sessionProjections` service when the
host provides one, and from an internal counter otherwise. Advancing the turn discards the previous
turn's classification and recall state.

**Host version detection.** The Harness exposes no version service on its context, so BMPP reads the
version from the **application manifest of the process hosting it** — the running entry point's own
`package.json` — and falls back to a Harness identity package resolved from that entry. Anchoring on
the entry point matters: resolving from BMPP's own module would read BMPP's *own* pinned dependency
and report the development dependency as the host version.

**No value imports from the Harness.** Every `@deepseek-ai/*` import in emitted code is a type import
and is erased at compile time; runtime access goes through the injected context. A test asserts this
against the built output, which is what makes BMPP genuinely standalone rather than a fragment of the
Harness monorepo.

---

## Audit

BMPP records every decision — the verdict, its reason code, the tool class, the policy state, the
enforcement outcome, the turn and the classification. It records **metadata only**: no tool
arguments, no note content, no user text.

**The audit is not written to the DSH session event log.** It lives in a storage sidecar: a
plugin-owned domain (`bmpp_audit`, version 1, per-record layout) opened through the Harness's public
`storageDomain` service, which stores it under `$DSH_HOME/storages/bmpp_audit/`.

This matters for a concrete reason. A session event type the Harness does not know is
*required-on-read*: a reader meeting an unrecognized event must refuse to reconstruct the session
rather than silently skip it, and the public `Session.append` API offers no way for a plugin to mark
its own event type as safe to omit. Writing a plugin-invented type into the session log therefore
made every audited session unobservable and unresumable. Keeping the audit in its own domain leaves
the session log interpretable by any Harness build, and keeps the audit durable and queryable.

Storage is an **optional** dependency. If a composition mounts no storage service, BMPP still
enforces every rule and reports the records it could not persist; a logging outage never becomes a
policy outage, and a failed audit never turns an allow into a deny.

---

## Limitations

Honest, current-state limitations:

- **Experimental.** The configuration model and the reason-code vocabulary may still change.
- **Basic Memory only.** The gate governs `mcp__basic-memory__*` and nothing else.
- **Reads are never blocked.** BMPP has no notion of a forbidden read.
- **Recall outcome is `ok` or `failed`.** Basic Memory advertises no output schema for its search
  tools, so an *empty but successful* search is indistinguishable from a populated one. BMPP refuses
  to parse result text to guess; `RECALL_EMPTY` stays modelled but is unreachable.
- **Secondary guards are partial.** The overwrite-without-read guard is implemented. The
  secret-pattern and test-fixture guards are modelled and configurable but not yet enforced.
- **The standalone Python regression layer is stale.** `tools/emit-policy-stream.mts` and
  `tools/bmpp_verify.py` were written against an earlier design in which the audit was a
  `bmpp/policy` session event. Since the audit moved to the storage sidecar, that layer reads no
  events and verifies nothing. The TypeScript suites are the authoritative verification today.
- **Not a sandbox and not a security boundary.** BMPP enforces a memory policy; it does not confine
  an agent.

---

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build    # emits lib/, which is never committed
```

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm. `pnpm test` also builds the project, because one
suite inspects the emitted JavaScript to prove the plugin imports no Harness value.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes.

---

## AI-assisted development

BMPP is developed using AI-assisted workflows, including LLM-assisted implementation, testing,
debugging and documentation, in an iterative ("vibe coding") style. This is stated plainly because it
is true and because it is relevant to how you should evaluate the project.

It is not offered as a quality guarantee in either direction. What the project relies on instead is
verifiable behaviour: a test suite that exercises the real tool registry, a compatibility envelope
that fails loudly rather than silently mis-enforcing, and the documented limitations above. Treat the
tests, not the prose, as the claim.

---

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability. Please do not open a public issue
for a security problem.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are welcome, including issues about behaviour
you think the policy gets wrong.

## License

MIT — see [LICENSE](LICENSE).

BMPP is an independent third-party plugin. It is not part of the DeepSeek Harness repository, and it
is not affiliated with or endorsed by the DeepSeek project.

---

## Português

Uma versão em português deste README está em [README.pt-BR.md](README.pt-BR.md).
