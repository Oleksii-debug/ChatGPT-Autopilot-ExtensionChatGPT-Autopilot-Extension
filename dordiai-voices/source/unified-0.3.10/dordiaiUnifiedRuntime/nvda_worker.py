"""Private streaming transport for the Holos-based NVDA driver."""
import argparse
import base64
import json
import os
from pathlib import Path
from queue import Queue
import sys
from threading import Event, Thread

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
from holos_speech import FastSpeech
from session_control import SynthesisCancelled, cancel_running


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", type=Path)
    args = parser.parse_args()
    replies = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="ascii", newline="\n")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    engine = FastSpeech(args.models, args.models / "voices")
    incoming = Queue()

    def receive():
        current = None
        try:
            for line in sys.stdin.buffer:
                request = json.loads(line)
                mode = request["mode"]
                if mode=='anticipate':
                    engine.anticipate(request.get('requests',[]))
                    continue
                if mode == "cancel":
                    engine.clear_ahead()
                    if current is not None:
                        current.set()
                        source_event=getattr(engine.reader,'cancel_event',None)
                        if source_event is not None:source_event.set()
                        cancel_running(engine.reader, current)
                        active=getattr(engine.reader,'active_run',None)
                        if active is not None:active[0].terminate=True
                        cancel_running(engine.identity.tone, current)
                    continue
                if mode in ("reference","batch"):
                    current = Event()
                incoming.put((request, current))
        finally:
            if current is not None:
                current.set()
                cancel_running(engine.reader, current)
                cancel_running(engine.identity.tone, current)
            incoming.put(None)

    Thread(target=receive, daemon=True, name="Speech requests").start()
    stream = None
    metadata = None
    try:
        with replies:
            while (entry := incoming.get()) is not None:
                request, current = entry
                mode = request["mode"]
                result = {"finished": True}
                try:
                    if mode in ("drop", "reference","batch") and stream is not None:
                        stream.close()
                        stream = None
                    if mode == "preload":
                        engine.preload()
                        result = {"ready": True, "engine": "Holos"}
                    elif mode == "reference":
                        plan = engine.plan(request)
                        metadata = engine.metadata(request, plan)
                        stream = engine.blocks(request, plan,cancellation=current)
                    elif mode == 'batch':
                        stream=engine.batch_blocks(request['items'],current)
                    if mode in ("reference", "next", "batch") and stream is not None:
                        block = next(stream, None)
                        if block is not None:
                            if isinstance(block,dict):result=block
                            else:
                                if isinstance(block,tuple):block,metadata=block
                                pcm = np.rint(block * 32767).astype("<i2").tobytes()
                                result = {"chunk": base64.b64encode(pcm).decode("ascii"), **metadata}
                        else:
                            stream = None
                except SynthesisCancelled:
                    stream = None
                except Exception as error:
                    if stream is not None:
                        stream.close()
                    stream = None
                    result = {"error": str(error)}
                replies.write(json.dumps(result, ensure_ascii=True) + "\n")
                replies.flush()
    finally:
        if stream is not None:
            stream.close()


if __name__ == "__main__":
    main()
