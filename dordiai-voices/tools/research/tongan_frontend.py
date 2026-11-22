"""Strict, isolated Tongan phonemic frontend; never a registered runtime language.

The 2024 Ministry for Pacific Peoples orthography distinguishes a macron vowel
(one nucleus, two moras) from a repeated vowel (two nuclei). Phonemic stress
follows the primary penultimate-mora account. Ambiguous unmarked vowel grouping,
unresolved clitic domains and marked already-long final vowels fail closed in
the default renderer; research hypotheses require an explicit opt-in.
"""
from dataclasses import dataclass,asdict,replace
import re
import unicodedata

VOWELS=frozenset("aeiou")
CONSONANTS=frozenset("fhklmnpstv")
GLOTTALS=frozenset("'‘’ʻʼʔ")
MACRON="\u0304"
ACUTE="\u0301"
FINAL_STRESS_MARKS=frozenset("´ˊ")
CLITICS=frozenset("u ku ma te ta ke mo ne ni na".split())
DIGIT_NAMES=("noa","taha","ua","tolu","fā","nima","ono","fitu","valu","hiva")
PHONE_CODES={**{c:c for c in "aeioufhklmnpstv"},"ŋ":"N","ʔ":"?"}
WORD_PARTS=re.compile(r"[\w\u0300-\u036f'‘’ʻʼʔ´ˊ]+|[^\w\u0300-\u036f'‘’ʻʼʔ´ˊ]+")
MAX_TEXT=8192

class UnsupportedTonganInput(ValueError):
    def __init__(self,message,*,reasons=()):
        super().__init__(message)
        self.reasons=tuple(reasons)

def is_vowel(segment):
    return segment in VOWELS or (segment.endswith("ː") and segment[:-1] in VOWELS)

def checked_text(text):
    if not isinstance(text,str):raise TypeError("Native text must be a string")
    if not text or len(text)>MAX_TEXT:raise UnsupportedTonganInput("Empty or oversized native text")
    return unicodedata.normalize("NFC",text)

@dataclass(frozen=True)
class Word:
    text:str
    segments:tuple
    graphemes:tuple
    mora_positions:tuple
    stress_position:int
    marked_accent:str
    warnings:tuple
    unresolved:tuple=()

    @property
    def syllable_nuclei(self):
        return tuple(index for index,segment in enumerate(self.segments) if is_vowel(segment))

    @property
    def ipa(self):
        out=[]
        for index,segment in enumerate(self.segments):
            if index==self.stress_position:
                out.append("ˈ")
            elif index and is_vowel(segment) and is_vowel(self.segments[index-1]):
                # Adjacent separately represented nuclei stay explicit. Different
                # vowels remain a research hiatus hypothesis until disambiguated.
                out.append(".")
            out.append(segment)
        return "".join(out)

    @property
    def encoded(self):
        tokens=[]
        for index,segment in enumerate(self.segments):
            base=segment.removesuffix("ː")
            code=PHONE_CODES[base]
            if index==self.stress_position:code="'"+code
            tokens.append(code)
            if segment.endswith("ː"):
                # eSpeak's documented base virtual':' lengthens the preceding
                # vowel; it is not another syllabic vowel or a foreign word.
                tokens.append(":")
        return "[["+"|".join(tokens)+"]]"

    def describe(self):
        return {**asdict(self),"ipa":self.ipa,"encoded_hypothesis":self.encoded,
                "mora_count":len(self.mora_positions),"syllable_nuclei":list(self.syllable_nuclei),
                "strictly_renderable":not self.unresolved}

def word(text,*,accent_kind="definitive"):
    if accent_kind not in ("definitive","enclitic"):raise ValueError("Unknown accent interpretation")
    original=checked_text(text);raw=original.lower()
    trailing=raw[-1] in FINAL_STRESS_MARKS
    if trailing:raw=raw[:-1]
    chars=unicodedata.normalize("NFD",raw)
    segments=[];graphemes=[];moras=[];acute_at=None;unresolved=[];i=0
    while i<len(chars):
        char=chars[i]
        if char in VOWELS:
            end=i+1;marks=[]
            while end<len(chars) and unicodedata.combining(chars[end]):
                marks.append(chars[end]);end+=1
            if any(mark not in (MACRON,ACUTE) for mark in marks) or len(set(marks))!=len(marks):
                raise UnsupportedTonganInput("Unsupported or repeated native vowel mark")
            graphemes.append(unicodedata.normalize("NFC",chars[i:end]))
            index=len(segments)
            segments.append(char+("ː" if MACRON in marks else ""))
            moras.append(index)
            if MACRON in marks:moras.append(index)
            if ACUTE in marks:
                if acute_at is not None:raise UnsupportedTonganInput("Multiple stress accents")
                acute_at=index
            i=end
        elif chars.startswith("ng",i):
            graphemes.append("ng");segments.append("ŋ");i+=2
        elif char in CONSONANTS:
            graphemes.append(char);segments.append(char);i+=1
        elif char in GLOTTALS:
            graphemes.append("ʻ");segments.append("ʔ");i+=1
        else:
            raise UnsupportedTonganInput("Unsupported native unit "+repr(char))
    if not segments or not moras or not is_vowel(segments[-1]):
        raise UnsupportedTonganInput("A supported native word must end in a vowel")
    for first,second in zip(segments,segments[1:]):
        if not is_vowel(first) and not is_vowel(second):
            raise UnsupportedTonganInput("Unrepresented native consonant cluster")
        if is_vowel(first) and is_vowel(second) and first.removesuffix("ː")!=second.removesuffix("ː"):
            if "unmarked-vowel-grouping" not in unresolved:unresolved.append("unmarked-vowel-grouping")
    if acute_at is not None and (acute_at!=len(segments)-1 or trailing):
        raise UnsupportedTonganInput("Ambiguous or nonfinal written accent")
    marked=acute_at is not None or trailing
    if marked and accent_kind=="definitive":
        if segments[-1].endswith("ː"):unresolved.append("definitive-accent-on-already-long-vowel")
        # Primary phonemic account: the definitive accent adds one final mora.
        # Keep that separately represented nucleus distinct from a written macron.
        segments.append(segments[-1].removesuffix("ː"));moras.append(len(segments)-1)
    head=moras[-1] if marked and accent_kind=="enclitic" else moras[-2 if len(moras)>1 else -1]
    stress=head
    if stress and not is_vowel(segments[stress-1]):stress-=1
    warnings=["native acoustic and listener validation pending"]
    if len(moras)==1:warnings.append("one-mora isolated stress; connected-speech domain needs explicit handling")
    if unresolved:warnings.append("phonemic hypothesis only: "+", ".join(unresolved))
    return Word(original,tuple(segments),tuple(graphemes),tuple(moras),stress,
                accent_kind if marked else "none",tuple(warnings),tuple(unresolved))

def text_words(text,*,digits=False):
    text=checked_text(text)
    if digits:text=re.sub(r"[0-9]",lambda m:" "+DIGIT_NAMES[int(m[0])]+" ",text)
    parts=WORD_PARTS.findall(text);result=[];consumed=set()
    for pos,part in enumerate(parts):
        if pos in consumed:continue
        if not any(char.isalpha() for char in part):
            if any(char.isdigit() for char in part):
                raise UnsupportedTonganInput("Numbers need explicit digit-by-digit mode")
            if any(char not in " \t\r\n.,!?:;()-–—" for char in part):
                raise UnsupportedTonganInput("Unsupported punctuation "+repr(part))
            result.append(part);continue
        immediate=parts[pos+1:pos+3]
        linked=(len(immediate)==2 and immediate[0].isspace() and immediate[1].lower() in CLITICS)
        analysed=word(part,accent_kind="enclitic" if linked else "definitive")
        if linked and analysed.marked_accent=="enclitic":
            clitic=word(immediate[1]);offset=len(analysed.segments)
            analysed=replace(analysed,text=analysed.text+immediate[0]+clitic.text,
                segments=analysed.segments+clitic.segments,
                graphemes=analysed.graphemes+clitic.graphemes,
                mora_positions=analysed.mora_positions+tuple(index+offset for index in clitic.mora_positions),
                unresolved=tuple(dict.fromkeys(analysed.unresolved+clitic.unresolved)),
                warnings=analysed.warnings+("explicit marked enclitic domain; no independent clitic stress added",))
            consumed.update((pos+1,pos+2))
        result.append(analysed)
    # One-mora grammatical words in connected text have unresolved stress domains.
    # Ordinary isolated letter/digit names are separate literal requests.
    word_positions=[index for index,value in enumerate(result) if isinstance(value,Word)]
    if len(word_positions)>1:
        for index in word_positions:
            value=result[index]
            if len(value.mora_positions)==1:
                result[index]=replace(value,unresolved=tuple(dict.fromkeys(value.unresolved+("unmarked-connected-clitic-domain",))))
    return result

def encoded(text,*,digits=False,allow_ambiguous_phonology=False):
    parts=text_words(text,digits=digits)
    unresolved=tuple(dict.fromkeys(reason for value in parts if isinstance(value,Word) for reason in value.unresolved))
    if unresolved and not allow_ambiguous_phonology:
        raise UnsupportedTonganInput("Native phonology requires explicit lexical/prosodic evidence",reasons=unresolved)
    return "".join(value.encoded if isinstance(value,Word) else value for value in parts)
