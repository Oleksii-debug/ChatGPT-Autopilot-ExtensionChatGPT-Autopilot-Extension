"""Owned GitHub-hosted Windows PnP endpoint trial; no user-PC installation.

Use only after the workflow verifies pinned vendor hashes, Authenticode and
Microsoft SDK SignTool catalogue membership. No vendor installer is executed.
A ready software endpoint is not real NVDA, captured audio or physical sound.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import struct
import time
import uuid

REPOSITORY = "Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension"
HARDWARE_ID = "VBAudioVACWDM"
CLASS_GUID = "4d36e96c-e325-11ce-bfc1-08002be10318"
EXPECTED = {
    "vbMmeCable64_win10.inf": "cecf9181b6c85842d707330efc594824a749a1d9e01db46eba0e60e72f0a66ee",
    "vbaudio_cable64_win10.cat": "5d24c17858b49ad83bb856c66c24c5c2aecdb89cbaae2f8179c15d351124fa9f",
    "vbaudio_cable64_win10.sys": "7ebcbbe7004d185f7b29613cd27fdc2dd71c1712224b767a74d2f66bdc33a7ef",
    "vbaudio_cable64arm_win10.sys": "85c217af826c2e1d478b52afc7c2248889c8478030d44e8134bd4c23b8915216",
    "VBCABLE_Setup_x64.exe": "734c35dfa6d98f48782a451633ceb471166ec70d60482fd89a1123d0ee3c4f41",
    "readme.txt": "f865f3e78e37006d48e56c93f51eff4ca79acda9969854400d79bfa3db38a8d5",
}
CAT_MEMBERS = {"vbMmeCable64_win10.inf", "vbaudio_cable64_win10.sys", "vbaudio_cable64arm_win10.sys"}
DWORD, BOOL, HANDLE = C.c_uint32, C.c_int32, C.c_void_p


class TrialBlocked(ValueError):
    pass


class GUID(C.Structure):
    _fields_ = [("Data1", DWORD), ("Data2", C.c_uint16), ("Data3", C.c_uint16), ("Data4", C.c_ubyte * 8)]


class DeviceInfo(C.Structure):
    _fields_ = [("cbSize", DWORD), ("ClassGuid", GUID), ("DevInst", DWORD), ("Reserved", C.c_void_p)]


class ClassHeader(C.Structure):
    _fields_ = [("cbSize", DWORD), ("InstallFunction", DWORD)]


class RemoveParams(C.Structure):
    _fields_ = [("ClassInstallHeader", ClassHeader), ("Scope", DWORD), ("HwProfile", DWORD)]


def guard_environment(environ, package, output, *, platform_name=os.name, pointer_bytes=struct.calcsize("P")):
    if (platform_name != "nt" or pointer_bytes != 8
            or environ.get("GITHUB_ACTIONS") != "true"
            or environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or environ.get("RUNNER_ARCH") != "X64"
            or not environ.get("GITHUB_RUN_ID", "").isdigit()
            or not environ.get("RUNNER_TEMP")):
        raise TrialBlocked("Only this repository's ephemeral GitHub-hosted64bit Windows runner is allowed")
    temporary = Path(environ["RUNNER_TEMP"]).resolve()
    package, output = Path(package), Path(output)
    if (package.is_symlink() or output.is_symlink()
            or not package.resolve().is_relative_to(temporary)
            or not output.resolve().is_relative_to(temporary)
            or package.resolve() == output.resolve()
            or package.resolve().is_relative_to(output.resolve())
            or output.resolve().is_relative_to(package.resolve())):
        raise TrialBlocked("Package and evidence must be separate owned RUNNER_TEMP subdirectories")
    if (environ["GITHUB_RUN_ID"] not in package.name or environ["GITHUB_RUN_ID"] not in output.name):
        raise TrialBlocked("Owned temporary roots must bind the current run ID")


def check_audio_service_receipt(report, returncode):
    expected_reason = ("No Windows audio output endpoint is present. The reviewed virtual driver requires reboot; "
                       "unattended driver installation was not attempted.")
    if (not isinstance(report,dict) or report.get("format")!="dordiai-audio-endpoint-setup"
            or report.get("format_version")!=1 or report.get("physical_audio_verified") is not False
            or report.get("driver_installed") is not False or report.get("wave_player_verified") is not False):
        raise TrialBlocked("Unexpected existing-service helper receipt")
    rows=report.get("services")
    if (not isinstance(rows,list) or [row.get("service") for row in rows] != ["AudioEndpointBuilder","Audiosrv"]
            or any(row.get("error") or row.get("start_error") or row.get("after",{}).get("state")!=4 for row in rows)):
        raise TrialBlocked("Existing audio services did not start cleanly; no driver trial")
    after=report.get("wave_out_devices_after")
    if returncode==0 and report.get("status")=="endpoint-present" and type(after) is int and after>0:
        return "existing-endpoint"
    if (returncode==2 and report.get("status")=="blocked" and type(after) is int and after==0
            and report.get("wave_out_devices_before")==0 and report.get("reason")==expected_reason):
        return "expected-no-endpoint"
    raise TrialBlocked("Unrecognized service helper failure; not suppressed")


def verify_package(package, validation_path):
    package = Path(package)
    for name, expected in EXPECTED.items():
        path = package / name
        if path.is_symlink() or not path.is_file():
            raise TrialBlocked("Pinned vendor member is missing or linked")
        with path.open("rb") as handle:
            actual = hashlib.file_digest(handle, "sha256").hexdigest()
        if actual != expected:
            raise TrialBlocked("Pinned vendor member hash mismatch: " + name)
    proof = json.loads(Path(validation_path).read_text(encoding="utf-8"))
    if (proof.get("format") != "dordiai-vb46-catalogue-verification"
            or proof.get("package_sha256") != "bc44e8974191a5a2427d6c979e2dab08dbb09925f3f435dfa2f0ba3e45b6eb90"
            or proof.get("catalogue_members") != {name: True for name in sorted(CAT_MEMBERS)}
            or proof.get("authenticode_valid") is not True
            or proof.get("signtool_authenticode_valid") is not True):
        raise TrialBlocked("Trusted catalogue membership/Authenticode proof is missing")
    return proof


def bind(library, name, args, result=BOOL):
    value = getattr(library, name)
    value.argtypes, value.restype = args, result
    return value


class WindowsPnP:
    def __init__(self):
        self.setup = C.WinDLL("setupapi", use_last_error=True)
        self.newdev = C.WinDLL("newdev", use_last_error=True)
        self.cfg = C.WinDLL("cfgmgr32", use_last_error=True)
        self.shell = C.WinDLL("shell32", use_last_error=True)
        if not bind(self.shell, "IsUserAnAdmin", [])():
            raise TrialBlocked("Standard trusted device installation requires the owned runner administrator")
        PG, PD = C.POINTER(GUID), C.POINTER(DeviceInfo)
        self.create_list = bind(self.setup, "SetupDiCreateDeviceInfoList", [PG,HANDLE], HANDLE)
        self.all_devices = bind(self.setup, "SetupDiGetClassDevsW", [PG,C.c_wchar_p,HANDLE,DWORD], HANDLE)
        self.enum = bind(self.setup, "SetupDiEnumDeviceInfo", [HANDLE,DWORD,PD])
        self.destroy = bind(self.setup, "SetupDiDestroyDeviceInfoList", [HANDLE])
        self.create = bind(self.setup, "SetupDiCreateDeviceInfoW", [HANDLE,C.c_wchar_p,PG,C.c_wchar_p,HANDLE,DWORD,PD])
        self.property = bind(self.setup, "SetupDiGetDeviceRegistryPropertyW",
                             [HANDLE,PD,DWORD,C.POINTER(DWORD),C.c_void_p,DWORD,C.POINTER(DWORD)])
        self.set_property = bind(self.setup, "SetupDiSetDeviceRegistryPropertyW", [HANDLE,PD,DWORD,C.c_void_p,DWORD])
        self.class_install = bind(self.setup, "SetupDiCallClassInstaller", [DWORD,HANDLE,PD])
        self.instance = bind(self.setup, "SetupDiGetDeviceInstanceIdW", [HANDLE,PD,C.c_wchar_p,DWORD,C.POINTER(DWORD)])
        self.set_class = bind(self.setup, "SetupDiSetClassInstallParamsW", [HANDLE,PD,C.POINTER(ClassHeader),DWORD])
        self.update = bind(self.newdev, "UpdateDriverForPlugAndPlayDevicesW",
                           [HANDLE,C.c_wchar_p,C.c_wchar_p,DWORD,C.POINTER(BOOL)])
        self.locate_node = bind(self.cfg, "CM_Locate_DevNodeW", [C.POINTER(DWORD),C.c_wchar_p,DWORD], DWORD)
        self.node_status = bind(self.cfg, "CM_Get_DevNode_Status",
                               [C.POINTER(DWORD),C.POINTER(DWORD),DWORD,DWORD], DWORD)

    @staticmethod
    def checked(value, operation):
        if not value:
            error = C.get_last_error()
            raise TrialBlocked(operation + " failed with Windows error " + str(error))
        return value

    @staticmethod
    def info():
        info = DeviceInfo()
        info.cbSize = C.sizeof(DeviceInfo)
        return info

    def instance_id(self, handle, info):
        buffer = C.create_unicode_buffer(1024)
        self.checked(self.instance(handle,C.byref(info),buffer,len(buffer),None), "Get owned instance ID")
        return buffer.value

    def matching(self):
        handle = self.all_devices(None,None,None,4)  # DIGCF_ALLCLASSES; include nonpresent nodes.
        if handle in (None,C.c_void_p(-1).value):
            raise TrialBlocked("Cannot enumerate preexisting PnP devices")
        result = []
        try:
            index = 0
            while True:
                info = self.info()
                if not self.enum(handle,index,C.byref(info)):
                    if C.get_last_error() == 259:
                        break
                    raise TrialBlocked("Preexisting PnP enumeration failed")
                index += 1
                required, kind = DWORD(), DWORD()
                ok = self.property(handle,C.byref(info),1,C.byref(kind),None,0,C.byref(required))
                error = C.get_last_error()
                if not ok and error == 13:  # Device has no hardware-ID property.
                    continue
                if not ok and error != 122:
                    raise TrialBlocked("Cannot safely inspect a preexisting hardware ID")
                if required.value > 65536:
                    raise TrialBlocked("Oversized hardware-ID property")
                buffer = (C.c_ubyte * max(2,required.value))()
                self.checked(self.property(handle,C.byref(info),1,C.byref(kind),buffer,C.sizeof(buffer),None),
                             "Read preexisting hardware ID")
                ids = bytes(buffer).decode("utf-16-le").split("\0")
                if any(value.casefold() == HARDWARE_ID.casefold() for value in ids):
                    result.append(self.instance_id(handle,info))
        finally:
            self.destroy(handle)
        return result

    def instance_exists(self, instance):
        if not isinstance(instance,str) or not instance.upper().startswith("ROOT\\DORDIAI_VBCABLE_"):
            raise TrialBlocked("Cannot verify cleanup without the exact owned instance ID")
        node = DWORD()
        # PHANTOM=1 includes configured AND nonpresent nodes. Never use CANCELREMOVE.
        result = self.locate_node(C.byref(node),instance,1)
        if result == 0:
            return True
        if result == 13:  # CR_NO_SUCH_DEVNODE, cfgmgr32.h.
            return False
        raise TrialBlocked("Owned instance absence could not be established; CONFIGRET " + str(result))

    @contextmanager
    def owned_device(self, inf, report):
        if self.matching():
            raise TrialBlocked("A matching vendor device already exists; refusing any shared device update")
        guid = GUID.from_buffer_copy(uuid.UUID(CLASS_GUID).bytes_le)
        handle = self.create_list(C.byref(guid),None)
        if handle in (None,C.c_void_p(-1).value):
            raise TrialBlocked("Cannot create owned PnP information set")
        info, created, instance = self.info(), False, None
        owner_name = "DORDIAI_VBCABLE_" + uuid.uuid4().hex.upper()
        try:
            self.checked(self.create(handle,owner_name,C.byref(guid),"Owned ephemeral Dordiai audio test",
                                     None,1,C.byref(info)), "Create owned root device")
            created = True
            instance = self.instance_id(handle,info)
            if not instance.upper().startswith("ROOT\\" + owner_name + "\\"):
                raise TrialBlocked("Generated instance did not retain the unique ownership prefix")
            report["owned_instance_id"] = instance
            raw = (HARDWARE_ID + "\0\0").encode("utf-16-le")
            buffer = (C.c_ubyte * len(raw)).from_buffer_copy(raw)
            self.checked(self.set_property(handle,C.byref(info),1,buffer,len(raw)), "Set owned hardware ID")
            self.checked(self.class_install(0x19,handle,C.byref(info)), "Register owned PnP device")
            if self.matching() != [instance]:
                raise TrialBlocked("Vendor hardware-ID ownership changed before installation")
            reboot = BOOL()
            # NONINTERACTIVE only; no FORCE, test signing, certificate import or automatic reboot.
            installed = bool(self.update(None,HARDWARE_ID,str(Path(inf).resolve()),4,C.byref(reboot)))
            report["driver_install_returned_success"] = installed
            report["windows_install_error"] = 0 if installed else C.get_last_error()
            report["windows_requires_reboot"] = bool(reboot.value)
            if reboot.value:
                raise TrialBlocked("Windows reports a reboot is required; reboot is forbidden for this trial")
            if not installed:
                raise TrialBlocked("Standard trusted installation failed; no signature/security bypass attempted")
            status, problem = DWORD(), DWORD()
            code = self.node_status(C.byref(status),C.byref(problem),info.DevInst,0)
            report["device_status"] = {"configret":code,"flags":status.value,"problem":problem.value}
            if code != 0 or problem.value or not status.value & 8:  # DN_STARTED
                raise TrialBlocked("Owned device did not start normally; no restart or policy bypass attempted")
            yield instance
        finally:
            cleanup = {"attempted":created,"scope":"Only this call's exact owned device instance",
                       "driver_store_purge_attempted":False}
            try:
                if created:
                    params = RemoveParams(ClassHeader(C.sizeof(ClassHeader),5),1,0)
                    self.checked(self.set_class(handle,C.byref(info),C.byref(params.ClassInstallHeader),C.sizeof(params)),
                                 "Set owned removal parameters")
                    self.checked(self.class_install(5,handle,C.byref(info)), "Remove owned device instance")
                    cleanup["removal_requested"] = True
                    deadline = time.monotonic()+5
                    while self.instance_exists(instance) and time.monotonic()<deadline:
                        time.sleep(.1)
                    cleanup["removed"] = not self.instance_exists(instance)
                    cleanup["absence_verified"] = cleanup["removed"]
                    cleanup["absence_query"] = "CM_Locate_DevNodeW PHANTOM; only CR_NO_SUCH_DEVNODE proves absence"
            except TrialBlocked as error:
                cleanup.update(removed=False,error=str(error))
            finally:
                self.destroy(handle)
                report["cleanup"] = cleanup


class OutCaps(C.Structure):
    _fields_ = [("wMid",C.c_uint16),("wPid",C.c_uint16),("version",DWORD),
                ("name",C.c_wchar*32),("formats",DWORD),("channels",C.c_uint16),
                ("reserved",C.c_uint16),("support",DWORD)]


class InCaps(C.Structure):
    _fields_ = OutCaps._fields_[:-1]


def endpoints():
    winmm = C.WinDLL("winmm",use_last_error=True)
    result = {}
    for kind,caps_type in (("Out",OutCaps),("In",InCaps)):
        count = bind(winmm,"wave"+kind+"GetNumDevs",[],C.c_uint)()
        get = bind(winmm,"wave"+kind+"GetDevCapsW",[C.c_size_t,C.c_void_p,C.c_uint],C.c_uint)
        rows = []
        for index in range(count):
            caps = caps_type()
            error = get(index,C.byref(caps),C.sizeof(caps))
            rows.append({"index":index,"error":error,"name":caps.name if error==0 else None,
                         "channels":caps.channels if error==0 else None})
        result[kind.lower()] = rows
    return result


def select_new_vendor_endpoints(before, during):
    """Select only newly appeared vendor endpoints; generic Speakers never qualifies."""
    def new(kind, prefix):
        prior={(row.get("name"),row.get("channels")) for row in before.get(kind,[]) if row.get("error")==0}
        return [row for row in during.get(kind,[])
                if row.get("error")==0 and row.get("channels")==2
                and isinstance(row.get("name"),str) and row["name"].startswith(prefix)
                and (row["name"],row["channels"]) not in prior]
    render=new("out","Speakers (VB-Audio Virtual Cabl")
    render+=new("out","CABLE Input (VB-Audio Virtual")
    capture=new("in","CABLE Output (VB-Audio Virtual")
    return (render[0],capture[0]) if len(render)==1 and len(capture)==1 else (None,None)


def run(args):
    report = {"format":"dordiai-owned-virtual-audio-endpoint-trial","format_version":1,
              "status":"blocked","virtual_audio_verified":False,"physical_audio_verified":False,
              "wave_player_verified":False,"product_ready":False,
              "vendor_installer_executed":False,"certificates_imported":False,"reboot_performed":False,
              "test_signing_modified":False,"signature_enforcement_modified":False,
              "vendor_requires_finalization_reboot":True,
              "scope":"One owned ephemeral PnP install/enumeration trial; not capture/NVDA/physical acceptance"}
    output_created = False
    try:
        if not args.ephemeral_ci:
            raise TrialBlocked("Explicit ephemeral CI scope is required")
        guard_environment(os.environ,args.package,args.output)
        if args.output.exists():
            raise TrialBlocked("Refusing an existing evidence output directory")
        args.output.mkdir(parents=True)
        output_created = True
        report["verification"] = verify_package(args.package,args.validation)
        report["endpoints_before"] = endpoints()
        pnp = WindowsPnP()
        with pnp.owned_device(args.package/"vbMmeCable64_win10.inf",report):
            deadline = time.monotonic()+20
            while True:
                observed = endpoints()
                render,capture = select_new_vendor_endpoints(report["endpoints_before"],observed)
                report["endpoints_during"] = observed
                if render and capture:
                    report.update(status="software-endpoints-present-not-audio-verified",
                                  render_endpoint=render,capture_endpoint=capture)
                    break
                if time.monotonic()>=deadline:
                    raise TrialBlocked("No usable render/capture endpoints appeared without a reboot")
                time.sleep(.25)
        if report.get("cleanup",{}).get("removed") is not True:
            report.update(status="failed",reason="Owned device cleanup did not complete")
    except (TrialBlocked,OSError,ValueError) as error:
        report.update(status="blocked",reason=str(error))
    finally:
        # Even environment rejection must not write outside the guarded CI output.
        if report.get("cleanup",{}).get("attempted") and report["cleanup"].get("removed") is not True:
            report.update(status="failed",cleanup_failure=True,
                          reason="Owned device removal was requested but actual instance absence was not verified")
        if output_created:
            (args.output/"endpoint-trial.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
        print("VIRTUAL_AUDIO_ENDPOINT_TRIAL "+json.dumps(report,ensure_ascii=True),flush=True)
    return 0 if report["status"]=="software-endpoints-present-not-audio-verified" else 2 if report["status"]=="blocked" else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package",required=True,type=Path)
    parser.add_argument("--validation",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    parser.add_argument("--ephemeral-ci",action="store_true")
    return run(parser.parse_args())


if __name__=="__main__":
    raise SystemExit(main())
