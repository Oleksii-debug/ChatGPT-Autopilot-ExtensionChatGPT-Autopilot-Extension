"""Routing data for local languages outside the ten established voices' languages."""
from ctypes import CDLL, c_char_p, c_float, c_size_t, c_void_p, create_string_buffer
from functools import lru_cache
import gzip
import json
from pathlib import Path
import re
from threading import Lock
import unicodedata


HERE=Path(__file__).resolve().parent
with (HERE/"wide_voice_index.json").open(encoding="utf8") as source:
    REGISTRY=json.load(source)
CODES=frozenset(REGISTRY)
NAMES={tag:info["name"] for tag,info in REGISTRY.items()}
CORE=frozenset(("uk","en","ru","sk","pl","de","fr","da","it","es"))
import importlib.util as _import_util
_personal_spec=_import_util.spec_from_file_location("_dordiai_private_language_catalog",HERE/"personal_catalog.py")
_personal_catalog=_import_util.module_from_spec(_personal_spec)
_personal_spec.loader.exec_module(_personal_catalog)
_public_registry=dict(REGISTRY)
PERSONAL={}
_observed_personal=None

def refresh_personal(force=False):
    global REGISTRY,CODES,NAMES,PERSONAL,_observed_personal
    found=_personal_catalog.discover(force)
    if found is not _observed_personal:
        _observed_personal=found
        PERSONAL={code:entry for code,entry in found.items() if code not in _public_registry and code not in CORE}
        REGISTRY=dict(_public_registry)
        REGISTRY.update(PERSONAL)
        CODES=frozenset(REGISTRY)
        NAMES={code:entry['name'] for code,entry in REGISTRY.items()}

refresh_personal(True)
_code_spec=_import_util.spec_from_file_location("_dordiai_wide_language_codes",HERE/"language_codes.py")
_language_codes=_import_util.module_from_spec(_code_spec)
_code_spec.loader.exec_module(_language_codes)
ALIASES=_language_codes.ALIASES
_lock=Lock()
_detector=None
_detector_attempted=False


def registered(code):
    parts=(code or "").strip().lower().replace("_","-")
    if not parts:return None
    primary=_language_codes.canonical_language(parts)
    if primary not in CORE and primary not in _public_registry:
        refresh_personal()
    while parts:
        # Exact explicitly installed personal/script variants take precedence.
        if parts in CODES:return parts
        tag=_language_codes.canonical_language(parts)
        if tag in CODES:return tag
        parts=parts.rpartition("-")[0]
    return None


def _load_detector():
    global _detector,_detector_attempted
    with _lock:
        if not _detector_attempted:
            path=HERE/"models/WideLanguages"
            try:
                lib=CDLL(str(path/"wide-lid.dll"))
                lib.lid_open.argtypes=[c_char_p,c_size_t];lib.lid_open.restype=c_void_p
                lib.lid_detect.argtypes=[c_void_p,c_char_p,c_char_p,c_size_t];lib.lid_detect.restype=c_float
                lib.lid_close.argtypes=[c_void_p];lib.lid_close.restype=None
                data=(path/"lid.176.ftz").read_bytes()
                handle=lib.lid_open(data,len(data))
                if handle:
                    import atexit
                    atexit.register(lib.lid_close,handle)
                    _detector=(lib,handle)
            except OSError:
                pass
            _detector_attempted=True
        return _detector


@lru_cache(maxsize=1536)
def _identify(text):
    detector=_load_detector()
    if not detector:return None,0.
    lib,handle=detector
    label=create_string_buffer(24)
    confidence=float(lib.lid_detect(handle,text.casefold().replace("\n"," ").encode("utf8"),label,len(label)))
    code=label.value.decode("ascii")
    return registered(code) or (code if code in CORE else None),confidence


@lru_cache(maxsize=1)
def _words():
    try:
        with gzip.open(HERE/"models/WideLanguages/wide_words.json.gz","rt",encoding="utf8") as data:
            return json.load(data)
    except (OSError,ValueError):
        return {}


@lru_cache(maxsize=1)
def _auxiliary(filename):
    # NVDA loads each add-on module by filename, outside the regular import path.
    import importlib.util
    file=Path(__file__).resolve().with_name(filename+".py")
    spec=importlib.util.spec_from_file_location("_dordiai_"+filename,file)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _profiles():
    module=_auxiliary("wide_profiles")
    module.RESOURCE=HERE/"models/WideLanguages/wide-profiles.bin"
    return module


@lru_cache(maxsize=1)
def _nordic():
    module=_auxiliary("wide_nordic")
    module.RESOURCE=HERE/"models/WideLanguages/Nordic/words.bin"
    return module


@lru_cache(maxsize=768)
def _phrase_language(text,script):
    tag,confidence=_identify(text)
    nordic=script=="latin" and tag in {"da","fo","is","nb","nn","sv"} and len(text.split())>=3
    if confidence>=.88 and tag and not nordic:
        return tag,confidence
    lexical,certainty=_profiles().predict(text,script)
    if nordic:
        spelling,margin,hits=_nordic().detect(text)
        if hits>=3 and spelling!=tag and (margin>=2.5 and confidence<.9 or
                margin>=1.5 and confidence<.70 and spelling==lexical or
                margin>=4 and spelling==lexical and certainty>=.85):
            return spelling,.91
        if confidence>=.88:return tag,confidence
    if lexical==tag:
        if tag and confidence>=.35 and certainty>=.22 and len(text.split())>=4:
            return tag,max(.52,confidence,certainty)
        return tag,max(confidence,certainty)
    if certainty>=.75 or (certainty>=.60 and confidence<.48):
        return lexical,certainty
    return tag,confidence


_SENTENCE_END = re.compile(r'(?:[.!?…]+(?:["»”’)]*)[ \t]+|[\r\n]+)')


def _word_spans(text,script,preferred,enabled_languages=None,mode="context",priorities=()):
    # Each sentence supplies context, while every lexical token remains eligible
    # for a different language in a multilingual dictionary/list.
    start=0
    for stop in _SENTENCE_END.finditer(text):
        end=stop.end()
        yield from _phrase_spans(text[start:end],script,preferred,enabled_languages,mode,priorities)
        start=end
    if start<len(text):
        yield from _phrase_spans(text[start:],script,preferred,enabled_languages,mode,priorities)


def _native_word_spans(text,script,preferred,enabled,mode,priorities,scope):
    start=0
    for stop in _SENTENCE_END.finditer(text):
        end=stop.end()
        yield from _phrase_spans(text[start:end],script,preferred,enabled,mode,priorities,scope)
        start=end
    if start<len(text):
        yield from _phrase_spans(text[start:],script,preferred,enabled,mode,priorities,scope)


_LEGACY_WORD_PATTERN = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*")
_NATIVE_WORD_FAMILIES = frozenset(("arabic", "bengali", "devanagari"))


def _word_ranges(text):
    """Keep complete native spellings and exact offsets, including bad marks."""
    if text.isascii():
        yield from ((match.start(), match.end()) for match in _LEGACY_WORD_PATTERN.finditer(text))
        return
    def base(char):
        # Equivalent to the former regex's Unicode word base, excluding Nd/_.
        return char.isalnum() and not char.isdecimal() and char not in "'’‘ʼ"
    def component(char):
        return base(char) or unicodedata.category(char).startswith("M") or char in "\u200c\u200d"
    index = 0
    while index < len(text):
        if not component(text[index]):
            index += 1
            continue
        start, has_base = index, False
        while index < len(text):
            char = text[index]
            if component(char):
                has_base = has_base or base(char)
                index += 1
            elif char in "'’‘ʼ" and has_base and index + 1 < len(text) and base(text[index + 1]):
                index += 1
            else:
                break
        if has_base:
            yield start, index


def _native_word_classifier_scope(policy, script, enabled):
    if script not in _NATIVE_WORD_FAMILIES:
        return frozenset()
    capability = getattr(policy, "classifier_family_languages", None)
    if capability is None:
        return frozenset()
    selected = capability(script)
    allowed = frozenset(code for code in selected if code in FAMILIES[script] and code in CODES | CORE)
    return allowed if enabled is None or allowed & enabled else frozenset()


@lru_cache(maxsize=8192)
def _legacy_lexical_candidates(word,script,skip_native_core=False):
    """Merge extended and core lexical evidence; never overwrite a homograph."""
    candidates=set()
    entry=_words().get(word)
    if isinstance(entry,str):
        candidates.add(entry)
    elif isinstance(entry,(list,tuple,set,dict)):
        candidates.update(code for code in entry if isinstance(code,str))
    if script=="latin":
        candidates.update(_auxiliary("latin_languages").word_candidates(word))
    elif script=="cyrillic":
        if not skip_native_core:
            speech = _auxiliary("speech_text")
            legacy = getattr(speech, "legacy_cyrillic_word_candidates", speech.cyrillic_word_candidates)
            candidates.update(legacy(word))
        candidates.intersection_update(FAMILIES["cyrillic"])
    if script in FAMILIES:
        candidates.intersection_update(FAMILIES[script])
    return frozenset(code for code in candidates if code in CODES|CORE)


def _lexical_candidates(word,script):
    primary = frozenset()
    if script == "cyrillic":
        speech = _auxiliary("speech_text")
        lookup = getattr(speech, "native_cyrillic_word_candidates", None)
        if lookup is not None:
            primary = lookup(word)  # Verified before either legacy cache is read.
    old = _legacy_lexical_candidates(word, script, bool(primary))
    if primary:
        # Replace weak UA/RU evidence, retaining independent other-Cyrillic labels.
        return frozenset((old - {"uk", "ru"}) | primary)
    return old


_lexical_candidates.cache_clear = _legacy_lexical_candidates.cache_clear
_lexical_candidates.cache_info = _legacy_lexical_candidates.cache_info


def _phrase_spans(text,script,preferred,enabled_languages=None,mode="context",priorities=(),classifier_scope=None):
    policy=_auxiliary("language_routing")
    enabled=policy.enabled_keys(enabled_languages)
    preferred=policy.fallback_language(preferred,enabled,priorities)
    if PERSONAL:
        local=_personal_catalog.detect_phrase(text,script,PERSONAL)
        if local and (enabled is None or local in enabled):return [(local,text)]
    if classifier_scope is not None and preferred not in FAMILIES[script]:
        # Preserve the established whole-script fallback when the primary user
        # language uses a different alphabet; an ML abstention is not a switch
        # to an unrelated acoustic alphabet.
        family_priority=next((policy.language_key(code) for code in priorities
            if policy.language_key(code) in FAMILIES[script]
            and policy.language_key(code) in CODES|CORE
            and (enabled is None or policy.language_key(code) in enabled)),None)
        preferred=family_priority or _tag(script,text,preferred,enabled) or preferred
    context=_tag(script,text,preferred,enabled) if mode=="context" else None
    if enabled is not None and context not in enabled:context=None
    matches=list(_word_ranges(text))
    if not matches:return [(context,text)]
    sentence_tag,sentence_score=_phrase_language(text,script) if len(matches)>1 and mode=="context" else (None,0.)
    if sentence_tag not in CODES|CORE or (enabled is not None and sentence_tag not in enabled):
        sentence_tag=None
    if script in FAMILIES and sentence_tag not in FAMILIES[script]:sentence_tag=None
    strong=len(matches)>=3 and sentence_tag is not None and sentence_score>=.85
    labels=[]
    current=preferred
    for start,end in matches:
        word=policy.normalize_word(text[start:end])
        if sum(char.isalpha() for char in word)<=1:
            # Shared letters are keyboard/spelling context, not language samples.
            guess=current if current in CODES|CORE else None
            labels.append(guess)
            continue
        candidates=_lexical_candidates(word,script)
        if enabled is not None:candidates=candidates & enabled
        if candidates:
            preference=sentence_tag if strong and sentence_tag in candidates else current
            decision=policy.resolve_word(word,preference,enabled,candidates=candidates,priorities=priorities)
            guess=decision.language
        else:
            guess=None
            if len(word)>=4:
                candidate,confidence=policy.classify_word(word,enabled)
                if (candidate and (classifier_scope is None or candidate in classifier_scope)
                        and (enabled is None or candidate in enabled)):
                    guess=candidate
                elif classifier_scope is None:
                    learned=policy.classifier_languages()
                    outside=(enabled if enabled is not None else CODES|CORE)-learned
                    if not learned or mode=="context" or outside:
                        candidate,confidence=_identify(word)
                        # The word-trained model's abstention remains authoritative
                        # for its own classes. The older general LID may only add
                        # languages outside that model's learned scope in word mode.
                        if mode=="words" and candidate in learned:candidate=None
                        threshold=.97 if len(word)<7 else .92
                        if confidence>=threshold:
                            guess=candidate
                        elif len(word)>=8 and candidate and confidence>=.82 and _profiles().predict(word,script)[0]==candidate:
                            guess=candidate
            if guess not in CODES|CORE or (enabled is not None and guess not in enabled):guess=None
            if script in FAMILIES and guess not in FAMILIES[script]:guess=None
            if guess is None:
                guess=(sentence_tag if strong else context) if mode=="context" else (
                    current if classifier_scope is not None else preferred)
        if enabled is not None and guess not in enabled:guess=None
        labels.append(guess)
        if guess is not None:current=guess
    offset=0;current=labels[0];spans=[]
    for (start,end),tag in zip(matches[1:],labels[1:]):
        if tag!=current:
            spans.append((current,text[offset:start]))
            offset=start;current=tag
    spans.append((current,text[offset:]))
    return spans


def _script(char):
    if char in "'’‘ʼ":return None
    n=ord(char)
    if char.isascii():return "latin" if char.isalpha() else None
    if not unicodedata.category(char).startswith("L"):return None
    if 0x0590<=n<=0x05ff or 0xfb1d<=n<=0xfb4f:return "he"
    if 0x0780<=n<=0x07bf:return "dv"
    if 0xabc0<=n<=0xabff:return "mni"
    if 0x0600<=n<=0x06ff or 0x0750<=n<=0x077f or 0x08a0<=n<=0x08ff or 0xfb50<=n<=0xfdff or 0xfe70<=n<=0xfeff:return "arabic"
    if 0x0400<=n<=0x052f:return "cyrillic"
    if 0x0370<=n<=0x03ff or 0x1f00<=n<=0x1fff:return "el"
    if 0x0530<=n<=0x058f:return "hy"
    if 0x10a0<=n<=0x10ff or 0x1c90<=n<=0x1cbf:return "ka"
    if 0x0900<=n<=0x097f:return "devanagari"
    if 0x0980<=n<=0x09ff:return "bengali"
    if 0x0a00<=n<=0x0a7f:return "pa"
    if 0x0a80<=n<=0x0aff:return "gu"
    if 0x0b00<=n<=0x0b7f:return "or"
    if 0x0b80<=n<=0x0bff:return "ta"
    if 0x0c00<=n<=0x0c7f:return "te"
    if 0x0c80<=n<=0x0cff:return "kn"
    if 0x0d00<=n<=0x0d7f:return "ml"
    if 0x0d80<=n<=0x0dff:return "si"
    if 0x0e00<=n<=0x0e7f:return "th"
    if 0x0e80<=n<=0x0eff:return "lo"
    if 0x0f00<=n<=0x0fff:return "tibetan"
    if 0x1780<=n<=0x17ff:return "km"
    if 0x1000<=n<=0x109f:return "burmese"
    if 0x1200<=n<=0x137f:return "ethiopic"
    if 0x13a0<=n<=0x13ff or 0xab70<=n<=0xabbf:return "chr"
    if 0x3040<=n<=0x30ff:return "kana"
    if 0x3400<=n<=0x9fff or 0x20000<=n<=0x323af or 0xf900<=n<=0xfaff:return "han"
    if 0xac00<=n<=0xd7ff or 0x1100<=n<=0x11ff or 0x3130<=n<=0x318f:return "ko"
    if unicodedata.name(char,"").startswith("LATIN"):return "latin"
    return "unknown"


FAMILIES={"arabic":("ar","fa","ur","ps","ug","sd","ks"),"devanagari":("hi","mr","ne","kok","mai","doi","brx"),
          "bengali":("bn","as","bpy","mni"),"ethiopic":("am","ti"),"burmese":("my","shn"),
          "han":("cmn","yue","ja","hak"),"tibetan":("dz","bo"),
          "cyrillic":("uk","ru","bg","be","mk","sr","kk","tt","ba","cv","ky","mn","tg","uz","az","nog","kaa","ab")}


def _hebrew_alphabet(text,preferred):
    if "yi" not in CODES:return "he"
    normal=unicodedata.normalize("NFKD",text).translate(str.maketrans({"װ":"וו","ױ":"וי","ײ":"יי"}))
    normal="".join(ch for ch in normal if not unicodedata.combining(ch))
    words=re.findall(r"[א-ת]+",normal)
    if not words or max(map(len,words))<2:return "yi" if preferred=="yi" else "he"
    votes=[_words().get(word) for word in words]
    difference=votes.count("yi")-votes.count("he")
    if difference and (len(words)<3 or abs(difference)>=2):return "yi" if difference>0 else "he"
    guess,confidence=_identify(text)
    if guess in {"he","yi"} and confidence>=.68:return guess
    if difference:return "yi" if difference>0 else "he"
    if any(ch in text for ch in "װױײײַ") or "ײַ" in text:return "yi"
    return "yi" if preferred=="yi" else "he"


def _tag(script,text,preferred,enabled_languages=None):
    allowed=_auxiliary("language_routing").enabled_keys(enabled_languages)
    def enabled(code):return allowed is None or code in allowed
    if script=="he":
        result=_hebrew_alphabet(text,preferred)
        return result if enabled(result) else None
    if script in CODES:return script if enabled(script) else None
    if script=="kana":return "ja" if enabled("ja") else None
    if script=="han" and preferred=="ja":return "ja" if enabled("ja") else None
    if script=="unknown":return None
    if script in {"latin","cyrillic"}:
        letters=sum(c.isalpha() for c in text)
        if letters<3:return None
        tag,p=_phrase_language(text,script)
        threshold=.78 if letters<8 else .42 if len(text.split())>=4 else .64
        if tag not in CODES or p<threshold or not enabled(tag):return None
        if script=="cyrillic" and tag not in FAMILIES[script] and PERSONAL.get(tag,{}).get("script")!=script:return None
        if script=="latin" and any(tag in options for family,options in FAMILIES.items() if family not in {"cyrillic","han"}):
            return None
        return tag
    if script in FAMILIES:
        options=tuple(code for code in FAMILIES[script] if code in CODES|CORE and enabled(code))
        if not options:return None
        if preferred in options:return preferred
        if len(text.strip())>2:
            tag,p=_identify(text)
            if tag in options and p>=.58:return tag
        return options[0]
    return None


def split_extended(text,preferred="uk",explicit=False,*,enabled_languages=None,mode="context",priorities=()):
    """Return exact slices; None delegates to the core-language planner.

    Restrict automatic guesses to enabled languages. An explicit language pins
    the whole span; script changes must not override NVDA/user language marks.
    """
    if mode not in {"context","words"}:raise ValueError("Unknown language routing mode: "+str(mode))
    policy=_auxiliary("language_routing")
    enabled=policy.enabled_keys(enabled_languages)
    preferred=policy.fallback_language(preferred,enabled,priorities)
    if not text:return []
    requested=registered(preferred)
    if explicit:
        return [(requested,text)]
    if (sum(char.isalpha() for char in text)<=1
            and not any(unicodedata.category(char).startswith("M") for char in text)):
        return [(requested,text)]
    pinned=(requested or preferred).lower().replace("_","-").split("-")[0]
    def label(script,span):
        if explicit and requested in PERSONAL and script==PERSONAL[requested]['script']:
            return requested
        if explicit:
            usual=next((family for family,tags in FAMILIES.items() if pinned in tags),pinned if pinned in {
                "he","el","hy","ka","pa","gu","or","ta","te","kn","ml","si","th","ko"} else "latin")
            usual={"ja":"kana","grc":"el","hyw":"hy","chr":"chr","yi":"he"}.get(pinned,usual)
            if script==usual or (pinned=="ja" and script=="han") or (
                pinned in {"sr","uz","az","kaa"} and script in {"latin","cyrillic"}):
                return requested
        result=_tag(script,span,requested or preferred,enabled)
        return result if enabled is None or result in enabled else None
    spans=[]
    def add(code,value):
        if spans and spans[-1][0]==code:
            spans[-1]=(code,spans[-1][1]+value)
        else:spans.append((code,value))
    def finish(script,value):
        if not explicit and script in {"latin","cyrillic"}:
            for code,part in _word_spans(value,script,requested or preferred,enabled,mode,priorities):add(code,part)
        elif not explicit and script in _NATIVE_WORD_FAMILIES:
            scope=_native_word_classifier_scope(policy,script,enabled)
            if scope:
                # Only explicit reviewed model capabilities activate this path.
                # Raw label count/native-mark support alone is insufficient.
                for code,part in _native_word_spans(value,script,requested or preferred,enabled,mode,priorities,scope):add(code,part)
            else:add(label(script,value),value)
        elif not explicit and script=="he" and "yi" in CODES:
            start=0
            for cut in _SENTENCE_END.finditer(value):
                end=cut.end()
                add(label(script,value[start:end]),value[start:end])
                start=end
            if start<len(value):add(label(script,value[start:]),value[start:])
        else:add(label(script,value),value)
    start=0;script=None
    for i,char in enumerate(text):
        current=_script(char)
        if (char in 'Ææ' and 'os' in PERSONAL and (not explicit or requested=='os') and
                _personal_catalog.orthography.ossetian_ae_in_word(text,i)):
            current='cyrillic'
        if current is None:continue
        if current=="kana" and script=="han":script="kana"
        if current=="han" and script=="kana":continue
        if script is not None and current!=script:
            finish(script,text[start:i])
            start=i
        script=current
    if script:
        span=text[start:]
        finish(script,span)
    else:add(requested if explicit else None,text)
    return spans
