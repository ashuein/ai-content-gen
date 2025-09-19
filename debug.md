# Debug notes (Windows)

## 1) Ghostscript (GhostPDL) build gotchas

Symptoms:
- `fatal error C1083: Cannot open include file: 'sys/types.h'` → Missing Windows SDK headers.
- `"C:\Program Files\Microsoft Visual Studio\Common\MSDev98\bin\rc" ... 'C:\Program' is not recognized` → Legacy RC path due to DEVSTUDIO.
- `U1073: don't know how to make 'setup'` → No such target in this makefile.

Fixes:
- Use “x64 Native Tools Command Prompt for VS 2022”. Install VS C++ Build Tools + Windows 10/11 SDK.
- Build from `ghostpdl-10.06.0`:
```
cd /d D:\SOFTWARE_Projects_LP\AI_content_gen\ghostpdl-10.06.0
set DEVSTUDIO=
for %I in ("C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe") do set RC=%~sI
nmake -f psi\msvc.mak WIN64=1 clean
nmake -f psi\msvc.mak WIN64=1 DEVSTUDIO= RC=%RC% gs
```
- Artifact: `ghostpdl-10.06.0\bin\gswin64c.exe`. Set `.env`: `GHOSTSCRIPT_PATH=./ghostpdl-10.06.0/bin/gswin64c.exe`.

## 2) dvisvgm + fontconfig message on Windows

Goal: eliminate `Fontconfig error: Cannot load default config file: No such file: (null)`.

Option A (global fontconfig config):
1) Create:
```
C:\etc\fonts
C:\etc\fonts\cache
```
2) Place config files:
- Copy repo files → `C:\etc\fonts\fonts.conf` and `C:\etc\fonts\fonts.dtd`.
- `fonts.conf` (absolute paths, forward slashes):
```
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>C:/Windows/Fonts</dir>
  <cachedir>C:/etc/fonts/cache</cachedir>
  <config><rescan>30</rescan></config>
</fontconfig>
```
3) System/user env (then restart shell):
```
FONTCONFIG_FILE=C:\etc\fonts\fonts.conf
FONTCONFIG_PATH=C:\etc\fonts
FONTCONFIG_CACHE=C:\etc\fonts\cache
FC_CONFIG_FILE=C:\etc\fonts\fonts.conf
FC_CONFIG_DIR=C:\etc\fonts
```

Option B (user-level XDG fallback):
```
%USERPROFILE%\.config\fontconfig\fonts.conf
%USERPROFILE%\.config\fontconfig\fonts.dtd
%USERPROFILE%\.config\fontconfig\cache
XDG_CONFIG_HOME=%USERPROFILE%\.config
```
Use the same `fonts.conf` content as above (absolute, forward slashes).

Option C (deterministic, fontconfig-free rendering):
- Use a dvisvgm fontmap + woff2 embedding:
  - Repo: `fontmaps/tex2sys.map` maps TeX fonts → Windows font files.
  - Test script runs: `dvisvgm --pdf <input.pdf> --fontmap=fontmaps/tex2sys.map --font-format=woff2 --stdout`.
  - Server compiler passes `--fontmap` and `--font-format=woff2`. Override via `.env`:
```
DVISVGM_FONTMAP=./fontmaps/tex2sys.map
DVISVGM_FONT_FORMAT=woff2
```
- This removes fontconfig from the lookup path; output is consistent across machines.

Option D (install fontconfig runtime):
- Install a Windows fontconfig runtime (e.g., MSYS2 `mingw-w64-ucrt-x86_64-fontconfig`) and ensure its bin precedes dvisvgm in PATH. Keep env pointing to `C:\etc\fonts`.

## 3) RDKit on Windows

Preferred (PyPI wheels):
- Use `rdkit` (not `rdkit-pypi`) on Python versions with available wheels. In repo venv:
```
.\.venv\Scripts\activate
pip install rdkit fastapi==0.115.0 uvicorn[standard]==0.30.6 pydantic==2.9.2
```
- Verify: `python -c "from rdkit import Chem; print(Chem.MolFromSmiles('CCO') is not None)"`

If wheels for current Python are unavailable:
- Use conda: `conda create -n rdkit-svc -c conda-forge python=3.10 rdkit fastapi uvicorn`
- Or build RDKit from source and point to repo venv Python.

## 4) TeX toolchain test

- Script: `scripts/test-tex.ps1` generates `public/test-hello.svg` with deterministic fonts.
- Requirements in `.env` (repo-relative):
```
TECTONIC_BIN=./tectonic.exe
DVISVGM_PATH=./dvisvgm-3.5-win64/dvisvgm.exe
GHOSTSCRIPT_PATH=./ghostpdl-10.06.0/bin/gswin64c.exe
FONTCONFIG_FILE=./fontconfig/fonts.conf
FONTCONFIG_PATH=./fontconfig
FONTCONFIG_CACHE=./fontconfig/cache
```

## 5) One-shot run

- `scripts/run-all.ps1` loads `.env`, starts RDKit (venv), builds chapter (PGFPlots→SVG via Tectonic+dvisvgm), and launches Vite.

## 6) dvisvgm options quick reference
- `--fontmap=<file>`: Map TeX font names to system font family or explicit font file.
- `--font-format=woff2|woff|otf|ttf|svg|path`: How to embed fonts in SVG.
- `--verbosity=0..4`: Control logging output.
- `--stdout`: Write SVG to stdout (we redirect to file in scripts).
