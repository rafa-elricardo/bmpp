# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. That channel keeps the report private until a fix is available, and it is
the only reporting route this project commits to.

If private reporting is not available to you, open a public issue that says only that you have a
security report and asks for a private channel. Do not include the details, a proof of concept, or
any data from a real system in that issue.

Please include, as far as you can:

- what you were running (BMPP version, DeepSeek Harness version, `mode` and `profile`);
- what you observed, and what you expected;
- the smallest reproduction you can manage;
- your assessment of the impact — in particular, whether it can cause a memory write that the
  configured policy should have blocked, or expose data that should not be visible.

## What counts as a security issue here

BMPP is a policy plugin, not a sandbox. Reports are most useful when they show one of:

- **A policy bypass.** A memory operation that changes state runs even though the configured `mode`
  and `profile` say it should be denied or should ask for approval.
- **A silent mis-enforcement.** BMPP appears to enforce a rule but is reading the wrong Harness
  surface, so its decisions do not match what it reports.
- **Audit disclosure.** Anything beyond the documented metadata reaches the audit record — tool
  arguments, note content, or user text. The audit is designed to carry tool *names*, classes, turn
  numbers, verdicts and reason codes, and nothing else.
- **A load-time failure that is not loud.** A Harness surface change that BMPP should have detected
  but did not, letting it activate against a host it was not written for.

## What is out of scope

- **The behaviour of the model.** BMPP decides whether a precondition is met; it does not judge
  whether a memory is worth keeping, and it cannot make a model choose well.
- **`mode: audit` not blocking anything.** That is the documented behaviour: `audit` records the
  denial it would have applied and allows the call. Only `mode: enforce` blocks.
- **Anything outside the `mcp__basic-memory__*` namespace.** BMPP does not govern `bash`, `edit`,
  `write`, the filesystem or any other tool, and it is not a general agent-confinement mechanism.
- **Vulnerabilities in the DeepSeek Harness or in Basic Memory.** Report those to their own projects.
- **A secret pattern that BMPP's heuristic guard does not recognise.** That guard is documented as a
  heuristic and is not currently enforced; a secret without a recognisable shape passes by design.

## Supported versions

This project is experimental and pre-1.0. Security fixes are made on `main`; there are no maintained
release branches. If you are running a pinned copy, updating to the current `main` is the fix path.

## Disclosure

This project does not currently commit to a response-time SLA. Reports will be acknowledged and
investigated on a best-effort basis, and a fix will be credited in the changelog unless you ask
otherwise.
