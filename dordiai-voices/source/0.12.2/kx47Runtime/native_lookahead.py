"""Prepare one short native carrier while the previous voice is speaking."""
from concurrent.futures import Future
from threading import Condition, Event, Thread, get_ident

from session_control import GuardedSession, SynthesisCancelled, cancel_running


class CarrierContext:
    def __init__(self, carrier):
        self.carrier = carrier
        self.cancel_thread = self.cancel_event = self.active_run = None

    def check_cancelled(self):
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise SynthesisCancelled()


class SharedCarrierSession:
    """Use the same graph, weights and arena, with per-request interruption."""
    def __init__(self, session, normal_owner, forecast_owner):
        self.normal = GuardedSession(session, normal_owner)
        self.forecast = GuardedSession(session, forecast_owner)

    def __getattr__(self, key):
        return getattr(self.normal, key)

    def run(self, *args, **kwargs):
        context = self.forecast if get_ident() == self.forecast.owner.cancel_thread else self.normal
        return context.run(*args, **kwargs)


class _Preparation:
    def __init__(self, token, key):
        self.token = token
        self.key = key
        self.stop = Event()
        self.result = Future()


class NativeLookahead:
    def __init__(self, provider):
        self.provider = provider
        self.changed = Condition()
        self.selected = self.pending = self.running = None
        self.closed = False
        self.thread = Thread(target=self._run, name="Next native pronunciation", daemon=True)
        self.thread.start()

    def _discard(self):
        job = self.selected
        if job is None:
            return
        job.stop.set()
        if self.running is job:
            cancel_running(self.provider, job.stop)
        if self.pending is job:
            self.pending = None
        self.selected = None

    def discard(self, token=None):
        with self.changed:
            if token is None or self.selected is not None and self.selected.token == token:
                self._discard()

    def schedule(self, hint, cancellation):
        if not hint or len(hint) != 3:
            return
        token, language, text = hint
        if not isinstance(text, str) or not 0 < len(text) <= 200:
            return
        with self.changed:
            if cancellation.is_set() or self.closed:
                return
            self._discard()
            self.selected = self.pending = _Preparation(token, (language, text))
            self.changed.notify()

    def take(self, language, text, cancellation):
        with self.changed:
            job = self.selected
            if job is None:
                return None
            if job.key != (language, text):
                self._discard()
                return None
            if cancellation.is_set():
                raise SynthesisCancelled()
            # Lookahead is optional: waiting for an unfinished forecast turns
            # a language transition into an unbounded pause. Use only work
            # already prepared; otherwise cancel it and render normally.
            if not job.result.done():
                self._discard()
                return None
            self.selected = None
        if cancellation.is_set():
            raise SynthesisCancelled()
        return job.result.result()

    def _run(self):
        self.provider.cancel_thread = get_ident()
        while True:
            with self.changed:
                self.changed.wait_for(lambda: self.pending is not None or self.closed)
                if self.closed:
                    return
                self.running = job = self.pending
                self.pending = None
                self.provider.cancel_event = job.stop
            audio = None
            try:
                source = self.provider.carrier(*job.key)
                try:
                    first = next(source, None)
                    # If the phonemizer split the input, use the normal streaming
                    # path. Never join or drop sentences to satisfy a forecast.
                    if first is not None and next(source, None) is None:
                        audio = first
                finally:
                    close = getattr(source, "close", None)
                    if close is not None:
                        close()
            except Exception:
                # A forecast is optional. The speaking thread can render
                # an uncancelled request through the ordinary path.
                audio = None
            finally:
                job.result.set_result(audio)
                with self.changed:
                    self.running = None
                    self.provider.cancel_event = None

    def close(self):
        with self.changed:
            self._discard()
            self.closed = True
            self.changed.notify()
        self.thread.join(timeout=2)
