"""Accessible entry point to the existing WorldVoice language-role editor."""
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
        for plugin in globalPluginHandler.runningPlugins:
            if plugin.__class__.__module__.lower() == "globalplugins.worldvoice":
                opener = getattr(plugin, "popupSpeechSettingsDialog", None)
                if callable(opener):
                    from synthDriverHandler import getSynth
                    if getattr(getSynth(), "name", "").lower() != "worldvoice":
                        gui.messageBox("Спочатку виберіть синтезатор WorldVoice через NVDA+Ctrl+S. "
                                       "Потім відкрийте цей пункт знову, щоб призначити голоси мовам.",
                                       "Поєднання голосів за мовами", wx.OK | wx.ICON_INFORMATION)
                        return
                    opener(event)
                    return
        gui.messageBox(
            "Для поєднання голосів установіть WorldVoice 7.1 і перезапустіть NVDA. "
            "Потім виберіть синтезатор WorldVoice через NVDA+Ctrl+S. "
            "У його налаштуваннях вимкніть вимогу однакового рушія для мов. "
            "Синхронізацію основного голосу з голосом його мови залиште ввімкненою. "
            "У розділі голосів призначте українській Лізу, Браяна чи інший голос dordiai-voices, "
            "а іншим мовам — доступні голоси відповідних синтезаторів. "
            "Самостійний синтезатор dordiai-voices також залишається доступним.",
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
