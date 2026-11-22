"""Actual NVDA configuration/profile APIs using an isolated metadata-only fixture.

No product addon, acoustic model or private Python interpreter is installed.
Candidate methods run on actual NVDA classes in a fresh private config path.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[1]
EXPECTED_INPUTS = {
    "driver.py": "06e9f652060dd78c9aae6b17d8d38692d58e9ec4",
    "personal_language.py": "c5c8d4dc2a0a666283c6ab6041df6228e5016d45",
    "preferences.py": "dc8aab9ba81a6a53d3e0bc9a7eb0edf7c46532d6",
    "language_codes.py": "1a86ca3cea4ab731a6a8a4979c7f729a1cb518ee",
    "language_iso_aliases.json": "431a3327fe2e1b8f6fdd16a3b1989b45050e8177"}

HOST_PLUGIN = "\nimport ast\nfrom collections import OrderedDict\nimport config\nimport core\nimport globalPluginHandler\nimport globalVars\nimport hashlib\nimport importlib.util\nimport inspect\nimport json\nfrom pathlib import Path\nimport synthDriverHandler\nimport sys\nimport traceback\nimport types\nimport versionInfo\nfrom autoSettingsUtils.driverSetting import DriverSetting\nfrom configobj import ConfigObj\n\nSETTINGS = __PERSONAL_SETTINGS__\n\n\ndef _load(name, path):\n    spec=importlib.util.spec_from_file_location(name,path)\n    module=importlib.util.module_from_spec(spec)\n    spec.loader.exec_module(module)\n    return module\n\n\ndef run_personal_settings_probe():\n    report={\"format\":\"dordiai-real-frozen-personal-settings\",\"format_version\":1,\n        \"run_id\":SETTINGS[\"run_id\"],\"status\":\"failed\",\"nvda_version\":versionInfo.version,\n        \"frozen\":bool(getattr(sys,\"frozen\",False)),\"python\":sys.version,\"checks\":[],\n        \"scope\":\"Actual NVDA configuration APIs with candidate methods and metadata-only optional-language fixtures\",\n        \"product_addon_installed\":False,\"product_archive_modified\":False,\n        \"optional_language_model_installed\":False,\"optional_language_speech_verified\":False,\n        \"physical_audio_verified\":False,\"acoustic_latency_verified\":False,\"pronunciation_verified\":False,\n        \"product_ready\":False,\"fake_production_audio\":False}\n    checks=report[\"checks\"]\n    original=synthDriverHandler.getSynth()\n    profiles=[]\n    fixture=None\n    def require(name,passed,**details):\n        checks.append({\"name\":name,\"status\":\"passed\" if passed else \"failed\",**details})\n        if not passed:raise AssertionError(\"Actual personal settings API invariant: \"+name)\n    try:\n        require(\"actual_frozen_nvda\",report[\"frozen\"] and versionInfo.version==\"2026.3.1\")\n        require(\"actual_host_python_313\",sys.version_info[:2]==(3,13))\n        require(\"builtin_silence_only\",getattr(original,\"name\",None)==\"silence\")\n        payload=Path(SETTINGS[\"payload_directory\"])\n        for filename,digest in SETTINGS[\"payload_sha256\"].items():\n            require(\"payload_\"+filename,hashlib.sha256((payload/filename).read_bytes()).hexdigest()==digest)\n        prefs=_load(\"_dordiai_owned_personal_preferences\",payload/\"preferences.py\")\n        policy=_load(\"_dordiai_owned_personal_policy\",payload/\"personal_language.py\")\n        wide=types.SimpleNamespace(PERSONAL={\"gag\":{\"name\":\"Metadata-only Gagauz fixture\"}},\n            refresh_personal=lambda force=False:None)\n        tree=ast.parse((payload/\"driver.py\").read_text(encoding=\"utf-8\"))\n        candidate=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name==\"SynthDriver\")\n        methods={\"_dordiai_personal_languages\",\"_get_availablePersonallanguages\",\"_get_personalLanguage\",\n            \"_set_personalLanguage\",\"_getConfigSpecForSettings\",\"loadSettings\",\"saveSettings\"}\n        selected=[node for node in candidate.body if isinstance(node,ast.FunctionDef) and node.name in methods]\n        require(\"exact_candidate_methods_selected\",len(selected)==len(methods))\n        setting_call=next(node for node in ast.walk(candidate) if isinstance(node,ast.Call)\n            and isinstance(node.func,ast.Name) and node.func.id==\"DriverSetting\"\n            and node.args and isinstance(node.args[0],ast.Constant) and node.args[0].value==\"personalLanguage\")\n        setting=eval(compile(ast.fix_missing_locations(ast.Expression(setting_call)),\"actual-owned-setting\",\"eval\"),\n            {\"DriverSetting\":DriverSetting})\n        require(\"actual_driver_setting_useconfig_false\",setting.useConfig is False and setting.defaultVal==\"auto\")\n        driver_name=\"dordiaiOwnedPersonal\"+SETTINGS[\"run_id\"][:8]\n        # These fixture methods declare no acoustic backend and are never selected.\n        extra=ast.parse(\"\"\"\nname=OWNED_DRIVER_NAME\ndescription=\"Owned configuration-only fixture (not a synthesizer)\"\nsupportedSettings=(OWNED_SETTING,)\n_cache_personalLanguage=False\n@classmethod\ndef check(cls): return False\ndef _dordiai_all_languages(self): return OrderedDict((code,code) for code in self.fixture_installed)\ndef _dordiai_all_voices(self): return OrderedDict(fixture=\"Metadata-only voice fixture\")\ndef _dordiai_compatible_voices(self,code): return (\"fixture\",)\ndef _get_voice(self): return \"fixture\"\ndef _getAvailableVoices(self): return OrderedDict(fixture=VoiceInfo(\"fixture\",\"Metadata-only fixture\",\"uk\"))\ndef speak(self,*a,**kw): raise AssertionError(\"A configuration-only fixture has no speech engine\")\ndef cancel(self): raise AssertionError(\"A configuration-only fixture has no audio engine\")\ndef pause(self,*a,**kw): raise AssertionError(\"A configuration-only fixture has no audio engine\")\n\"\"\").body\n        namespace={\"__name__\":\"_dordiai_owned_personal_settings\",\"PreferencesMixin\":prefs.PreferencesMixin,\n            \"NativeSynthDriver\":synthDriverHandler.SynthDriver,\"_personal_language\":policy,\"_wide\":wide,\n            \"OrderedDict\":OrderedDict,\"VoiceInfo\":synthDriverHandler.VoiceInfo,\"config\":config,\n            \"OWNED_SETTING\":setting,\"OWNED_DRIVER_NAME\":driver_name}\n        definition=ast.ClassDef(name=\"PrivateSettingsDriver\",\n            bases=[ast.Name(id=\"PreferencesMixin\",ctx=ast.Load()),ast.Name(id=\"NativeSynthDriver\",ctx=ast.Load())],\n            keywords=[],body=extra+selected,decorator_list=[])\n        exec(compile(ast.fix_missing_locations(ast.Module(body=[definition],type_ignores=[])),\n            \"owned-exact-candidate-settings-methods\",\"exec\"),namespace)\n        cls=namespace[\"PrivateSettingsDriver\"]\n        fixture=cls.__new__(cls)\n        fixture.fixture_installed=(\"uk\",\"gag\")\n        fixture._dordiai_init()\n        fixture.personalLanguage=\"auto\"\n        require(\"actual_host_auto_properties\",fixture.personalLanguage==\"auto\" and\n            hasattr(type(fixture),\"personalLanguage\"))\n        spec=fixture.getConfigSpec()\n        require(\"actual_super_config_spec\",spec.get(\"personalLanguage\")==\"string(default='auto')\")\n        report[\"actual_api\"]={\"driver_setting_signature\":str(inspect.signature(DriverSetting)),\n            \"mro\":[item.__module__+\".\"+item.__name__ for item in cls.__mro__],\n            \"base_load_function\":synthDriverHandler.SynthDriver.loadSettings.__module__,\n            \"base_save_function\":synthDriverHandler.SynthDriver.saveSettings.__module__,\n            \"base_configspec_classmethod\":isinstance(inspect.getattr_static(\n                synthDriverHandler.SynthDriver,\"_getConfigSpecForSettings\"),classmethod),\n            \"candidate_method_names\":sorted(methods),\"useConfig\":setting.useConfig}\n        fixture.initSettings()\n        require(\"fresh_base_optional_default_auto\",fixture.personalLanguage==\"auto\" and\n            config.conf[\"speech\"][driver_name][\"personalLanguage\"]==\"auto\")\n        require(\"actual_classmethod_config_api\",report[\"actual_api\"][\"base_configspec_classmethod\"])\n        # Use real ConfigManager profile files in this fresh private --config-path.\n        a=\"owned-personal-a-\"+SETTINGS[\"run_id\"][:8]\n        b=\"owned-personal-b-\"+SETTINGS[\"run_id\"][:8]\n        for name in (a,b):\n            config.conf.createProfile(name);profiles.append(name)\n        config.conf.manualActivateProfile(a)\n        fixture.initSettings()\n        section=config.conf[\"speech\"][driver_name]\n        section[prefs.ENABLED_LANGUAGES_KEY]=\"uk gag\"\n        section[prefs.CONFIG_KEYS[2]]=\"uk\"\n        section[\"personalLanguage\"]=\"gag\"\n        fixture.loadSettings()\n        require(\"profile_a_load_after_enabled_state\",fixture.personalLanguage==\"gag\" and\n            fixture._dordiai_enabled_languages==frozenset((\"uk\",\"gag\")))\n        require(\"actual_available_control_info\",list(fixture.availablePersonallanguages)==[\"auto\",\"gag\"] and\n            fixture.availablePersonallanguages[\"gag\"].displayName==\"Metadata-only Gagauz fixture\")\n        fixture.saveSettings()\n        config.conf.save()\n        require(\"profile_a_saved_choice\",section[\"personalLanguage\"]==\"gag\")\n        profile_a_filename=Path(config.conf.profiles[-1].filename)\n        require(\"profile_a_saved_to_owned_file\",profile_a_filename.is_file() and\n            profile_a_filename.parent==Path(SETTINGS[\"config_path\"])/\"profiles\")\n        require(\"profile_a_written_choice\",ConfigObj(str(profile_a_filename),encoding=\"UTF-8\",file_error=True)\n            [\"speech\"][driver_name][\"personalLanguage\"]==\"gag\")\n        config.conf.manualActivateProfile(b)\n        fixture.initSettings()\n        require(\"fresh_profile_inherits_base_auto\",fixture.personalLanguage==\"auto\")\n        section_b=config.conf[\"speech\"][driver_name]\n        section_b[prefs.ENABLED_LANGUAGES_KEY]=\"uk\"\n        section_b[prefs.CONFIG_KEYS[2]]=\"uk\"\n        section_b[\"personalLanguage\"]=\"auto\"\n        fixture.loadSettings(onlyChanged=True)\n        fixture.saveSettings()\n        config.conf.save()\n        require(\"profile_b_independent_auto\",fixture.personalLanguage==\"auto\" and\n            section_b[\"personalLanguage\"]==\"auto\")\n        require(\"profile_b_save_did_not_rewrite_profile_a\",ConfigObj(str(profile_a_filename),encoding=\"UTF-8\",file_error=True)\n            [\"speech\"][driver_name][\"personalLanguage\"]==\"gag\")\n        config.conf.manualActivateProfile(a)\n        fixture.loadSettings(onlyChanged=True)\n        require(\"profile_a_choice_survives_profile_b_save\",fixture.personalLanguage==\"gag\")\n        # Resource removal changes only this fixture's metadata; no model exists.\n        fixture.fixture_installed=(\"uk\",)\n        fixture.loadSettings()\n        require(\"absent_optional_resource_profile_loads\",fixture.personalLanguage==\"auto\" and\n            list(fixture.availablePersonallanguages)==[\"auto\"])\n        fixture.saveSettings()\n        require(\"unavailable_choice_saved_as_auto\",config.conf[\"speech\"][driver_name][\"personalLanguage\"]==\"auto\")\n        fixture.fixture_installed=(\"uk\",\"gag\")\n        fixture.loadSettings(onlyChanged=True)\n        require(\"saved_auto_does_not_resurrect\",fixture.personalLanguage==\"auto\")\n        config.conf[\"speech\"][driver_name][prefs.ENABLED_LANGUAGES_KEY]=\"uk gag\"\n        fixture.loadSettings(onlyChanged=True)\n        fixture.personalLanguage=\"gag\"\n        fixture.saveSettings()\n        config.conf[\"speech\"][driver_name][prefs.ENABLED_LANGUAGES_KEY]=\"uk\"\n        fixture.loadSettings(onlyChanged=True)\n        require(\"disabled_choice_reset_in_actual_profile\",fixture.personalLanguage==\"auto\")\n        fixture.saveSettings()\n        config.conf.manualActivateProfile(b)\n        fixture.loadSettings(onlyChanged=True)\n        require(\"profile_b_remains_unchanged\",fixture.personalLanguage==\"auto\" and\n            config.conf[\"speech\"][driver_name][\"personalLanguage\"]==\"auto\")\n        require(\"global_synth_never_selected_fixture\",synthDriverHandler.getSynth() is original)\n        report[\"status\"]=\"passed-actual-settings-api\"\n    except Exception as error:\n        report[\"error\"]={\"type\":type(error).__name__,\"reason\":str(error),\n            \"frames\":[{\"file\":Path(frame.filename).name,\"function\":frame.name,\"line\":frame.lineno}\n                for frame in traceback.extract_tb(error.__traceback__)[-16:]]}\n    finally:\n        cleanup=[]\n        try:config.conf.manualActivateProfile(None)\n        except Exception as error:cleanup.append(type(error).__name__)\n        for name in profiles:\n            try:config.conf.deleteProfile(name)\n            except Exception as error:cleanup.append(type(error).__name__)\n        try:\n            if original is not None and synthDriverHandler.getSynth() is original:\n                synthDriverHandler.changeVoice(original,None)\n            else:cleanup.append(\"OriginalSelectedSynthChanged\")\n        except Exception as error:cleanup.append(type(error).__name__)\n        report[\"cleanup\"]={\"errors\":cleanup,\"owned_profiles_removed\":not cleanup,\n            \"original_synth_preserved\":synthDriverHandler.getSynth() is original,\n            \"config_scope\":\"Fresh private portable NVDA profile only\"}\n        if cleanup:report[\"status\"]=\"failed-cleanup\"\n        path=Path(SETTINGS[\"report_path\"])\n        temporary=path.with_name(path.name+\".writing\")\n        temporary.write_text(json.dumps(report,ensure_ascii=False,indent=2)+\"\\n\",encoding=\"utf-8\")\n        temporary.replace(path)\n        core.callLater(100,core.triggerNVDAExit)\n\n\nclass GlobalPlugin(globalPluginHandler.GlobalPlugin):\n    def __init__(self,*args,**kwargs):\n        super().__init__(*args,**kwargs)\n        core.callLater(1500,run_personal_settings_probe)\n"

def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def prepare_owned_inputs(candidate, runtime, run):
    candidate, runtime, run = Path(candidate), Path(runtime), Path(run)
    external=run/"external"
    external.mkdir()
    digests={}
    for name,expected in EXPECTED_INPUTS.items():
        source=(candidate if name in {"driver.py","personal_language.py"} else runtime)/name
        if not source.is_file() or source.is_symlink() or source.stat().st_size>1024*1024:
            raise ValueError("Reviewed candidate input must be a bounded regular file: "+name)
        raw=source.read_bytes()
        if hashlib.sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=expected:
            raise ValueError("Reviewed candidate input Git blob differs: "+name)
        target=external/name
        target.write_bytes(raw)
        digests[name]=hashlib.sha256(raw).hexdigest()
        if sha256_file(target)!=digests[name]:
            raise ValueError("Owned candidate copy changed: "+name)
    return {"payload_directory":str(external),"payload_sha256":digests,
        "candidate_git_blobs":dict(EXPECTED_INPUTS)}


def base_controller():
    spec=importlib.util.spec_from_file_location("_dordiai_pinned_nvda_bootstrap",
        Path(__file__).with_name("windows_nvda_probe.py"))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stop_owned(process):
    if process is not None and process.poll() is None:
        subprocess.run(["taskkill","/PID",str(process.pid),"/T","/F"],
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
        process.wait(timeout=20)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-dir",type=Path,required=True)
    parser.add_argument("--runtime-dir",type=Path,default=ROOT/"source/0.12.2/kx47Runtime")
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--installer-cache",type=Path)
    parser.add_argument("--timeout",type=float,default=180)
    args=parser.parse_args(argv)
    if not 1<=args.timeout<=300:
        parser.error("Owned probe timeout must be within1..300seconds")
    args.output.mkdir(parents=True,exist_ok=False)
    output=args.output.resolve()
    report={"format":"dordiai-frozen-nvda-personal-settings-controller","format_version":1,"status":"blocked",
        "scope":"Actual host configuration APIs with metadata-only fixture; no product or model addon installed",
        "nvda_host_verified":False,"production_routing_verified":False,
        "physical_audio_verified":False,"acoustic_latency_verified":False,"pronunciation_verified":False,
        "product_ready":False,"product_archive_used":False}
    process=None
    run=None
    try:
        if os.name!="nt":
            report["reason"]="Real Windows frozen NVDA host required"
            return 2
        base=base_controller()
        existing=base.existing_nvda_processes()
        if existing:
            report["reason"]="Unrelated NVDA instance active; refusing interaction"
            return 2
        # A short disposable location avoids the official NVDA portable installer's
        # directory MAX_PATH limitation. This is explicitly NOT installed long-path proof.
        run=Path(tempfile.mkdtemp(prefix="dps-nvda-"))
        run_id=uuid.uuid4().hex
        report.update(run_id=run_id,run_directory=str(run),installed_long_path_verified=False,
                      optional_language_model_installed=False)
        settings=prepare_owned_inputs(args.candidate_dir.resolve(),args.runtime_dir.resolve(),run)
        config=run/"config"
        config.mkdir()
        (config/"profiles").mkdir()
        configuration=("[general]\nshowWelcomeDialog = False\naskToExit = False\nsaveConfigurationOnExit = False\n"
            "playStartAndExitSounds = False\nlanguage = en\n[update]\nautoCheck = False\nstartupNotification = False\n"
            "[speech]\nsynth = silence\n")
        (config/"nvda.ini").write_text(configuration,encoding="utf-8")
        installer=base.verified_installer(args.installer_cache.resolve() if args.installer_cache else output/"nvda_2026.3.1.exe")
        report.update(installer_sha256=base.NVDA_SHA256,nvda_version=base.NVDA_VERSION)
        portable=run/"portable"
        command=[str(installer),"--create-portable-silent","--portable-path="+str(portable),
            "--config-path="+str(config),"--no-sr-flag","--minimal","--log-file="+str(run/"portable-creation.log")]
        with (run/"portable-creation-console.log").open("wb") as console:
            process=subprocess.Popen(command,cwd=run,stdout=console,stderr=subprocess.STDOUT)
            base.wait_process(process,min(args.timeout,180))
        process=None
        executable=portable/"nvda.exe"
        if not executable.is_file():
            raise RuntimeError("Pinned portable NVDA was not created")
        (config/"nvda.ini").write_text(configuration,encoding="utf-8")
        addon=config/"addons/dordiaiPersonalSettingsProbe"
        plugins=addon/"globalPlugins"
        plugins.mkdir(parents=True)
        (addon/"manifest.ini").write_text('name = "dordiaiPersonalSettingsProbe"\nsummary = "Owned configuration-only personal settings probe"\nversion = "1.0.0"\nauthor = "dordiai-voices"\nminimumNVDAVersion = "2026.1"\nlastTestedNVDAVersion = "2026.3.1"\n',encoding="utf-8")
        settings.update(run_id=run_id,report_path=str(run/"host-probe.json"),config_path=str(config))
        source=HOST_PLUGIN.replace("__PERSONAL_SETTINGS__",repr(settings))
        compile(source,"owned-frozen-nvda-personal-settings-probe","exec")
        (plugins/"dordiaiPersonalSettingsProbe.py").write_text(source,encoding="utf-8")
        report["external_candidate"]={key:value for key,value in settings.items() if key!="cases"}
        command=[str(executable),"--config-path="+str(config),"--log-file="+str(run/"nvda.log"),
                 "--debug-logging","--no-sr-flag","--minimal","--lang=en"]
        with (run/"nvda-console.log").open("wb") as console:
            process=subprocess.Popen(command,cwd=portable,stdout=console,stderr=subprocess.STDOUT)
            base.wait_process(process,args.timeout)
        process=None
        candidate=json.loads((run/"host-probe.json").read_text(encoding="utf-8"))
        if candidate.get("run_id")!=run_id:
            raise ValueError("Owned host receipt identity differs")
        report["probe"]=candidate
        report["status"]=candidate["status"]
        report["nvda_host_verified"]=candidate["status"]=="passed-actual-settings-api"
        outcome=0 if report["nvda_host_verified"] else 1
    except Exception as error:
        report.update(status="failed",error_type=type(error).__name__,reason=str(error))
        outcome=1
    finally:
        try:
            stop_owned(process)
        except Exception as cleanup_error:
            report["cleanup_error_type"]=type(cleanup_error).__name__
            report["status"]="failed-cleanup"
            report["nvda_host_verified"]=False
        if run is not None:
            for name in ("host-probe.json","nvda.log","nvda-console.log","portable-creation.log","portable-creation-console.log"):
                source=run/name
                if source.is_file():
                    raw=source.read_bytes()
                    (output/name).write_bytes(raw[-2*1024*1024:])
        (output/"controller.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        print("PERSONAL_FROZEN_NVDA_SETTINGS "+json.dumps(report,ensure_ascii=True),flush=True)
    return 1 if report.get("cleanup_error_type") else outcome


if __name__=="__main__":
    raise SystemExit(main())
