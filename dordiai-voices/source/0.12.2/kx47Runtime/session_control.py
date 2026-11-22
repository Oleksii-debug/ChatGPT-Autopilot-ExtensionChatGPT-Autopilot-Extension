"""Cancel stale speech between model stages without discarding loaded models."""

from threading import Event, RLock


class RequestCancellation:
    """Track every queued or streaming request until its final response.

    The input reader may receive several requests before the synthesis thread
    finishes one. Cancelling just the latest event leaves the current graph
    running; retain all events and interrupt the one actually in the graph.
    """
    def __init__(self):
        self._lock = RLock()
        self._requests = set()

    def new(self):
        event = Event()
        with self._lock:
            self._requests.add(event)
        return event

    def release(self, event):
        with self._lock:
            self._requests.discard(event)

    def cancel(self, owner=None):
        with self._lock:
            pending = tuple(self._requests)
            for event in pending:
                event.set()
        for event in pending:
            cancel_running(owner, event)



class SynthesisCancelled(Exception):
    pass


def cancel_running(owner, event):
    """Interrupt this request's native graph without unloading its model."""
    active = getattr(owner, "active_run", None)
    if active is not None and active[1] is event:
        active[0].terminate = True


class GuardedSession:
    def __init__(self, session, owner):
        self.session = session
        self.owner = owner

    def __getattr__(self, key):
        return getattr(self.session, key)

    def run(self, output_names, input_feed, run_options=None):
        import onnxruntime as ort
        self.owner.check_cancelled()
        options = run_options if run_options is not None else ort.RunOptions()
        active = (options, getattr(self.owner, "cancel_event", None))
        self.owner.active_run = active
        try:
            # Close the race between publishing RunOptions and a cancellation
            # received just before the native session starts.
            self.owner.check_cancelled()
            result = self.session.run(output_names, input_feed, options)
            self.owner.check_cancelled()
            return result
        except Exception:
            # ORT reports native termination as an error. Convert only a
            # genuinely cancelled request into our normal completion path.
            self.owner.check_cancelled()
            raise
        finally:
            if getattr(self.owner, "active_run", None) is active:
                self.owner.active_run = None
