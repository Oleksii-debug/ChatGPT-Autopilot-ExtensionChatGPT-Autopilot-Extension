"""Cancel stale speech between model stages without discarding loaded models."""


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
