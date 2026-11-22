"""Pure standard-library native Kashmiri tokenizer for routing prevalidation.

No acoustic modules are imported, so catalogue checks can inspect a request
before choosing an installed same-language alternative.
"""
import re

FRONTEND_FORMAT = "dordiai-matcha-native-frontend-v1"


class UnsupportedMatchaInput(ValueError):
    pass


def _replace(text, mapping):
    inverted = {variant: canonical for canonical, variants in mapping.items() for variant in variants}
    if not inverted:
        return text
    expression = "|".join(re.escape(value) for value in sorted(inverted, key=len, reverse=True))
    return re.sub(expression, lambda match: inverted[match.group()], text)


class MatchaFrontend:
    InputError = UnsupportedMatchaInput

    def __init__(self, config):
        if config.get("format") != FRONTEND_FORMAT or config.get("code") != "ks":
            raise ValueError("Invalid native Kashmiri frontend")
        self.config = config
        symbols = config.get("symbols")
        if (not isinstance(symbols, list) or len(symbols) != 272 or symbols[0] != "_"
                or any(not isinstance(item, str) for item in symbols)):
            raise ValueError("Invalid trained Kashmiri vocabulary")
        # Upstream contains four repeated symbols; dict construction deliberately
        # retains the last occurrence, exactly as its training tokenizer does.
        self.symbols = {symbol: index for index, symbol in enumerate(symbols)}
        self.allowed = frozenset(config["allowed_characters"])
        for name in ("character_mapping", "punctuation_mapping", "digits_mapping", "word_to_digit_mapping"):
            value = config.get(name)
            if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, list)
                                                  or any(not isinstance(x, str) or not x for x in v)
                                                  for k, v in value.items()):
                raise ValueError("Invalid pinned Kashmiri normalization table")

    def normalized(self, text):
        text = _replace(str(text), self.config["character_mapping"])
        text = _replace(text, self.config["punctuation_mapping"])
        text = re.sub(r"\bؠ|ؠ\b", "ۍ", text)
        text = _replace(text, self.config["digits_mapping"])
        text = _replace(text, self.config["word_to_digit_mapping"])
        punctuations = "".join(re.escape(item) for item in self.config["punctuations"])
        if punctuations:
            text = re.sub(r"(?<=[" + punctuations + r"])(?=[^" + punctuations + r"0-9 \n])", " ", text)
            text = re.sub(r"\s+([" + punctuations + r"])", r"\1", text)
        unsupported = sorted({char for char in text if char not in self.allowed and not char.isspace()})
        if unsupported:
            raise self.InputError("Native Kashmiri checkpoint has no trained symbols for " + repr("".join(unsupported)))
        # Canonical spaces and line endings are harmless; every non-space symbol
        # must retain its actual trained ID rather than disappear during input.
        text = re.sub(r"\s+", " ", text).strip()
        missing = sorted({char for char in text if char not in self.symbols})
        if missing:
            raise self.InputError("Native Kashmiri tokenizer cannot encode " + repr("".join(missing)))
        return text

    def ids(self, text):
        normalized = self.normalized(text)
        if not normalized:
            raise self.InputError("Empty native Kashmiri input")
        result = [0]
        for char in normalized:
            result.extend((self.symbols[char], 0))
        return result

