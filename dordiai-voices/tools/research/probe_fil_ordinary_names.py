"""Pinned Filipino28 instance of the isolated common ordinary-name PCM proof."""
from pathlib import Path
import importlib.util
spec=importlib.util.spec_from_file_location('_ordinary_name_pcm_shared',Path(__file__).with_name('ordinary_name_pcm_probe.py'))
common=importlib.util.module_from_spec(spec);spec.loader.exec_module(common)
DEFINITION={'format': 'dordiai-fil-ordinary-name-candidate-v1', 'code': 'fil', 'iso': 'tgl', 'count': 28, 'repertoire': ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'ñ', 'ng', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'], 'candidate_sha': 'c09796a1e0f5fe5dc85d4b51b029ecfbf1946ada9e92e703f93f0f2290b1c41a', 'source_sha': '5f20b7eb93ef53af129822bede538121b8967fbc0e7fd93c64bef646d740f66f', 'required_names': {'j': 'dyey', 'ñ': 'enye', 'ng': 'en dyi'}, 'pack_bytes': 105531396, 'pack_sha': '0dbb2c1846544c99160aae53373b908ed583065cbe4561313bec15fd4f6a7985', 'model_sha': 'f0594f259f7016a0ff00d5e72886f946e6ed6ae8edf1d9e78649f24d59c83ffb'}
if __name__=='__main__':common.main(DEFINITION)
