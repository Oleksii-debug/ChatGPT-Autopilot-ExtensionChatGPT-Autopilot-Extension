"""Spell Unicode decimal numbers in the language currently spoken by the neural carrier."""
import ctypes as ct
from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata

TOKENS=re.compile(r"\d+(?:[.,\u066b\u066c\u00a0\u202f]\d+)*")
RUNS=re.compile(r"\d+")


@lru_cache(maxsize=1)
def _library():
    try:
        lib=ct.WinDLL('icu.dll',winmode=0x800)
        lib.unum_open.argtypes=[ct.c_int,ct.c_void_p,ct.c_int,ct.c_char_p,ct.c_void_p,ct.POINTER(ct.c_int)]
        lib.unum_open.restype=ct.c_void_p
        lib.unum_close.argtypes=[ct.c_void_p]
        lib.unum_formatDecimal.argtypes=[ct.c_void_p,ct.c_char_p,ct.c_int,ct.c_wchar_p,ct.c_int,
                                         ct.c_void_p,ct.POINTER(ct.c_int)]
        lib.unum_getLocaleByType.argtypes=[ct.c_void_p,ct.c_int,ct.POINTER(ct.c_int)]
        lib.unum_getLocaleByType.restype=ct.c_char_p
        return lib
    except (OSError,AttributeError):
        return None


@lru_cache(maxsize=512)
def _from_icu(code,ascii_number):
    lib=_library()
    if lib is None:return None
    error=ct.c_int()
    fmt=lib.unum_open(5,None,0,code.encode('ascii'),None,ct.byref(error))
    if not fmt:return None
    try:
        locale=lib.unum_getLocaleByType(fmt,0,ct.byref(error)) or b''
        if locale.split(b'_')[0]!=code.encode('ascii') or error.value>0:return None
        output=ct.create_unicode_buffer(1024)
        value=ascii_number.encode('ascii')
        n=lib.unum_formatDecimal(fmt,value,len(value),output,len(output),None,ct.byref(error))
        if error.value>0 or n<=0 or n>=len(output):return None
        spoken=output.value.replace('\u00ad','').replace('\u200b','')
        readable=any(c.isalpha() or unicodedata.category(c)=='Nl' for c in spoken)
        return spoken if readable and not any(c.isdecimal() for c in spoken) else None
    finally:
        lib.unum_close(fmt)


@lru_cache(maxsize=1)
def _words():
    return json.loads(Path(__file__).with_name('wide_number_words.json').read_bytes())


def spell_numbers(code,text):
    if not any(c.isdecimal() for c in text):return text
    data=_words().get(code)
    if data is None:
        # A subsequently registered acoustic language can use the system's own
        # rules even before a portable digit fallback is included in its pack.
        def spoken_run(match):
            ascii_digits=''.join(str(unicodedata.decimal(c)) for c in match[0])
            value=_from_icu(code,ascii_digits)
            if value and (len(ascii_digits)==1 or not ascii_digits.startswith('0')):
                return value
            return ' '.join(_from_icu(code,c) or c for c in ascii_digits)
        return RUNS.sub(spoken_run,text)
    words=data['digits']
    hindi_context=code=='hi' and any(char.isalpha() for char in text)
    def digits(number):
        return ' '.join(words[int(c)] for c in number)
    def replace(match):
        token=''.join(str(unicodedata.decimal(c)) if c.isdecimal() else c for c in match[0])
        decimal=data['decimal'];group=data['group']
        token=token.replace('\u066b',decimal).replace('\u066c',group)
        # Arabic text also commonly contains an ASCII-formatted measurement.
        if decimal not in '.,' and group not in '.,':
            token=token.replace(',',group).replace('.',decimal)
        if group in ('\u00a0','\u202f',' '):
            token=token.replace('\u00a0',group).replace('\u202f',group)
        parts=token.split(decimal)
        integer=parts[0]
        groups=integer.split(group)
        grouped=len(groups)>1
        valid_grouping=(len(groups[0])<=3 and all(len(s)==3 for s in groups[1:]))
        if code=='hi' and grouped and len(groups[-1])==3 and len(groups[0])<=2:
            valid_grouping|=all(len(s)==2 for s in groups[1:-1])
        if len(parts)>2 or not all(s.isdecimal() for s in groups) or (grouped and not valid_grouping):
            return RUNS.sub(lambda m:_from_icu(code,m[0]) or digits(m[0]),token)
        if len(parts)==2 and not parts[1].isdecimal():
            return RUNS.sub(lambda m:_from_icu(code,m[0]) or digits(m[0]),token)
        integer=''.join(groups)
        if len(integer)>12 or len(integer)>1 and integer[0]=='0':
            left=digits(integer)
        else:
            value='.'.join([integer,*parts[1:]])
            if len(parts)==1 or not parts[1].endswith('0'):
                spoken=_from_icu(code,value)
                if spoken:return spoken
            left=_from_icu(code,integer) or digits(integer)
        if len(parts)==2:return left+' '+data['point']+' '+digits(parts[1])
        return left
    def acoustic_form(match):
        spoken=replace(match)
        # Both are ordinary Arabic spellings of "hundred". The neural speaker
        # retained the intended consonant in the spelling without the silent alif.
        if code=='ar':return spoken.replace('مائة','مئة')
        if hindi_context:return spoken.replace('हज़ार','हजार')
        return spoken
    return TOKENS.sub(acoustic_form,text)
