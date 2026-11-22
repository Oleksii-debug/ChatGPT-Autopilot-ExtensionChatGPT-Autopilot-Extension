"""Statistical language identification shared by all selected Latin languages."""
from functools import lru_cache
import re
from unicodedata import name as unicode_name

@lru_cache(maxsize=1)
def detector():
    from lingua import Language,LanguageDetectorBuilder,IsoCode639_1
    from data_registry import REGISTRY
    languages=[]
    codes={code for code,row in REGISTRY.languages.items() if row.get('auto_detect')}
    common=any(row['backend']=='supertonic' for row in REGISTRY.languages.values())
    if common:
        # Load identification data for enabled languages, not every language
        # the acoustic model could theoretically generate. New registered
        # languages join this set automatically on the next worker start.
        codes.update(REGISTRY.languages)
    for code in sorted(codes):
        iso=getattr(IsoCode639_1,code.upper(),None)
        if iso is not None:
            language=Language.from_iso_code_639_1(iso)
            if language is not None:languages.append(language)
    builder=LanguageDetectorBuilder.from_languages(*(languages or [Language.ENGLISH]))
    if common:builder=builder.with_low_accuracy_mode()
    return builder.build()

@lru_cache(maxsize=512)
def primary_language(text):
    from language_words import short_language
    lexical=short_language(text)
    if lexical:return lexical
    scores=detector().compute_language_confidence_values(text)
    if not scores or scores[0].value<.55:return None
    return scores[0].language.iso_code_639_1.name.lower()

@lru_cache(maxsize=512)
def identify(text):
    from language_words import short_language
    lexical=short_language(text)
    if lexical:return lexical
    words = text.split()
    scores = detector().compute_language_confidence_values(text)
    if not scores:
        return 'en'
    code = scores[0].language.iso_code_639_1.name.lower()
    # Short shared words and interface names retain the default Latin language.
    if len(words) <= 2 and (scores[0].value < .75 or
                           len(scores)>1 and scores[0].value-scores[1].value < .25):
        return 'en'
    return code

def language_runs(text):
    # Separate sentences before identification: otherwise a majority language
    # can swallow a short Slovak sentence inside an English/German paragraph.
    sentences = re.findall(r'.+?(?:[.!?…]+(?=\s|$)|$)',text,re.DOTALL)
    runs=[]
    for sentence in sentences:
        sentence=sentence.strip()
        if not sentence:
            continue
        from mixed_runs import lexical_runs
        for code,span in lexical_runs(sentence,identify(sentence)):
            if runs and runs[-1][0]==code:
                runs[-1]=(code,runs[-1][1]+' '+span)
            else:
                runs.append((code,span))
    return runs

@lru_cache(maxsize=512)
def confidently_mixed(text):
    """Use only distinctive words as evidence of intra-sentence switching.

    Shared short words carry no reliable language identity. The common
    acoustic model handles ambiguous spans; do not force a majority-language
    prefix when separate distinctive words identify different languages.
    """
    found=set()
    from language_words import evidence
    for word in re.findall(r"[^\W\d_]+",text,re.UNICODE):
        lexical,known,_=evidence(word)
        if known:
            if lexical:
                found.add(lexical)
                if len(found)>1:return True
            continue
        if len(word)<4:continue
        scores=detector().compute_language_confidence_values(word)
        if scores and scores[0].value>=.9 and (len(scores)==1 or scores[0].value-scores[1].value>=.5):
            found.add(scores[0].language.iso_code_639_1.name.lower())
            if len(found)>1:return True
    return False

def mixed_scripts(text):
    scripts={unicode_name(char,'').split(' ',1)[0] for char in text if char.isalpha()}
    # Japanese normally combines these scripts within a single language.
    return len(scripts)>1 and not scripts<= {'CJK','HIRAGANA','KATAKANA'}
