# Contributing to BMPP

Thanks for taking a look. BMPP is a small, opinionated project, so the most useful contributions are
usually focused and evidence-backed.

## Getting set up

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm (`packageManager` in `package.json` pins the
version). `pnpm test` also builds the project: one suite inspects the emitted JavaScript to prove the
plugin imports no Harness *value*, only types.

## Before you open a pull request

Run the same checks CI would:

```sh
pnpm run typecheck
pnpm test
pnpm run build
git diff --check
```

All four must pass. A pull request with a failing suite will not be reviewed until it is green.

## What a good change looks like

- **One concern per pull request.** A behaviour change and its tests belong together; an unrelated
  refactor does not.
- **Tests describe behaviour, not implementation.** Prefer exercising the real tool registry and the
  real policy pipeline over asserting on internals. The integration suites show the pattern.
- **Keep the policy machine pure.** `src/state.ts` decides; `src/gate.ts` integrates. `mode` and
  `profile` must stay out of the machine's inputs — enforcement is applied after the verdict, and a
  change that lets configuration reach the decision is a design regression.
- **No new value imports from the Harness.** `@deepseek-ai/*` is used for types only, so the emitted
  plugin imports nothing from the Harness. A test enforces this; a change that breaks it will fail.
- **Fail loud rather than guess.** If a precondition cannot be established, the honest outcome is a
  refusal with a clear reason, not a silent default.
- **Document what you changed.** Behaviour changes update the README and the relevant document in
  `docs/`, in the same pull request.

## Reporting bugs and proposing policy changes

Use issues for both. For a bug, include the BMPP version, the DeepSeek Harness version, the `mode`
and `profile` in use, and the smallest reproduction you can manage.

For a proposal about *what the policy should be* — a precondition that should exist, one that should
not, a reason code that reads badly — open an issue rather than a pull request first. The policy is
the product, and a change to it deserves discussion before code.

Security problems do **not** go in public issues. See [SECURITY.md](SECURITY.md).

## Compatibility changes

BMPP claims compatibility through an explicit envelope, never through equality. Adding a DeepSeek
Harness version to that envelope requires that you actually ran the plugin against that version and
observed it work — see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the procedure. Bumping a
version string without that evidence will be declined.

## AI-assisted contributions

AI-assisted work is welcome, and this project is itself developed that way. If a tool wrote a
substantial part of your change, say so in the pull request. The requirement is the same either way:
you are responsible for the change, and it has to pass the checks and make sense to a human reading
it.

## License

By contributing you agree that your contribution is licensed under the project's MIT license
(see [LICENSE](LICENSE)).
