# Changelog

All notable changes to BMPP are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release records the DeepSeek Harness versions it was verified against. Compatibility is claimed
by an explicit envelope, never by version equality — see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## [Unreleased]

### Added

- Initial standalone project: `package.json` as a DSH bundle (`dsh.bundle.patch`), the
  `cordis.patch.yml` configuration layer, an MIT `LICENSE`, editor/build configuration and a
  gitignore that keeps local overlays, build output and machine-specific paths out of history.
- `src/config.ts` — the `mode` (`off` / `audit` / `enforce`) × `profile` (`compat` / `strict`)
  configuration model with a dependency-free validator, stable error codes, the approved defaults
  (`audit` + `compat`), and an explicit table of what `strict` changes and what it deliberately
  leaves alone.
- `src/version.ts` — BMPP's own version line, the Harness compatibility envelope
  (`>=0.1.5-rc.2 <0.2.0`), best-effort Harness version detection, and a pure compatibility
  classifier.
- `src/index.ts` — the Cordis plugin entry point: configuration validation, a structural probe of
  the injected `tools` service, the load-time activation decision, and a one-line load report. It
  registers no interception yet.
- `docs/ARCHITECTURE.md` — the full design (migration of the working design document).
- `docs/COMPATIBILITY.md` — the version envelope, detection strategy and re-verification procedure.
- `docs/DISTRIBUTION.md` — the development and distribution mechanisms, the bundle installation
  path, dependency-declaration rationale, repository hygiene and the license analysis.
- Unit tests for the configuration model and the version classifier.
- `src/state.ts` — the pure policy state machine and its reason-code vocabulary:
  `decide()` returns the verdict, the reason and the audit event, with `mode` and
  `profile` deliberately absent from its inputs.
- `src/gate.ts` — the integration layer: `tools/pre-execute`, `tools/result`,
  `session/disposed`, and the `bmpp__classify` control tool, registered on the
  real Harness runtime.
- `src/audit.ts` — durable `bmpp/policy` session events in two shapes
  (`pre-execute` and `recall`), with `policyTurn` and `harnessTurn` kept
  distinct and the append isolated from the verdict: a failed audit is counted
  and reported, and never changes what the policy decides.

- Integration coverage for the **real Basic Memory contract**: the 21 tool
  identities of Basic Memory 0.23.2 registered on the genuine `ToolRuntime` and
  served by local MCP-shaped fixtures. It pins the bridge's naming rule, the
  read/write/destructive split, the recall signal (`isError` only), the absence
  of `structuredContent` and `outputSchema`, and the `move_note` /
  `archive/` behaviour — including the write-tracking gap for moves, asserted as
  an observed limitation rather than papered over.

- `move_note` tracking: a state-changing memory operation is now identified by
  **tool + origin + destination**, where the destination records whether it came
  from `destination_path` or `destination_folder`. Two moves of one note to two
  different places are two operations; the same move twice is one. The recall
  gate, the reason codes, the classification of `move_note` and its
  non-destructive status are unchanged.
- `tools/emit-policy-stream.mts` and `tools/bmpp_verify.py` — an independent
  regression layer over the durable `bmpp/policy` stream: the emitter drives the
  real pipeline and writes the events, the verifier checks the record's
  invariants in Python without sharing code with the implementation.

### Notes

- **Gate mounted, audit durable, not yet installed anywhere.** The policy is enforced in-process and
  every decision is written to the session log; no Cordis profile references BMPP yet, and the
  Harness checkout is untouched.
- **Recall outcome is `ok` or `failed` only.** The MCP bridge advertises no output schema for the
  search tool, so an empty-but-successful search is indistinguishable from a populated one and BMPP
  refuses to parse content text to guess. `RECALL_EMPTY` stays modelled but unreachable; see
  `docs/ARCHITECTURE.md` §7.4(a).
- **`UNKNOWN_MEMORY_TOOL` is never emitted.** The code stays in the closed
  vocabulary, but an unclassified tool inside the memory namespace fails closed
  through the applicable precondition code, so the model receives the actionable
  instruction. `tools/bmpp_verify.py` rule R11 enforces that.
- **Secondary guards still pending.** The overwrite-without-read guard is enforced (except under
  `profile: strict`, where behaviour is unchanged); the secret-pattern and test-fixture guards are
  not implemented yet.

[Unreleased]: https://github.com/rafa-elricardo/bmpp/commits/main
