# Changelog

All notable changes to BMPP are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release records the DeepSeek Harness versions it was verified against. Compatibility is claimed
by an explicit envelope, never by version equality — see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## [Unreleased]

### Added

- Initial standalone project: `package.json` as a DSH bundle (`dsh.bundle.patch`), the
  `cordis.patch.yml` configuration layer, an MIT `LICENSE`, editor/build configuration, and a
  gitignore that keeps local overlays, build output and machine-specific paths out of history.
- `src/config.ts` — the `mode` (`off` / `audit` / `enforce`) × `profile` (`compat` / `strict`)
  configuration model with a dependency-free validator, stable error codes, the approved defaults
  (`audit` + `compat`), and an explicit table of what `strict` changes and what it deliberately
  leaves alone.
- `src/version.ts` — BMPP's own version line, the Harness compatibility envelope
  (`>=0.1.5-rc.2 <0.2.0`), Harness version detection, and a pure compatibility classifier.
- `src/state.ts` — the pure policy state machine and its reason-code vocabulary. `decide()` returns
  the verdict, the reason and a decision event, with `mode` and `profile` deliberately absent from
  its inputs.
- `src/gate.ts` — the integration layer: `tools/pre-execute`, `tools/result`, `session/disposed`,
  the `bmpp__classify` control tool, and the turn lifecycle that discards a previous turn's
  classification and recall state when the Harness turn advances.
- **Batch semantics** — a lookup and a mutation issued in the same parallel batch are detected, and
  the write fails closed with `MEMORY_LOOKUP_PENDING_IN_BATCH` rather than being satisfied by a
  search that had not landed yet.
- `src/audit-sink.ts`, `src/audit-store.ts` — the audit record schema (domain `bmpp_audit`,
  version 1, per-record layout) and its durable store, written through the Harness's public
  `storageDomain` service. Metadata only: no tool arguments, no note content, no user text.
- `bmpp__classify` — the model-facing control tool that declares a turn `simple` or `complex`.
- Integration coverage for the **real Basic Memory contract**: the 21 tool identities of Basic
  Memory 0.23.2 registered on the genuine `ToolRuntime` and served by local MCP-shaped fixtures. It
  pins the bridge's naming rule, the read/write/destructive split, the recall signal (`isError`
  only), the absence of `structuredContent` and `outputSchema`, and the `move_note` / `archive/`
  behaviour.
- `move_note` tracking: a state-changing memory operation is identified by **tool + origin +
  destination**, where the destination records whether it came from `destination_path` or
  `destination_folder`. Two moves of one note to two different places are two operations; the same
  move twice is one.
- A session-compatibility regression suite that drives the **real JSONL persistence backend**: it
  persists a session carrying BMPP activity, reopens it through the real reader, and asserts that
  the log carries no event type the Harness cannot interpret while the audit sidecar holds the
  records.
- `docs/ARCHITECTURE.md`, `docs/COMPATIBILITY.md`, `docs/DISTRIBUTION.md` — the design record, the
  compatibility strategy, and the development versus distribution mechanisms.

### Changed

- **The audit no longer uses the DSH session event log.** It previously persisted `bmpp/policy`
  session events. A session event type the Harness does not know is required-on-read, and the
  public `Session.append` API offers no way for a plugin to mark its own event type as safe to omit,
  so every audited session became unobservable and unresumable. The audit now lives in a
  plugin-owned storage sidecar; the session log stays interpretable by any Harness build.
  Storage is an optional dependency: without it, BMPP enforces every rule and reports the records it
  could not persist.
- **Harness version detection now anchors on the host application entry point** instead of on BMPP's
  own module. Resolving from BMPP's module read BMPP's *own* pinned Harness dependency and reported
  the development dependency as the host version, which made the compatibility check meaningless in
  a development overlay.

### Notes

- **Gate mounted; audit durable; not published to a registry.** The policy is enforced in-process and
  every decision is recorded in the audit sidecar. No Cordis profile references BMPP by default, and
  the official Harness checkout is never modified.
- **Recall outcome is `ok` or `failed` only.** The MCP bridge advertises no output schema for the
  search tool, so an empty-but-successful search is indistinguishable from a populated one and BMPP
  refuses to parse content text to guess. `RECALL_EMPTY` stays modelled but unreachable.
- **`UNKNOWN_MEMORY_TOOL` is never emitted.** The code stays in the closed vocabulary, but an
  unclassified tool inside the memory namespace fails closed through the applicable precondition
  code, so the model receives the actionable instruction.
- **Secondary guards are partial.** The overwrite-without-read guard is implemented. The
  secret-pattern and test-fixture guards are modelled and configurable but not yet enforced.
- **The standalone Python regression layer is stale.** `tools/emit-policy-stream.mts` and
  `tools/bmpp_verify.py` were written against the earlier session-event audit and no longer observe
  anything. The TypeScript suites are the authoritative verification.

### Compatibility

- Verified against DeepSeek Harness `0.1.5-rc.2` and `0.1.6-alpha.1`, both inside the declared
  envelope `>=0.1.5-rc.2 <0.2.0`.

[Unreleased]: https://github.com/rafa-elricardo/bmpp/commits/main
