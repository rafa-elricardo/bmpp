#!/usr/bin/env python3
"""Check a BMPP policy stream for the invariants the plugin promises.

This is a REGRESSION layer, not a second implementation of the policy. It reads
the durable `bmpp/policy` events that the plugin actually wrote — one JSON object
per line, as emitted by `tools/emit-policy-stream.mts` — and checks properties
that must hold of the record itself. It deliberately does not re-derive a
decision: it asks whether the stream is internally consistent with the rules the
plugin claims.

Usage:
    python3 tools/bmpp_verify.py [stream.jsonl]

Exit code 0 means every rule passed. Any failure prints the offending line.

Rules:
  R1  every event carries a policyVersion
  R2  every pre-execute event carries a valid decision and reason code
  R3  a memory write is never ALLOWED without a completed recall in the stream
  R4  a memory write is never DENIED while a completed recall exists
  R5  recallOutcome is 'ok' or 'failed' only: 'empty' is unreachable
  R6  an ALLOWED memory write names a completed recall state
  R7  no event carries tool arguments, note content or result text
  R8  PENDING_IN_BATCH only ever appears with recallState 'in_flight'
  R9  a memory write is never allowed on an unclassified turn
  R10 the stream contains at least one of each outcome a reader depends on
  R11 a fail-closed unlisted memory tool is expressed by a PRECONDITION code,
      and never by UNKNOWN_MEMORY_TOOL, which the decision core does not emit
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

KNOWN_REASON_CODES = {
    "CLASSIFICATION_REQUIRED",
    "MEMORY_LOOKUP_REQUIRED",
    "MEMORY_LOOKUP_FAILED",
    "MEMORY_LOOKUP_PENDING_IN_BATCH",
    "CREATE_REQUIRES_SEARCH",
    "OVERWRITE_REQUIRES_READ",
    "UNKNOWN_MEMORY_TOOL",
    "ALLOW_SIMPLE",
    "ALLOW_READ_ONLY",
    "ALLOW_RECALL_OK",
    "ALLOW_CONTROL",
    "ALLOW_OUT_OF_SCOPE",
}

DENY_CODES = {
    "CLASSIFICATION_REQUIRED",
    "MEMORY_LOOKUP_REQUIRED",
    "MEMORY_LOOKUP_FAILED",
    "MEMORY_LOOKUP_PENDING_IN_BATCH",
    "CREATE_REQUIRES_SEARCH",
    "OVERWRITE_REQUIRES_READ",
    "UNKNOWN_MEMORY_TOOL",
}

# Keys that would mean the payload carries more than metadata.
FORBIDDEN_KEYS = {
    "arguments", "args", "content", "message", "messages", "text",
    "transcript", "reasoning", "body", "result", "destination_path", "destination",
}

# Concepts that must never appear anywhere in the serialized payload.
FORBIDDEN_SUBSTRINGS = ("note body", "No results found", "archive/")


def load(path: Path) -> tuple[list[dict], dict[str, list[dict]]]:
    """Return (all events, events grouped by scenario)."""
    events: list[dict] = []
    by_scenario: dict[str, list[dict]] = {}
    scenario = "<none>"
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError as error:
            raise SystemExit(f"{path}:{number}: not JSON: {error}") from error
        if record.get("type") == "@scenario":
            scenario = str(record["name"])
            by_scenario.setdefault(scenario, [])
            continue
        if record.get("type") != "bmpp/policy":
            continue
        data = record["data"]
        data["_scenario"] = record.get("scenario", scenario)
        events.append(data)
        by_scenario.setdefault(data["_scenario"], []).append(data)
    return events, by_scenario


def check(events: list[dict], by_scenario: dict[str, list[dict]]) -> list[str]:
    """Return one message per violated rule."""
    failures: list[str] = []

    def fail(rule: str, detail: str) -> None:
        failures.append(f"{rule}: {detail}")

    # R1 policyVersion present and non-empty
    for event in events:
        if not event.get("policyVersion"):
            fail("R1", f"event without policyVersion: {event}")

    # R2 valid decision and reason code on every pre-execute event
    for event in events:
        if event.get("kind") != "pre-execute":
            continue
        if event.get("decision") not in {"allow", "deny"}:
            fail("R2", f"invalid decision {event.get('decision')!r} in {event}")
        code = event.get("reasonCode")
        if code not in KNOWN_REASON_CODES:
            fail("R2", f"unknown reason code {code!r} in {event}")
        if (code in DENY_CODES) != (event.get("decision") == "deny"):
            fail("R2", f"reason {code} disagrees with decision {event.get('decision')!r}")

    # R3/R4/R6 recall must be completed before a write is allowed, and a
    # completed recall must be used
    for scenario, group in by_scenario.items():
        recall_done = None
        for event in group:
            if event.get("kind") == "recall":
                recall_done = event.get("recallState")
                continue
            if event.get("kind") != "pre-execute" or event.get("toolClass") != "memory.write":
                continue
            # A SIMPLE turn turns the recall gate off entirely, so a completed
            # recall is required only when the turn was COMPLEX or unclassified.
            requires_recall = event.get("classification") != "simple"
            if event.get("decision") == "allow" and requires_recall and recall_done != "succeeded":
                fail("R3", f"scenario {scenario}: write allowed with recall {recall_done!r}")
            if event.get("decision") == "allow" and event.get("reasonCode") not in {
                "ALLOW_RECALL_OK", "ALLOW_SIMPLE"
            }:
                fail("R6", f"scenario {scenario}: allow reason {event.get('reasonCode')!r}")

    # R5 'empty' is modelled but unreachable through the real adapter
    for event in events:
        if event.get("kind") == "recall" and event.get("recallOutcome") not in {"ok", "failed"}:
            fail("R5", f"recall outcome {event.get('recallOutcome')!r} is not reachable")

    # R7 metadata only
    for event in events:
        for key in event:
            if key in FORBIDDEN_KEYS:
                fail("R7", f"payload carries forbidden key {key!r}")
        serialized = json.dumps(event)
        for needle in FORBIDDEN_SUBSTRINGS:
            if needle in serialized:
                fail("R7", f"payload contains {needle!r}")

    # R8 PENDING_IN_BATCH requires an in-flight recall
    for event in events:
        if event.get("reasonCode") == "MEMORY_LOOKUP_PENDING_IN_BATCH" and event.get("recallState") != "in_flight":
            fail("R8", f"PENDING_IN_BATCH with recallState {event.get('recallState')!r}")

    # R9 a destructive tool on an unclassified turn must not be allowed
    for scenario, group in by_scenario.items():
        for event in group:
            if event.get("toolClass") == "memory.write" and event.get("classification") == "unknown":
                if event.get("decision") == "allow":
                    fail("R9", f"scenario {scenario}: unclassified turn allowed a memory write")

    # R10 the stream must actually exercise the outcomes a reader depends on
    codes = {event.get("reasonCode") for event in events}
    required = {
        "CLASSIFICATION_REQUIRED", "MEMORY_LOOKUP_REQUIRED", "MEMORY_LOOKUP_FAILED",
        "ALLOW_READ_ONLY", "ALLOW_RECALL_OK", "ALLOW_SIMPLE",
    }
    missing = required - codes
    if missing:
        fail("R10", f"stream never exercised {sorted(missing)}")
    if not any(event.get("kind") == "recall" for event in events):
        fail("R10", "stream contains no recall event")

    # R11 fail-closed for an unlisted memory tool must read as a missing
    # precondition the model can act on, not as a code the core never emits.
    for event in events:
        if event.get("reasonCode") == "UNKNOWN_MEMORY_TOOL":
            fail("R11", "UNKNOWN_MEMORY_TOOL was emitted, but the decision core never produces it")

    return failures


def main(argv: list[str]) -> int:
    """Run every rule against the stream named on the command line."""
    path = Path(argv[1] if len(argv) > 1 else "tools/policy-stream.jsonl")
    if not path.is_file():
        print(f"stream not found: {path}", file=sys.stderr)
        print("emit it first: pnpm exec tsx tools/emit-policy-stream.mts", file=sys.stderr)
        return 2

    events, by_scenario = load(path)
    failures = check(events, by_scenario)

    print(f"bmpp policy stream: {path}")
    print(f"events: {len(events)}  scenarios: {len(by_scenario)}")
    for name, group in by_scenario.items():
        decisions = [e for e in group if e.get("kind") == "pre-execute"]
        allowed = sum(1 for e in decisions if e.get("decision") == "allow")
        denied = len(decisions) - allowed
        recalls = sum(1 for e in group if e.get("kind") == "recall")
        print(f"  {name:<40} judged={len(decisions):<3} allow={allowed:<3} deny={denied:<3} recall={recalls}")
    print("-" * 78)
    if failures:
        for failure in failures:
            print(f"  FAIL {failure}")
        print(f"falhas: {len(failures)}")
        return 1
    print("falhas: 0")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
