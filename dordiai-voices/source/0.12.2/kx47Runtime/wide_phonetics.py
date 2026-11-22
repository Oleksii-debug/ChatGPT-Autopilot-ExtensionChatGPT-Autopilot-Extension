"""Local orthography-to-IPA rules and table-specific acoustic phoneme spellings."""
import json
from functools import lru_cache
from pathlib import Path
import re
import unicodedata

ROUTES={"nn":"gmq/nb","fy":"gmw/nl","oc":"roa/ca","sro":"roa/it"}
DIGITS={
    "nn":"null ein to tre fire fem seks sju åtte ni".split(),
    "fy":"nul ien twa trije fjouwer fiif seis sân acht njoggen".split(),
    "oc":"zèro un dos tres quatre cinc sièis sèt uèch nòu".split(),
    "sro":"zeru unu duus tres cuàturu cincu ses seti otu noi".split(),
}


def rules(entries):
    return [(re.compile(pattern),out,swap) for pattern,out,swap in entries]


def apply_rules(text,steps):
    for pattern,out,swap in steps:
        if swap:
            text=pattern.sub(lambda m:(m["before"] or "")+(m["sw2"] or "")+(m["sw1"] or "")+(m["after"] or ""),text)
        else:
            text=pattern.sub(lambda m:(m["before"] or "")+out+(m["after"] or ""),text)
    return text


def scanner(mapping):
    return re.compile("|".join(re.escape(item) for item in sorted(mapping,key=len,reverse=True) if item))


class PronunciationRules:
    def __init__(self,folder,code):
        folder=Path(folder)
        self.code=code
        data=json.loads((folder/(code+".json")).read_bytes())
        self.pre=rules(data["pre"]);self.post=rules(data["post"])
        self.mapping=data["map"]
        self.scan=scanner(self.mapping)
        acoustic=folder/(code+"-phones.json")
        self.phones=json.loads(acoustic.read_bytes()) if acoustic.is_file() else {}
        self.phone_regex=scanner(self.phones) if self.phones else None

    @lru_cache(maxsize=512)
    def ipa(self,text):
        norm=unicodedata.normalize("NFD",text.lower())
        prepared=apply_rules(norm,self.pre)
        mapped=self.scan.sub(lambda m:self.mapping[m[0]],prepared)
        return unicodedata.normalize("NFC",apply_rules(mapped,self.post))

    def encoded(self,text,strict=True):
        text=re.sub(r"\d",lambda m:" "+DIGITS[self.code][unicodedata.digit(m[0])]+" ",text)
        ipa=self.ipa(text)
        tokens=[]
        for part in re.findall(r"[\w\u0300-\u036f\u02b0-\u02ff\u1d00-\u1dff]+|[^\w\u0300-\u036f\u02b0-\u02ff\u1d00-\u1dff]+",ipa):
            if not any(ch.isalpha() for ch in part):
                tokens.append(part.replace("["," ").replace("]"," "))
                continue
            pos=0;word=[]
            while pos<len(part):
                m=self.phone_regex.match(part,pos)
                if not m:
                    if strict:raise ValueError("Unrepresented pronunciation unit "+repr(part[pos])+" in "+part)
                    # A foreign proper name may carry letters absent from the rules.
                    # Keep it audible when passed to the acoustic table.
                    tokens.append(part);word=[];break
                word.append(self.phones[m[0]]);pos=m.end()
            if word:tokens.append("[["+"".join(word)+"]]")
        return "".join(tokens)
