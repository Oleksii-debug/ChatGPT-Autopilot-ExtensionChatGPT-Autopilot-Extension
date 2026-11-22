"""NVDA-profile preferences and an accessible dialog for both dordiai synthesizers."""
from collections import OrderedDict
import json

CORE_NAMES = {
    "uk": "Українська", "ru": "Російська", "en": "Англійська",
    "sk": "Словацька", "pl": "Польська", "de": "Німецька",
    "fr": "Французька", "da": "Данська", "it": "Італійська", "es": "Іспанська",
}
CONFIG_KEYS = ("dordiaiExcludedVoices", "dordiaiExcludedLanguages", "dordiaiDefaultLanguage")
ENABLED_LANGUAGES_KEY = "dordiaiEnabledLanguages"
VERSION_KEY = "dordiaiPreferencesVersion"
MODE_KEY = "dordiaiLanguageMode"
VOICE_MAP_KEY = "dordiaiLanguageVoices"
INITIAL_LANGUAGES = ("uk", "en", "ru")


def _package_component(component):
    """Load maintenance helpers locally without changing NVDA's import path."""
    import importlib.util
    from pathlib import Path
    import sys
    name = "_dordiai_preferences_" + component
    module = sys.modules.get(name)
    if module is None:
        path = Path(__file__).resolve().with_name(component + ".py")
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            raise
    return module


def install_extra_package(path, addon_root, *, references=None, engine_id="holos"):
    """Dispatch by manifest; a voice archive is not a model-resource archive."""
    from pathlib import Path
    import zipfile
    references = Path(references) if references is not None else Path(addon_root) / "kx47Runtime/models/voices"
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
    voice = "voice-package.json" in names
    resource = "dordiai-resource-pack.json" in names
    if voice == resource:
        raise ValueError("Пакет повинен містити один підтриманий маніфест: голос або мовні ресурси.")
    if voice:
        result = _package_component("voice_assets").install_voice_package(path, references, engine_id=engine_id)
        return {"kind": "voice", "directory": str(result)}
    return _package_component("package_manager").install_pack(path, addon_root=addon_root)


def list_extra_packages(addon_root, *, references=None):
    from pathlib import Path
    references = Path(references) if references is not None else Path(addon_root) / "kx47Runtime/models/voices"
    resources = [{**entry, "kind": "resource"} for entry in
                 _package_component("package_manager").list_installed_packs(addon_root=addon_root)]
    assets = _package_component("voice_assets")
    voices = [{**entry, "kind": "voice"} for entry in
              assets._packages.list_installed_packages(assets.package_root(references))]
    return resources + voices


def remove_extra_package(entry, addon_root, *, references=None):
    from pathlib import Path
    references = Path(references) if references is not None else Path(addon_root) / "kx47Runtime/models/voices"
    package_id = entry.get("id", entry.get("pack_id"))
    if entry.get("kind") == "voice":
        return _package_component("voice_assets").uninstall_voice_package(references, package_id)
    return _package_component("package_manager").uninstall_pack(package_id, addon_root=addon_root)


def begin_package_speech(synth):
    """On NVDA's main thread, keep navigation on a genuine built-in synth.

    NVDA's public setSynth(..., isFallback=True) terminates the old instance
    while preserving the configured synthesizer. Files are not changed unless
    the built-in eSpeak instance was successfully selected first.
    """
    import speech
    import synthDriverHandler as handler
    if handler.getSynth() is not synth:
        raise RuntimeError("Вибрано інший синтезатор. Пакет не змінено.")
    synth.saveSettings()
    reserve = getattr(synth, "_dordiai_begin_package_maintenance", None)
    if reserve is None:
        raise RuntimeError("Драйвер не підтримує безпечне завершення робочих процесів. Пакет не змінено.")
    maintenance = reserve()
    error = None
    try:
        speech.cancelSpeech()
        selected = handler.setSynth("espeak", isFallback=True)
    except Exception as exception:
        selected, error = False, str(exception)
    fallback = handler.getSynth()
    if not selected or fallback is None or getattr(fallback, "name", None) != "espeak":
        synth._dordiai_end_package_maintenance(maintenance)
        detail = "Не вдалося ввімкнути вбудований eSpeak для озвучення під час роботи з пакетом. Пакет не змінено."
        if error:
            detail += " " + error
        raise RuntimeError(detail)
    return {"synth_name": synth.name, "temporary_synth": fallback, "retired_driver": synth,
            "maintenance": maintenance, "maintenance_released": False}


def quiesce_package_speech(session, timeout=8.0):
    """Run in the package worker, never on NVDA's event thread."""
    session["retired_driver"]._dordiai_quiesce_package_maintenance(session["maintenance"], timeout=timeout)


def release_package_speech(session):
    if session.get("maintenance_released"):
        return
    if not session["retired_driver"]._dordiai_end_package_maintenance(session["maintenance"]):
        raise RuntimeError("Не вдалося зняти блокування оновлення пакетів.")
    session["maintenance_released"] = True


def finish_package_speech(session):
    """Restore a fresh driver after success OR rollback, without stealing a user switch.

    API success establishes selection, not physical audio-device acceptance.
    The returned detail must be surfaced alongside the package result.
    """
    import speech
    import synthDriverHandler as handler
    release_package_speech(session)
    current = handler.getSynth()
    errors = []
    if current is not session["temporary_synth"] and getattr(current, "name", None) != session["synth_name"]:
        return {"restored": False, "user_changed_synth": True, "synth": current,
                "error": False, "detail": "Залишено синтезатор, вибраний вами під час роботи з пакетом."}
    if current is not session["temporary_synth"]:
        # Reselecting dordiai manually during installation must not leave a
        # now-stale epoch alive. Preserve that same synth's latest profile, then
        # reload it; only a different synthesizer is left untouched above.
        try:
            current.saveSettings()
        except Exception as error:
            errors.append("Не вдалося зберегти останні налаштування: " + str(error))
    speech.cancelSpeech()
    try:
        selected = handler.setSynth(session["synth_name"], isFallback=True)
    except Exception as error:
        selected = False
        errors.append(str(error))
    current = handler.getSynth()
    if selected and current is not None and getattr(current, "name", None) == session["synth_name"]:
        detail = "Синтезатор автоматично перезавантажено. Нові мови можна ввімкнути в налаштуваннях."
        if errors:
            detail += " " + "; ".join(errors)
        return {"restored": True, "user_changed_synth": False, "synth": current, "error": bool(errors),
                "detail": detail}
    detail = "Не вдалося перезавантажити dordiai-voices після роботи з пакетом."
    if current is None or getattr(current, "name", None) != "espeak":
        try:
            fallback_selected = handler.setSynth("espeak", isFallback=True)
        except Exception as error:
            fallback_selected = False
            errors.append(str(error))
        current = handler.getSynth()
        if not fallback_selected or current is None or getattr(current, "name", None) != "espeak":
            detail += " Не вдалося також увімкнути резервний eSpeak. Потрібен перезапуск NVDA."
        else:
            detail += " Для навігації залишено вбудований eSpeak. Повторно виберіть dordiai-voices або перезапустіть NVDA."
    else:
        detail += " Для навігації залишено вбудований eSpeak. Повторно виберіть dordiai-voices або перезапустіть NVDA."
    if errors:
        detail += " Помилки відновлення: " + "; ".join(errors)
    return {"restored": False, "user_changed_synth": False, "synth": current, "error": True, "detail": detail}


def _safe_error_details(error):
    try:
        return _package_component("error_diagnostics").safe_error(error)
    except Exception:
        return {"type": type(error).__name__}


def _worker_import_failure(details, depth=0):
    """Classify typed worker diagnostics, never exception-message substrings."""
    if not isinstance(details, dict) or depth > 3:
        return False
    kind = details.get("type")
    if not isinstance(kind, str):
        return False
    if kind in {"SynthesisCancelled", "CancelledError"}:
        return False
    if kind in {"ImportError", "ModuleNotFoundError"}:
        return True
    return _worker_import_failure(details.get("cause"), depth + 1)


def is_fatal_import_failure(error):
    # An unsupported-text wrapper with a host ImportError as incidental context
    # is not automatically a fatal bootstrap error. Worker diagnostics are an
    # explicit typed IPC field, distinct from arbitrary text or stale notices.
    if type(error).__name__ in {"SynthesisCancelled", "CancelledError"}:
        return False
    return isinstance(error, ImportError) or _worker_import_failure(getattr(error, "dordiai_worker_error", None))


def _diagnostic_has_frame(details, module, function):
    """Match bounded safe IPC provenance; never inspect messages or paths."""
    frames = details.get("frames") if isinstance(details, dict) else None
    if not isinstance(frames, list) or not frames or len(frames) > 16:
        return False
    if any(not isinstance(frame, dict) for frame in frames):
        return False
    return any(frame.get("module") == module and frame.get("function") == function
               for frame in frames)


def _required_resource_failure_details(details):
    """Recognize only the attested bundled offline RuAccent loader failure."""
    if not isinstance(details, dict) or details.get("type") != "ModelDownloadError":
        return False
    cause = details.get("cause")
    if (not isinstance(cause, dict) or cause.get("type") != "FileNotFoundError"
            or cause.get("cause") is not None):
        return False
    # Class names alone are insufficient: unrelated downloads, user files and
    # unsupported-input wrappers must not replace the user's synthesizer.
    return (
        _diagnostic_has_frame(details, "native_multilingual", "russian_text")
        and _diagnostic_has_frame(details, "stressonnx.backends.ruaccent", "_load")
        and _diagnostic_has_frame(details, "stressonnx.download", "_download_files")
        and _diagnostic_has_frame(cause, "stressonnx.download", "_download_files")
    )


def is_fatal_required_resource_failure(error):
    """Only fresh worker metadata can attest this permanent route failure."""
    if type(error).__name__ in {"SynthesisCancelled", "CancelledError"}:
        return False
    return _required_resource_failure_details(getattr(error, "dordiai_worker_error", None))


def is_fatal_speech_failure(error):
    return is_fatal_import_failure(error) or is_fatal_required_resource_failure(error)


def _import_component(details, depth=0):
    if not isinstance(details, dict) or depth > 4:
        return None
    value = details.get("import_name")
    if details.get("type") in {"ImportError", "ModuleNotFoundError"} and isinstance(value, str):
        import re
        if re.fullmatch(r"[A-Za-z0-9_.<>-]{1,160}", value):
            return value
    return _import_component(details.get("worker"), depth + 1) or _import_component(details.get("cause"), depth + 1)


def _publish_bootstrap_notice(driver, text, details, *, allow_speech):
    """Retain a braille/error path even when speech cannot initialize."""
    driver._dordiai_last_error_notice = text
    recovery = details["recovery"]
    if allow_speech:
        try:
            from ui import message
            message(text)
            recovery["notice_delivery"] = "nvda-speech-and-braille-requested"
            return
        except Exception as error:
            recovery["notice_error"] = _safe_error_details(error)
    try:
        import braille
        braille.handler.message(text)
        recovery["notice_delivery"] = "braille-only"
    except Exception as error:
        recovery["braille_error"] = _safe_error_details(error)
        recovery["notice_delivery"] = "retained-error-details-only"
    # Never log the exception's message, requested speech text or local paths.
    try:
        from logHandler import log
        log.error("dordiai-voices: bootstrap recovery notice: %s", json.dumps(details, ensure_ascii=True))
    except Exception:
        pass


def recover_bootstrap_speech(driver, details):
    """Run only through NVDA's event queue; never reload a broken synthesizer."""
    import speech
    import synthDriverHandler as handler
    recovery = details["recovery"] = {"state": "queued", "physical_audio_verified": False}
    driver._dordiai_last_error_details = details
    required_resource = _required_resource_failure_details(details.get("worker"))
    recovery["reason"] = "required-resource-unavailable" if required_resource else "import-bootstrap-failure"
    base = ("Не вдалося завантажити потрібні ресурси dordiai-voices." if required_resource
            else "Не вдалося завантажити компоненти dordiai-voices.")
    component = _import_component(details)
    if component:
        base += " Компонент: " + component + "."
    if handler.getSynth() is not driver:
        recovery["state"] = "user-synth-preserved"
        _publish_bootstrap_notice(driver, base + " Залишено вибраний вами синтезатор.", details, allow_speech=True)
        return
    try:
        driver.saveSettings()
    except Exception as error:
        recovery["save_error"] = _safe_error_details(error)
        base += " Останні налаштування не вдалося зберегти."
    try:
        speech.cancelSpeech()
    except Exception as error:
        recovery["cancel_error"] = _safe_error_details(error)
    try:
        # NVDA normally retries the previous synth if selecting a new one fails.
        # Publicly deselect first so eSpeak failure cannot reselect this broken
        # add-on. isFallback keeps the user's configured synth/profile intact.
        cleared = handler.setSynth(None, isFallback=True)
        if not cleared or handler.getSynth() is not None:
            raise RuntimeError("Could not deselect failing synthesizer")
        recovery["espeak_selection_succeeded"] = bool(handler.setSynth("espeak", isFallback=True))
    except Exception as error:
        recovery["fallback_error"] = _safe_error_details(error)
    current = handler.getSynth()
    name = getattr(current, "name", None)
    if current is not driver and name == "espeak":
        recovery["state"] = "builtin-espeak-selected"
        text = base + " Для навігації ввімкнено вбудований eSpeak. Виправте помилку перед повторним вибором dordiai-voices."
        allow_speech = True
    elif current is not driver and name == "oneCore":
        recovery["state"] = "builtin-windows-fallback-selected"
        text = base + " eSpeak недоступний. Для навігації ввімкнено вбудований синтезатор Windows."
        allow_speech = True
    else:
        recovery["state"] = "spoken-fallback-unavailable"
        text = base + " Резервний синтезатор також недоступний. Виберіть інший синтезатор або перезапустіть NVDA. Подробиці помилки збережено."
        allow_speech = False
    _publish_bootstrap_notice(driver, text, details, allow_speech=allow_speech)


def _codes(value):
    """Read only text lists from a profile; malformed values must not enable everything."""
    return set(value.split()) if isinstance(value, str) else set()


def initial_languages(languages):
    """A fresh profile opts in to the three packaged defaults, or one installed fallback."""
    available = tuple(languages)
    enabled = set(INITIAL_LANGUAGES).intersection(available)
    if not enabled and available:
        enabled.add(available[0])
    return enabled


def load_preference_state(values, voices, languages, compatible=None):
    """Pure profile migration/validation; never activates newly installed languages implicitly.

    ``voices`` and ``languages`` must already describe installed, allowed resources.
    The legacy exclusion list is migrated when it expressed an explicit selection.
    """
    voice_ids, language_ids = set(voices), set(languages)
    if not voice_ids or not language_ids:
        raise ValueError("Немає встановленої працездатної мови та голосу.")
    hidden_voices = _codes(values.get(CONFIG_KEYS[0], "")) & voice_ids
    if not voice_ids - hidden_voices:
        hidden_voices.clear()
    enabled_voices = voice_ids - hidden_voices
    positive = values.get(ENABLED_LANGUAGES_KEY, "")
    legacy_hidden = {language_key(c) for c in _codes(values.get(CONFIG_KEYS[1], ""))}
    if _codes(positive):
        enabled_languages = {language_key(c) for c in _codes(positive)} & language_ids
    elif legacy_hidden:
        enabled_languages = language_ids - legacy_hidden
    else:
        enabled_languages = initial_languages(languages)
    if not enabled_languages:
        enabled_languages = initial_languages(languages)
    if compatible:
        readable = [code for code in languages if enabled_voices & set(compatible(code))]
        enabled_languages.intersection_update(readable)
        if not enabled_languages:
            enabled_languages = initial_languages(readable)
        if not enabled_languages:
            raise ValueError("Немає сумісної пари ввімкненого голосу та встановленої мови.")
    default = language_key(values.get(CONFIG_KEYS[2], "uk"))
    if default not in enabled_languages:
        default = next((c for c in INITIAL_LANGUAGES if c in enabled_languages),
                       next(c for c in languages if c in enabled_languages))
    mode = values.get(MODE_KEY, "auto")
    if not isinstance(mode, str) or mode not in {"auto", "forced"}:
        mode = "auto"
    try:
        candidate_map = json.loads(values.get(VOICE_MAP_KEY, "{}"))
    except (ValueError, TypeError):
        candidate_map = {}
    voice_map = {}
    if isinstance(candidate_map, dict):
        for code, voice in candidate_map.items():
            if not isinstance(code, str) or not isinstance(voice, str):
                continue
            code = language_key(code)
            if code in language_ids and voice in enabled_voices:
                allowed = set(compatible(code)) if compatible else voice_ids
                if voice in allowed:
                    voice_map[code] = voice
    return {
        "selection": (frozenset(hidden_voices), frozenset(language_ids - enabled_languages), default),
        "enabled_languages": frozenset(enabled_languages),
        "mode": mode,
        "voice_map": voice_map,
    }


def validate_preference_selection(voices, languages, default, selected_voice,
                                  all_voices, all_languages, mode="auto", voice_map=None,
                                  compatible=None):
    """Validate before cancellation or any setting mutation."""
    voices, languages = set(voices), set(languages)
    if not voices or not voices <= set(all_voices):
        raise ValueError("Залиште ввімкненим принаймні один встановлений голос.")
    if not languages or not languages <= set(all_languages):
        raise ValueError("Залиште ввімкненою принаймні одну встановлену мову.")
    if default not in languages or selected_voice not in voices:
        raise ValueError("Основна мова й вибраний голос мають бути ввімкнені.")
    if not isinstance(mode, str) or mode not in {"auto", "forced"}:
        raise ValueError("Виберіть автоматичний або примусовий режим мови.")
    for language in languages:
        options = voices & (set(compatible(language)) if compatible else set(all_voices))
        if not options:
            raise ValueError("Для мови %s немає ввімкненого сумісного голосу." % language)
    for code, voice in (voice_map or {}).items():
        if code not in all_languages or voice not in voices:
            raise ValueError("Призначення голосу містить недоступну мову або голос.")
        if compatible and voice not in set(compatible(code)):
            raise ValueError("Вибраний голос несумісний із мовою %s." % code)



def language_key(value):
    return _package_component("language_codes").canonical_language(value, default="uk")


class PreferencesMixin:
    def _dordiai_init(self):
        self._dordiai_selection = (frozenset(), frozenset(), "uk")
        self._dordiai_mode = "auto"
        self._dordiai_voice_map = {}
        self._dordiai_enabled_languages = frozenset(INITIAL_LANGUAGES)

    @classmethod
    def _getConfigSpecForSettings(cls, settings):
        spec = super()._getConfigSpecForSettings(settings)
        spec.update({
            CONFIG_KEYS[0]: "string(default='')",
            CONFIG_KEYS[1]: "string(default='')",
            CONFIG_KEYS[2]: "string(default='uk')",
            ENABLED_LANGUAGES_KEY: "string(default='')",
            VERSION_KEY: "integer(default=0)",
            MODE_KEY: "string(default='auto')",
            VOICE_MAP_KEY: "string(default='{}')",
        })
        return spec

    def loadSettings(self, onlyChanged=False):
        super().loadSettings(onlyChanged=onlyChanged)
        import config
        section = config.conf["speech"][self.name]
        voices = self._dordiai_all_voices()
        languages = self._dordiai_all_languages()
        state = load_preference_state(section, voices, languages,
                                      getattr(self, "_dordiai_compatible_voices", None))
        self._dordiai_selection = state["selection"]
        self._dordiai_enabled_languages = state["enabled_languages"]
        self._dordiai_mode = state["mode"]
        self._dordiai_voice_map = state["voice_map"]
        self.invalidateCache()
        if self.voice not in voices or self.voice in self._dordiai_selection[0]:
            self.voice = next(c for c in voices if c not in self._dordiai_selection[0])

    def saveSettings(self):
        super().saveSettings()
        import config
        section = config.conf["speech"][self.name]
        voices, languages, default = getattr(self, "_dordiai_selection", ((), (), "uk"))
        for key, value in zip(CONFIG_KEYS, (" ".join(sorted(voices)), " ".join(sorted(languages)), default)):
            section[key] = value
        enabled = set(self._dordiai_enabled_languages) & set(self._dordiai_all_languages())
        section[ENABLED_LANGUAGES_KEY] = " ".join(sorted(enabled))
        section[VERSION_KEY] = 2
        section[MODE_KEY] = self._dordiai_mode
        section[VOICE_MAP_KEY] = json.dumps(self._dordiai_voice_map, ensure_ascii=True, sort_keys=True)

    def _dordiai_filter_voices(self, values):
        hidden = self._dordiai_selection[0]
        return OrderedDict((key, value) for key, value in values.items() if key not in hidden)

    def _dordiai_language(self, code):
        default = self._dordiai_selection[2]
        if self._dordiai_mode == "forced" or language_key(code) not in self._dordiai_enabled_languages:
            return default
        return code

    def _dordiai_filter_languages(self, values):
        return {code for code in values if language_key(code) in self._dordiai_enabled_languages}

    def _dordiai_voice_options(self, language, voices=None):
        available = voices if voices is not None else self._dordiai_all_voices()
        compatible = getattr(self, "_dordiai_compatible_voices", None)
        supported = set(compatible(language_key(language))) if compatible else set(available)
        hidden = self._dordiai_selection[0]
        return OrderedDict((key, name) for key, name in available.items()
                           if key in supported and key not in hidden)

    def _dordiai_voice_for_language(self, language, fallback_voice):
        language = language_key(self._dordiai_language(language))
        options = self._dordiai_voice_options(language)
        wanted = self._dordiai_voice_map.get(language)
        if wanted in options:
            return wanted
        if fallback_voice in options:
            return fallback_voice
        if self.voice in options:
            return self.voice
        if options:
            return next(iter(options))
        raise ValueError("Для мови %s немає ввімкненого сумісного голосу." % language)

    def _dordiai_apply(self, voices, languages, default, selected_voice, settings,
                       mode=None, voice_map=None):
        all_voices, all_languages = self._dordiai_all_voices(), self._dordiai_all_languages()
        mode = mode if mode is not None else self._dordiai_mode
        voice_map = dict(self._dordiai_voice_map if voice_map is None else voice_map)
        validate_preference_selection(voices, languages, default, selected_voice,
                                      all_voices, all_languages, mode, voice_map,
                                      getattr(self, "_dordiai_compatible_voices", None))
        self.cancel()
        self._dordiai_selection = (
            frozenset(all_voices.keys() - set(voices)),
            frozenset(all_languages.keys() - set(languages)),
            default,
        )
        self._dordiai_mode, self._dordiai_voice_map = mode, voice_map
        self._dordiai_enabled_languages = frozenset(languages)
        self.invalidateCache()
        for name, value in settings.items():
            setattr(self, name, value)
        from synthDriverHandler import changeVoice
        changeVoice(self, selected_voice)
        self.saveSettings()

    def _dordiai_report_error(self, error):
        """Announce synthesis failures on NVDA's event thread without flooding typing echo.

        ui.message updates braille as well as speech. The caller retains responsibility
        for detailed exception logging and for not reporting a failed utterance as spoken.
        """
        from time import monotonic
        self._dordiai_last_error = str(error)
        details = _safe_error_details(error)
        self._dordiai_last_error_details = details
        if is_fatal_speech_failure(error):
            # A fatal loader failure must bypass the ordinary five-second notice limit.
            # One queued recovery per driver prevents a failed notice looping
            # through the same broken synth. Runtime/model work never switches
            # synthesizers directly from the producer thread.
            if getattr(self, "_dordiai_fatal_recovery_scheduled", False):
                previous = getattr(self, "_dordiai_fatal_error_details", None)
                if isinstance(previous, dict):
                    previous["repeat_count"] = int(previous.get("repeat_count", 0)) + 1
                    self._dordiai_last_error_details = previous
                return
            self._dordiai_fatal_recovery_scheduled = True
            self._dordiai_fatal_error_details = details
            import queueHandler
            queueHandler.queueFunction(queueHandler.eventQueue, recover_bootstrap_speech, self, details)
            return
        now = monotonic()
        if now - getattr(self, "_dordiai_last_error_time", float("-inf")) < 5.0:
            return
        self._dordiai_last_error_time = now
        import queueHandler
        from ui import message
        queueHandler.queueFunction(
            queueHandler.eventQueue, message,
            "Помилка dordiai-voices. " + self._dordiai_last_error[:300],
        )

    def _dordiai_open_settings(self):
        open_dialog(self)


def open_dialog(synth):
    # These imports stay outside the driver's startup and audio preparation path.
    import wx
    import gui
    from gui import guiHelper
    from gui.settingsDialogs import SettingsDialog
    from synthDriverHandler import getSynth

    class PreferencesDialog(SettingsDialog):
        title = synth.description + " — налаштування"

        def __init__(self, parent):
            self.synth = synth
            self.voice_labels = synth._dordiai_all_voices()
            self.language_labels = synth._dordiai_all_languages()
            self.voice_codes = list(self.voice_labels)
            self.language_codes = list(self.language_labels)
            self.original = synth._dordiai_selection
            self.voice_map = dict(synth._dordiai_voice_map)
            self.mapping_code = None
            self._package_busy = False
            super().__init__(parent, resizeable=True, buttons={wx.OK, wx.CANCEL, wx.APPLY})

        def makeSettings(self, sizer):
            self.tabs = wx.Notebook(self)
            speech = wx.Panel(self.tabs)
            voices = wx.Panel(self.tabs)
            languages = wx.Panel(self.tabs)
            packages = wx.Panel(self.tabs)
            self.tabs.AddPage(speech, "Мовлення")
            self.tabs.AddPage(voices, "Голоси")
            self.tabs.AddPage(languages, "Мови")
            self.tabs.AddPage(packages, "Пакети")
            sizer.Add(self.tabs, proportion=1, flag=wx.EXPAND)
            speech_sizer = wx.BoxSizer(wx.VERTICAL)
            speech.SetSizer(speech_sizer)
            speech_helper = guiHelper.BoxSizerHelper(speech, sizer=speech_sizer)
            self.voice = speech_helper.addLabeledControl("Основний голос", wx.Choice, choices=[])
            self.mode = speech_helper.addLabeledControl(
                "Визначення мови", wx.Choice,
                choices=["Автоматично: позначки, словники й контекст", "Примусово: тільки основна мова"],
            )
            self.mode.SetSelection(1 if synth._dordiai_mode == "forced" else 0)
            self.sliders = {}
            for key, label, low, high in (
                ("rate", "Швидкість, відсотків", 0, 100),
                ("rateMultiplier", "Множник швидкості", 1, 5),
                ("volume", "Гучність, відсотків", 0, 100),
                ("pitch", "Висота, відсотків", 0, 100),
                ("timbre", "Тембр, відсотків", 0, 100),
            ):
                self.sliders[key] = speech_helper.addLabeledControl(
                    label, wx.SpinCtrl, min=low, max=high, initial=int(getattr(synth, key)),
                    style=wx.SP_ARROW_KEYS,
                )
            self.choices = {}
            for key, label, property_name in (
                ("numberLanguage", "Мова чисел", "availableNumberlanguages"),
                ("spellingLanguage", "Мова кириличних літер", "availableSpellinglanguages"),
                ("readingStyle", "Режим читання", "availableReadingstyles"),
            ):
                values = getattr(synth, property_name, None)
                if values:
                    codes = list(values)
                    control = speech_helper.addLabeledControl(label, wx.Choice, choices=[v.displayName for v in values.values()])
                    value = getattr(synth, key)
                    control.SetSelection(codes.index(value) if value in codes else 0)
                    self.choices[key] = (control, codes)

            self.voice_list = self._checklist(voices, "Доступні голоси", self.voice_labels, self.original[0])
            self.language_list = self._checklist(languages, "Мови для перемикання", self.language_labels, self.original[1])
            lang_helper = guiHelper.BoxSizerHelper(languages, sizer=languages.GetSizer())
            self.fallback = lang_helper.addLabeledControl("Основна мова", wx.Choice, choices=[])
            self.mapping_language = lang_helper.addLabeledControl("Мова для призначення голосу", wx.Choice, choices=[])
            self.mapping_voice = lang_helper.addLabeledControl("Голос для цієї мови", wx.Choice, choices=[])
            self.mapping_language.Bind(wx.EVT_CHOICE, self._on_mapping_language)
            self.mapping_voice.Bind(wx.EVT_CHOICE, self._on_mapping_voice)
            explanation = wx.StaticText(languages, label=(
                "Показано встановлені мови. Галочка вмикає мову, але не видаляє її файли. "
                "Нові мови потрібно вмикати окремо. Текст вимкненою мовою читається основною мовою. "
                "Виберіть мову й сумісний голос. У примусовому режимі весь текст читається основною мовою."
            ))
            explanation.Wrap(500)
            languages.GetSizer().Add(explanation, flag=wx.TOP, border=8)
            self.voice_list.Bind(wx.EVT_CHECKLISTBOX, self._on_selection)
            self.language_list.Bind(wx.EVT_CHECKLISTBOX, self._on_selection)
            self._update_choices(synth.voice, self.original[2])
            self._make_packages(packages)
            self.Bind(wx.EVT_CLOSE, self._on_close)

        def _package_manager(self):
            return _package_component("package_manager")

        def _package_root(self):
            from pathlib import Path
            return Path(__file__).resolve().parent.parent

        def _voice_reference_root(self):
            from pathlib import Path
            value = getattr(self.synth, "_voiceReferences", None)
            if value is not None:
                return Path(value)
            models = getattr(self.synth, "_models", None)
            return Path(models) / "voices" if models is not None else self._package_root() / "kx47Runtime/models/voices"

        def _make_packages(self, panel):
            box = wx.BoxSizer(wx.VERTICAL)
            panel.SetSizer(box)
            helper = guiHelper.BoxSizerHelper(panel, sizer=box)
            self.packages = helper.addLabeledControl("Установлені додаткові пакети", wx.ListBox,
                                                    choices=[], size=(510, 180))
            self.install_package = wx.Button(panel, label="Установити пакет із ZIP-файла…")
            self.remove_package = wx.Button(panel, label="Видалити вибраний пакет…")
            self.rollback_package = wx.Button(panel, label="Вибрати попередню версію голосу…")
            self.install_package.Bind(wx.EVT_BUTTON, self._install_package)
            self.remove_package.Bind(wx.EVT_BUTTON, self._remove_package)
            self.rollback_package.Bind(wx.EVT_BUTTON, self._rollback_voice_package)
            self.packages.Bind(wx.EVT_LISTBOX, self._on_package_selection)
            box.Add(self.install_package, flag=wx.TOP, border=8)
            box.Add(self.remove_package, flag=wx.TOP, border=8)
            box.Add(self.rollback_package, flag=wx.TOP, border=8)
            self.package_status = wx.StaticText(panel, label=(
                "Основний комплект не видаляється тут. Під час роботи з пакетом навігацію озвучує "
                "вбудований eSpeak. Потім dordiai-voices автоматично перезавантажиться, "
                "і можна буде ввімкнути нові мови на вкладці «Мови»."
            ))
            self.package_status.Wrap(500)
            box.Add(self.package_status, flag=wx.TOP, border=8)
            self._refresh_packages()

        def _refresh_packages(self):
            try:
                self.package_entries = list_extra_packages(self._package_root(), references=self._voice_reference_root())
                self.packages.SetItems([
                    "%s: %s%s%s" % (
                        "Голос" if entry.get("kind") == "voice" else "Мовні ресурси",
                        entry.get("name", entry.get("id", "Пакет")),
                        " — " + str(entry["version"]) if entry.get("version") else "",
                        " — потребує відновлення" if entry.get("status") == "unavailable" else "",
                    ) for entry in self.package_entries
                ])
                if self.package_entries:
                    self.packages.SetSelection(0)
                self.remove_package.Enable(bool(self.package_entries) and not self._package_busy)
                self._on_package_selection()
            except Exception as error:
                self.package_entries = []
                self.packages.SetItems([])
                self.remove_package.Enable(False)
                self.rollback_package.Enable(False)
                self.package_status.SetLabel("Не вдалося прочитати список пакетів: " + str(error))

        def _on_package_selection(self, event=None):
            index = self.packages.GetSelection()
            enabled = (not self._package_busy and 0 <= index < len(self.package_entries)
                       and self.package_entries[index].get("kind") == "voice")
            self.rollback_package.Enable(enabled)
            if event is not None:
                event.Skip()

        def _install_package(self, event):
            if self._package_busy:
                return
            with wx.FileDialog(self, "Виберіть мовний або голосовий пакет",
                               wildcard="Пакети (*.zip;*.dordiai-voice)|*.zip;*.dordiai-voice",
                               style=wx.FD_OPEN | wx.FD_FILE_MUST_EXIST) as dialog:
                if dialog.ShowModal() != wx.ID_OK:
                    return
                path = dialog.GetPath()
            self._run_package_operation("Установлення пакета…", lambda: install_extra_package(
                path, self._package_root(), references=self._voice_reference_root(),
                engine_id=getattr(self.synth, "_referenceEngine", "holos")))

        def _remove_package(self, event):
            if self._package_busy:
                return
            index = self.packages.GetSelection()
            if not 0 <= index < len(self.package_entries):
                return
            entry = self.package_entries[index]
            pack_id = entry.get("id", entry.get("pack_id"))
            if not pack_id:
                gui.messageBox("У пакета немає коректного ідентифікатора.", self.title, wx.OK | wx.ICON_ERROR)
                return
            result = gui.messageBox(
                "Видалити пакет «%s» з диска? Синтезатор автоматично перезавантажиться. "
                "Мови, яким потрібні його ресурси, стануть недоступними." % entry.get("name", pack_id),
                self.title, wx.YES_NO | wx.NO_DEFAULT | wx.ICON_QUESTION,
            )
            if result != wx.YES:
                return
            self._run_package_operation("Видалення пакета…", lambda: remove_extra_package(
                entry, self._package_root(), references=self._voice_reference_root()))

        def _rollback_voice_package(self, event):
            if self._package_busy:
                return
            index = self.packages.GetSelection()
            if not 0 <= index < len(self.package_entries):
                return
            entry = self.package_entries[index]
            if entry.get("kind") != "voice":
                return
            assets = _package_component("voice_assets")
            try:
                versions = [document["version"] for document in assets.voice_versions(
                    self._voice_reference_root(), entry["id"]) if document["version"] != entry.get("version")]
            except Exception as error:
                gui.messageBox(str(error), self.title, wx.OK | wx.ICON_ERROR)
                return
            if not versions:
                gui.messageBox("Інших установлених версій цього голосу немає.", self.title,
                               wx.OK | wx.ICON_INFORMATION)
                return
            with wx.SingleChoiceDialog(self, "Виберіть установлену версію голосу", self.title, versions) as dialog:
                if dialog.ShowModal() != wx.ID_OK:
                    return
                version = versions[dialog.GetSelection()]
            self._run_package_operation("Перевірка й активація версії голосу…", lambda: assets.activate_voice_version(
                self._voice_reference_root(), entry["id"], version,
                engine_id=getattr(self.synth, "_referenceEngine", "holos")))

        def _run_package_operation(self, status, operation):
            from threading import Thread
            from ui import message
            # Save the current dialog's validated settings before terminating
            # its synth. A fresh driver will read the same NVDA profile later.
            if not self._save():
                return
            try:
                self._package_speech = begin_package_speech(self.synth)
            except Exception as error:
                detail = str(error)
                self.package_status.SetLabel(detail)
                gui.messageBox(detail, self.title, wx.OK | wx.ICON_ERROR)
                if getSynth() is not self.synth:
                    # Even a failed NVDA switch can terminate the old instance.
                    # Never leave an editable dialog bound to that object.
                    super().onCancel(None)
                return
            self._package_busy = True
            for index in range(3):
                self.tabs.GetPage(index).Enable(False)
            self.install_package.Enable(False)
            self.remove_package.Enable(False)
            self.rollback_package.Enable(False)
            self.package_status.SetLabel(status)
            message(status)

            def work():
                success, detail = False, ""
                try:
                    quiesce_package_speech(self._package_speech)
                    operation()
                except Exception as error:
                    detail = str(error)
                else:
                    success, detail = True, "Пакет змінено й перевірено."
                finally:
                    try:
                        release_package_speech(self._package_speech)
                    except Exception as error:
                        success, detail = False, detail + " " + str(error)
                wx.CallAfter(self._package_finished, success, detail)
            try:
                Thread(target=work, daemon=True, name="Dordiai package operation").start()
            except Exception as error:
                detail = "Не вдалося почати операцію з пакетом: " + str(error)
                try:
                    release_package_speech(self._package_speech)
                except Exception as cleanup_error:
                    detail += " " + str(cleanup_error)
                self._package_finished(False, detail)

        def _package_finished(self, success, detail):
            # A rolled-back transaction can replace the index too, so always
            # restore a new driver after a transaction has run.
            try:
                restored = finish_package_speech(self._package_speech)
            except Exception as error:
                restored = {"restored": False, "error": True, "synth": getSynth(),
                            "detail": "Помилка відновлення озвучення: " + str(error)}
            detail += " " + restored["detail"]
            self._package_busy = False
            self.package_status.SetLabel(detail)
            gui.messageBox(detail, self.title, wx.OK | (wx.ICON_INFORMATION if success and not restored["error"] else wx.ICON_ERROR))
            # The old dialog holds a terminated driver and outdated model/voice
            # choices. Close it and build a new dialog from the restored driver.
            super().onCancel(None)
            current = restored.get("synth")
            if restored["restored"] and current is not None:
                wx.CallAfter(current._dordiai_open_settings)

        def _on_close(self, event):
            if self._package_busy:
                event.Veto()
                return
            event.Skip()

        def _checklist(self, parent, label, values, excluded):
            box = wx.BoxSizer(wx.VERTICAL)
            parent.SetSizer(box)
            helper = guiHelper.BoxSizerHelper(parent, sizer=box)
            control = helper.addLabeledControl(label, wx.CheckListBox, choices=list(values.values()), size=(510, 255))
            for i, code in enumerate(values):
                control.Check(i, code not in excluded)
            buttons = wx.BoxSizer(wx.HORIZONTAL)
            for label, state in (("Увімкнути всі", True), ("Вимкнути всі", False)):
                button = wx.Button(parent, label=label)
                button.Bind(wx.EVT_BUTTON, lambda event, c=control, s=state: self._check_all(c, s))
                buttons.Add(button, flag=wx.RIGHT, border=8)
            box.Add(buttons, flag=wx.TOP, border=8)
            return control

        def _check_all(self, control, state):
            for i in range(control.GetCount()):
                control.Check(i, state)
            self._update_choices()

        def _on_selection(self, event):
            self._update_choices()
            event.Skip()

        @staticmethod
        def _current(choice, codes):
            i = choice.GetSelection()
            return codes[i] if 0 <= i < len(codes) else None

        def _update_choices(self, wanted_voice=None, wanted_language=None):
            self._store_mapping()
            wanted_mapping = self.mapping_code
            wanted_voice = wanted_voice or self._current(self.voice, getattr(self, "enabled_voice_codes", []))
            wanted_language = wanted_language or self._current(self.fallback, getattr(self, "enabled_language_codes", []))
            self.enabled_voice_codes = [self.voice_codes[i] for i in self.voice_list.GetCheckedItems()]
            self.enabled_language_codes = [self.language_codes[i] for i in self.language_list.GetCheckedItems()]
            for control, codes, labels, preferred in (
                (self.voice, self.enabled_voice_codes, self.voice_labels, wanted_voice),
                (self.fallback, self.enabled_language_codes, self.language_labels, wanted_language),
            ):
                control.SetItems([labels[c] for c in codes])
                if codes:
                    control.SetSelection(codes.index(preferred) if preferred in codes else 0)
            self.voice_map = {code: voice for code, voice in self.voice_map.items()
                              if code in self.language_labels and voice in self.enabled_voice_codes}
            self.mapping_language.SetItems([self.language_labels[c] for c in self.enabled_language_codes])
            if self.enabled_language_codes:
                index = self.enabled_language_codes.index(wanted_mapping) if wanted_mapping in self.enabled_language_codes else 0
                self.mapping_language.SetSelection(index)
                self.mapping_code = self.enabled_language_codes[index]
            else:
                self.mapping_code = None
            self._update_mapping_voices()

        def _store_mapping(self):
            if not self.mapping_code or not hasattr(self, "mapping_voice_codes"):
                return
            voice = self._current(self.mapping_voice, self.mapping_voice_codes)
            if voice:
                self.voice_map[self.mapping_code] = voice
            else:
                self.voice_map.pop(self.mapping_code, None)

        def _update_mapping_voices(self):
            compatible = getattr(self.synth, "_dordiai_compatible_voices", None)
            allowed = set(compatible(self.mapping_code)) if compatible and self.mapping_code else set(self.voice_codes)
            self.mapping_voice_codes = [None] + [c for c in self.enabled_voice_codes if c in allowed]
            self.mapping_voice.SetItems(["Основний сумісний голос"] + [self.voice_labels[c] for c in self.mapping_voice_codes[1:]])
            wanted = self.voice_map.get(self.mapping_code)
            self.mapping_voice.SetSelection(self.mapping_voice_codes.index(wanted) if wanted in self.mapping_voice_codes else 0)
            self.mapping_voice.Enable(bool(self.mapping_code))

        def _on_mapping_language(self, event):
            self._store_mapping()
            self.mapping_code = self._current(self.mapping_language, self.enabled_language_codes)
            self._update_mapping_voices()
            event.Skip()

        def _on_mapping_voice(self, event):
            self._store_mapping()
            event.Skip()

        def postInit(self):
            self.voice.SetFocus()

        def _save(self):
            if self._package_busy:
                gui.messageBox("Дочекайтеся завершення роботи з пакетом.", self.title, wx.OK | wx.ICON_INFORMATION)
                return False
            if getSynth() is not self.synth:
                gui.messageBox("Вибрано інший синтезатор. Відкрийте його налаштування.", self.title, wx.OK | wx.ICON_INFORMATION)
                return False
            self._store_mapping()
            settings = {key: control.GetValue() for key, control in self.sliders.items()}
            for key, (choice, codes) in self.choices.items():
                settings[key] = codes[choice.GetSelection()]
            try:
                self.synth._dordiai_apply(
                    self.enabled_voice_codes, self.enabled_language_codes,
                    self._current(self.fallback, self.enabled_language_codes),
                    self._current(self.voice, self.enabled_voice_codes), settings,
                    mode="forced" if self.mode.GetSelection() == 1 else "auto",
                    voice_map=self.voice_map,
                )
            except ValueError as error:
                gui.messageBox(str(error), self.title, wx.OK | wx.ICON_ERROR)
                return False
            return True

        def onApply(self, event):
            self._save()

        def onOk(self, event):
            if self._save():
                super().onOk(event)

        def onCancel(self, event):
            if self._package_busy:
                gui.messageBox("Дочекайтеся завершення роботи з пакетом.", self.title, wx.OK | wx.ICON_INFORMATION)
                return
            super().onCancel(event)

    # Keep a single class per loaded driver so repeated hotkeys cannot open duplicates.
    dialog_type = getattr(synth, "_dordiai_dialog_type", None)
    if dialog_type is None:
        synth._dordiai_dialog_type = dialog_type = PreferencesDialog
    popup = getattr(gui.mainFrame, "popupSettingsDialog", None)
    if popup is None:
        popup = gui.mainFrame._popupSettingsDialog
    popup(dialog_type)

