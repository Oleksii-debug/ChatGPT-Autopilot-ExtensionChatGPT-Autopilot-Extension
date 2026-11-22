"""Use the shipped pure-Python numeral library in NVDA without sys.path edits.

Only the requested language module is imported into a private namespace. The
upstream package initializer loads unrelated languages and is not executed.
"""
from functools import lru_cache
from importlib import import_module
from pathlib import Path
from threading import RLock
from types import ModuleType
import sys

LIBRARY=Path(__file__).parent/'python/Lib/site-packages/num2words'
_lock=RLock()
_namespace='_dordiaiUnified_private_numbers'

@lru_cache(maxsize=16)
def converter(language):
    if language not in ('uk', 'ru', 'en', 'sk', 'de', 'pl', 'fr', 'da', 'it', 'es'):raise ValueError('Unsupported numeral language')
    with _lock:
        if _namespace not in sys.modules:
            package=ModuleType(_namespace)
            package.__path__=[str(LIBRARY)]
            package.__package__=_namespace
            sys.modules[_namespace]=package
        code=language.upper()
        module=import_module(_namespace+'.lang_'+code)
        return getattr(module,'Num2Word_'+code)()

def num2words(number,lang='en'):
    with _lock:return converter(lang).to_cardinal(number)
