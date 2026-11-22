"""Separate owned-NVDA keyboard settings supplement; historical probes stay intact.

Uses real SendInput for hotkeys, notebook/tab navigation, checkbox/choice edits,
OK/Escape and NVDA configuration save. Restarts the same isolated portable
profile, then restores the original settings through the keyboard. No package
file chooser, named-profile switching, pronunciation or physical-audio claim.
Saved-synth automatic startup is observed before probe reselection; an unresolved
headless startup remains separately UNVERIFIED, even if parameter reload works.
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from hashlib import sha1, sha256
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import zipfile
from types import SimpleNamespace

BASE_BLOB = 'ec3d93b5b6e3f92af70d0b989ca9e280db5a840f'
PIN_VALIDATOR_BLOB = '1d785fb951625b424e4d620426640b5bfab3a73e'
DEVICE_BLOB = '6539e4f770d93300fa96c272c9e281f767026e3f'
LOOPBACK_GUARD_BLOB = 'd1d11c230e0feb3e1725383aa433b6d7a1528693'
MARKER_CPP_SHA256 = 'eba7fd78469298b7c4c300fdd80c9da18ffb1d03323c8b72230d92ff59448012'
EXCLUDED = {'kostia','inna','dina','vira','innesa','veronika_classmate','anatolii','veronika'}
DEFAULT_CHECK = '    check("fresh_default_languages", "passed" if set(enabled) == {"uk", "en", "ru"} else "failed", enabled=enabled)\n'

PLUGIN_CODE = r'''
import ctypes as _ks_ct
import os as _ks_os
import hashlib as _ks_hashlib
import weakref as _ks_weakref

_KS = None
_KS_STARTUP_REF = None
_KS_BASE_FINISH = finish

class _KSMouse(_ks_ct.Structure):
    _fields_ = [("dx",_ks_ct.c_int32),("dy",_ks_ct.c_int32),("mouseData",_ks_ct.c_uint32),
                ("dwFlags",_ks_ct.c_uint32),("time",_ks_ct.c_uint32),("dwExtraInfo",_ks_ct.c_size_t)]
class _KSKeyboard(_ks_ct.Structure):
    _fields_ = [("wVk",_ks_ct.c_uint16),("wScan",_ks_ct.c_uint16),("dwFlags",_ks_ct.c_uint32),
                ("time",_ks_ct.c_uint32),("dwExtraInfo",_ks_ct.c_size_t)]
class _KSHardware(_ks_ct.Structure):
    _fields_ = [("uMsg",_ks_ct.c_uint32),("wParamL",_ks_ct.c_uint16),("wParamH",_ks_ct.c_uint16)]
class _KSUnion(_ks_ct.Union):
    _fields_ = [("mi",_KSMouse),("ki",_KSKeyboard),("hi",_KSHardware)]
class _KSInput(_ks_ct.Structure):
    _anonymous_ = ("data",)
    _fields_ = [("type",_ks_ct.c_uint32),("data",_KSUnion)]

def _ks_expected_languages():
    return {"uk","en","ru"} if SETTINGS["keyboard_settings_phase"]=="edit" else {"en"}

def _ks_snapshot(synth=None):
    synth=DRIVER if synth is None else synth
    return {"languages":sorted(synth._dordiai_enabled_languages),"default_language":synth._dordiai_selection[2],
            "mode":synth._dordiai_mode,"voice":synth.voice,"voice_map":dict(synth._dordiai_voice_map),
            "voices":list(synth.availableVoices)}

def _ks_capture_startup():
    # OfficialNVDA speech.initialize precedes globalPluginHandler.initialize.
    # Observe the real saved-synth startup before historical begin() reselects
    # anything and before its late headless WavePlayer factory is installed.
    global _KS_STARTUP_REF
    import config
    endpoint=SETTINGS.get("keyboard_virtual_endpoint")
    if endpoint:
        _ks_require(not SETTINGS.get("headless_ui_probe"),"Owned virtual render cannot use a recording sink")
        if SETTINGS["keyboard_settings_phase"]=="edit":
            # Only the disposable NVDA profile's route is configured. Never
            # change Windows default devices, formats, privacy or system policy.
            config.conf["audio"]["outputDevice"]=endpoint["id"]
        _ks_require(config.conf["audio"]["outputDevice"]==endpoint["id"],"Saved exact owned output endpoint differs")
    active=synthDriverHandler.getSynth()
    _KS_STARTUP_REF=_ks_weakref.ref(active) if active is not None else lambda:None
    RESULT["keyboard_startup_synth"]={"observed_before_probe_begin":True,
        "configured_synth":config.conf["speech"]["synth"],"actual_synth":getattr(active,"name",None),
        "actual_module":type(active).__module__ if active is not None else None,
        "player_class":type(getattr(active,"_player",None)).__name__,
        "output_device":config.conf["audio"]["outputDevice"],
        "real_wave_player":_ks_real_player(active),
        "settings":_ks_snapshot(active) if getattr(active,"name",None)=="kx47Preview" else None,
        "saved_synth_automatic_startup_verified":False,"status":"observed-before-reselection"}
    save()

def _ks_check_startup():
    if SETTINGS["keyboard_settings_phase"]!="resume":return
    import config
    row=RESULT["keyboard_startup_synth"]
    _ks_require(row["configured_synth"]=="kx47Preview","Saved synth selection did not persist before actual restart")
    expected=dict(SETTINGS["keyboard_original_settings"])
    expected.update(languages=["en"],default_language="en",voice_map={"en":"viktoriia"})
    live=synthDriverHandler.getSynth()
    row.update(at_begin_synth=getattr(live,"name",None),same_startup_instance_at_begin=live is _KS_STARTUP_REF(),
               at_begin_real_wave_player=_ks_real_player(live),
               at_begin_output_device=config.conf["audio"]["outputDevice"],
               at_begin_settings=_ks_snapshot(live) if getattr(live,"name",None)=="kx47Preview" else None)
    if row["actual_synth"]=="kx47Preview" and row["at_begin_synth"]=="kx47Preview" and row["same_startup_instance_at_begin"]:
        _ks_require(row["settings"]==expected,"Automatic saved-synth startup loaded incorrect settings")
        _ks_require(row["at_begin_settings"]==expected,"Saved-synth settings changed before probe selection")
        if SETTINGS.get("keyboard_virtual_endpoint"):
            _ks_require(row["real_wave_player"] and row["at_begin_real_wave_player"],"Automatic startup did not initialize genuine WavePlayer")
            _ks_require(row["at_begin_output_device"]==SETTINGS["keyboard_virtual_endpoint"]["id"],"Exact owned output route changed before startup observation")
        row.update(status="passed-functional-only",saved_synth_automatic_startup_verified=True)
        check("saved_synth_automatic_startup","passed",observation=row)
    elif SETTINGS.get("headless_ui_probe"):
        row.update(status="blocked-saved-synth-startup-unverified-headless",manual_reselection_after_startup_observation=True,
                   startup_failure_cause_not_inferred=True)
        check("saved_synth_automatic_startup","blocked",reason="Headless run: saved synth startup was not preserved before the late recording factory. Cause is not inferred; only parameter reload after explicit selection is tested. Inspect the unchanged NVDA startup log.",observation=row)
    else:raise ValueError("Genuine saved synthesizer failed to start before probe reselection")

def _ks_real_player(synth):
    import nvwave
    player=getattr(synth,"_player",None)
    return bool(player is not None and type(player) is nvwave.WavePlayer and
                type(player).__module__=="nvwave" and getattr(player,"_player",None))

def _ks_focus():
    import api
    focus=api.getFocusObject()
    control=wx.Window.FindFocus()
    return {"wx_class":type(control).__name__ if control else None,
            "name":str(getattr(focus,"name","") or "")[:300],
            "role":str(getattr(focus,"role","")),
            "states":sorted(str(v) for v in getattr(focus,"states",set()))}

def _ks_record(name, **fields):
    _KS["result"]["events"].append(dict(name=name,time_ns=time.perf_counter_ns(),**fields))
    save()

def _ks_require(value,message):
    if not value:raise ValueError(message)

def _ks_raw(vkCode,scanCode,extended,pressed,injected):
    if _KS and not _KS.get("cleaned"):
        rows=_KS["result"]["raw_keys"]
        _ks_require(len(rows)<8192,"Settings raw-key log exceeded bound")
        rows.append(dict(vk=int(vkCode),scan=int(scanCode),extended=bool(extended),pressed=bool(pressed),injected=bool(injected)))
    return True

def _ks_speech(speechSequence,priority):
    if _KS and not _KS.get("cleaned"):
        rows=_KS["result"]["speech_requests"]
        if len(rows)<2048:
            rows.append({"text":[x[:300] for x in speechSequence if isinstance(x,str)],
                         "commands":[type(x).__name__ for x in speechSequence if not isinstance(x,str)]})

def _ks_gesture(gesture):
    if _KS and not _KS.get("cleaned"):
        rows=_KS["result"]["gesture_scripts"]
        if len(rows)<2048:
            script=gesture.script
            rows.append({"identifiers":list(gesture.identifiers),"script_name":getattr(script,"__name__",None),
                         "script_module":getattr(script,"__module__",None)})
    return True

def _ks_saved():
    if _KS and not _KS.get("cleaned"):_KS["result"]["public_post_configSave_count"]+=1

def _ks_owned():
    user=_KS["user"];pid=_ks_ct.c_uint32()
    hwnd=user.GetForegroundWindow()
    user.GetWindowThreadProcessId(hwnd,_ks_ct.byref(pid))
    return bool(hwnd and pid.value==_ks_os.getpid() and synthDriverHandler.getSynth() is DRIVER)

def _ks_wait(predicate,callback,reason,deadline=None):
    deadline=deadline or time.monotonic()+8
    if predicate():later(100,callback)
    elif time.monotonic()<deadline:later(100,lambda:_ks_wait(predicate,callback,reason,deadline))
    else:raise TimeoutError(reason)

def _ks_send(chords,label,callback):
    _ks_require(_ks_owned(),"Foreground ownership changed before keyboard input")
    values=[]
    for chord in chords:
        for vk,extended in chord:
            row=_KSInput();row.type=1;row.ki=_KSKeyboard(vk,0,1 if extended else 0,0,0x44565345);values.append(row)
        for vk,extended in reversed(chord):
            row=_KSInput();row.type=1;row.ki=_KSKeyboard(vk,0,(1 if extended else 0)|2,0,0x44565345);values.append(row)
    _ks_require(0<len(values)<=1024,"Keyboard action exceeds bounded event budget")
    buffer=(_KSInput*len(values))(*values)
    sent=int(_KS["user"].SendInput(len(values),buffer,_ks_ct.sizeof(_KSInput)))
    _ks_record("send_input",label=label,events_expected=len(values),events_sent=sent,
               chords=[[[a,bool(b)] for a,b in c] for c in chords])
    if sent!=len(values):
        # Always release every possible modifier after a partial insertion.
        release=[]
        for vk,ext in {(v,e) for c in chords for v,e in c}:
            row=_KSInput();row.type=1;row.ki=_KSKeyboard(vk,0,(1 if ext else 0)|2,0,0x44565345);release.append(row)
        _KS["user"].SendInput(len(release),(_KSInput*len(release))(*release),_ks_ct.sizeof(_KSInput))
        raise OSError("SendInput did not insert all balanced events")
    later(350,callback)

def _ks_key(vk,callback,label=None,modifiers=()):
    _ks_send([list(modifiers)+[(vk,vk in (0x23,0x24,0x25,0x26,0x27,0x28))]],label or str(vk),callback)

def _ks_hotkey(callback):
    before=len(_KS["result"]["gesture_scripts"])
    def opened():
        _ks_require(any(x["script_name"]=="script_preferences" and str(x["script_module"]).endswith("dordiaiMainPreferences")
                        for x in _KS["result"]["gesture_scripts"][before:]),"Real NVDA gesture did not resolve the preferences script")
        callback(find_dialog())
    _ks_send([[_KS["nvda_key"],(0x11,False),(0x10,False),(0x79,False)]],"NVDA+control+shift+f10",
             lambda:_ks_wait(lambda:find_dialog() is not None,opened,"Actual hotkey did not open settings"))

def _ks_tab_to(target,callback,count=0):
    if wx.Window.FindFocus() is target:return later(100,callback)
    _ks_require(count<64,"Target is not reachable by bounded keyboard Tab traversal")
    _ks_key(9,lambda:_ks_tab_to(target,callback,count+1),"Tab")

def _ks_page(dialog,target,callback):
    desired=next(i for i in range(dialog.tabs.GetPageCount()) if dialog.tabs.GetPage(i) is target.GetParent())
    delta=(desired-dialog.tabs.GetSelection())%dialog.tabs.GetPageCount()
    if not delta:return _ks_tab_to(target,callback)
    _ks_send([[(0x11,False),(9,False)]]*delta,"Ctrl+Tab to page",
             lambda:_ks_wait(lambda:dialog.tabs.GetSelection()==desired,
                 lambda:_ks_tab_to(target,callback),"Notebook keyboard page did not change"))

def _ks_list(dialog,kind,code,desired,callback):
    control=getattr(dialog,kind+"_list");codes=getattr(dialog,kind+"_codes")
    _ks_require(code in codes,"Requested actual checkbox code absent")
    index=codes.index(code)
    def selected():
        _ks_require(control.GetSelection()==index,"Native checklist selection differs")
        before=control.IsChecked(index)
        if before==desired:return later(100,callback)
        count=len(_KS["result"]["speech_requests"])
        def changed():
            _ks_require(control.IsChecked(index)==desired,"Actual Space did not toggle checkbox")
            _ks_record("checkbox",kind=kind,code=code,before=before,after=bool(control.IsChecked(index)),
                       speech_requests_since_key=len(_KS["result"]["speech_requests"])-count,focus=_ks_focus())
            callback()
        _ks_key(0x20,changed,"Space "+kind+" "+code)
    def focus_ready():
        _ks_send([[(0x24,True)]]+[[(0x28,True)]]*index,"Home/Down select "+kind+" "+code,selected)
    _ks_page(dialog,control,focus_ready)

def _ks_choice(dialog,control,index,callback,label):
    _ks_require(0<=index<control.GetCount(),"Requested choice index absent")
    def focus_ready():
        sequence=[[(0x12,False),(0x28,True)],[(0x24,True)]]+[[(0x28,True)]]*index+[[(0x0d,False)]]
        def chosen():
            _ks_require(control.GetSelection()==index,"Keyboard choice did not commit expected selection")
            _ks_record("choice",label=label,index=index,text=control.GetStringSelection(),focus=_ks_focus())
            callback()
        _ks_send(sequence,"Alt+Down/Home/Down/Enter "+label,chosen)
    _ks_page(dialog,control,focus_ready)

def _ks_close_ok(dialog,callback):
    button=wx.Window.FindWindowById(wx.ID_OK,dialog)
    _ks_require(button is not None,"Actual OK button absent")
    _ks_tab_to(button,lambda:_ks_key(0x20,
        lambda:_ks_wait(lambda:find_dialog() is None,callback,"Keyboard OK did not close settings"),"Space on actual OK"))

def _ks_dialog_snapshot(dialog):
    return {"languages":sorted(dialog.language_codes[i] for i in dialog.language_list.GetCheckedItems()),
            "voices":sorted(dialog.voice_codes[i] for i in dialog.voice_list.GetCheckedItems()),
            "default_language":dialog.enabled_language_codes[dialog.fallback.GetSelection()],
            "voice_map":dict(dialog.voice_map),"pages":[dialog.tabs.GetPageText(i) for i in range(dialog.tabs.GetPageCount())]}

def _ks_assert_current(expected):
    actual=_ks_snapshot()
    _ks_require(actual==expected,"Actual runtime settings differ from keyboard-saved state")
    return actual

def _ks_expected_edited():
    value=dict(_KS["result"]["original_settings"])
    value.update(languages=["en"],default_language="en",voice_map={"en":"viktoriia"})
    return value

def _ks_edit_mapping(dialog,restore=False):
    def chosen_language():
        code=(_KS["result"]["original_settings"]["voice_map"].get("en") if restore else "viktoriia")
        _ks_require(code in dialog.mapping_voice_codes,"Expected compatible voice is not offered")
        _ks_choice(dialog,dialog.mapping_voice,dialog.mapping_voice_codes.index(code),
            lambda:_ks_save_dialog(dialog,restore),"English compatible voice")
    _ks_choice(dialog,dialog.mapping_language,dialog.enabled_language_codes.index("en"),chosen_language,"Mapping language English")

def _ks_save_dialog(dialog,restore):
    expected=_KS["result"]["original_settings"] if restore else _ks_expected_edited()
    def saved():
        _ks_record("keyboard_ok_applied",restore=restore,settings=_ks_assert_current(expected))
        _ks_hotkey(lambda reopened:_ks_reopened(reopened,expected,restore))
    _ks_close_ok(dialog,saved)

def _ks_reopened(dialog,expected,restore):
    snapshot=_ks_dialog_snapshot(dialog)
    _ks_require(snapshot["languages"]==expected["languages"],"Reopened checkbox selection was not retained")
    _ks_require(snapshot["default_language"]==expected["default_language"],"Reopened primary language differs")
    _ks_require(snapshot["voice_map"]==expected["voice_map"],"Reopened language/voice mapping differs")
    _ks_record("keyboard_reopen_verified",restore=restore,dialog=snapshot)
    _ks_key(0x1b,lambda:_ks_wait(lambda:find_dialog() is None,
        lambda:_ks_configuration_save(expected),"Keyboard Escape did not close reopened dialog"),"Escape")

def _ks_configuration_save(expected):
    before=_KS["result"]["public_post_configSave_count"]
    before_scripts=len(_KS["result"]["gesture_scripts"])
    def saved():
        import config
        from configobj import ConfigObj
        path=Path(config.conf.profiles[0].filename).resolve(strict=True)
        allowed=Path(_KS["config_root"]).resolve(strict=True)
        _ks_require(path.is_relative_to(allowed) and path.name=="nvda.ini","Saved configuration escaped owned profile")
        disk=ConfigObj(str(path),encoding="UTF-8",file_error=True)
        _ks_require(disk["speech"]["synth"]=="kx47Preview","Selected synth not persisted to actual nvda.ini")
        section=disk["speech"][DRIVER.name]
        _ks_require(set(str(section["dordiaiEnabledLanguages"]).split())==set(expected["languages"]),"Enabled languages not persisted to actual nvda.ini")
        _ks_require(section["dordiaiDefaultLanguage"]==expected["default_language"],"Primary language not persisted")
        _ks_require(json.loads(section["dordiaiLanguageVoices"])==expected["voice_map"],"Voice mapping not persisted")
        endpoint=SETTINGS.get("keyboard_virtual_endpoint")
        if endpoint:
            _ks_require(disk["audio"]["outputDevice"]==endpoint["id"],"Owned exact render selection was not persisted")
            _ks_require(_ks_real_player(DRIVER),"The actual settings driver is not using genuine WavePlayer")
        _KS["result"].update(status="passed-functional-only",saved_settings=_ks_assert_current(expected),
            profile_disk_sha256=_ks_hashlib.sha256(path.read_bytes()).hexdigest(),
            configuration_saved_by_real_NVDA_keyboard_command=True)
        check("actual_keyboard_settings", "passed",phase=SETTINGS["keyboard_settings_phase"],
            scope="Actual injected native keys, genuine wx/NVDA save and owned-profile disk receipt; no physical keyboard or acoustic claim")
        finish()
    _ks_send([[_KS["nvda_key"],(0x11,False),(0x43,False)]],"NVDA+control+c",
        lambda:_ks_wait(lambda:_KS["result"]["public_post_configSave_count"]>before and any(
            x["script_name"]=="script_saveConfiguration" and x["script_module"]=="globalCommands"
            for x in _KS["result"]["gesture_scripts"][before_scripts:]),saved,"Actual NVDA configuration-save command not observed"))

def _ks_restore(dialog):
    _ks_record("NVDA_tools_menu_opened_settings",dialog=_ks_dialog_snapshot(dialog))
    _ks_require(_ks_dialog_snapshot(dialog)["languages"]==["en"],"Restart did not populate saved language checkbox")
    def enabled():
        original=_KS["result"]["original_settings"]["default_language"]
        _ks_choice(dialog,dialog.fallback,dialog.enabled_language_codes.index(original),
            lambda:_ks_edit_mapping(dialog,restore=True),"Restore primary language")
    _ks_list(dialog,"language","uk",True,lambda:_ks_list(dialog,"language","ru",True,enabled))

def _ks_menu():
    import gui
    tray=gui.mainFrame.sysTrayIcon
    root_items=[x for x in tray.menu.GetMenuItems() if not x.IsSeparator() and x.IsEnabled()]
    tools_index=next(i for i,x in enumerate(root_items) if x.GetSubMenu() is tray.toolsMenu)
    items=[x for x in tray.toolsMenu.GetMenuItems() if not x.IsSeparator() and x.IsEnabled()]
    targets=[i for i,x in enumerate(items) if "dordiai-voices" in x.GetItemLabelText()]
    _ks_require(len(targets)==1,"Expected exact dordiai Tools menu item absent/ambiguous")
    def root_open():
        _ks_send([[(0x24,True)]]+[[(0x28,True)]]*tools_index+[[(0x27,True)]],"Navigate NVDA Tools submenu",tools_open)
    def tools_open():
        _ks_send([[(0x24,True)]]+[[(0x28,True)]]*targets[0]+[[(0x0d,False)]],"Activate dordiai Tools item",
            lambda:_ks_wait(lambda:find_dialog() is not None,lambda:_ks_restore(find_dialog()),"Real NVDA menu did not open settings"))
    _ks_send([[_KS["nvda_key"],(0x4e,False)]],"NVDA+n",root_open)

def _ks_edit(dialog):
    _ks_record("actual_hotkey_opened_settings",dialog=_ks_dialog_snapshot(dialog))
    _ks_require(set(dialog.language_codes[i] for i in dialog.language_list.GetCheckedItems())=={"uk","en","ru"},"Fresh core language checkboxes differ")
    other=next(c for c in dialog.voice_codes if c!=DRIVER.voice)
    def restored_voice():
        _ks_require(len(dialog.voice_list.GetCheckedItems())==45,"Voice checkbox toggle was not restored")
        _ks_list(dialog,"language","ru",False,lambda:_ks_list(dialog,"language","uk",False,lambda:_ks_edit_mapping(dialog)))
    _ks_list(dialog,"voice",other,False,lambda:_ks_list(dialog,"voice",other,True,restored_voice))

def open_settings():
    global _KS,STAGE
    import config,globalVars,inputCore,keyboardHandler,speech
    STAGE="keyboard_settings"
    _ks_require(_KS is None,"Settings probe started twice")
    _ks_require(not keyboardHandler.ignoreInjected and config.conf["keyboard"]["handleInjectedKeys"],"Actual injected-key handling is disabled")
    keys=keyboardHandler.getNVDAModifierKeys()
    _ks_require(keys and keys[0][0]==0x2d,"Probe requires configured Insert NVDA modifier; configuration is not changed")
    user=_ks_ct.WinDLL("user32",use_last_error=True)
    for name,args,result in [
        ("SendInput",[_ks_ct.c_uint32,_ks_ct.POINTER(_KSInput),_ks_ct.c_int],_ks_ct.c_uint32),
        ("GetForegroundWindow",[],_ks_ct.c_void_p),
        ("GetKeyState",[_ks_ct.c_int],_ks_ct.c_short),
        ("GetWindowThreadProcessId",[_ks_ct.c_void_p,_ks_ct.POINTER(_ks_ct.c_uint32)],_ks_ct.c_uint32),
        ("SetForegroundWindow",[_ks_ct.c_void_p],_ks_ct.c_bool)]:
        f=getattr(user,name);f.argtypes=args;f.restype=result
    _ks_require(not any(user.GetKeyState(vk)&0x8000 for vk in (0x10,0x11,0x12,0x2d,0x5b,0x5c)),
                "A physical modifier is already held; refusing keyboard probe")
    result=RESULT["keyboard_settings"]={"phase":SETTINGS["keyboard_settings_phase"],"status":"running",
        "events":[],"raw_keys":[],"speech_requests":[],"gesture_scripts":[],"public_post_configSave_count":0,
        "original_settings":SETTINGS.get("keyboard_original_settings") or _ks_snapshot(),
        "owned_virtual_endpoint_id":(SETTINGS.get("keyboard_virtual_endpoint") or {}).get("id"),
        "real_wave_player_initialized":_ks_real_player(DRIVER),
        "physical_keyboard_verified":False,"full_accessibility_verified":False,"named_profile_switching_verified":False,
        "file_chooser_keyboard_verified":False,"pronunciation_verified":False,"physical_audio_verified":False}
    _KS={"result":result,"user":user,"nvda_key":(int(keys[0][0]),bool(keys[0][1])),
         "saved_speech_mode":speech.getState().speechMode,"config_root":globalVars.appArgs.configPath}
    inputCore.decide_handleRawKey.register(_ks_raw)
    inputCore.decide_executeGesture.register(_ks_gesture)
    speech.pre_speechQueued.register(_ks_speech)
    config.post_configSave.register(_ks_saved)
    speech.setSpeechMode(speech.SpeechMode.talk)
    speech.cancelSpeech()
    result["public_TALK_then_cancel_before_keyboard"]=True
    frame=_KS["frame"]=wx.Frame(None,title="Owned keyboard settings fixture",size=(460,200))
    wx.TextCtrl(frame,value="Owned settings keyboard test")
    frame.Show();frame.Raise();user.SetForegroundWindow(frame.GetHandle())
    if SETTINGS["keyboard_settings_phase"]=="edit":
        _ks_require(result["original_settings"]["voice_map"]=={},"Fresh isolated voice mapping must be empty")
        later(600,lambda:_ks_hotkey(_ks_edit))
    else:
        _ks_record("actual_process_restart_loaded_settings",settings=_ks_assert_current(_ks_expected_edited()))
        later(600,_ks_menu)

def _ks_cleanup():
    if not _KS or _KS.get("cleaned"):return
    import config,inputCore,speech
    _KS["cleaned"]=True
    errors=[]
    def restore(fn):
        try:fn()
        except Exception as error:errors.append(type(error).__name__)
    restore(lambda:inputCore.decide_handleRawKey.unregister(_ks_raw))
    restore(lambda:inputCore.decide_executeGesture.unregister(_ks_gesture))
    restore(lambda:speech.pre_speechQueued.unregister(_ks_speech))
    restore(lambda:config.post_configSave.unregister(_ks_saved))
    restore(lambda:speech.setSpeechMode(_KS["saved_speech_mode"]))
    restore(lambda:_KS["frame"].Destroy())
    _KS["result"]["cleanup"]={"errors":errors,"observers_unregistered":not errors,"normal_user_profile_untouched":True}
    check("keyboard_settings_cleanup","passed" if not errors else "failed",errors=errors)

def finish():
    _ks_cleanup()
    return _KS_BASE_FINISH()
'''


def _load_pinned(path, expected, name):
    raw=Path(path).read_bytes()
    if sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()!=expected:
        raise ValueError('Historical source changed: '+str(path))
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def compose_plugin(base, phase, original=None, endpoint=None):
    if phase not in {'edit','resume'}:raise ValueError('Unknown settings phase')
    if base.PROBE_PLUGIN.count(DEFAULT_CHECK)!=1:raise ValueError('Historical initial-language anchor differs')
    if base.PROBE_PLUGIN.count('def begin():\n')!=1:raise ValueError('Historical startup anchor differs')
    extra={'keyboard_settings_phase':phase,'keyboard_original_settings':original,'keyboard_virtual_endpoint':endpoint}
    source=base.PROBE_PLUGIN.replace(DEFAULT_CHECK,
        '    check("settings_phase_initial_languages", "passed" if set(enabled) == _ks_expected_languages() else "failed", enabled=enabled)\n',1)
    source=source.replace('SETTINGS = __PROBE_SETTINGS__\n','SETTINGS = __PROBE_SETTINGS__\nSETTINGS.update('+repr(extra)+')\n',1)
    source=source.replace('def begin():\n','def begin():\n    _ks_check_startup()\n',1)
    source+='\n'+PLUGIN_CODE+'\n_ks_capture_startup()\n'
    compile(source.replace('__PROBE_SETTINGS__',repr({})).replace('__NATIVE_IMPORT_DIAGNOSTIC__',repr('')),'keyboard-settings-only','exec')
    return source


def validate_phase(controller,phase,pin):
    if phase not in {'edit','resume'}:raise ValueError('Unknown settings receipt phase')
    if controller.get('addon_sha256')!=pin['archive_sha256']:
        raise ValueError('Actual addon hash differs')
    probe=controller.get('probe',{});row=probe.get('keyboard_settings',{})
    if row.get('phase')!=phase or row.get('status')!='passed-functional-only':raise ValueError('Actual settings phase failed')
    if probe.get('nvda_version_actual')!='2026.3.1':raise ValueError('Official NVDA version differs')
    if probe.get('product_ready') is not False or probe.get('physical_audio_verified') is not False:
        raise ValueError('Settings proof cannot imply product or physical acceptance')
    if row.get('cleanup')!={'errors':[],'observers_unregistered':True,'normal_user_profile_untouched':True}:
        raise ValueError('Actual settings observer cleanup failed')
    if row.get('configuration_saved_by_real_NVDA_keyboard_command') is not True or row.get('public_post_configSave_count',0)<1:
        raise ValueError('Genuine public NVDA configuration save missing')
    for flag in ('physical_keyboard_verified','full_accessibility_verified','named_profile_switching_verified',
                 'file_chooser_keyboard_verified','pronunciation_verified','physical_audio_verified'):
        if row.get(flag) is not False:raise ValueError('Unsupported settings acceptance claim: '+flag)
    if not row.get('raw_keys') or not row.get('speech_requests'):raise ValueError('Actual raw keys or NVDA speech feedback missing')
    scripts={x.get('script_name') for x in row.get('gesture_scripts',[])}
    if not {'script_preferences','script_saveConfiguration'}<=scripts:raise ValueError('Genuine NVDA keyboard script observations missing')
    if phase=='resume' and 'script_showGui' not in scripts:raise ValueError('Genuine NVDA menu gesture observation missing')
    if row.get('public_TALK_then_cancel_before_keyboard') is not True:raise ValueError('Public speech-mode/cancel boundary missing')
    sent=[r for r in row.get('events',[]) if r.get('name')=='send_input']
    if not sent or any(r.get('events_expected',0)<=0 or r.get('events_sent')!=r['events_expected'] for r in sent):
        raise ValueError('Balanced native keyboard input failed')
    names={r['name'] for r in row.get('events',[])}
    required={'keyboard_ok_applied','keyboard_reopen_verified'} | ({'actual_hotkey_opened_settings','checkbox','choice'} if phase=='edit' else {'actual_process_restart_loaded_settings','NVDA_tools_menu_opened_settings'})
    if not required<=names:raise ValueError('Required real UI path missing')
    labels={r.get('label') for r in sent}
    if not {'NVDA+control+shift+f10','NVDA+control+c'}<=labels:
        raise ValueError('Actual settings/save keyboard chords missing')
    if phase=='resume' and not {'NVDA+n','Activate dordiai Tools item'}<=labels:
        raise ValueError('Actual NVDA menu keyboard path missing')
    checks=list(controller.get('checks',[]))+list(probe.get('checks',[]))
    startup=probe.get('keyboard_startup_synth',{})
    if phase=='resume':
        if startup.get('observed_before_probe_begin') is not True or startup.get('configured_synth')!='kx47Preview':raise ValueError('Preselection startup observation missing')
        auto=startup.get('saved_synth_automatic_startup_verified') is True
        if auto and (startup.get('actual_synth')!='kx47Preview' or startup.get('status')!='passed-functional-only'
            or startup.get('at_begin_synth')!='kx47Preview' or startup.get('same_startup_instance_at_begin') is not True
            or startup.get('settings')!=dict(row['original_settings'],languages=['en'],default_language='en',voice_map={'en':'viktoriia'})
            or startup.get('at_begin_settings')!=startup.get('settings')):
            raise ValueError('Automatic startup claim contradicts observed original startup state')
        scoped_block=(probe.get('recording_pcm_sink_test_double') is True and startup.get('status')=='blocked-saved-synth-startup-unverified-headless'
            and (startup.get('actual_synth')!='kx47Preview' or startup.get('at_begin_synth')!='kx47Preview' or startup.get('same_startup_instance_at_begin') is False)
            and startup.get('startup_failure_cause_not_inferred') is True
            and startup.get('manual_reselection_after_startup_observation') is True and not auto)
        if not auto and not scoped_block:raise ValueError('Saved synth startup is neither proved nor explicitly blocked')
    else:scoped_block=False
    endpoint=row.get('owned_virtual_endpoint_id')
    if endpoint:
        if probe.get('recording_pcm_sink_test_double') is not False or row.get('real_wave_player_initialized') is not True:
            raise ValueError('Owned virtual mode requires real initialized WavePlayer without recording double')
        if phase=='resume' and (not auto or startup.get('output_device')!=endpoint or startup.get('real_wave_player') is not True
            or startup.get('at_begin_real_wave_player') is not True or startup.get('at_begin_output_device')!=endpoint):
            raise ValueError('Owned virtual automatic startup requires genuine WavePlayer on the saved exact endpoint')
    if not checks or any(r.get('status')!='passed' and not (r.get('status')=='blocked' and (
        r.get('name') in {'windows_audio_output_enumeration','physical_audio_output'} or
        scoped_block and r.get('name')=='saved_synth_automatic_startup')) for r in checks):
        raise ValueError('Unexpected failed/blocked actual integration check')
    settings=row['saved_settings']
    if len(settings['voices'])!=45 or EXCLUDED.intersection(settings['voices']):raise ValueError('Retained voice identity differs')
    original=row['original_settings']
    if original.get('languages')!=['en','ru','uk'] or original.get('default_language')!='uk' or original.get('mode')!='auto' or original.get('voice_map')!={}:
        raise ValueError('Original fresh isolated profile differs')
    expected=original if phase=='resume' else dict(original,languages=['en'],default_language='en',voice_map={'en':'viktoriia'})
    if settings!=expected:raise ValueError('Saved runtime state differs from exact requested UI choices')
    if phase=='edit':
        toggles=[r for r in row['events'] if r.get('name')=='checkbox']
        languages={r.get('code') for r in toggles if r.get('kind')=='language' and r.get('before') is True and r.get('after') is False}
        if languages!={'uk','ru'}:raise ValueError('Both initial languages must be disabled by real Space keys')
        voice_off={r.get('code') for r in toggles if r.get('kind')=='voice' and r.get('before') is True and r.get('after') is False}
        voice_on={r.get('code') for r in toggles if r.get('kind')=='voice' and r.get('before') is False and r.get('after') is True}
        if len(voice_off)!=1 or voice_off!=voice_on:raise ValueError('Real voice checkbox was not toggled and restored')
    return row


def _within(path,root):
    value=Path(path).resolve(strict=True)
    if not value.is_relative_to(root.resolve(strict=True)):raise ValueError('Restart path escaped owned test directory')
    return value


def verify_installed_runtime(addon,installed):
    """Read-only proof that disabling checkboxes did not remove/change runtime files."""
    with zipfile.ZipFile(addon) as z:
        manifest=json.loads(z.read('dordiai-release.json'))
    records=manifest.get('files')
    if not isinstance(records,dict):raise ValueError('Original release file manifest missing')
    count=size=0
    for name,record in records.items():
        if not name.startswith('kx47Runtime/'):continue
        if '\\' in name or ':' in name or any(part in {'','.','..'} for part in name.split('/')):
            raise ValueError('Unsafe immutable runtime manifest path')
        path=_within(installed/name,installed)
        if path.is_symlink() or not path.is_file() or path.stat().st_size!=record['size_bytes'] or _sha_file(path)!=record['sha256']:
            raise ValueError('Installed runtime file changed or was deleted: '+name)
        count+=1;size+=record['size_bytes']
    if not count:raise ValueError('No runtime files in immutable release manifest')
    return {'verified_files':count,'verified_bytes':size,'all_match_immutable_core_manifest':True,
            'scope':'Read-only installed runtime/model/private-Python bytes; no checkbox deletion or modification'}


class OwnedProcesses:
    """Observe only this controller's exact Popen objects; never rediscover PIDs."""
    def __init__(self,module):
        self.module=module;self.children=[]
    def __getattr__(self,name):return getattr(self.module,name)
    def Popen(self,command,*args,**kwargs):
        process=self.module.Popen(command,*args,**kwargs)
        self.children.append((process,Path(command[0]).name.lower()))
        return process
    def reap(self,base,report):
        errors=[]
        for process,_ in self.children:
            try:
                base.stop_owned(process)
                process.wait(timeout=20)
                if process.poll() is None:raise RuntimeError('Exact owned child was not reaped')
            except Exception as error:errors.append(type(error).__name__+': '+str(error))
        rows=[{'pid':p.pid,'executable':name,'returncode':p.poll(),'reaped':p.poll() is not None}
              for p,name in self.children]
        report['owned_process_cleanup']={'children':rows,'errors':errors,
            'all_reaped_before_device_cleanup':bool(rows) and not errors and all(x['reaped'] for x in rows),
            'actual_nvda_process_count':sum(x['executable']=='nvda.exe' for x in rows)}
        if errors or any(not x['reaped'] for x in rows):
            raise RuntimeError('Exact owned process cleanup failed: '+str(errors))


def validate_described_endpoint(completed,render):
    if completed.returncode!=0:raise ValueError('Reviewed native describe helper failed: '+completed.stderr[:500])
    value=json.loads(completed.stdout)
    endpoint=value.get('selected_endpoint',{})
    ident=endpoint.get('id')
    if (value.get('capture_mode')!='process-include-current-pid' or value.get('target_pid')!=completed.pid
            or not isinstance(ident,str) or not 1<=len(ident)<=1024 or any(c in ident for c in '\0\r\n')
            or not isinstance(endpoint.get('name'),str) or not endpoint['name'].startswith(render['name'])):
        raise ValueError('Native describe helper returned a different endpoint/owner')
    return value


@contextmanager
def owned_virtual_render(args,report):
    if not args.owned_virtual_render:
        yield None
        return
    if not args.ephemeral_ci or args.headless_ui_probe:
        raise ValueError('Owned virtual render requires explicit ephemeral CI and no recording sink')
    folder=Path(__file__).resolve().parent
    device=_load_pinned(folder/'windows_virtual_audio_trial.py',DEVICE_BLOB,'_settings_owned_device')
    guard=_load_pinned(folder/'process_loopback_guard.py',LOOPBACK_GUARD_BLOB,'_settings_owned_helper_guard')
    device.guard_environment(os.environ,args.package,args.output)
    cpp=folder/'windows_process_loopback.cpp'
    if cpp.is_symlink() or _sha_file(cpp)!=MARKER_CPP_SHA256:raise ValueError('Frozen native describe source changed')
    state=report['owned_virtual_render']={'requested':True,'endpoint_kind':'owned-signed-vendor-virtual-render',
        'recording_pcm_sink_test_double':False,'physical_audio_verified':False,'product_ready':False,
        'system_default_device_changed':False,'system_format_changed':False,'privacy_policy_changed':False,
        'signature_policy_changed':False,'reboot_performed':False,'vendor_installer_executed':False,
        'capture_or_microphone_api_requested':False}
    state['vendor_verification']=device.verify_package(args.package,args.validation)
    state['native_helper_build']=guard.verify_build(args.marker_helper,args.marker_build_receipt,cpp)
    state['endpoints_before']=device.endpoints()
    pnp=device.WindowsPnP()
    try:
        with pnp.owned_device(args.package/'vbMmeCable64_win10.inf',state):
            deadline=time.monotonic()+20
            while True:
                observed=device.endpoints()
                render,_=device.select_new_vendor_endpoints(state['endpoints_before'],observed)
                if render:break
                if time.monotonic()>=deadline:raise RuntimeError('Unique newly owned vendor render did not appear')
                time.sleep(.25)
            state['endpoints_during']=observed
            def verify_live():
                if pnp.matching()!=[state['owned_instance_id']] or not pnp.instance_exists(state['owned_instance_id']):
                    raise ValueError('Exact owned endpoint lease changed')
            verify_live()
            completed=guard.own_child([str(args.marker_helper),'--describe-native-format','--render-name',render['name'],
                '--owned-instance-id',state['owned_instance_id']],8)
            described=validate_described_endpoint(completed,render)
            state['native_description']=described
            state['describe_helper']={'pid':completed.pid,'returncode':completed.returncode,'reaped':True,'mode':'describe-only-no-playback-or-capture'}
            endpoint=dict(described['selected_endpoint'],owned_instance_id=state['owned_instance_id'])
            state['endpoint']=endpoint
            yield SimpleNamespace(endpoint=endpoint,verify_live=verify_live)
            verify_live()
            if report.get('owned_process_cleanup',{}).get('all_reaped_before_device_cleanup') is not True:
                raise RuntimeError('Owned NVDA processes were not reaped before device cleanup')
    finally:
        cleanup=state.get('cleanup',{})
        if cleanup.get('attempted') and (cleanup.get('removed') is not True or cleanup.get('absence_verified') is not True):
            report['owned_virtual_cleanup_failed']=True
            raise RuntimeError('Exact owned device absence was not verified')


def _run_phases(args,pin,output,base,pristine,report,lease):
    original_subprocess=base.subprocess
    observed=OwnedProcesses(subprocess)
    base.subprocess=observed
    process=None
    try:
        if lease:lease.verify_live()
        base.PROBE_PLUGIN=compose_plugin(base,'edit',endpoint=lease.endpoint if lease else None)
        command=['--addon',str(args.addon),'--output',str(output/'edit'),'--timeout',str(args.timeout),'--long-installed-config']
        if args.installer_cache:command+=['--installer-cache',str(args.installer_cache)]
        if args.headless_ui_probe:command+=['--headless-ui-probe']
        code=base.main(command)
        first=json.loads((output/'edit/windows-nvda-probe.json').read_text(encoding='utf-8'))
        report['phases']['edit']=first
        if code not in {0,2}:raise ValueError('Actual first NVDA settings process failed')
        edited=validate_phase(first,'edit',pin)
        run=_within(first['run_directory'],output/'edit')
        installed=_within(first['extracted_addon'],run)
        report['runtime_after_disable']=verify_installed_runtime(args.addon,installed)
        config=_within(first['config_directory'],run)
        executable=_within(run/'portable/nvda.exe',run)
        if base.existing_nvda_processes():raise RuntimeError('Unrelated NVDA process present before owned restart')
        resumed=output/'resume';resumed.mkdir()
        settings={'output':str(resumed),'run_id':uuid.uuid4().hex,'headless_ui_probe':args.headless_ui_probe,
                  'fatal_recovery_probe':False,'required_resource_recovery_probe':False,'typing_probe':False,
                  'typing_scenario':'standard','required_resource_quarantine':None}
        base.PROBE_PLUGIN=pristine
        plugin=compose_plugin(base,'resume',edited['original_settings'],endpoint=lease.endpoint if lease else None).replace('__PROBE_SETTINGS__',repr(settings)).replace('__NATIVE_IMPORT_DIAGNOSTIC__',repr(base.NATIVE_IMPORT_DIAGNOSTIC))
        plugin_path=_within(config/'addons/dordiaiProbe/globalPlugins/dordiaiProbe.py',run)
        plugin_path.write_text(plugin,encoding='utf-8')
        before_ini=_sha_file(config/'nvda.ini')
        if before_ini!=edited['profile_disk_sha256']:
            raise ValueError('Keyboard-saved profile bytes changed before restart')
        executable_hash=_sha_file(executable)
        if lease:lease.verify_live()
        started=time.time_ns()
        with (resumed/'nvda-console.log').open('xb') as console:
            process=observed.Popen([str(executable),'--config-path='+str(config),'--log-file='+str(resumed/'nvda.log'),
                '--debug-logging','--no-sr-flag','--minimal','--lang=en'],cwd=executable.parent,stdout=console,stderr=subprocess.STDOUT)
            process_pid=process.pid
            deadline=time.monotonic()+args.timeout
            receipt=resumed/'nvda-probe.json'
            while time.monotonic()<deadline:
                if receipt.is_file():
                    value=json.loads(receipt.read_text(encoding='utf-8'))
                    if value.get('run_id')==settings['run_id'] and value.get('status') not in {None,'running'}:break
                if process.poll() is not None:raise RuntimeError('Owned restarted NVDA exited before its receipt')
                time.sleep(.25)
            else:raise TimeoutError('Owned restart settings proof timed out')
            try:process.wait(timeout=20)
            except subprocess.TimeoutExpired:base.stop_owned(process);raise RuntimeError('Owned restarted NVDA did not shut down normally')
            if process.returncode!=0:raise RuntimeError('Owned restarted NVDA shutdown returned a failure')
        process=None
        second={'addon_sha256':pin['archive_sha256'],'checks':[],'probe':value}
        report['phases']['resume']=second
        validate_phase(second,'resume',pin)
        if _sha_file(executable)!=executable_hash:raise ValueError('Owned official NVDA executable changed')
        if _sha_file(args.addon)!=pin['archive_sha256']:raise ValueError('Original immutable addon changed')
        report['runtime_after_restart_and_restore']=verify_installed_runtime(args.addon,installed)
        startup=value['keyboard_startup_synth']
        automatic=startup['saved_synth_automatic_startup_verified'] is True
        if lease and not automatic:raise ValueError('Owned virtual render must close the genuine saved-synth startup gate')
        report.update(status='passed-functional-only' if automatic else 'partial-functional-only',phases=dict(report['phases'],resume=second),
            actual_second_process_pid=process_pid,actual_second_process_started_at_ns=started,
            same_owned_profile_path=True,profile_ini_before_restart_sha256=before_ini,
            actual_keyboard_settings_and_parameter_reload_verified=True,
            saved_synth_automatic_startup_verified=automatic,
            unresolved_requirements=[] if automatic else ['Saved-synth automatic startup before probe reselection: UNVERIFIED in this headless run; failure cause not inferred from output-device absence alone'],
            scope='Genuine injected Windows keys, live NVDA wx controls and base-profile parameter reload after process restart. Saved-synth automatic startup has a separate pre-reselection observation/gate. Not physical input, file chooser, named profile switching, native pronunciation or acoustic acceptance')
        return 0
    finally:
        try:
            observed.reap(base,report)
        finally:
            base.subprocess=original_subprocess
            base.PROBE_PLUGIN=pristine


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--addon',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--pin',type=Path,required=True);p.add_argument('--installer-cache',type=Path)
    p.add_argument('--headless-ui-probe',action='store_true');p.add_argument('--timeout',type=float,default=900)
    p.add_argument('--owned-virtual-render',action='store_true');p.add_argument('--ephemeral-ci',action='store_true')
    p.add_argument('--package',type=Path);p.add_argument('--validation',type=Path)
    p.add_argument('--marker-helper',type=Path);p.add_argument('--marker-build-receipt',type=Path)
    args=p.parse_args(argv)
    if os.name!='nt':p.error('A genuine Windows desktop/NVDA process is required')
    if not 60<=args.timeout<=1800:p.error('Timeout must be bounded60..1800seconds')
    if args.owned_virtual_render and (args.headless_ui_probe or not args.ephemeral_ci or any(v is None for v in (args.package,args.validation,args.marker_helper,args.marker_build_receipt))):
        p.error('Owned virtual render requires all reviewed package/helper inputs, ephemeral CI and no recording sink')
    folder=Path(__file__).resolve().parent
    gate=_load_pinned(folder/'validate_source13_integration_receipt.py',PIN_VALIDATOR_BLOB,'_settings13_pin')
    pin=gate.read_pin(args.pin)  # Unfilled pin rejects before installer/core acquisition.
    if args.addon.stat().st_size!=pin['archive_bytes'] or _sha_file(args.addon)!=pin['archive_sha256']:
        p.error('Actual immutable source13 addon differs from its completed build pin')
    output=args.output.resolve()
    if args.output.is_symlink() or output.exists() or output.is_relative_to(folder) or args.addon.resolve().is_relative_to(output):
        p.error('Supplement output must be new and separate from tool/core inputs')
    output.mkdir(parents=True)
    base=_load_pinned(folder/'windows_nvda_probe.py',BASE_BLOB,'_settings_keyboard_base')
    pristine=base.PROBE_PLUGIN
    base.SCOPE='actual-owned-NVDA-keyboard-settings-and-restart-supplement'
    report={'format':'dordiai-keyboard-settings-supplement','format_version':1,'status':'running',
            'core_sha256':pin['archive_sha256'],'product_ready':False,'physical_audio_verified':False,
            'named_profile_switching_verified':False,'file_chooser_keyboard_verified':False,'phases':{}}
    try:
        with owned_virtual_render(args,report) as lease:
            result=_run_phases(args,pin,output,base,pristine,report,lease)
        if report.get('owned_process_cleanup',{}).get('actual_nvda_process_count')!=2:
            raise RuntimeError('Expected exactly two own NVDA processes')
        return result
    except Exception as error:
        report.update(status='failed',error_type=type(error).__name__,error=str(error))
        raise
    finally:
        base.PROBE_PLUGIN=pristine
        base.write_json(output/'keyboard-settings-supplement.json',report)


def _sha_file(path):
    with Path(path).open('rb') as f:return __import__('hashlib').file_digest(f,'sha256').hexdigest()


if __name__=='__main__':raise SystemExit(main())
