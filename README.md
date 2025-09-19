# Auto Doc Render MVP (Windows, no Docker)

## Overview
Render-only pipeline that turns validated JSON specs into deterministic HTML/SVG:
- DocJSON validation (AJV 2020)
- KaTeX Math (server-side to MathML+HTML)
- Plot renderer: PGFPlots → PDF (Tectonic) → SVG (dvisvgm)
- RDKit SMILES → SVG (FastAPI microservice)
- Diagram compiler → deterministic SVG
- React reader + interactive math.js widget

## Prerequisites
- Node.js 20 LTS (or 18+)
- Python 3.10+ (64-bit)
- MiKTeX (installed)
- Tectonic (repo-local `./tectonic.exe`)
- dvisvgm (repo-local `./dvisvgm-3.5-win64/dvisvgm.exe`)
- Ghostscript `gswin64c.exe` (either installed or built from `ghostpdl-10.06.0`)

## .env (repo root; relative paths)
```
RDKIT_URL=http://127.0.0.1:8000
OPENAI_API_KEY=
OPENAI_ORG=
OPENAI_PROJECT=
DVISVGM_PATH=./dvisvgm-3.5-win64/dvisvgm.exe
GHOSTSCRIPT_PATH=./ghostpdl-10.06.0/bin/gswin64c.exe
TECTONIC_BIN=./tectonic.exe
```

## Python RDKit service
```
python -m venv .venv
.\.venv\Scripts\activate
pip install -r python\requirements.txt
uvicorn python.rdkit_service.main:app --host 127.0.0.1 --port 8000
```

## Node setup & run
```
npm install
npm run chapter:build
npm run dev
```
Open http://localhost:5173

## Chapters and outputs

- Inputs (authoring):
  - `chapters/` — DocJSON chapter files (e.g., `chapters/gravitation.json`)
  - `plots/` — PlotSpec JSONs for PGFPlots
  - `diagrams/` — DiagramSpec JSONs for schematic SVGs

- Outputs (artifacts the Reader serves):
  - `rendered/chapter.json` — pre-rendered chapter payload (HTML/SVG)
  - `rendered/test-hello.svg`, `rendered/rdkit-test.svg` — smoke-test artifacts

Build a chapter:

```
# Default (auto-picks chapters/gravitation.json or chapters/hello-chapter.json)
npm run chapter:build

# Explicit input
npm run chapter:build -- --input chapters/gravitation.json
# or via env
CHAPTER_INPUT=chapters/gravitation.json npm run chapter:build

# Convenience
npm run chapter:build:gravitation
```

Serve the Reader:

- `npm run dev` then open http://localhost:5173
- The Reader fetches `/chapter.json` which Vite serves from `rendered/chapter.json`.

## Tectonic (repo-local)
Install via PowerShell (places `tectonic.exe` in repo root):
```
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://drop-ps1.fullyjustified.net'))
```

## dvisvgm (repo-local)
Use the bundled binary via `DVISVGM_PATH=./dvisvgm-3.5-win64/dvisvgm.exe`.

## Ghostscript from GhostPDL sources (Windows)
You have the source tree `ghostpdl-10.06.0`. To produce `gswin64c.exe`:
- Install Visual Studio Build Tools (MSVC) with Desktop C++ workload.
- Open an x64 Native Tools Command Prompt for VS.
- Navigate to the GhostPDL source:
```
cd /d D:\SOFTWARE_Projects_LP\AI_content_gen\ghostpdl-10.06.0
```
- Build Ghostscript (Windows console binary) using nmake project files. The typical entry point is under `psi/msvc.mak` or solution files under `platform/win*`. For recent GhostPDL, run:
```
nmake -f psi\msvc.mak setup MSVC_VERSION=17 PLATFORM=64
nmake -f psi\msvc.mak GS_DLL=1 shared all
```
This produces `bin\gswin64c.exe`. If your tree includes SLN files for MuPDF only, consult `doc/Make.htm` and `psi/` makefiles to build Ghostscript; MuPDF SLN is unrelated.
- Set `.env` to point to the produced binary:
```
GHOSTSCRIPT_PATH=./ghostpdl-10.06.0/bin/gswin64c.exe
```

## Test TeX pipeline
```
powershell -ExecutionPolicy Bypass -File .\scripts\test-tex.ps1
```
Generates `rendered/test-hello.svg` using `TECTONIC_BIN`, `DVISVGM_PATH`, `GHOSTSCRIPT_PATH`.

## Orchestrated run
```
powershell -ExecutionPolicy Bypass -File .\scripts\run-all.ps1
```
Loads `.env`, starts RDKit, builds chapter (including PGFPlots→SVG), and starts Vite.

## Windows: Ghostscript build notes (issues and fixes)

These are the exact problems encountered and the solutions that worked when building from `ghostpdl-10.06.0`:

- Issue: Missing system headers (e.g., `sys/types.h`)
  - Error snippet: `fatal error C1083: Cannot open include file: 'sys/types.h': No such file or directory`
  - Cause: Windows SDK headers/libs not in the environment
  - Fix:
    1) Install VS 2022 C++ Build Tools + Windows 10/11 SDK in the Visual Studio Installer.
    2) Open “x64 Native Tools Command Prompt for VS 2022” (not PowerShell).
    3) Confirm SDK vars exist: `%INCLUDE%` contains `...Windows Kits\10\Include\<sdkver>\ucrt; ...\um; ...\shared` and `%LIB%` contains `...Windows Kits\10\Lib\<sdkver>\ucrt\x64; ...\um\x64`.

- Issue: RC path points to legacy MSDev98 and fails due to spaces
  - Error snippet: `'C:\Program' is not recognized ... MSDev98\bin\rc` and `U1077 / 0x1` from nmake
  - Cause: Makefile chooses an old RC path when `DEVSTUDIO` is set/assumed
  - Fix (use Windows SDK rc.exe with a short, space-free path and clear `DEVSTUDIO`):
```
cd /d D:\SOFTWARE_Projects_LP\AI_content_gen\ghostpdl-10.06.0
set DEVSTUDIO=
for %I in ("C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe") do set RC=%~sI
nmake -f psi\msvc.mak WIN64=1 clean
nmake -f psi\msvc.mak WIN64=1 DEVSTUDIO= RC=%RC% gs
```
  - Note: The banner “Unknown nmake version” is informational. The resulting artifact is `ghostpdl-10.06.0\bin\gswin64c.exe`.

## Virtual environment location (Python)

- Recommended: keep the venv at the repo root as `.venv`.
  - Our orchestration script `scripts/run-all.ps1` expects `.venv` in the repo root and activates it automatically.
  - Install dependencies from the repo root:
```
python -m venv .venv
.\.venv\Scripts\activate
pip install -r python\requirements.txt
```
- If you prefer `python/.venv`, update `scripts/run-all.ps1` to point to `python\.venv\Scripts\activate.ps1` accordingly.

## dvisvgm fontconfig (Windows, repo-local)
- We ship a minimal fontconfig at `fontconfig/fonts.conf` pointing to `C:/Windows/Fonts`.
- Set these in `.env` so dvisvgm can find it without PATH edits:
```
FONTCONFIG_FILE=./fontconfig/fonts.conf
FONTCONFIG_PATH=./fontconfig
```
- Our scripts will respect these if present. If you still see warnings, ensure the XML is readable and the path is correct.

## How this codebase works

### Purpose
Render-only pipeline that converts small, validated JSON specs into a fully formed technical chapter (HTML/SVG), plus a minimal Reader UI to view it.

### Inputs (what upstream provides)
- DocJSON chapter container (see `chapters/hello-chapter.json` or `chapters/gravitation.json`)
- PlotSpec JSON for PGFPlots (e.g., `plots/uniform-accel.json`)
- DiagramSpec JSON for deterministic schematics (e.g., `diagrams/vec-projection.json`)
- Optional: environment vars in `.env` (repo-relative paths for tools)

Constraints:
- No raw TeX/TikZ/SVG from upstream; only tiny, typed specs. All specs are AJV-validated.

### Outputs (what this produces)
- `rendered/chapter.json`: a single pre-rendered payload containing:
  - Paragraphs (HTML, inline math via client-side KaTeX)
  - Equations (KaTeX → MathML/HTML; server-side render)
  - Plot SVG (PGFPlots → Tectonic → PDF → dvisvgm → SVG; fonts embedded)
  - Chem SVG (RDKit CLI → SVG)
  - Diagram SVG (deterministic compiler → SVG)
  - Widget spec (client-only math.js playground)
- Reader UI (Vite) that renders `rendered/chapter.json` (served at `/chapter.json`) at runtime

### Pipeline (build)
1) Load & validate
   - AJV validates DocJSON/PlotSpec/DiagramSpec; unknown types/fields fail fast.
2) Equation
   - math.js numeric check (vars/expr/expect/tol) → hard gate
   - KaTeX render → MathML+HTML (build fails on TeX parse error)
3) Plot
   - Expr allowlist; render TeX from PlotSpec (axis labels use raw LaTeX)
   - Tectonic (no shell-escape) → PDF → dvisvgm (with fontmap+woff2) → SVG
4) Chem
   - RDKit CLI (Python venv): `server/chem/render.py` turns SMILES → SVG (invalid SMILES → fail)
5) Diagram
   - Topology checks + grid-snap → deterministic SVG
6) Output
   - Writes `rendered/chapter.json` with pre-rendered HTML/SVG for all sections

### Reader (serve)
- `npm run dev` starts a Vite React app that:
  - Fetches `/chapter.json` (served from `rendered/chapter.json`)
  - Renders all sections; KaTeX processes inline `$...$` in paragraphs client-side
  - Provides a ToC and a math.js-based interactive widget

### Integration (how other apps connect)
- Upstream authoring/LLM emits DocJSON + referenced specs (PlotSpec/DiagramSpec)
  - Place files into `chapters/` (DocJSON), `plots/` (PlotSpec), `diagrams/` (DiagramSpec) or invoke the build programmatically
- Downstream consumption
  - Consume `rendered/chapter.json` directly to render in any app
  - Or embed the provided Reader UI

### Failure gates (robustness)
- Schema invalid → stop
- TeX parse error → stop
- Equation numeric check fails → stop
- Plot expr contains illegal tokens → stop
- RDKit SMILES conversion fails → stop
- Diagram topology/overlap fails → stop
- (Optional sanitizer) geometry-changing removals → stop

### Commands
- Install (one-shot):
  - `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`
- Full test suite:
  - `powershell -ExecutionPolicy Bypass -File .\scripts\test-all.ps1`
- Build chapter (writes `public/chapter.json`):
  - `npm run chapter:build`
  - `npm run chapter:build -- --input chapters/gravitation.json`
  - `CHAPTER_INPUT=chapters/gravitation.json npm run chapter:build`
- Run Reader UI:
  - `npm run dev` → open http://localhost:5173

Notes:
- Python venv is used for RDKit; the build invokes the venv’s `python.exe` (or `RDKIT_PYTHON`) directly, so shell activation is not required.
- Plot axis labels are rendered by PGFPlots (raw LaTeX). Font embedding is controlled via `fontmaps/tex2sys.map` and `DVISVGM_FONT_FORMAT`.
