"""Immutable original100 workload/auditor, independent of mutable UI probes.

The selected pure nodes below are preserved verbatim from the reviewed plain
probe Git blob3db4eadd4b1b9bc029d33a3272b8f083dcfcbb79. This module performs
no NVDA/device/model actions and does not change expected word memberships.
"""
ORIGINAL_PROBE_GIT_BLOB='3db4eadd4b1b9bc029d33a3272b8f083dcfcbb79'
ORIGINAL_INPUT_UTF8_SHA256='c7cfa1ba024ee6f59bfa0152a4016318c9f8542fbec79f6b7accb07645acbe16'
ORIGINAL_PURE_HELPERS_SHA256='0085c12a1a7da4336a314dd92061ca91ab17ab6c9b91c1448e3c2c4d1d7c630c'

import unicodedata as _plain_unicode

import re as _plain_re

PLAIN_SOURCE_CASES = [{"word":"ольсену","memberships":["uk"]},{"word":"галапагосе","memberships":["uk"]},{"word":"витівкових","memberships":["uk"]},{"word":"доктрину","memberships":["ru","uk"]},{"word":"мегакрутими","memberships":["uk"]},{"word":"утеплювавсь","memberships":["uk"]},{"word":"рушникосушки","memberships":["uk"]},{"word":"яснесенькою","memberships":["uk"]},{"word":"вигибатимеш","memberships":["uk"]},{"word":"курятинами","memberships":["ru","uk"]},{"word":"висловлень","memberships":["uk"]},{"word":"малопривабливій","memberships":["uk"]},{"word":"детектуй","memberships":["uk"]},{"word":"погамував","memberships":["uk"]},{"word":"зализуватимусь","memberships":["uk"]},{"word":"проголених","memberships":["uk"]},{"word":"попідливано","memberships":["uk"]},{"word":"найпискливіш","memberships":["uk"]},{"word":"розплішіться","memberships":["uk"]},{"word":"оберстдорфові","memberships":["uk"]},{"word":"без'ядерності","memberships":["uk"]},{"word":"озимій","memberships":["uk"]},{"word":"променітимем","memberships":["uk"]},{"word":"дідуню","memberships":["uk"]},{"word":"плагіоклазі","memberships":["uk"]},{"word":"непальцем","memberships":["ru","uk"]},{"word":"бережечками","memberships":["uk"]},{"word":"драйвували","memberships":["uk"]},{"word":"кріогідратів","memberships":["uk"]},{"word":"діагенезом","memberships":["uk"]},{"word":"одкочено","memberships":["uk"]},{"word":"незім'яте","memberships":["uk"]},{"word":"присмирённая","memberships":["ru"]},{"word":"списались","memberships":["ru","uk"]},{"word":"аминбаевны","memberships":["ru"]},{"word":"прорубишься","memberships":["ru"]},{"word":"ковыляниями","memberships":["ru"]},{"word":"припоминаньи","memberships":["ru"]},{"word":"оплёвывающуюся","memberships":["ru"]},{"word":"ильменским","memberships":["ru"]},{"word":"донецки","memberships":["ru"]},{"word":"пожалевши","memberships":["ru"]},{"word":"простерёгшего","memberships":["ru"]},{"word":"воспринимала","memberships":["ru"]},{"word":"зарумянивших","memberships":["ru"]},{"word":"лилиянн","memberships":["ru"]},{"word":"переволочило","memberships":["ru","uk"]},{"word":"картофелесортировальных","memberships":["ru"]},{"word":"низлагаемы","memberships":["ru"]},{"word":"питиримах","memberships":["ru"]},{"word":"безмельницыны","memberships":["ru"]},{"word":"иносказательно","memberships":["ru"]},{"word":"петрунелями","memberships":["ru"]},{"word":"антитеатру","memberships":["ru","uk"]},{"word":"синевато-сером","memberships":["ru"]},{"word":"посахаренную","memberships":["ru"]},{"word":"истолковываемое","memberships":["ru"]},{"word":"тяготимому","memberships":["ru"]},{"word":"отсасываемых","memberships":["ru"]},{"word":"саживаешь","memberships":["ru"]},{"word":"поточенной","memberships":["ru"]},{"word":"зашлифовывала","memberships":["ru"]},{"word":"кудесниками","memberships":["ru"]},{"word":"взаимопроникающего","memberships":["ru"]},{"word":"небесно-голубому","memberships":["ru","uk"]},{"word":"нордах","memberships":["ru","uk"]},{"word":"затекли","memberships":["ru","uk"]},{"word":"спохватитесь","memberships":["ru","uk"]},{"word":"кольчуги","memberships":["ru","uk"]},{"word":"скверна","memberships":["ru","uk"]},{"word":"шапочками","memberships":["ru","uk"]},{"word":"питого","memberships":["ru","uk"]},{"word":"зашушукайтесь","memberships":["ru","uk"]},{"word":"камуфляже","memberships":["ru","uk"]},{"word":"уколупнули","memberships":["ru","uk"]},{"word":"полонянка","memberships":["ru","uk"]},{"word":"тумаком","memberships":["ru","uk"]},{"word":"контрпропагандою","memberships":["ru","uk"]},{"word":"маликам","memberships":["ru","uk"]},{"word":"червоточиною","memberships":["ru","uk"]},{"word":"тугрику","memberships":["ru","uk"]},{"word":"дискомфортах","memberships":["ru","uk"]},{"word":"конденсорами","memberships":["ru","uk"]},{"word":"секуляризуй","memberships":["ru","uk"]},{"word":"поморочило","memberships":["ru","uk"]},{"word":"блефуй","memberships":["ru","uk"]},{"word":"скрипни","memberships":["ru","uk"]},{"word":"плющена","memberships":["ru","uk"]},{"word":"термосифонною","memberships":["ru","uk"]},{"word":"обагритесь","memberships":["ru","uk"]},{"word":"лонам","memberships":["ru","uk"]},{"word":"черпав","memberships":["ru","uk"]},{"word":"неоген","memberships":["ru","uk"]},{"word":"перешитому","memberships":["ru","uk"]},{"word":"фталазолом","memberships":["ru","uk"]},{"word":"латникам","memberships":["ru","uk"]}]

def _plain_normalize(word):
    text = _plain_unicode.normalize("NFC", word.casefold().translate(
        str.maketrans({"’": "'", "‘": "'", "ʼ": "'"})))
    result = []
    for char in text:
        if char == "\u0301" and result and _plain_unicode.name(result[-1], "").startswith("CYRILLIC"):
            continue
        result.append(char)
    return "".join(result)

def _plain_tokens(text):
    # Normalize the complete owned text before tokenization, so a combining
    # Cyrillic stress accent cannot silently split one input word in two.
    return _plain_re.findall(r"[^\W\d_]+(?:['’‘ʼ][^\W\d_]+)*", _plain_normalize(text))

def _plain_source_groups():
    groups = {"uk": [], "ru": [], "shared": []}
    seen = set()
    for sample in PLAIN_SOURCE_CASES:
        word = sample["word"]
        members = frozenset(sample["memberships"])
        if word in seen or members not in ({'uk'}, {'ru'}, {'uk', 'ru'}):
            raise ValueError("Source-selected plain-read fixture changed or duplicated")
        seen.add(word)
        groups["shared" if len(members) == 2 else next(iter(members))].append(sample)
    if len(seen) != 96 or not all(groups.values()):
        raise ValueError("The full authenticated96 source fixture is required")
    return groups

def _plain_cases():
    groups = _plain_source_groups()
    mixed = []
    for index in range(max(map(len, groups.values()))):
        for group in ("uk", "ru", "shared"):
            if index < len(groups[group]):
                mixed.append(groups[group][index])
    mixed.extend([groups["uk"][0], groups["ru"][0], groups["shared"][0], groups["uk"][1]])
    if len(mixed) != 100:
        raise ValueError("Plain word-list workload is not exactly100 words")
    tagged = []
    for index in range(3):
        tagged.extend((groups["uk"][index], groups["ru"][index]))
    definitions = (("auto_unmarked_100", mixed, "auto", ["uk", "en", "ru"], False),
        ("forced_uk_unmarked_12", mixed[:12], "forced", ["uk", "en", "ru"], False),
        ("disabled_ru_unmarked_12", mixed[:12], "auto", ["uk", "en"], False),
        ("native_rich_metadata_6", tagged, "auto", ["uk", "en", "ru"], True),
        ("forced_uk_native_metadata_6", tagged, "forced", ["uk", "en", "ru"], True),
        ("disabled_ru_native_metadata_6", tagged, "auto", ["uk", "en"], True),
        ("auto_native_known_compound_1", [{"word": "пресс-центр", "memberships": ["ru"]}],
         "auto", ["uk", "en", "ru"], False))
    result = []
    for name, samples, mode, enabled, metadata in definitions:
        specs = []
        current = "uk"
        for sample in samples:
            members = frozenset(sample["memberships"])
            authored = ("ru" if members == {"uk"} else "uk") if metadata else None
            if mode == "forced" or "ru" not in enabled:
                expected = "uk"
            elif authored is not None:
                expected = authored
            elif len(members) == 1:
                expected = next(iter(members))
            else:
                expected = current  # finite shared membership cannot infer author intent
            specs.append({"word": sample["word"], "memberships": sorted(members),
                          "authored_locale": authored, "expected_language": expected})
            current = expected
        result.append({"name": name, "words": specs, "mode": mode, "enabled": enabled,
                       "native_metadata": metadata, "text": " ".join(row["word"] for row in specs)})
    return result

def _plain_route_audit(words, routes):
    observed = []
    for route in routes:
        language = str(route.get("language", "")).replace("_", "-").lower().split("-")[0]
        for word in _plain_tokens(route.get("text", "")):
            observed.append((word, language))
    expected = []
    for source_index, row in enumerate(words):
        # A hyphenated dictionary form can genuinely span multiple planner
        # requests. Every lexical piece keeps the WHOLE source form's expected
        # locale; no input word is removed or assigned a new dictionary label.
        for piece_index, piece in enumerate(_plain_tokens(row["word"])):
            expected.append((piece, source_index, piece_index, row))
    wanted = [piece for piece, _, _, _ in expected]
    actual = [word for word, _ in observed]
    exact = wanted == actual
    mismatches = []
    if exact:
        mismatches = [{"input_index": source_index, "piece_index": piece_index,
            "source_word": row["word"], "lexical_piece": piece, "memberships": row["memberships"],
            "expected_language": row["expected_language"], "actual_language": observed[index][1],
            "authored_locale": row["authored_locale"]}
            for index, (piece, source_index, piece_index, row) in enumerate(expected)
            if observed[index][1] != row["expected_language"]]
    compact_input = _plain_re.sub(r"\s+", "", _plain_normalize(" ".join(row["word"] for row in words)))
    compact_planned = _plain_re.sub(r"\s+", "", _plain_normalize("".join(route.get("text", "") for route in routes)))
    return {"input_word_count": len(words), "input_lexical_piece_count": len(expected),
        "observed_word_count": len(observed), "observed_lexical_piece_count": len(observed),
        "input_words_preserved_in_order": exact, "lexical_content_preserved_in_order": exact,
        "raw_nonwhitespace_text_preserved": compact_input == compact_planned,
        "raw_punctuation_changes_may_originate_in_nvda_speech_processing": True,
        "hyphenated_source_forms": [row["word"] for row in words if "-" in row["word"]],
        "routing_passed": exact and not mismatches,
        "mismatches": mismatches[:100], "observed_word_routes": [
            {"word": word, "language": language} for word, language in observed],
        "scope": "Every lexical piece of all original finite-source forms; actual segmentation is observed, not bypassed"}

def _plain_sequence(sequence):
    values = []
    for item in sequence:
        if isinstance(item, str):
            values.append({"text": item[:16384]})
        else:
            row = {"command": type(item).__name__}
            for name in ("lang", "index", "state", "explicit"):
                if hasattr(item, name):
                    row[name] = getattr(item, name)
            values.append(row)
    return values


def original_source100():
    """Fresh original full forms and expectations, never shortened or relabeled."""
    import hashlib
    case=_plain_cases()[0]
    if (len(case['words'])!=100 or len(_plain_tokens(case['text']))!=102
            or hashlib.sha256(case['text'].encode('utf-8')).hexdigest()!=ORIGINAL_INPUT_UTF8_SHA256):
        raise ValueError('Immutable authenticated original100 workload differs')
    return case


def audit_original100(routes):
    return _plain_route_audit(original_source100()['words'],routes)
