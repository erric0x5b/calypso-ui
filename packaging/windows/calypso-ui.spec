# Build from the repository root on Windows:
#   pyinstaller --clean --noconfirm packaging\windows\calypso-ui.spec

from PyInstaller.utils.hooks import collect_data_files, collect_submodules
from pathlib import Path
import sys


block_cipher = None
repo_root = Path(SPECPATH).resolve().parents[1]
sys.path.insert(0, str(repo_root))

datas = []
datas += collect_data_files("backend.app", includes=["static/**/*", "config/**/*"])

hiddenimports = []
hiddenimports += collect_submodules("pymavlink.dialects")


a = Analysis(
    [str(repo_root / "backend" / "app" / "standalone.py")],
    pathex=[str(repo_root)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="CalypsoUI",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="CalypsoUI",
)
