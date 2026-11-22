"""Declarative voice/language packages; no executable code is loaded from data."""
from pathlib import Path
import json,re

DEFAULT={
 'version':1,'base_voice':'sara_archive',
 'voices':{
  'sara_archive':{'name':'Сара 1','holos':'sara_archive','pocket':'sara_archive','target':'shared/sara_archive.npy'},
  'elis':{'name':'Еліс','holos':'elis','pocket':'elis','target':'shared/elis.npy'},
  'bella':{'name':'Белла','holos':'bella','pocket':'bella','target':'shared/bella.npy'}},
 'languages':{
  'uk':{'backend':'holos','phonemizer':'uk','aliases':['uk_UA'],'preload':True},
  'ru':{'backend':'holos','phonemizer':'ru','aliases':['ru_RU'],'preload':True},
  'en':{'backend':'pocket','aliases':['en_US','en_GB'],'auto_detect':True,'preload':True},
  'sk':{'backend':'rhvoice','model':'Slovak','voice':'Jasietka','source':'shared/sources/sk-rhvoice.npy','aliases':['sk_SK'],'auto_detect':True,'preload':True},
  'de':{'backend':'piper','model':'Piper/de_DE-kerstin-medium.onnx','source':'shared/sources/de-piper.npy','aliases':['de_DE'],'auto_detect':True,'preload':True},
  'pl':{'backend':'piper','model':'Piper/pl_PL-gosia-medium.onnx','source':'shared/sources/pl-piper.npy','aliases':['pl_PL'],'auto_detect':True,'preload':True}}}

# Compatibility adapters above remain readable in older catalogs. New packages
# use one joint acoustic model instead of per-language source speakers.
for _code, _alias in {'fr': 'fr_FR', 'da': 'da_DK', 'it': 'it_IT', 'es': 'es_ES'}.items():
    DEFAULT["languages"][_code] = dict(aliases=[_alias], auto_detect=True, preload=True)
for _language in DEFAULT['languages'].values():
    _language.pop('phonemizer',None);_language.pop('voice',None)
    _language.update(backend='supertonic',model='Supertonic3',source='shared/sources/common-supertonic.npy',
                     steps=8,vector_model='vector_estimator.static-q8.onnx')

def acoustic_graph(folder,name):
    source=folder/name
    if source.suffix=='.onnx':
        compiled=source.with_suffix('.ort')
        if compiled.is_file():return compiled
    return source

class Registry:
    def __init__(self,models=None,data=None):
        self.models=Path(models) if models else Path(__file__).parent/'models'
        path=self.models/'voices/catalog.json'
        self.data=json.loads(json.dumps(data)) if data is not None else json.loads(path.read_text(encoding='utf8')) if path.is_file() else json.loads(json.dumps(DEFAULT))
        if self.data.get('version')!=1:raise ValueError('Unsupported voice registry version')
        self.voices=self.data['voices'];self.languages=self.data['languages']
        self.aliases={alias.lower().replace('_','-'):code for code,row in self.languages.items() for alias in row.get('aliases',[])}
        if self.data['base_voice'] not in self.voices:raise ValueError('Missing base voice')
        for key,voice in self.voices.items():
            if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}',key) or not isinstance(voice.get('name'),str):
                raise ValueError('Invalid voice registration')
            if voice.get('target'):self.resource('voices/'+voice['target'])
        for code,language in self.languages.items():
            if not re.fullmatch(r'[a-z]{2,3}(?:-[a-z0-9]{2,8})*',code):raise ValueError('Invalid language code')
            if language.get('backend') not in ('holos','pocket','piper','rhvoice','supertonic'):raise ValueError('Unsupported language adapter')
            if language['backend'] in ('piper','rhvoice','supertonic') and not all(language.get(k) for k in ('model','source')):raise ValueError('Missing native language resources')
            if language['backend']=='rhvoice' and not language.get('voice'):raise ValueError('Missing RHVoice carrier voice')
            if language.get('model'):self.resource(language['model'])
            if language.get('source'):self.resource('voices/'+language['source'])

    def resource(self,relative):
        path=(self.models/relative).resolve()
        if not path.is_relative_to(self.models.resolve()):raise ValueError('Package path escapes model directory')
        return path

    def names(self):return {key:row['name'] for key,row in self.voices.items()}
    def voice(self,key):return self.voices[key]
    def language(self,code):return self.languages[self.locale(code)]
    def locale(self,tag):
        value=(tag or '').lower().replace('_','-')
        if value in self.languages:return value
        if value in self.aliases:return self.aliases[value]
        return value.split('-')[0] if value.split('-')[0] in self.languages else 'uk'
    def accepts(self,tag):
        value=(tag or '').lower().replace('_','-')
        return value in self.languages or value in self.aliases or value.split('-')[0] in self.languages
    def native_carrier(self,code):return self.language(code)['backend'] in ('piper','rhvoice','supertonic')
    def available_languages(self):
        return set(self.languages)|{alias for row in self.languages.values() for alias in row.get('aliases',[])}
    def source_voice(self,voice,backend):
        return self.voice(voice).get(backend) or self.data['base_voice']

REGISTRY=Registry()
