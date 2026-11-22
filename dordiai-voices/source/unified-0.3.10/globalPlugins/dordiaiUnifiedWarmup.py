"""Load the private speech worker during NVDA startup without speaking."""
from threading import Thread
import globalPluginHandler
from logHandler import log

class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self):
        super().__init__()
        def warm():
            try:
                from synthDrivers.dordiaiUnified import shared_worker
                shared_worker().preload()
            except Exception:
                log.warning('dordiai-voices: background initialization failed',exc_info=True)
        Thread(target=warm,name='dordiai-voices warmup',daemon=True).start()
