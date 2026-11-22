"""Register only our external engine; do not change selected synth or language roles."""
from pathlib import Path
import globalVars


def onInstall():
    source = Path(__file__).resolve().parent / "worldVoiceBridge/DordiaiVoices"
    destination = Path(globalVars.appArgs.configPath) / "WorldVoice-workspace/DordiaiVoices/DordiaiVoices"
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("__init__.py", "manifest.json"):
        target = destination / name
        temporary = target.with_suffix(target.suffix + ".new")
        temporary.write_bytes((source / name).read_bytes())
        temporary.replace(target)


def onUninstall():
    # NVDA runs the old onUninstall at restart after the replacement's
    # onInstall has already registered its wrapper. Keep that new wrapper.
    pending = Path(globalVars.appArgs.configPath) / "addons/kx47Voices.pendingInstall"
    if (pending / "manifest.ini").is_file() and Path(__file__).resolve().parent != pending.resolve():
        return
    source = Path(__file__).resolve().parent / "worldVoiceBridge/DordiaiVoices"
    destination = Path(globalVars.appArgs.configPath) / "WorldVoice-workspace/DordiaiVoices/DordiaiVoices"
    # Remove only unmodified files owned by this add-on; keep user edits and
    # every other WorldVoice engine. An empty wrapper directory is harmless.
    for name in ("__init__.py", "manifest.json"):
        target = destination / name
        original = source / name
        if target.is_file() and original.is_file() and target.read_bytes() == original.read_bytes():
            target.unlink()
