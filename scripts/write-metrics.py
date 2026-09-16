#!/usr/bin/env python3
"""Compute a METRICS snapshot ({contextPct, model, inputTokens, outputTokens})
from a Claude Code session transcript (.jsonl) and print it as JSON.

Usage: write-metrics.py <path-to-transcript.jsonl>
"""
from __future__ import annotations

import json
import sys

# Context window per model family. Extend as new models ship.
CONTEXT_WINDOWS = {
    "haiku": 200_000,
}
DEFAULT_CONTEXT_WINDOW = 1_000_000


def context_window_for(model: str | None) -> int:
    if not model:
        return DEFAULT_CONTEXT_WINDOW
    for needle, window in CONTEXT_WINDOWS.items():
        if needle in model:
            return window
    return DEFAULT_CONTEXT_WINDOW


def main() -> None:
    transcript_path = sys.argv[1]
    # Optional, in argv order: the Claude session id and the pipeline stage.
    # Both empty for a hand-started tab, which records nulls rather than failing.
    session_id = sys.argv[2] if len(sys.argv) > 2 else ""
    stage = sys.argv[3] if len(sys.argv) > 3 else ""

    seen_uuids: set[str] = set()
    total_output_tokens = 0
    last_context_tokens = 0
    last_timestamp = None
    first_timestamp = None
    model = None

    with open(transcript_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get("type") != "assistant":
                continue

            message = entry.get("message", {})
            usage = message.get("usage")
            uuid = entry.get("uuid")
            if not usage or uuid in seen_uuids:
                continue
            seen_uuids.add(uuid)

            model = message.get("model", model)
            total_output_tokens += usage.get("output_tokens", 0) or 0

            context_tokens = (
                (usage.get("input_tokens", 0) or 0)
                + (usage.get("cache_creation_input_tokens", 0) or 0)
                + (usage.get("cache_read_input_tokens", 0) or 0)
            )
            timestamp = entry.get("timestamp")
            if timestamp and (first_timestamp is None or timestamp < first_timestamp):
                first_timestamp = timestamp
            if last_timestamp is None or (timestamp or "") > last_timestamp:
                last_timestamp = timestamp
                last_context_tokens = context_tokens

    window = context_window_for(model)
    context_pct = round(last_context_tokens / window * 100)

    print(
        json.dumps(
            {
                "sessionId": session_id or None,
                "stage": stage or None,
                "contextPct": context_pct,
                "model": model,
                "inputTokens": last_context_tokens,
                "outputTokens": total_output_tokens,
                "startedAt": first_timestamp,
                "updatedAt": last_timestamp,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
