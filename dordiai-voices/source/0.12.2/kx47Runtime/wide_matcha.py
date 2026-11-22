"""Native Kashmiri Bolbosh/Matcha ONNX carrier; no client-side PyTorch.

The pinned model operates on Kashmiri characters, not an unrelated G2P. Its
upstream normalizer drops unsupported letters. This adapter rejects them so a
caller can explicitly choose an installed same-language alternative instead.
"""
import json
from pathlib import Path
from threading import RLock
import weakref

from wide_mms import MMSCarrier, UnsupportedMMSInput, prepared_character_name

FORMAT = "dordiai-matcha-onnx-v1"
FRONTEND_FORMAT = "dordiai-matcha-native-frontend-v1"


from wide_matcha_frontend import MatchaFrontend as _NativeFrontend


class MatchaFrontend(_NativeFrontend):
    # Preserve the runtime adapter's existing unsupported-input error contract.
    InputError = UnsupportedMMSInput


class NativeMatcha(MMSCarrier):
    def __init__(self, directory, session_factory=None, owner=None):
        self.folder = Path(directory)
        self.config = json.loads((self.folder / "config.json").read_text(encoding="utf-8"))
        runtime = json.loads((self.folder / "runtime_config.json").read_text(encoding="utf-8"))
        if (runtime.get("format") != FORMAT or runtime.get("code") != "ks" or runtime.get("iso_code") != "kas"
                or runtime.get("sample_rate") != 22050 or runtime.get("steps") != 10
                or runtime.get("speaker") not in (422, 423)):
            raise ValueError("Prepared Matcha model is not the pinned native Kashmiri standard")
        self.frontend = MatchaFrontend(self.config)
        self.code = "ks"
        self.rate = self.sample_rate = 22050
        self.speaker = runtime["speaker"]
        self.temperature = float(runtime.get("temperature", .667))
        self.session_factory, self.owner = session_factory, owner
        self._graph = self._inputs = None
        self._closed = False
        self._lock = RLock()
        if owner is not None:
            from wide_loading import DeferredValue
            reference = weakref.ref(self)
            def open_if_alive():
                carrier = reference()
                return carrier._open() if carrier is not None else None
            self._deferred = DeferredValue(open_if_alive)
        else:
            self._deferred = None

    def _open(self):
        with self._lock:
            if self._closed:
                return None
        if self.session_factory is None:
            import onnxruntime as ort
            ort.disable_telemetry_events()
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            graph = ort.InferenceSession(str(self.folder / "model.onnx"), sess_options=options,
                                        providers=["CPUExecutionProvider"])
        else:
            graph = self.session_factory(self.folder / "model.onnx")
        if self.owner is not None:
            from session_control import GuardedSession
            if not isinstance(graph, GuardedSession):
                graph = GuardedSession(graph, self.owner)
        inputs = {item.name: item for item in graph.get_inputs()}
        required = {"x": "tensor(int64)", "x_lengths": "tensor(int64)",
                    "scales": "tensor(float)", "spks": "tensor(int64)"}
        if set(inputs) != set(required) or any(inputs[k].type != v for k, v in required.items()):
            raise ValueError("Unexpected native Kashmiri Matcha graph signature")
        with self._lock:
            if self._closed:
                return None
            self._graph, self._inputs = graph, inputs
        return graph

    def audio(self, text, character=False, rate=1., *, temperature=None):
        import numpy as np
        if self.owner is not None:
            self.owner.check_cancelled()
        if character and not (len(text) == 1 and text.isdecimal()):
            text = prepared_character_name("ks", text, self.folder.parent.parent)
        ids = self.frontend.ids(text)
        if len(ids) > 4096:
            raise ValueError("Native Kashmiri request must be split into shorter text")
        speed = min(2.5, max(.5, float(rate)))
        noise = self.temperature if temperature is None else float(temperature)
        if not np.isfinite(noise) or not 0. <= noise <= 1.5:
            raise ValueError("Invalid native Kashmiri sampling temperature")
        feed = {"x": np.asarray([ids], np.int64), "x_lengths": np.asarray([len(ids)], np.int64),
                "scales": np.asarray([noise, 1. / speed], np.float32),
                "spks": np.asarray([self.speaker], np.int64)}
        output, lengths = self.preload().run(None, feed)
        output = np.asarray(output, np.float32)
        count = int(np.asarray(lengths).reshape(-1)[0])
        if output.ndim != 2 or output.shape[0] != 1 or not 32 <= count <= output.shape[1]:
            raise ValueError("Native Kashmiri checkpoint returned invalid audio dimensions")
        wave = output[0, :count].copy()
        if self.owner is not None:
            self.owner.check_cancelled()
        if not np.isfinite(wave).all() or np.max(np.abs(wave)) < 1e-7:
            raise ValueError("Native Kashmiri checkpoint returned invalid or silent audio")
        return wave
