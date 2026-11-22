"""Unicode conventions for optional languages sharing the Latin and Cyrillic alphabets."""
import unicodedata

_GAGAUZ_UPPER=str.maketrans({'I':'ı','İ':'i'})


def fold_text(text,code):
    value=unicodedata.normalize('NFC',text)
    if (code or '').lower().replace('_','-').split('-')[0]=='gag':
        value=value.translate(_GAGAUZ_UPPER)
    return unicodedata.normalize('NFC',value.casefold())


def ossetian_ae_in_word(text,index):
    """Preserve adjacent Cyrillic spelling; standalone Danish/Norwegian æ remains Latin."""
    def neighbour(step):
        pos=index+step
        while 0<=pos<len(text) and unicodedata.category(text[pos]).startswith('M'):
            pos+=step
        if not 0<=pos<len(text):return None
        char=text[pos]
        if not char.isalpha():return None
        return 'cyrillic' if unicodedata.name(char,'').startswith('CYRILLIC ') else 'other'
    adjacent=(neighbour(-1),neighbour(1))
    return 'cyrillic' in adjacent and 'other' not in adjacent
