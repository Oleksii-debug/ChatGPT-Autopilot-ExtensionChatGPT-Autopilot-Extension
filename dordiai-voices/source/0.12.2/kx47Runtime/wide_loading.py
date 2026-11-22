"""Keep a cold native session construction off the cancellable speech request."""
from threading import BoundedSemaphore, Event, Lock, Thread


# The native runtimes cannot cancel InferenceSession construction. Let a
# construction finish, while new cursor requests can use already loaded data.
# Only one such operation can outlive its calling request in this process.
_construction_slot = BoundedSemaphore(1)


class DeferredValue:
    def __init__(self, factory):
        self.factory = factory
        self._lock = Lock()
        self._done = Event()
        self._running = False
        self._value = None
        self._error = None

    def _build(self):
        try:
            self._value = self.factory()
        except Exception as error:
            self._error = error
        finally:
            self._done.set()
            _construction_slot.release()

    def get(self, owner=None):
        while True:
            if owner is not None:
                owner.check_cancelled()
            if self._done.is_set():
                if self._error is not None:
                    raise self._error
                return self._value
            with self._lock:
                if not self._running and _construction_slot.acquire(blocking=False):
                    self._running = True
                    try:
                        Thread(target=self._build, daemon=True, name="dordiai model loader").start()
                    except RuntimeError:
                        self._running = False
                        _construction_slot.release()
                        raise
            self._done.wait(.012)


class DeferredSession:
    def __init__(self, factory, owner):
        from session_control import GuardedSession
        self._value = DeferredValue(lambda: GuardedSession(factory(), owner))
        self._owner = owner

    def run(self, *args, **kwargs):
        return self._value.get(self._owner).run(*args, **kwargs)
