"""Isolated Tongan phonemic prototype; deliberately not a registered language.

Native orthographic rules follow NZ Ministry of Education Faufaua (2010),
pp. 20–21, and Garellek & White (2015), doi:10.1017/S0025100314000206.
Definitive vowel copying follows Garellek & Tabain (2019),
doi:10.1017/S0025100318000397. No model/voice language is silently substituted.

The output is a broad, mora-preserving phonemic hypothesis. It does not resolve
unwritten definitive accents, clitic grouping, optional vowel fusion, secondary
stress, loanword stress or native phrasal intonation. Acoustic validation and a
native listener are still required before these rules can become a product.
"""
from dataclasses import dataclass, asdict
import re
import unicodedata


VOWELS = frozenset("aeiou")
CONSONANTS = frozenset("fhklmnpstv")
GLOTTALS = frozenset("'‘’ʻʼʔ")
MACRON = "\u0304"
ACUTE = "\u0301"
FINAL_STRESS_MARKS = frozenset("´ˊ")
CLITICS = frozenset("u ku ma te ta ke mo ne ni na".split())
PHONE_CODES = {**{c: c for c in "aeioufhklmnpstv"}, "ŋ": "N", "ʔ": "?"}
DIGIT_NAMES = ("noa", "taha", "ua", "tolu", "fā", "nima", "ono", "fitu", "valu", "hiva")
WORD_PARTS = re.compile(r"[\w\u0300-\u036f'‘’ʻʼʔ´ˊ]+|[^\w\u0300-\u036f'‘’ʻʼʔ´ˊ]+")


class UnsupportedTonganInput(ValueError):
    """The prototype cannot represent the input without guessing or dropping it."""


@dataclass(frozen=True)
class Word:
    text: str
    segments: tuple
    graphemes: tuple
    mora_positions: tuple
    stress_position: int
    marked_accent: str
    warnings: tuple

    @property
    def ipa(self):
        return "".join(("ˈ" if i == self.stress_position else "") + s
                       for i, s in enumerate(self.segments))

    @property
    def encoded(self):
        # The documented | separator prevents adjacent phones from accidentally
        # becoming an acoustic table's multi-character/diphthong mnemonic.
        return "[[" + "|".join(("'" if i == self.stress_position else "") + PHONE_CODES[s]
                                 for i, s in enumerate(self.segments)) + "]]"

    def describe(self):
        return {**asdict(self), "ipa": self.ipa, "encoded": self.encoded,
                "mora_count": len(self.mora_positions)}


def word(text, *, accent_kind="definitive"):
    """Analyse a native orthographic word, retaining every written mora.

    A final acute normally denotes a definitive accent, with one copied final
    vowel mora. For a documented accent before a one-mora enclitic, explicitly
    use accent_kind='enclitic': stress shifts to the final original mora without
    inventing a copied vowel. The caller cannot infer that grammatical choice
    from the isolated written word itself.
    """
    if accent_kind not in {"definitive", "enclitic"}:
        raise ValueError("accent_kind must be definitive or enclitic")
    raw = unicodedata.normalize("NFC", str(text)).lower()
    trailing = bool(raw and raw[-1] in FINAL_STRESS_MARKS)
    if trailing:
        raw = raw[:-1]
    chars = unicodedata.normalize("NFD", raw)
    segments, graphemes, moras = [], [], []
    acute_at = None
    i = 0
    while i < len(chars):
        c = chars[i]
        if c in VOWELS:
            j = i + 1
            marks = []
            while j < len(chars) and unicodedata.combining(chars[j]):
                marks.append(chars[j]); j += 1
            if any(m not in {MACRON, ACUTE} for m in marks) or len(set(marks)) != len(marks):
                raise UnsupportedTonganInput("Unsupported vowel mark in " + repr(text))
            graphemes.append(unicodedata.normalize("NFC", chars[i:j]))
            segments.append(c); moras.append(len(segments) - 1)
            if MACRON in marks:
                segments.append(c); moras.append(len(segments) - 1)
            if ACUTE in marks:
                if acute_at is not None:
                    raise UnsupportedTonganInput("Multiple stress accents in " + repr(text))
                acute_at = len(segments) - 1
            i = j
            continue
        if chars.startswith("ng", i):
            graphemes.append("ng"); segments.append("ŋ"); i += 2
        elif c in CONSONANTS:
            graphemes.append(c); segments.append(c); i += 1
        elif c in GLOTTALS:
            graphemes.append("ʻ"); segments.append("ʔ"); i += 1
        else:
            raise UnsupportedTonganInput("Unsupported Tongan unit " + repr(c) + " in " + repr(text))
    if not segments or not moras or segments[-1] not in VOWELS:
        raise UnsupportedTonganInput("A native word must end in a vowel: " + repr(text))
    for first, second in zip(segments, segments[1:]):
        if first not in VOWELS and second not in VOWELS:
            raise UnsupportedTonganInput("Unrepresented consonant cluster in " + repr(text))
    if acute_at is not None and (acute_at != len(segments) - 1 or trailing):
        raise UnsupportedTonganInput("Ambiguous/nonfinal written accent in " + repr(text))
    marked = acute_at is not None or trailing
    if marked and accent_kind == "definitive":
        segments.append(segments[-1]); moras.append(len(segments) - 1)
    stress_vowel = moras[-1] if marked and accent_kind == "enclitic" else moras[-2 if len(moras) > 1 else -1]
    stress = stress_vowel
    if stress > 0 and segments[stress - 1] not in VOWELS:
        stress -= 1
    warnings = ["native acoustic and listener validation pending"]
    if len(moras) == 1:
        warnings.append("isolated one-mora stress; connected-speech clitic domain is unresolved")
    if any(a in VOWELS and b in VOWELS and a != b for a, b in zip(segments, segments[1:])):
        warnings.append("vowel sequences retained; optional fusion and loanword stress are unresolved")
    return Word(unicodedata.normalize("NFC", str(text)), tuple(segments), tuple(graphemes), tuple(moras),
                stress, accent_kind if marked else "none", tuple(warnings))


def text_words(text, *, digits=False):
    """Return words and punctuation, with only explicitly marked enclitic shifts.

    Digits are rejected unless the caller explicitly asks for digit-by-digit
    names; these are not advertised as a cardinal-number grammar.
    """
    if digits:
        text = re.sub(r"[0-9]", lambda m: " " + DIGIT_NAMES[int(m[0])] + " ", text)
    parts = WORD_PARTS.findall(unicodedata.normalize("NFC", text))
    result, consumed = [], set()
    for pos, part in enumerate(parts):
        if pos in consumed:
            continue
        if not any(c.isalpha() for c in part):
            if any(c.isdigit() for c in part):
                raise UnsupportedTonganInput("Numbers require explicit digit-by-digit mode")
            if any(c not in " \t\r\n.,!?:;()-–—" for c in part):
                raise UnsupportedTonganInput("Unsupported punctuation " + repr(part))
            result.append(part)
            continue
        # Only cross whitespace, never a punctuation/clause boundary.
        immediate = parts[pos + 1:pos + 3]
        linked = (len(immediate) == 2 and immediate[0].isspace()
                  and immediate[1].lower() in CLITICS)
        kind = "enclitic" if linked else "definitive"
        analysed = word(part, accent_kind=kind)
        if linked and analysed.marked_accent == "enclitic":
            clitic = word(immediate[1])
            offset = len(analysed.segments)
            # The overtly marked group is one stress domain, so the one-mora
            # clitic must not receive a fabricated independent primary stress.
            analysed = Word(analysed.text + immediate[0] + clitic.text,
                            analysed.segments + clitic.segments,
                            analysed.graphemes + clitic.graphemes,
                            analysed.mora_positions + tuple(i + offset for i in clitic.mora_positions),
                            analysed.stress_position, "enclitic", analysed.warnings)
            consumed.update((pos + 1, pos + 2))
        result.append(analysed)
    return result


def encoded(text, *, digits=False):
    return "".join(p.encoded if isinstance(p, Word) else p for p in text_words(text, digits=digits))
