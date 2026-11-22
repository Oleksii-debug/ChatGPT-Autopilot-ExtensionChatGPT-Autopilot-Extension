# Owned signed virtual endpoint first trial

The actual read-only acquisition45024624054 verified the official
VBCABLE_Driver_Pack46.zip:1,324,680 bytes, SHA-256
bc44e8974191a5a2427d6c979e2dab08dbb09925f3f435dfa2f0ba3e45b6eb90.
The modern INF declares10/31/2026,3.5.2.0 andHardwareIdVBAudioVACWDM.
The modern catalogue has a valid Microsoft Windows Hardware Compatibility
Publisher signature. The SYS and vendor setup EXE signatures were valid.
This alone does not prove catalogue membership or successful installation.

The isolated [virtual-audio-trial] workflow performs the missing catalogue
membership checks using an already installed, signed Microsoft SDK SignTool,
kernel policy /kp and explicit /c catalogue. It verifies the exact pinned INF,
x64/ARM64SYS and signatures before any device change. It never executes the
vendor installer or guesses its flags; never redistributes vendor binaries.

The reviewed helper permits only this repository's GitHub-hosted x64 Windows
runner and separate run-bound directories under RUNNER_TEMP. It refuses any
preexisting matching hardware. Documented SetupAPI creates one uniquely named
ROOT device; UpdateDriverForPlugAndPlayDevicesW uses NONINTERACTIVE only,
without FORCE, and supplies a non-null NeedReboot result. A requested reboot,
device problem or failure to start remains blocked. No reboot, TestSigning,
certificate import or security-policy change is attempted.

The vendor readme explicitly requires reboot to finalize installation and
uninstallation. That instruction remains recorded. Even if a fresh PnP node
starts and MME render/capture endpoints appear without reboot, this trial only
reports software-endpoints-present-not-audio-verified. It does not claim
vendor-finalized installation, actual sample capture, NVDA/WavePlayer playback,
physical audio or pronunciation. Removal of the exact newly created instance is requested in finally. A removed
result requires a bounded CM_Locate_DevNodeW PHANTOM query to prove the exact
instance is gone, including nonpresent nodes. Unverified/deferred cleanup is a
hard exit1 and is never accepted as an ordinary blocked outcome. The driver store is not broadly purged; the entire owned VM is
discarded after the job.

Only metadata/verification logs are uploaded. Existing audio services may be
started using the existing owned-CI helper. No user computer is affected.
A later separately reviewed trial can hold this same owned device lease while
measuring real WavePlayer and a virtual capture stream; physical_audio_verified
must remain false.

Primary API references:
- https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupdicreatedeviceinfow
- https://learn.microsoft.com/en-us/windows/win32/api/newdev/nf-newdev-updatedriverforplugandplaydevicesw
- https://learn.microsoft.com/en-us/windows-hardware/drivers/install/dif-remove
- https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
- https://vb-audio.com/Cable/

The synthetic tests verify ownership/resource guards and API-call contracts,
not an actual driver installation. Actual endpoint presence requires a completed
trial report; it is not claimed by this recipe.
