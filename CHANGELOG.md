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

### Notes

- **Foundation only.** No tool interception, no state machine, no audit events, and no enforcement.
  Those land in later phases, each as its own commit; see `docs/ARCHITECTURE.md` §26.
- **Not yet installed anywhere.** No Cordis profile references BMPP, and the Harness checkout is
  untouched.

[Unreleased]: https://github.com/rafa-elricardo/bmpp/commits/main
