# Codebase Design Report

This file describes the three primary components of the AI Content Generation codebase and maps all modules and directories to them.

## Major Components

### 1. Prompt Injector
- **prompt-injector/**: Constructs and injects LLM prompts using versioned message envelopes and security patterns.
- **config/**: Path and environment configuration consumed by the prompt-injector and envelope builders.
- **shared/**: Common utilities and types (e.g., message envelopes, core interfaces) shared across prompt-injector and engine.

### 2. Content Generation Engine
- **content-engine/**: Contract-first LLM content pipeline modules (M1-Plan, M2-Scaffold, M3-Section, M4-Assembler).
- **course_database/**: NCERT curriculum data, indexes, and mappings used during planning and metadata enrichment.
- **validator/**: Custom validation utilities (equation pre-checks, beat-dependency validator, and other gates).
- **schema/**: JSON Schema definitions for DocJSON, PlotSpec, DiagramSpec, adapters, and message envelopes.
- **types.ts**: Core TypeScript interfaces for DocJSON payloads, Section entries, EqCheck, PlotSpec, DiagramSpec, and FormulaWidgetSpec.
- **templates/**: TeX and document templates used by content-engine modules to scaffold output.
- **scripts/**: Automation scripts for building, testing, and orchestrating the generation pipeline (e.g., run-all, install).

### 3. Content Renderer
- **server/**: Node.js orchestrator and HTTP microservices for server-side rendering:
  - Math (KaTeX → HTML/MathML)
  - Plot (PGFPlots → Tectonic → PDF → dvisvgm → SVG)
  - Diagram compiler → deterministic SVG
  - RDKit (Python service invocation for chemical SVG)
  - Caching, resilience, monitoring, security, and publishing layers
- **client/**: React/Vite Reader UI for serving pre-rendered chapters (`index.html`, interactive widgets, and ToC).
- **python/rdkit_service/**: FastAPI-based RDKit microservice for SMILES-to-SVG chemical rendering.
- **plots/**: PlotSpec JSON inputs consumed by the rendering pipeline.
- **diagrams/**: DiagramSpec JSON inputs consumed by the rendering pipeline.
- **CR_chapters/**: Authoring DocJSON chapter directory for content-renderer test cases.
- **CR_rendered/**: Output directory holding rendered chapter JSON and sample SVG artifacts.

## External Tools & Resources
- **ghostpdl-10.06.0/**, **dvisvgm-3.5-win64/**, **tectonic.exe**: Bundled TeX toolchain components for server-side SVG conversion.
- **fontconfig/**, **fontmaps/**: Font configuration and mapping for PGFPlots and dvisvgm.

## Environment & Build Artifacts
- **cache/**, **dist/**, **tmp-tex/**, **node_modules/**, **venv/**: Build caches, artifact directories, and dependencies.
- **.env**, **.claude**, **.gitignore**, **.vscode/**: Environment and IDE configuration files.
- **package.json**, **tsconfig.json**, **renderer.config.ts**, **vite.config.ts**: Root-level configuration for Node.js, TypeScript, and Vite.
- **README.md**, **con_gen_schema.md**: Repository documentation and architecture specifications.

## End-to-End Content Generation Workflow
Below is the sequential flow from initial prompt preparation through final delivered content:

1. **Prompt Construction (Prompt Injector)**
   - Build versioned message envelopes and secure LLM prompts (`prompt-injector/`, using `config/` and `shared/`).
2. **Plan Generation (M1-Plan)**
   - Generate a high-level DocPlan with beats, objectives, and metadata (`content-engine/m1-plan/`).
3. **Scaffold Creation (M2-Scaffold)**
   - Produce a detailed scaffold outline for sections (`content-engine/m2-scaffold/`).
4. **Adapter Transformation**
   - Transform scaffold output into SectionContext for decoupled section generation (`content-engine/adapters/`).
5. **Section Generation (M3-Section)**
   - Create narrative content, equations, and asset markers, enforcing validation gates (`content-engine/m3-section/`).
6. **Assembly (M4-Assembler)**
   - Compile all SectionDocs into a cohesive document structure with consistent IDs and metadata (`content-engine/m4-assembler/`).
7. **Asset Rendering (Server Side)**
   - Render math (KaTeX → HTML/MathML), plots (PGFPlots → Tectonic → PDF → dvisvgm → SVG), diagrams, and chemistry SVGs via microservices (`server/`, `python/rdkit_service/`, `plots/`, `diagrams/`).
8. **Rendered Output Packaging**
   - Bundle pre-rendered HTML/SVG assets into a single `chapter.json` payload under `CR_rendered/` (or `public/`).
9. **Reader UI Delivery (Client Side)**
   - Serve the final `chapter.json` through the React/Vite Reader UI with interactive widgets and table of contents (`client/`, `index.html`, `vite.config.ts`).

This workflow establishes a contract-first, modular pipeline from LLM prompts to user-ready educational content.