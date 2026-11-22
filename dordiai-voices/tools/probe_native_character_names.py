#!/usr/bin/env python3
from pathlib import Path
import json,sys,tempfile,time,hashlib
ROOT=Path(__file__).resolve().parents[1]
import argparse
parser=argparse.ArgumentParser(description='Real local native ordinary-name PCM probes, not pronunciation or NVDA acceptance')
parser.add_argument('--onnxruntime-root',type=Path,required=True)
args=parser.parse_args()
safe=args.onnxruntime_root.resolve()
sys.path.insert(0,str(safe))
for binary in (p for p in safe.rglob('*') if p.is_file() and (p.suffix.lower() in {'.so','.dll','.pyd'} or '.so.' in p.name)):
 data=binary.read_bytes()
 if b'mobile.events.data.microsoft.com' in data or b'OneCollector' in data:
  raise RuntimeError('Refusing previously rejected telemetry-capable preparation runtime')
import onnxruntime as ort
assert ort.__version__=='1.27.0' and Path(ort.__file__).resolve().is_relative_to(safe)
ort.disable_telemetry_events()
import numpy as np,soundfile as sf
sys.path.insert(0,str(ROOT/'source/0.12.2/kx47Runtime'))
from character_names import spoken_name
from wide_mms import MMSCarrier
from wide_omnivoice_onnx import audio as omni_audio
resources=ROOT/'source/0.12.2/kx47Runtime/models/CharacterNames'
out=ROOT/'evidence/ordinary_alphabet_probes';out.mkdir(exist_ok=True)
report={'scope':'Real offline Linux native-carrier PCM. No human pronunciation, full alphabet audio, target-voice projection or NVDA acceptance claim.','onnxruntime':ort.__version__,'languages':{}}
with tempfile.TemporaryDirectory(prefix='dordiai-character-probe-') as temporary:
 models=Path(temporary)
 (models/'CharacterNames').symlink_to(resources,target_is_directory=True)
 (models/'MMS').symlink_to(ROOT/'model-packs/mms/kx47Runtime/models/MMS',target_is_directory=True)
 (models/'SharedOmniONNX').symlink_to(ROOT/'model-packs/extra-onnx/kx47Runtime/models/SharedOmniONNX',target_is_directory=True)
 for code,keys in [('ha',['b','ɓ','sh']),('ay',['ch','ñ',"q'"]),('rm',['b','c','w'])]:
  doc=json.loads((resources/(code+'.json')).read_text(encoding='utf-8'));entry={'source_alphabet_complete':doc['ordinary_alphabet_source_complete'],'source_native_names':len(doc['ordinary_alphabet_source_repertoire']),'clips':[],'human_pronunciation_accepted':False}
  report['languages'][code]=entry
  if code!='rm':
   carrier=MMSCarrier(models/'MMS'/code)
   errors={}
   for glyph in doc['ordinary_alphabet_source_repertoire']:
    name=spoken_name(code,glyph,directory=resources)
    try:carrier.frontend.ids(name)
    except ValueError as error:errors[glyph]=str(error)
   entry['all_source_names_native_vocabulary_errors']=errors
  for glyph in keys:
   name=spoken_name(code,glyph,directory=resources);start=time.perf_counter()
   if code=='rm':wave,sr=omni_audio(code,glyph,True,models=models)
   else:wave,sr,_=carrier.audio(glyph,character=True)
   elapsed=time.perf_counter()-start
   assert np.isfinite(wave).all() and np.max(np.abs(wave))>1e-7
   path=out/(code+'-'+str(len(entry['clips']))+'.wav');sf.write(path,wave,sr,subtype='PCM_16')
   result={'glyph':glyph,'resolved_native_name':name,'samples':len(wave),'sample_rate':sr,'seconds':elapsed,'peak':float(np.max(np.abs(wave))),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'path':str(path.relative_to(ROOT))}
   entry['clips'].append(result)
   (ROOT/'evidence/ordinary_alphabet_probes.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
   print(code,result,flush=True)
  if code!='rm':carrier.close()
