MENU_LABEL='dordiai-voices — голоси, мови й мовлення…'
"""Open preferences for the active dordiai driver from NVDA's menu or keyboard."""
import globalPluginHandler
import globalVars
import gui
import wx
from scriptHandler import script
from synthDriverHandler import getSynth
from ui import message


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self):
        super().__init__()
        self._item = None
        if globalVars.appArgs.secure:
            return
        self._menu = gui.mainFrame.sysTrayIcon.toolsMenu
        self._item = self._menu.Append(wx.ID_ANY, MENU_LABEL)
        gui.mainFrame.sysTrayIcon.Bind(wx.EVT_MENU, self._open, self._item)

    def _open(self, event=None):
        synth = getSynth()
        opener = getattr(synth, "_dordiai_open_settings", None)
        if opener is None:
            message("Виберіть синтезатор dordiai-voices через NVDA+Ctrl+S.")
            return
        wx.CallAfter(opener)

    @script(
        description="Відкрити налаштування активного синтезатора dordiai-voices",
        category="dordiai-voices",
        gesture="kb:NVDA+control+shift+f10",
    )
    def script_preferences(self, gesture):
        if not globalVars.appArgs.secure:
            self._open()

    def terminate(self):
        if self._item is not None:
            gui.mainFrame.sysTrayIcon.Unbind(wx.EVT_MENU, handler=self._open, source=self._item)
            self._menu.DestroyItem(self._item)
            self._item = None
        super().terminate()

