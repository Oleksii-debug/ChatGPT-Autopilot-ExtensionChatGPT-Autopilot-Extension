"""Accessible entry point to the active dordiai language and voice assignments."""
import globalPluginHandler
import globalVars
import gui
import wx


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self):
        super().__init__()
        self._item = None
        if globalVars.appArgs.secure:
            return
        self._menu = gui.mainFrame.sysTrayIcon.toolsMenu
        self._item = self._menu.Append(wx.ID_ANY, "dordiai-voices: поєднання голосів за мовами…")
        gui.mainFrame.sysTrayIcon.Bind(wx.EVT_MENU, self._open, self._item)

    def _open(self, event):
        from synthDriverHandler import getSynth
        synth = getSynth()
        opener = getattr(synth, "_dordiai_open_settings", None)
        if callable(opener):
            wx.CallAfter(opener)
            return
        gui.messageBox(
            "Спочатку виберіть синтезатор dordiai-voices через NVDA+Ctrl+S. "
            "Потім відкрийте цей пункт для вибору мов і призначення голосів.",
            "Поєднання голосів за мовами", wx.OK | wx.ICON_INFORMATION,
        )

    def terminate(self):
        if self._item is not None:
            try:
                gui.mainFrame.sysTrayIcon.Unbind(wx.EVT_MENU, handler=self._open, source=self._item)
                self._menu.DestroyItem(self._item)
            except (RuntimeError, AttributeError):
                pass
            self._item = None
        super().terminate()
