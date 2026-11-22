"""Spoken letter names for the experiment's native Latin-language routes."""
from string import ascii_lowercase


NAMES = {
    "sk": "a bé cé dé e ef gé há i jé ká el em en o pé kvé er es té u vé dvojité-vé iks ypsilon zé",
    "pl": "a be ce de e ef gie ha i jot ka el em en o pe ku er es te u fał wu iks igrek zet",
    "de": "ah beh ceh deh eh eff geh hah ih jot kah ell emm enn oh peh kuh err ess teh uh fau weh ix ypsilon zett",
    "fr": "a bé cé dé e effe gé hache i ji ka elle emme enne o pé ku erre esse té u vé double-vé ix i-grec zède",
    "da": "a be se de e ef ge hå i jod kå el em en o pe ku er es te u ve dobbelt-ve eks y sæt",
    "it": "a bi ci di e effe gi acca i i-lunga cappa elle emme enne o pi qu erre esse ti u vu doppia-vu ics ipsilon zeta",
    "es": "a be ce de e efe ge hache i jota ka ele eme ene o pe cu erre ese te u uve uve-doble equis ye zeta",
}

EXTRAS = {
    "sk": dict(zip("áäčďéíĺľňóôŕšťúýž",
                   ("dlhé á", "široké e", "čé", "ďé", "dlhé é", "dlhé í", "dlhé el", "eľ",
                    "eň", "dlhé ó", "ô", "dlhé er", "eš", "ťé", "dlhé ú", "dlhé ypsilon", "žé"))),
    "pl": {"ą":"ą", "ć":"cie", "ę":"ę", "ł":"eł", "ń":"eń", "ó":"u kreskowane",
           "ś":"eś", "ź":"ziet", "ż":"żet"},
    "de": {"ä":"a Umlaut", "ö":"o Umlaut", "ü":"u Umlaut", "ß":"Eszett"},
    "fr": {"à":"a accent grave", "â":"a accent circonflexe", "ç":"cé cédille", "é":"e accent aigu",
           "è":"e accent grave", "ê":"e accent circonflexe", "ë":"e tréma", "î":"i accent circonflexe",
           "ï":"i tréma", "ô":"o accent circonflexe", "œ":"o e liés", "ù":"u accent grave",
           "û":"u accent circonflexe", "ü":"u tréma", "ÿ":"i grec tréma"},
    "da": {"æ":"æ", "ø":"ø", "å":"å"},
    "it": {"à":"a accentata", "è":"e con accento grave", "é":"e con accento acuto",
           "ì":"i accentata", "ò":"o accentata", "ù":"u accentata"},
    "es": {"á":"a con tilde", "é":"e con tilde", "í":"i con tilde", "ñ":"eñe",
           "ó":"o con tilde", "ú":"u con tilde", "ü":"u con diéresis"},
}

for _code, _names in NAMES.items():
    assert len(_names.split()) == 26, _code

LETTERS = {
    code: dict(zip(ascii_lowercase, (word.replace("-", " ") for word in names.split()))) | EXTRAS[code]
    for code, names in NAMES.items()
}


def letter_name(language, char):
    return LETTERS.get(language, {}).get(char.lower())
