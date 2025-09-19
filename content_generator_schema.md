Here’s a single, saveable spec you can plug into your project. It gives you:

* Concrete JSON Schemas for **DocPlan → Scaffold → Section → Final Chapter** (what the LLM engine produces at each step)
* Mini-schemas for **PlotSpec, DiagramSpec, WidgetSpec, ChemSpec**
* A **validator + repair FSM**, error codes, and test checklist
* Clean **module boundaries** (inputs/outputs) so this “LLM content engine” can be developed, debugged, and refactored independently
* Exact **I/O contracts** matched to your Reader app (inputs/outputs and folder layout)&#x20;

---

# LLM Content Engine — Contracts & Schemas (v1)

## 0) Context & Alignment with Reader

* Your Reader app is **render-only** and expects:

  * **Inputs**: `chapters/*.json` (DocJSON), `plots/*.json` (PlotSpec), `diagrams/*.json` (DiagramSpec)
  * **Build output**: `rendered/chapter.json` (pre-rendered payload with HTML/SVG)
    Exactly as your README describes for *Inputs/Outputs/Pipeline/Failure gates*.&#x20;

**Goal:** The LLM engine **only** produces the authoring inputs your Reader consumes (plus planning artifacts you keep server-side).

---

## 1) Engine Modules & I/O (clean boundaries)

### M1. **Plan Generator**

* **Input**: `PlanRequest`
  `{ title, subject, grade, difficulty, chapter_pdf_url }`
* **Output**: `DocPlan.json` (JSON)

### M2. **Scaffold Generator**

* **Input**: `DocPlan.json`
* **Output**: `Scaffold.json`

### M3. **Section Generator (loop per section)**

* **Input**: `DocPlan.json`, `Scaffold.sections[i]`, `RunningState.json`
* **Output**: `SectionDocJSON.json` (interleaved prose + assets with IDs)

### M4. **Assembler**

* **Input**: all `SectionDocJSON` chunks
* **Output**:

  * `chapters/<slug>.json` (final **DocJSON** file for Reader)
  * `plots/*.json` (PlotSpec files referenced by DocJSON)
  * `diagrams/*.json` (DiagramSpec files referenced by DocJSON)

> The **Reader** then builds `rendered/chapter.json` and assets per its pipeline.&#x20;

---

## 2) Global ID & File Conventions

* **Chapter slug**: kebab-case of title (e.g., `laws-of-motion`)
* **Section IDs**: `sec-1`, `sec-2`, …
* **Equation IDs**: `eq-...`, **Figures/Diagrams**: `fig-...`, **Plots**: `plot-...`, **Widgets**: `wid-...`, **Exercises**: `ex-...`
* **Spec files**:

  * PlotSpec: `plots/<chapter-slug>/<plot-id>.json`
  * DiagramSpec: `diagrams/<chapter-slug>/<diagram-id>.json`

---

## 3) JSON Schemas

> Minimal, opinionated, and strict (`additionalProperties:false`). Extend if you need more fields; keep the core stable.

### 3.1 DocPlan schema (`schemas/docplan.schema.json`)

```json
{
  "$id": "docplan.schema.json",
  "type": "object",
  "properties": {
    "meta": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "subject": {"enum": ["Physics","Chemistry","Mathematics"]},
        "grade": {"type": "string"},
        "difficulty": {"enum": ["comfort","hustle","advanced"]}
      },
      "required": ["title","subject","grade","difficulty"],
      "additionalProperties": false
    },
    "learning_objectives": {"type": "array", "items": {"type": "string"}, "minItems": 3},
    "beats": {
      "type": "array",
      "minItems": 6,
      "maxItems": 12,
      "items": {
        "type": "object",
        "properties": {
          "id": {"type":"string", "pattern":"^beat-[a-z0-9-]+$"},
          "headline": {"type":"string"},
          "prereqs": {"type":"array","items":{"type":"string"}},
          "outcomes": {"type":"array","items":{"type":"string"}, "minItems": 1},
          "assets_suggested": {
            "type":"array",
            "items":{"type":"string", "pattern":"^(eq|plot|diagram|widget|chem):[a-z0-9_-]+$"}
          }
        },
        "required": ["id","headline","prereqs","outcomes","assets_suggested"],
        "additionalProperties": false
      }
    },
    "glossary_seed": {"type":"array","items":{"type":"string"}},
    "misconceptions": {"type":"array","items":{"type":"string"}},
    "assessment_outline": {"type":"array","items":{"type":"string"}}
  },
  "required": ["meta","learning_objectives","beats"],
  "additionalProperties": false
}
```

### 3.2 Scaffold schema (`schemas/scaffold.schema.json`)

```json
{
  "$id": "scaffold.schema.json",
  "type": "object",
  "properties": {
    "sections": {
      "type": "array",
      "minItems": 5,
      "maxItems": 9,
      "items": {
        "type": "object",
        "properties": {
          "id": {"type":"string","pattern":"^sec-[0-9]+$"},
          "title": {"type":"string"},
          "beats": {"type":"array","items":{"type":"string","pattern":"^beat-[a-z0-9-]+$"}, "minItems": 1},
          "intro_hook": {"type":"string"},
          "concept_sequence": {"type":"array","items":{"type":"string"}, "minItems": 1},
          "where_assets_go": {
            "type":"array",
            "items":{"type":"string","pattern":"^\\{\\{(eq|plot|diagram|widget|chem):[a-z0-9_-]+\\}\\}$"}
          },
          "transitions": {
            "type":"object",
            "properties": {"in":{"type":"string"}, "out":{"type":"string"}},
            "required": ["in","out"],
            "additionalProperties": false
          },
          "dependencies": {"type":"array","items":{"type":"string"}}
        },
        "required": ["id","title","beats","intro_hook","concept_sequence","where_assets_go","transitions"],
        "additionalProperties": false
      }
    }
  },
  "required": ["sections"],
  "additionalProperties": false
}
```

### 3.3 RunningState schema (`schemas/runningstate.schema.json`)

```json
{
  "$id": "runningstate.schema.json",
  "type": "object",
  "properties": {
    "recap_150w": {"type":"string", "maxLength": 1200},
    "introduced_terms": {"type":"array","items":{"type":"string"}},
    "used_assets": {
      "type":"array",
      "items":{"type":"object",
        "properties":{"id":{"type":"string"}, "type":{"enum":["eq","plot","diagram","widget","chem"]}},
        "required":["id","type"],
        "additionalProperties": false
      }
    },
    "open_threads": {"type":"array","items":{"type":"string"}},
    "style_guard": {
      "type":"object",
      "properties": {"difficulty":{"enum":["comfort","hustle","advanced"]}, "tone":{"type":"string"}},
      "required": ["difficulty"],
      "additionalProperties": false
    }
  },
  "required": ["recap_150w","style_guard"],
  "additionalProperties": false
}
```

### 3.4 SectionDocJSON schema (`schemas/sectiondoc.schema.json`)

```json
{
  "$id": "sectiondoc.schema.json",
  "type": "object",
  "properties": {
    "meta": {
      "type":"object",
      "properties": {
        "chapterId":{"type":"string"},
        "sectionId":{"type":"string","pattern":"^sec-[0-9]+$"}
      },
      "required":["chapterId","sectionId"],
      "additionalProperties": false
    },
    "sections": {
      "type":"array",
      "items": {
        "type":"object",
        "properties": {
          "id":{"type":"string"},
          "type":{"enum":["paragraph","equation","plot","chem","diagram","widget","exercise"]},
          "md":{"type":"string"},
          "tex":{"type":"string"},
          "specRef":{"type":"string"}, 
          "spec":{"type":"object"},
          "check": {
            "type":"object",
            "properties": {
              "expr":{"type":"string"},
              "vars":{"type":"object"},
              "expect":{"type":"number"},
              "tol":{"type":"number"}
            },
            "required":["expr","vars","expect","tol"],
            "additionalProperties": false
          }
        },
        "required": ["id","type"],
        "additionalProperties": false
      }
    }
  },
  "required": ["meta","sections"],
  "additionalProperties": false
}
```

### 3.5 Final DocJSON schema (Chapter file for Reader)

`schemas/docjson_final.schema.json` — **aligns with your Reader’s expectations** (types + refs).&#x20;

```json
{
  "$id": "docjson_final.schema.json",
  "type": "object",
  "properties": {
    "meta": {
      "type":"object",
      "properties":{
        "title":{"type":"string"},
        "subject":{"enum":["Physics","Chemistry","Mathematics"]},
        "grade":{"type":"string"},
        "difficulty":{"enum":["comfort","hustle","advanced"]},
        "chapterId":{"type":"string"}
      },
      "required":["title","subject","grade","difficulty","chapterId"],
      "additionalProperties": false
    },
    "sections": {
      "type":"array",
      "items": {
        "type":"object",
        "properties":{
          "id":{"type":"string"},
          "type":{"enum":["paragraph","equation","plot","chem","diagram","widget","exercise"]},
          "md":{"type":"string"},
          "tex":{"type":"string"},
          "specRef":{"type":"string"},
          "spec":{"type":"object"},
          "check":{
            "type":"object",
            "properties":{"expr":{"type":"string"},"vars":{"type":"object"},"expect":{"type":"number"},"tol":{"type":"number"}},
            "required":["expr","vars","expect","tol"],
            "additionalProperties": false
          }
        },
        "required":["id","type"],
        "additionalProperties": false
      }
    }
  },
  "required": ["meta","sections"],
  "additionalProperties": false
}
```

### 3.6 Asset mini-schemas

**PlotSpec** (`schemas/plotspec.schema.json`)

```json
{
  "$id": "plotspec.schema.json",
  "type": "object",
  "properties": {
    "kind": {"const":"pgfplot"},
    "title": {"type":"string"},
    "x": {"type":"object","properties":{"min":{"type":"number"},"max":{"type":"number"},"ticks":{"type":"integer"},"label":{"type":"string"}}, "required":["min","max","label"], "additionalProperties": false},
    "y": {"type":"object","properties":{"min":{"type":"number"},"max":{"type":"number"},"ticks":{"type":"integer"},"label":{"type":"string"}}, "required":["min","max","label"], "additionalProperties": false},
    "expr": {"type":"string"},
    "params": {"type":"object"},
    "style": {"type":"object","properties":{"grid":{"type":"boolean"},"samples":{"type":"integer","minimum": 16, "maximum": 2048}}, "additionalProperties": false}
  },
  "required": ["kind","x","y","expr"],
  "additionalProperties": false
}
```

**DiagramSpec** (`schemas/diagramspec.schema.json`)

```json
{
  "$id": "diagramspec.schema.json",
  "type": "object",
  "properties": {
    "canvas":{"type":"object","properties":{"width":{"type":"integer"},"height":{"type":"integer"},"grid":{"type":"integer"},"snap":{"type":"boolean"}}, "required":["width","height","grid","snap"], "additionalProperties": false},
    "nodes":{"type":"array","items":{"type":"object"}},
    "edges":{"type":"array","items":{"type":"object"}},
    "labels":{"type":"array","items":{"type":"object"}},
    "rules":{"type":"object"}
  },
  "required": ["canvas"],
  "additionalProperties": false
}
```

**WidgetSpec** (`schemas/widgetspec.schema.json`)

```json
{
  "$id": "widgetspec.schema.json",
  "type":"object",
  "properties":{
    "kind":{"const":"formula-playground"},
    "expr":{"type":"string"},
    "params":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"min":{"type":"number"},"max":{"type":"number"},"step":{"type":"number"},"default":{"type":"number"}}, "required":["name","min","max","step","default"], "additionalProperties": false}},
    "display":{"type":"object","properties":{"latex":{"type":"string"}},"additionalProperties": false}
  },
  "required":["kind","expr","params"],
  "additionalProperties": false
}
```

**ChemSpec (inline)**
In **DocJSON** `sections[]` of `type:"chem"`, store **SMILES** as `md:"CCO"` or `spec:{ "smiles":"CCO" }` (your Reader’s RDKit service converts to SVG).&#x20;

---

## 4) Validator & Repair FSM

**States:** `S0 Plan → S1 Scaffold → S2 Section(i) → S3 Assemble` (publish only if all green)

**Per-step gates & repairs**

| Step     | Validation                                                                                                                      | Repair Strategy                                                    | Max Attempts |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -----------: |
| Plan     | AJV(docplan), beat ordering                                                                                                     | Re-emit invalid subtree w/ AJV error context                       |            2 |
| Scaffold | AJV(scaffold), markers reference beats                                                                                          | Re-emit section(s) with corrected markers                          |            2 |
| Section  | AJV(sectiondoc), KaTeX parse, numeric check, units (optional), lexer on Plot expr, RDKit SMILES parse, Diagram topology/overlap | Typed repair for failing asset only (eq/plot/chem/diagram subnode) |            2 |
| Assemble | AJV(docjson\_final), cross-ref IDs unique                                                                                       | If conflict, rename `-2`, update refs; else fail                   |            1 |

**Error codes** (prefix `E-LLM-…`)

* `E-LLM-SCHEMA-DOCPLAN`, `E-LLM-SCHEMA-SCAFFOLD`, `E-LLM-SCHEMA-SECTION`, `E-LLM-SCHEMA-FINAL`
* `E-LLM-MATH-PARSE`, `E-LLM-MATH-NUMERIC`, `E-LLM-MATH-UNITS`
* `E-LLM-PLOT-LEX`, `E-LLM-PLOT-COMPILE`
* `E-LLM-CHEM-RDKIT`
* `E-LLM-DIAGRAM-TOPOLOGY`, `E-LLM-DIAGRAM-OVERLAP`
* `E-LLM-A11Y-MISSING` (optional), `E-LLM-SANITIZER` (geometry changed)

**Outputs per step**

* `ValidationReport.json` (per module)
* `CorrectionLog.json` (diffs with timestamps)
* Content hashes for caching

---

## 5) Prompts (YAML, API-ready)

> These are **inputs** to the LLM engine. They only affect M1–M3 (planning & generation). The **assembler’s** output must match the **Final DocJSON schema** above.

### 5.1 Plan (M1)

```yaml
model: gpt-5-mini
temperature: 0.1
messages:
  - role: system
    content: |
      Output JSON only, validating against docplan.schema.json. No extra text.
      Use the attached NCERT PDF strictly for scope. Difficulty mode: {{difficulty}}.
  - role: user
    content: |
      Metadata:
      title: "{{chapter_name}}"
      subject: "{{subject}}"
      grade: "{{class}}"
      difficulty: "{{difficulty}}"
      Attachment: {{pdf_url}}
      Task: produce a DocPlan with 6–10 beats, clear objectives, misconceptions, and assessment outline.
```

### 5.2 Scaffold (M2)

```yaml
model: gpt-5-mini
temperature: 0.1
messages:
  - role: system
    content: |
      Output JSON only, validating against scaffold.schema.json. No extra text.
      Each section merges 1–2 beats, includes asset markers in narrative order, and has transitions in/out.
  - role: user
    content: |
      DocPlan:
      {{docplan_json}}
      Constraint: 5–8 sections. Keep within chapter scope from the PDF.
```

### 5.3 Section (M3, repeated per section)

```yaml
model: gpt-5-mini
temperature: 0.1
messages:
  - role: system
    content: |
      Output JSON only, validating against sectiondoc.schema.json. No extra text.
      Equations must compile in KaTeX, plots as PlotSpec JSON, chem as SMILES, diagrams as DiagramSpec, widgets as WidgetSpec.
  - role: user
    content: |
      Global plan:
      {{docplan_json}}

      Scaffold section:
      {{scaffold_section_json}}

      Running state:
      {{running_state_json}}

      Task:
      Generate interleaved prose and assets at marker positions. Keep tone and difficulty consistent.
```

---

## 6) Assembly → Reader Inputs

**Assembler writes**:

* `chapters/<chapter-slug>.json` (**Final DocJSON**) — the **only** file your Reader needs to ingest as a chapter input
* `plots/<chapter-slug>/*.json` (**PlotSpec JSONs**) referenced by the chapter
* `diagrams/<chapter-slug>/*.json` (**DiagramSpec JSONs**) referenced by the chapter

> This aligns with your Reader’s expectations and build scripts to produce `rendered/chapter.json`.&#x20;

---

## 7) Minimal Examples (ready to drop)

**DocPlan (excerpt)**

```json
{
  "meta":{"title":"Laws of Motion","subject":"Physics","grade":"Class XI","difficulty":"hustle"},
  "learning_objectives":["Define net force","Apply Newton's laws","Construct free-body diagrams"],
  "beats":[
    {"id":"beat-intro","headline":"Intuition for forces","prereqs":[],"outcomes":["force intuition"],"assets_suggested":["diagram:fbd1"]},
    {"id":"beat-n2","headline":"Newton's 2nd law","prereqs":["beat-intro"],"outcomes":["F=ma"],"assets_suggested":["eq:n2","widget:force_mass_acc"]}
  ],
  "glossary_seed":["force","mass","acceleration"],
  "misconceptions":["mass vs weight"],
  "assessment_outline":["concept checks","numerical problems"]
}
```

**Scaffold (excerpt)**

```json
{
  "sections":[
    {
      "id":"sec-1",
      "title":"From Intuition to Net Force",
      "beats":["beat-intro"],
      "intro_hook":"Pushing a stalled car…",
      "concept_sequence":["Everyday forces","Direction matters","Netting forces"],
      "where_assets_go":["{{diagram:fbd1}}"],
      "transitions":{"in":"","out":"We can now formalize this with Newton's laws."},
      "dependencies":[]
    }
  ]
}
```

**SectionDocJSON (excerpt)**

```json
{
  "meta":{"chapterId":"laws-of-motion","sectionId":"sec-1"},
  "sections":[
    {"id":"p1","type":"paragraph","md":"When several pushes act ..."},
    {"id":"fig-fbd1","type":"diagram","specRef":"diagrams/laws-of-motion/fig-fbd1.json"},
    {"id":"p2","type":"paragraph","md":"The net force is the vector sum ..."}
  ]
}
```

**PlotSpec (excerpt)**

```json
{
  "kind":"pgfplot",
  "title":"Uniform acceleration s(t)",
  "x":{"min":0,"max":10,"ticks":6,"label":"$t$"},
  "y":{"min":0,"max":200,"ticks":6,"label":"$s$"},
  "expr":"u*x + 0.5*a*x^2",
  "params":{"u":5,"a":2},
  "style":{"grid":true,"samples":201}
}
```

**DiagramSpec (excerpt)**

```json
{
  "canvas":{"width":480,"height":280,"grid":8,"snap":true},
  "nodes":[
    {"id":"O","kind":"point","x":60,"y":220,"label":"O"},
    {"id":"v","kind":"arrow","from":[60,220],"to":[240,140],"label":"v"},
    {"id":"w","kind":"arrow","from":[60,220],"to":[380,220],"label":"w"}
  ],
  "labels":[{"of":"v","pos":"mid","text":"θ","dx":-10,"dy":-10}],
  "rules":{"requiredNodes":["O","v","w"],"forbidEdgeCrossings":true}
}
```

**WidgetSpec (excerpt)**

```json
{
  "kind":"formula-playground",
  "expr":"u + a*t",
  "params":[
    {"name":"u","min":0,"max":20,"step":1,"default":5},
    {"name":"a","min":-10,"max":10,"step":0.5,"default":2},
    {"name":"t","min":0,"max":10,"step":0.1,"default":3}
  ],
  "display":{"latex":"v=u+at"}
}
```

---

## 8) Test & Monitoring Checklist

* **Schema validation (AJV)** against all five schemas
* **Math checks**: KaTeX parse, `|f(vars)-expect|≤tol`, (optional) units
* **Plot checks**: expr lexer allowlist; PGFPlots compile success (in Reader build)&#x20;
* **Chem checks**: SMILES parse via RDKit (in Reader build)&#x20;
* **Diagram checks**: topology, grid-snap, label-overlap solver
* **A11y** (optional): `<title>/<desc>` presence in compiled SVGs
* **Repair loop** (typed, bounded) per failing subtree
* **CorrectionLog** and **content hashes** for caching
* **Golden render**: SSIM ≥ 0.99 for key plots/diagrams vs stored PNGs (optional)

---

## 9) Engine API (optional façade)

**POST** `/generate/plan` → `DocPlan.json`
**POST** `/generate/scaffold` → `Scaffold.json`
**POST** `/generate/section` → `SectionDocJSON.json`
**POST** `/assemble` → writes `chapters/<slug>.json`, `plots/...`, `diagrams/...`

Each returns `{ ok: true, artifact_url, validation_report_url }` (or `{ ok:false, code, details }` with the error codes above).

---

## 10) Final Notes

* Keep **DocPlan** and **Scaffold** in the LLM context for all **Section** calls; they’re small and ensure continuity.
* Your **Reader** stays unchanged—this engine’s **final output** is exactly the **chapter DocJSON + PlotSpec + DiagramSpec** files your build expects.&#x20;
* You can start single-shot (whole chapter), then move to **section-by-section** once you want better retries/caching.

If you want, I can bundle these schemas into actual files (`schemas/*.schema.json`) and a tiny **TypeScript validator** stub (`validate.ts`) you can drop into your repo to run AJV + per-asset checks.

---

## 11) Enhanced Architecture for True Lego-Brick Modularity

> **Extends Section 1** with additional patterns to ensure each module can be developed, tested, deployed, and refactored independently without cascading changes to other modules.

### 11.1 Current Modularity Assessment

The base architecture already provides:
- ✅ **Well-defined I/O contracts** per module
- ✅ **Schema validation at boundaries**
- ✅ **Module-specific error codes**
- ✅ **Stateless operations** (except M3's RunningState)

Areas for enhancement:
- ⚠️ **M3 multi-dependency coupling** (DocPlan + Scaffold + RunningState)
- ⚠️ **Shared schema dependencies** across modules
- ⚠️ **No version negotiation** mechanism

### 11.2 Schema Versioning & Metadata Envelope

Wrap all module outputs in a versioned envelope:

```json
{
  "envelope": {
    "version": "1.0.0",
    "producer": "M1-PlanGenerator",
    "timestamp": "2024-01-20T10:00:00Z",
    "correlationId": "ch-abc123",
    "contentHash": "sha256:def456...",
    "compatible": ["1.0.0", "1.1.0"]
  },
  "payload": {
    /* actual DocPlan/Scaffold/SectionDocJSON content */
  }
}
```

**Benefits:**
- Modules can check version compatibility before processing
- Correlation IDs enable distributed tracing
- Content hashes enable intelligent caching
- Backward compatibility declarations

### 11.3 Decoupled M3 Input Contract

Instead of M3 requiring full DocPlan + Scaffold objects, create a **SectionContext** adapter:

```json
{
  "envelope": { /* ... */ },
  "payload": {
    "context": {
      "chapterId": "laws-of-motion",
      "sectionId": "sec-1",
      "sectionTitle": "Forces and Motion",
      "difficulty": "hustle",
      "subject": "Physics",
      "assetMarkers": [
        "{{eq:newton_second_law}}",
        "{{plot:force_acceleration}}",
        "{{diagram:free_body}}"
      ],
      "transitions": {
        "in": "We've seen forces in everyday life...",
        "out": "Now we'll formalize this with equations."
      },
      "conceptSequence": ["Force intuition", "Vector addition", "Net force"]
    },
    "runningState": { /* ... */ }
  }
}
```

**Benefits:**
- M3 only depends on **SectionContext** schema, not DocPlan/Scaffold schemas
- M2 (Scaffold) can change its internal structure without affecting M3
- Easier to unit test M3 with mock contexts

### 11.4 Module Adapter Interface Pattern

Define a standard interface for module adapters:

```typescript
interface ModuleAdapter<TInput, TOutput> {
  name: string;
  version: string;

  canHandle(envelope: Envelope<TInput>): boolean;
  transform(input: Envelope<TInput>): Promise<Envelope<TOutput>>;
  validate(output: Envelope<TOutput>): ValidationResult;

  // Optional: version migration
  migrate?(from: string, to: string, data: any): any;
}

// Example usage
class ScaffoldToContextAdapter implements ModuleAdapter<Scaffold, SectionContext> {
  canHandle(envelope: Envelope<Scaffold>): boolean {
    return envelope.envelope.version.startsWith("1.");
  }

  async transform(input: Envelope<Scaffold>): Promise<Envelope<SectionContext>> {
    // Convert Scaffold.sections[i] → SectionContext
    // Only extract fields M3 actually needs
  }
}
```

### 11.5 Message Passing Architecture

Replace direct function calls with message passing:

```typescript
interface ModuleMessage<T> {
  header: {
    source: string;          // "M2-Scaffold"
    target: string;          // "M3-Section"
    messageType: string;     // "GENERATE_SECTION"
    correlationId: string;   // "ch-abc123"
    version: string;         // "1.0.0"
    timestamp: string;
  };
  payload: T;
}

// Module M2 publishes
const scaffoldMessage: ModuleMessage<Scaffold> = {
  header: { source: "M2-Scaffold", target: "M3-Section", ... },
  payload: scaffoldData
};

// Module M3 subscribes
class SectionGenerator {
  async handleMessage(msg: ModuleMessage<SectionContext>) {
    if (!this.canHandle(msg.header.version)) {
      throw new IncompatibleVersionError();
    }
    // Process message...
  }
}
```

### 11.6 Contract Testing Framework

Each module should have contract tests that verify integration points:

```typescript
// M3 contract test
describe("M3 Section Generator Contract", () => {
  it("should handle SectionContext v1.0.0", () => {
    const mockContext = createMockSectionContext("1.0.0");
    const result = sectionGenerator.transform(mockContext);
    expect(result).toMatchSchema("sectiondoc.schema.json");
  });

  it("should reject incompatible versions", () => {
    const futureContext = createMockSectionContext("2.0.0");
    expect(() => sectionGenerator.canHandle(futureContext)).toBe(false);
  });
});

// M2 → M3 integration contract test
describe("M2-M3 Integration Contract", () => {
  it("should transform Scaffold to SectionContext correctly", () => {
    const scaffold = loadFixture("sample-scaffold.json");
    const adapter = new ScaffoldToContextAdapter();
    const context = adapter.transform(scaffold);

    // Verify M3 can process the output
    expect(sectionGenerator.canHandle(context)).toBe(true);
  });
});
```

### 11.7 Module Ownership & Independence Matrix

| Module | Owns | Publishes | Subscribes | Can Change Without Affecting |
|--------|------|-----------|------------|------------------------------|
| **M1** | DocPlan schema, planning logic | `DocPlan.json v1.0.0` | `PlanRequest v1.0.0` | M3, M4 (M2 uses adapter) |
| **M2** | Scaffold schema, section logic | `Scaffold.json v1.0.0`<br/>`SectionContext.json v1.0.0` | `DocPlan.json v1.x.x` | M3, M4 (via SectionContext) |
| **M3** | SectionDocJSON schema, content logic | `SectionDocJSON.json v1.0.0` | `SectionContext.json v1.x.x`<br/>`RunningState.json v1.x.x` | M1, M2, M4 |
| **M4** | Assembly logic, file organization | Final Reader files | `SectionDocJSON.json v1.x.x` | M1, M2, M3 |

### 11.8 Enhanced Error Handling with Module Isolation

Extend error codes to include module boundaries:

```typescript
// Module-specific error types
type ModuleError =
  | { code: "E-M1-SCHEMA-DOCPLAN", module: "M1", data: AjvError[] }
  | { code: "E-M2-SCAFFOLD-BEATS", module: "M2", data: { invalidBeats: string[] } }
  | { code: "E-M3-CONTENT-KATEX", module: "M3", data: { equation: string, error: string } }
  | { code: "E-M4-ASSEMBLY-REFS", module: "M4", data: { duplicateIds: string[] } }
  | { code: "E-ADAPTER-VERSION", module: "ADAPTER", data: { expected: string, got: string } };

// Error isolation: failure in M2 doesn't crash M1's output
class ModulePipeline {
  async execute(request: PlanRequest): Promise<Result<FinalOutputs, ModuleError[]>> {
    const errors: ModuleError[] = [];

    // M1: Always succeeds or fails cleanly
    const planResult = await M1.execute(request);
    if (planResult.isError()) {
      errors.push(planResult.error);
      return Err(errors); // Stop pipeline
    }

    // M2: Uses adapter, isolates failures
    try {
      const scaffoldResult = await M2.execute(planResult.value);
      // Continue with M3, M4...
    } catch (adapterError) {
      errors.push({ code: "E-ADAPTER-VERSION", module: "ADAPTER", data: adapterError });
      // Could retry with different adapter or graceful degradation
    }
  }
}
```

### 11.9 Development & Deployment Independence

**Development workflow:**
1. **Unit tests**: Each module tested in isolation with mocks
2. **Contract tests**: Verify module interfaces work together
3. **Integration tests**: End-to-end pipeline tests
4. **Canary deployment**: Deploy one module at a time

**Module deployment strategy:**
```yaml
# Module versions can be deployed independently
services:
  m1-plan-generator:
    image: content-engine/m1:v1.2.0
    environment:
      - SCHEMA_VERSION=1.0.0

  m2-scaffold-generator:
    image: content-engine/m2:v1.1.5
    environment:
      - ACCEPTS_DOCPLAN_VERSIONS=1.0.0,1.1.0
      - PRODUCES_CONTEXT_VERSION=1.0.0

  m3-section-generator:
    image: content-engine/m3:v1.3.0
    environment:
      - ACCEPTS_CONTEXT_VERSIONS=1.0.0
```

### 11.10 Backward Compatibility Strategy

**Schema evolution rules:**
- **Additive changes**: New optional fields (PATCH version bump)
- **Compatible changes**: Relaxed validation (MINOR version bump)
- **Breaking changes**: Required field changes (MAJOR version bump)

**Migration example:**
```typescript
// DocPlan v1.0.0 → v1.1.0 adds optional "tags" field
class DocPlanMigrator {
  migrate(from: "1.0.0", to: "1.1.0", data: DocPlanV1): DocPlanV1_1 {
    return {
      ...data,
      tags: [] // Sensible default for new optional field
    };
  }
}

// Modules declare compatibility ranges
const M2_COMPAT = {
  accepts: { docplan: "^1.0.0" },  // Accepts 1.0.0, 1.1.0, 1.2.0 etc.
  produces: { scaffold: "1.0.0" }
};
```

### 11.11 Benefits Summary

This enhanced architecture provides:

1. **True independence**: Modules can be developed, tested, and deployed separately
2. **Version safety**: Compatibility checks prevent runtime failures
3. **Easier debugging**: Correlation IDs and module isolation
4. **Graceful evolution**: Schema versioning and migration support
5. **Better testing**: Contract tests verify integration points
6. **Operational visibility**: Module-specific metrics and error tracking

The modules become true "Lego bricks" that can be:
- ✅ **Swapped**: Replace M3 with a different content generator
- ✅ **Upgraded**: Deploy M2 v1.2.0 without touching M1 or M3
- ✅ **Extended**: Add new fields to schemas without breaking existing modules
- ✅ **Tested**: Isolated unit tests + integration contract tests
- ✅ **Debugged**: Module-specific error codes and tracing


## 12. Further Improvement Suggestions:
\[#content-engine-review-v3]

### 12.1) Short verdict

i) **Yes—this revision is materially better.** You’ve moved from “prompt choreography” to **contract-first modules** with **strict schemas** and a **validator/repair FSM**, which is exactly what keeps automated pipelines stable and refactorable.&#x20;
ii) With **DocPlan → Scaffold → Section → Assemble** plus **PlotSpec/DiagramSpec/WidgetSpec/ChemSpec** minis, your LLM is boxed into producible, testable artifacts that your Reader can consume unchanged.&#x20;
iii) A few sharp edges remain; below I’d lock them down.

---

### 12.2) What’s unequivocally right (keep as-is)

|  # | Win                                                    | Why it matters                                              | Where it lives                                             |
| -: | ------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------- |
|  1 | **Strict JSON Schemas** (`additionalProperties:false`) | Prevents drift & “surprise fields” during refactors         | DocPlan/Scaffold/Section/Final schemas                     |
|  2 | **Mini-specs for assets** (Plot/Diagram/Widget)        | Keeps TikZ/PGFPlots, diagrams, and widgets deterministic    | Mini-schemas section                                       |
|  3 | **Assembler writes Reader-native files**               | Decouples content engine from renderer; cleaner deployments | Assembler outputs (`chapters/…`, `plots/…`, `diagrams/…`)  |
|  4 | **Validator & Repair FSM** w/ error codes              | Typed, bounded repair loops; great for CI and telemetry     | FSM + codes table                                          |
|  5 | **ID/file conventions**                                | Stable anchors for highlights, cross-refs, caching          | Global conventions section                                 |

---

### 12.3) Critical improvements I’d add now (surgical, high ROI)

1. **Versioned envelopes at module boundaries.** Wrap every module output with `{envelope{version, producer, correlationId, contentHash}, payload{…}}`. This lets you evolve schemas without lock-step refactors and enables cache correctness by hash. (You hinted modularity; formalize it.)

2. **SectionContext adapter (M2→M3).** Don’t feed the full DocPlan+Scaffold into M3. Publish a **minimal SectionContext** (title, asset markers, transitions, difficulty, subject) so M3’s contract survives Scaffold redesigns. (You can still keep RunningState for continuity.)

3. **Schema compatibility rules.** Document:

   * Patch = optional field add; Minor = relaxed constraints; Major = required/shape change.
   * Modules must declare `accepts ^x.y.z` and `produces a.b.c`. Fail fast on mismatch.

4. **Deterministic caching keys** for compilers. Cache TikZ/PGFPlots, RDKit, and DiagramSpec by **SHA256(spec + templateVersion)**. This will keep build latency sub-second for repeated chapters.

5. **No silent auto-fix.** Your FSM lists repairs; ensure every change writes a **CorrectionLog.json** diff and re-validates before proceed (you already list outputs; make the assembler fail if a repair wasn’t re-validated).&#x20;

6. **Unicode & token sanitation.** Add an input-normalization pass (NFC, strip zero-width/homoglyphs) and lexers for `expr` fields (allowlist operators/symbols). This reduces weird compile bugs that sneak past schemas.

---

### 12.4) Folder naming: should you prefix with “CG\_…”?

#### 12.4.1 My rule of thumb

i) **Prefer domain-based, readable namespaces** over opaque prefixes.
ii) Use **module codes** *inside* the package name (e.g., `content-engine.m1-plan`) rather than top-level abbreviations.

#### 12.4.2 Options compared

| Option                       | Example                                                 | Pros                                        | Cons                                                 | My call                    |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| A) Prefix folders with `CG_` | `CG_M1_Plan`, `CG_M3_Section`                           | Visually groups “content generator”         | Cryptic; collides with IDE sorting; not web-friendly | **No**                     |
| B) Domain + module code      | `content-engine/m1-plan`, `content-engine/m3-section`   | Self-explanatory; scales; great for tooling | Slightly longer paths                                | **Yes**                    |
| C) Service-style             | `services/plan-generator`, `services/section-generator` | Clear in microservices                      | Loses the coherent “engine” grouping                 | Maybe (if splitting repos) |

**Recommendation:** adopt **B**.

---

### 12.5) Suggested monorepo layout (refactor-friendly)

```
/content-engine/
  /m1-plan/
    schemas/docplan.schema.json
    src/index.ts
    tests/contract.spec.ts
  /m2-scaffold/
    schemas/scaffold.schema.json
    src/index.ts
    tests/contract.spec.ts
  /m3-section/
    schemas/sectiondoc.schema.json
    src/index.ts
    tests/contract.spec.ts
  /m4-assemble/
    schemas/docjson_final.schema.json
    src/index.ts
    tests/assembler.spec.ts
  /adapters/
    scaffold-to-sectioncontext.ts         # M2 → M3 adapter
  /schemas-shared/
    plotspec.schema.json
    diagramspec.schema.json
    widgetspec.schema.json
  /compilers/
    pgfplots/ (tectonic+dvisvgm wrapper; cache by SHA256)
    rdkit/ (SMILES→SVG)
    diagram/ (deterministic JSON→SVG)
  /validators/
    ajv.ts
    expr-lexer.ts
    units.ts
    unicode-normalize.ts
  /fsm/
    validate-and-repair.ts                # state machine
  /artifacts/
    chapters/
    plots/
    diagrams/
    reports/ (ValidationReport.json, CorrectionLog.json)
```

This directly mirrors the **module & schema boundaries** you defined, so refactors don’t ripple.&#x20;

---

### 12.6) Integration gates (concrete, minimal)

| Gate | Check                                  | Fail condition                                   |                |         |
| ---: | -------------------------------------- | ------------------------------------------------ | -------------- | ------- |
|   G1 | **AJV** DocPlan/Scaffold/Section/Final | Any `additionalProperties` or missing `required` |                |         |
|   G2 | **KaTeX parse** + **numeric check**    | Parse error or \`                                | f(vars)-expect | > tol\` |
|   G3 | **PlotSpec lexer** + PGFPlots compile  | Disallowed token or compile fail                 |                |         |
|   G4 | **RDKit** SMILES parse                 | Canonicalization/parse fail                      |                |         |
|   G5 | **Diagram topology/overlap**           | Missing required nodes or unresolved overlaps    |                |         |
|   G6 | **SVG sanitizer**                      | Disallowed element/attribute; geometry diff      |                |         |
|   G7 | **Cross-ref uniq**                     | Duplicate IDs in Assemble step                   |                |         |

You’ve already enumerated most of these in the FSM—keep them as **blocking**.&#x20;

---

### 12.7) Final, opinionated answers

1. **Is this design better?**
   **Yes.** It’s contract-driven, modular, and testable; it aligns the generator with the Reader’s inputs and uses typed repair loops. Lock in versioned envelopes + SectionContext, and you’re production-ready in spirit.&#x20;

2. **Use `CG_` prefixes?**
   **No.** Prefer `content-engine/m{1..4}-<verb>` (readable, scales, grep-able). Reserve prefixes for **code** (e.g., error codes `E-LLM-…`)—which you already do well.&#x20;

If you want, I can emit **starter files** for the folder tree above (schemas + tiny AJV validator + FSM stub) so your team can drop them in and run contract tests immediately.
