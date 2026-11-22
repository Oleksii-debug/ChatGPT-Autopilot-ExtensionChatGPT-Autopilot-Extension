"""NVDA-profile preferences and an accessible dialog for both dordiai synthesizers."""
from collections import OrderedDict

CORE_NAMES = {
    "uk": "Українська", "ru": "Російська", "en": "Англійська",
    "sk": "Словацька", "pl": "Польська", "de": "Німецька",
    "fr": "Французька", "da": "Данська", "it": "Італійська", "es": "Іспанська",
}
CONFIG_KEYS = ("dordiaiExcludedVoices", "dordiaiExcludedLanguages", "dordiaiDefaultLanguage")


def language_key(value):
    code = (value or "uk").lower().replace("_", "-")
    return {"no": "nb", "iw": "he", "zh": "cmn"}.get(code, code.split("-")[0])


class PreferencesMixin:
    def _dordiai_init(self):
        self._dordiai_selection = (frozenset(), frozenset(), "uk")

    @classmethod
    def _getConfigSpecForSettings(cls, settings):
        spec = super()._getConfigSpecForSettings(settings)
        spec.update({
            CONFIG_KEYS[0]: "string(default='')",
            CONFIG_KEYS[1]: "string(default='')",
            CONFIG_KEYS[2]: "string(default='uk')",
        })
        return spec

    def loadSettings(self, onlyChanged=False):
        super().loadSettings(onlyChanged=onlyChanged)
        import config
        section = config.conf["speech"][self.name]
        excluded_voices = frozenset(section.get(CONFIG_KEYS[0], "").split())
        excluded_languages = frozenset(section.get(CONFIG_KEYS[1], "").split())
        default = section.get(CONFIG_KEYS[2], "uk")
        voices = self._dordiai_all_voices()
        languages = self._dordiai_all_languages()
        if not voices.keys() - excluded_voices:
            excluded_voices = frozenset()
        enabled_languages = languages.keys() - excluded_languages
        if not enabled_languages:
            excluded_languages = frozenset()
            enabled_languages = languages.keys()
        if default not in enabled_languages:
            default = "uk" if "uk" in enabled_languages else next(c for c in languages if c in enabled_languages)
        self._dordiai_selection = (excluded_voices, excluded_languages, default)
        self.invalidateCache()
        if self.voice in excluded_voices:
            self.voice = next(c for c in voices if c not in excluded_voices)

    def saveSettings(self):
        super().saveSettings()
        import config
        section = config.conf["speech"][self.name]
        voices, languages, default = getattr(self, "_dordiai_selection", ((), (), "uk"))
        for key, value in zip(CONFIG_KEYS, (" ".join(sorted(voices)), " ".join(sorted(languages)), default)):
            section[key] = value

    def _dordiai_filter_voices(self, values):
        hidden = self._dordiai_selection[0]
        return OrderedDict((key, value) for key, value in values.items() if key not in hidden)

    def _dordiai_language(self, code):
        hidden = self._dordiai_selection[1]
        return self._dordiai_selection[2] if language_key(code) in hidden else code

    def _dordiai_filter_languages(self, values):
        hidden = self._dordiai_selection[1]
        return {code for code in values if language_key(code) not in hidden}

    def _dordiai_apply(self, voices, languages, default, selected_voice, settings):
        all_voices, all_languages = self._dordiai_all_voices(), self._dordiai_all_languages()
        if not voices or not set(voices) <= all_voices.keys():
            raise ValueError("Залиште ввімкненим принаймні один голос.")
        if not languages or not set(languages) <= all_languages.keys():
            raise ValueError("Залиште ввімкненою принаймні одну мову.")
        if default not in languages or selected_voice not in voices:
            raise ValueError("Основна мова й вибраний голос мають бути ввімкнені.")
        self.cancel()
        self._dordiai_selection = (
            frozenset(all_voices.keys() - set(voices)),
            frozenset(all_languages.keys() - set(languages)),
            default,
        )
        self.invalidateCache()
        for name, value in settings.items():
            setattr(self, name, value)
        from synthDriverHandler import changeVoice
        changeVoice(self, selected_voice)
        self.saveSettings()

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
            super().__init__(parent, resizeable=True, buttons={wx.OK, wx.CANCEL, wx.APPLY})

        def makeSettings(self, sizer):
            self.tabs = wx.Notebook(self)
            speech = wx.Panel(self.tabs)
            voices = wx.Panel(self.tabs)
            languages = wx.Panel(self.tabs)
            self.tabs.AddPage(speech, "Мовлення")
            self.tabs.AddPage(voices, "Голоси")
            self.tabs.AddPage(languages, "Мови")
            sizer.Add(self.tabs, proportion=1, flag=wx.EXPAND)
            speech_sizer = wx.BoxSizer(wx.VERTICAL)
            speech.SetSizer(speech_sizer)
            speech_helper = guiHelper.BoxSizerHelper(speech, sizer=speech_sizer)
            self.voice = speech_helper.addLabeledControl("Голос", wx.Choice, choices=[])
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
                    control = speech_helper.addLabeledControl(label, wx.Choice, choices=[v.name for v in values.values()])
                    value = getattr(synth, key)
                    control.SetSelection(codes.index(value) if value in codes else 0)
                    self.choices[key] = (control, codes)

            self.voice_list = self._checklist(voices, "Доступні голоси", self.voice_labels, self.original[0])
            self.language_list = self._checklist(languages, "Мови для перемикання", self.language_labels, self.original[1])
            lang_helper = guiHelper.BoxSizerHelper(languages, sizer=languages.GetSizer())
            self.fallback = lang_helper.addLabeledControl("Основна мова", wx.Choice, choices=[])
            explanation = wx.StaticText(languages, label="Текст вимкненою мовою читається основною мовою.")
            explanation.Wrap(500)
            languages.GetSizer().Add(explanation, flag=wx.TOP, border=8)
            self.voice_list.Bind(wx.EVT_CHECKLISTBOX, self._on_selection)
            self.language_list.Bind(wx.EVT_CHECKLISTBOX, self._on_selection)
            self._update_choices(synth.voice, self.original[2])

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

        def postInit(self):
            self.voice.SetFocus()

        def _save(self):
            if getSynth() is not self.synth:
                gui.messageBox("Вибрано інший синтезатор. Відкрийте його налаштування.", self.title, wx.OK | wx.ICON_INFORMATION)
                return False
            settings = {key: control.GetValue() for key, control in self.sliders.items()}
            for key, (choice, codes) in self.choices.items():
                settings[key] = codes[choice.GetSelection()]
            try:
                self.synth._dordiai_apply(
                    self.enabled_voice_codes, self.enabled_language_codes,
                    self._current(self.fallback, self.enabled_language_codes),
                    self._current(self.voice, self.enabled_voice_codes), settings,
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

    # Keep a single class per loaded driver so repeated hotkeys cannot open duplicates.
    dialog_type = getattr(synth, "_dordiai_dialog_type", None)
    if dialog_type is None:
        synth._dordiai_dialog_type = dialog_type = PreferencesDialog
    gui.mainFrame._popupSettingsDialog(dialog_type)

