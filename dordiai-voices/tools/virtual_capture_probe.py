"""Observer-only extension of the real NVDA probe; never replaces audio or injects speech."""
from __future__ import annotations
import argparse
import ast
from pathlib import Path
import sys


def instrument(source):
    anchors = {
        '"timeouts": [], "errors": []}':
        '"timeouts": [], "errors": [], "request_events": [], "cancel_events": []}',
        '        with LOCK:\n            ACTIVE_REQUEST = None\n        return latency':
        '        with LOCK:\n            ACTIVE_REQUEST = None\n'
        '        output["request_events"].append({"ordinal": len(output["request_events"]),\n'
        '            "language": language, "glyph": letters[language] if glyph is None else glyph,\n'
        '            "speak_started_ns": pending["started_ns"], "first_feed_ns": pending["first_feed_ns"],\n'
        '            "observed_return_ns": time.perf_counter_ns(), "wait_done": wait_done})\n'
        '        return latency',
        '            output["cancel_api_ms"].append(elapsed)':
        '            output["cancel_api_ms"].append(elapsed)\n'
        '            output["cancel_events"].append({"ordinal": len(output["cancel_events"]),\n'
        '                "request_ordinal": len(output["request_events"])-1 if value is not None else None,\n'
        '                "started_ns": started, "ended_ns": started+int(round(elapsed*1000000)),\n'
        '                "elapsed_ms": elapsed})',
    }
    for old,new in anchors.items():
        if source.count(old)!=1:
            raise ValueError("Real probe observation anchor changed; refusing a guessed instrumentation")
        source=source.replace(old,new,1)
    ast.parse(source)
    return source


def main():
    import windows_nvda_probe as probe
    # This process edits only its owned test plugin string, never the addon/controller file.
    probe.PROBE_PLUGIN=instrument(probe.PROBE_PLUGIN)
    return probe.main()


if __name__=="__main__":
    raise SystemExit(main())
