"""A chosen optional locale applies only to genuinely unmarked speech.

This module neither discovers models nor declares support. Callers supply the
intersection of already installed, enabled and verified optional languages.
"""


def available(personal, installed, enabled):
    installed, enabled = set(installed), set(enabled)
    return {code: row for code, row in personal.items()
            if code in installed and code in enabled and isinstance(row, dict)
            and isinstance(row.get("name"), str) and row["name"].strip()}


def normalized_choice(value, allowed):
    if not isinstance(value, str):
        return "auto"
    value = value.strip().lower().replace("_", "-")
    return value if value != "auto" and value in allowed else "auto"


def apply_default(sequence, selected, fallback, language_command, origin_command):
    """Rewrite only original-default segments; retain source objects otherwise.

    Track the original concrete locale separately from the chosen default. A
    later explicit-origin marker might have no LangChange because NVDA omitted
    a redundant same-locale command; it must restore that original locale.
    """
    if selected == "auto":
        return sequence
    items = tuple(sequence)
    if not any(isinstance(item, str) and item.strip() for item in items):
        return sequence if isinstance(sequence, (tuple, list)) else items
    output = [origin_command(True), language_command(selected)]
    original_language = fallback
    original_explicit = None  # Untagged direct callers retain named locales.
    for item in items:
        if isinstance(item, origin_command):
            original_explicit = item.explicit
            if item.explicit:
                output.append(item)
                output.append(language_command(original_language))
            else:
                output.append(origin_command(True))
                output.append(language_command(selected))
        elif isinstance(item, language_command):
            original_language = item.lang or fallback
            if original_explicit is False or original_explicit is None and not item.lang:
                output.append(language_command(selected))
            else:
                output.append(item)
        else:
            output.append(item)
    return tuple(output)
