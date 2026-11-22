"""Use the focused keyboard locale only inside NVDA's genuine typing event."""
import api
import config
import globalPluginHandler
import globalVars
import languageHandler
from synthDriverHandler import getSynth
from winBindings import user32


def _valid_focus(driver, obj):
    try:
        return (not globalVars.appArgs.secure and getSynth() is driver and
                api.getFocusObject() is obj and not api.isTypingProtected() and
                config.conf["speech"]["trustVoiceLanguage"] and
                config.conf["speech"]["autoLanguageSwitching"])
    except Exception:
        return False


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def event_typedCharacter(self, obj, nextHandler, ch):
        driver = getSynth()
        factory = getattr(driver, "_dordiai_typing_context", None)
        if (getattr(driver, "name", None) != "kx47Preview" or
                not callable(factory) or not _valid_focus(driver, obj)):
            nextHandler()
            return
        thread = getattr(obj, "windowThreadID", 0)
        if not thread:
            nextHandler()
            return
        try:
            layout = user32.GetKeyboardLayout(thread)
            locale = languageHandler.windowsLCIDToLocaleName(int(layout) & 0xffff) if layout else None
        except Exception:
            locale = None
        if not locale:
            nextHandler()
            return
        # Active before NVDA builds spelling/symbol names and optional word
        # echo. The normal handler owns suppression, passwords, capital
        # announcements and the word buffer; no text is intercepted or spoken.
        with factory(locale, valid=lambda: (_valid_focus(driver, obj) and
                                           user32.GetKeyboardLayout(thread) == layout)):
            nextHandler()
