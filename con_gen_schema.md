# LLM Content Engine — Production-Ready Architecture (v2.0)

*Integrated architecture combining all critical improvements from modular design analysis and external review*

---

## Overview

This specification defines a production-ready LLM content generation engine with true Lego-brick modularity. It incorporates:

* **Versioned message envelopes** for schema evolution
* **Decoupled module boundaries** with adapter patterns
* **Deterministic caching** and content hashing
* **Comprehensive validation gates** with typed error handling
* **Contract-first development** enabling independent module evolution

**Key Principles:**
- Modules communicate via versioned message contracts
- Each module owns its schema and can evolve independently
- All artifacts are content-addressed for caching
- Validation failures are typed and repairable
- Output exactly matches Reader's input expectations

---

## 1) Architecture Overview

### 1.1 Enhanced Module Pipeline

```
PlanRequest → [M1] → DocPlan.v1 → [M2] → Scaffold.v1
                                            ↓
SectionContext.v1 ← [Adapter] ← Scaffold.v1
                                            ↓
SectionContext.v1 → [M3] → SectionDoc.v1 → [M4] → Final Outputs
```

### 1.2 Module Independence Matrix

| Module | Input Contract | Output Contract | Can Change Without Affecting |
|--------|---------------|-----------------|------------------------------|
| **M1-Plan** | `PlanRequest.v1` | `DocPlan.v1` | M3, M4 (M2 uses adapter if needed) |
| **M2-Scaffold** | `DocPlan.v1.x` | `Scaffold.v1 + SectionContext.v1` | M3, M4 (via SectionContext) |
| **M3-Section** | `SectionContext.v1.x + RunningState.v1.x` | `SectionDoc.v1` | M1, M2, M4 |
| **M4-Assembler** | `SectionDoc.v1.x[]` | Reader-compatible files | M1, M2, M3 |

### 1.3 Message Envelope Standard

All inter-module communication uses versioned envelopes:

```json
{
  "envelope": {
    "version": "1.0.0",
    "producer": "M1-PlanGenerator",
    "timestamp": "2024-01-20T10:00:00Z",
    "correlationId": "ch-abc123",
    "contentHash": "sha256:def456789...",
    "compatible": ["1.0.0", "1.1.0"]
  },
  "payload": {
    /* module-specific data */
  }
}
```

---

## 2) Core Schemas with Versioning

### 2.1 DocPlan Schema v1.0 (`content-engine/m1-plan/schemas/docplan.v1.schema.json`)

```json
{
  "$id": "docplan.v1.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "envelope": {
      "type": "object",
      "properties": {
        "version": {"type": "string", "pattern": "^1\\.[0-9]+\\.[0-9]+$"},
        "producer": {"const": "M1-PlanGenerator"},
        "timestamp": {"type": "string", "format": "date-time"},
        "correlationId": {"type": "string"},
        "contentHash": {"type": "string", "pattern": "^sha256:[a-f0-9]{64}$"},
        "compatible": {"type": "array", "items": {"type": "string"}}
      },
      "required": ["version", "producer", "timestamp", "correlationId", "contentHash"],
      "additionalProperties": false
    },
    "payload": {
      "type": "object",
      "properties": {
        "meta": {
          "type": "object",
          "properties": {
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "subject": {"enum": ["Physics", "Chemistry", "Mathematics"]},
            "grade": {"type": "string", "pattern": "^(Class )?(I|V|X|XI|XII|[1-9]|1[0-2])$"},
            "difficulty": {"enum": ["comfort", "hustle", "advanced"]}
          },
          "required": ["title", "subject", "grade", "difficulty"],
          "additionalProperties": false
        },
        "learning_objectives": {
          "type": "array",
          "items": {"type": "string", "minLength": 10, "maxLength": 150},
          "minItems": 3,
          "maxItems": 8
        },
        "beats": {
          "type": "array",
          "minItems": 6,
          "maxItems": 12,
          "items": {
            "type": "object",
            "properties": {
              "id": {"type": "string", "pattern": "^beat-[a-z0-9-]+$"},
              "headline": {"type": "string", "minLength": 5, "maxLength": 100},
              "prereqs": {"type": "array", "items": {"type": "string", "pattern": "^beat-[a-z0-9-]+$"}},
              "outcomes": {"type": "array", "items": {"type": "string", "minLength": 5}, "minItems": 1, "maxItems": 3},
              "assets_suggested": {
                "type": "array",
                "items": {"type": "string", "pattern": "^(eq|plot|diagram|widget|chem):[a-z0-9_-]+$"},
                "maxItems": 5
              }
            },
            "required": ["id", "headline", "prereqs", "outcomes", "assets_suggested"],
            "additionalProperties": false
          }
        },
        "glossary_seed": {"type": "array", "items": {"type": "string"}, "maxItems": 20},
        "misconceptions": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
        "assessment_outline": {"type": "array", "items": {"type": "string"}, "maxItems": 8}
      },
      "required": ["meta", "learning_objectives", "beats"],
      "additionalProperties": false
    }
  },
  "required": ["envelope", "payload"],
  "additionalProperties": false
}
```

### 2.2 SectionContext Schema v1.0 (`content-engine/adapters/schemas/sectioncontext.v1.schema.json`)

```json
{
  "$id": "sectioncontext.v1.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "envelope": {
      "type": "object",
      "properties": {
        "version": {"type": "string", "pattern": "^1\\.[0-9]+\\.[0-9]+$"},
        "producer": {"const": "M2-ScaffoldAdapter"},
        "timestamp": {"type": "string", "format": "date-time"},
        "correlationId": {"type": "string"},
        "contentHash": {"type": "string", "pattern": "^sha256:[a-f0-9]{64}$"},
        "compatible": {"type": "array", "items": {"type": "string"}}
      },
      "required": ["version", "producer", "timestamp", "correlationId", "contentHash"],
      "additionalProperties": false
    },
    "payload": {
      "type": "object",
      "properties": {
        "context": {
          "type": "object",
          "properties": {
            "chapterId": {"type": "string", "pattern": "^[a-z0-9-]+$"},
            "sectionId": {"type": "string", "pattern": "^sec-[0-9]+$"},
            "sectionTitle": {"type": "string", "minLength": 5, "maxLength": 100},
            "difficulty": {"enum": ["comfort", "hustle", "advanced"]},
            "subject": {"enum": ["Physics", "Chemistry", "Mathematics"]},
            "assetMarkers": {
              "type": "array",
              "items": {"type": "string", "pattern": "^\\{\\{(eq|plot|diagram|widget|chem):[a-z0-9_-]+\\}\\}$"},
              "maxItems": 10
            },
            "transitions": {
              "type": "object",
              "properties": {
                "in": {"type": "string", "maxLength": 300},
                "out": {"type": "string", "maxLength": 300}
              },
              "required": ["in", "out"],
              "additionalProperties": false
            },
            "conceptSequence": {
              "type": "array",
              "items": {"type": "string", "minLength": 3, "maxLength": 100},
              "minItems": 1,
              "maxItems": 8
            }
          },
          "required": ["chapterId", "sectionId", "sectionTitle", "difficulty", "subject", "assetMarkers", "transitions", "conceptSequence"],
          "additionalProperties": false
        },
        "runningState": {
          "type": "object",
          "properties": {
            "recap_150w": {"type": "string", "minLength": 50, "maxLength": 1200},
            "introduced_terms": {"type": "array", "items": {"type": "string"}, "maxItems": 50},
            "used_assets": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {"type": "string"},
                  "type": {"enum": ["eq", "plot", "diagram", "widget", "chem"]},
                  "contentHash": {"type": "string", "pattern": "^sha256:[a-f0-9]{64}$"}
                },
                "required": ["id", "type", "contentHash"],
                "additionalProperties": false
              },
              "maxItems": 20
            },
            "open_threads": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
            "style_guard": {
              "type": "object",
              "properties": {
                "difficulty": {"enum": ["comfort", "hustle", "advanced"]},
                "tone": {"type": "string", "maxLength": 100}
              },
              "required": ["difficulty"],
              "additionalProperties": false
            }
          },
          "required": ["recap_150w", "style_guard"],
          "additionalProperties": false
        }
      },
      "required": ["context", "runningState"],
      "additionalProperties": false
    }
  },
  "required": ["envelope", "payload"],
  "additionalProperties": false
}
```

### 2.3 Enhanced Asset Schemas

**PlotSpec v1.0** (`content-engine/schemas-shared/plotspec.v1.schema.json`)

```json
{
  "$id": "plotspec.v1.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "kind": {"const": "pgfplot"},
    "contentHash": {"type": "string", "pattern": "^sha256:[a-f0-9]{64}$"},
    "title": {"type": "string", "maxLength": 100},
    "x": {
      "type": "object",
      "properties": {
        "min": {"type": "number"},
        "max": {"type": "number"},
        "ticks": {"type": "integer", "minimum": 2, "maximum": 20},
        "label": {"type": "string", "maxLength": 50}
      },
      "required": ["min", "max", "label"],
      "additionalProperties": false
    },
    "y": {
      "type": "object",
      "properties": {
        "min": {"type": "number"},
        "max": {"type": "number"},
        "ticks": {"type": "integer", "minimum": 2, "maximum": 20},
        "label": {"type": "string", "maxLength": 50}
      },
      "required": ["min", "max", "label"],
      "additionalProperties": false
    },
    "expr": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9_\\s+\\-*/^().]*$",
      "maxLength": 200
    },
    "params": {
      "type": "object",
      "patternProperties": {
        "^[a-zA-Z][a-zA-Z0-9_]*$": {"type": "number"}
      },
      "additionalProperties": false,
      "maxProperties": 10
    },
    "style": {
      "type": "object",
      "properties": {
        "grid": {"type": "boolean"},
        "samples": {"type": "integer", "minimum": 16, "maximum": 2048}
      },
      "additionalProperties": false
    }
  },
  "required": ["kind", "contentHash", "x", "y", "expr"],
  "additionalProperties": false
}
```

**DiagramSpec v1.0** (`content-engine/schemas-shared/diagramspec.v1.schema.json`)

```json
{
  "$id": "diagramspec.v1.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "contentHash": {"type": "string", "pattern": "^sha256:[a-f0-9]{64}$"},
    "canvas": {
      "type": "object",
      "properties": {
        "width": {"type": "integer", "minimum": 64, "maximum": 2048},
        "height": {"type": "integer", "minimum": 64, "maximum": 2048},
        "grid": {"type": "integer", "minimum": 2, "maximum": 32},
        "snap": {"type": "boolean"}
      },
      "required": ["width", "height", "grid", "snap"],
      "additionalProperties": false
    },
    "nodes": {
      "type": "array",
      "minItems": 1,
      "maxItems": 50,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "id": {"type": "string", "pattern": "^[a-zA-Z0-9_-]+$"},
              "kind": {"const": "point"},
              "x": {"type": "number"},
              "y": {"type": "number"},
              "label": {"type": "string", "maxLength": 20}
            },
            "required": ["id", "kind", "x", "y"],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "id": {"type": "string", "pattern": "^[a-zA-Z0-9_-]+$"},
              "kind": {"const": "arrow"},
              "from": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
              "to": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
              "label": {"type": "string", "maxLength": 20}
            },
            "required": ["id", "kind", "from", "to"],
            "additionalProperties": false
          }
        ]
      }
    },
    "labels": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "of": {"type": "string"},
          "pos": {"enum": ["mid", "start", "end"]},
          "text": {"type": "string", "maxLength": 30},
          "dx": {"type": "number", "minimum": -100, "maximum": 100},
          "dy": {"type": "number", "minimum": -100, "maximum": 100}
        },
        "required": ["of", "pos", "text"],
        "additionalProperties": false
      },
      "maxItems": 20
    },
    "rules": {
      "type": "object",
      "properties": {
        "requiredNodes": {"type": "array", "items": {"type": "string"}, "maxItems": 20},
        "forbidEdgeCrossings": {"type": "boolean"}
      },
      "additionalProperties": false
    }
  },
  "required": ["contentHash", "canvas", "nodes"],
  "additionalProperties": false
}
```

**WidgetSpec v1.0** (`content-engine/schemas-shared/widgetspec.v1.schema.json`)

```json
{
  "$id": "widgetspec.v1.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Interactive Widget Specification",
  "type": "object",
  "properties": {
    "contentHash": {"type": "string", "pattern": "^sha256:[a-f0-9]{64}$"},
    "kind": {"enum": ["formula-playground", "plot-explorer"]},
    "expr": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9_\\s+\\-*/^().]*$",
      "minLength": 1,
      "maxLength": 500
    },
    "params": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10,
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "pattern": "^[a-zA-Z][a-zA-Z0-9_]*$",
            "minLength": 1,
            "maxLength": 20
          },
          "min": {"type": "number", "minimum": -1e10, "maximum": 1e10},
          "max": {"type": "number", "minimum": -1e10, "maximum": 1e10},
          "step": {"type": "number", "minimum": 1e-10, "maximum": 1e6},
          "default": {"type": "number"},
          "unit": {"type": "string", "maxLength": 20}
        },
        "required": ["name", "min", "max", "step", "default"],
        "additionalProperties": false
      }
    },
    "display": {
      "type": "object",
      "properties": {
        "latex": {"type": "string", "maxLength": 200},
        "title": {"type": "string", "maxLength": 100},
        "debounceMs": {"type": "integer", "minimum": 100, "maximum": 2000, "default": 300}
      },
      "additionalProperties": false
    },
    "constraints": {
      "type": "object",
      "properties": {
        "maxSamples": {"type": "integer", "minimum": 10, "maximum": 1000, "default": 100},
        "units": {"type": "string", "maxLength": 50}
      },
      "additionalProperties": false
    }
  },
  "required": ["contentHash", "kind", "expr", "params"],
  "additionalProperties": false
}
```

**ChemSpec v1.0** (`content-engine/schemas-shared/chemspec.v1.schema.json`)

```json
{
  "$id": "chemspec.v1.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Chemical Structure Specification",
  "type": "object",
  "properties": {
    "contentHash": {"type": "string", "pattern": "^sha256:[a-f0-9]{64}$"},
    "format": {"enum": ["smiles", "inchi", "pubchem_cid"]},
    "data": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "format": {"const": "smiles"},
            "smiles": {
              "type": "string",
              "pattern": "^[A-Za-z0-9@+\\-\\[\\]()=#/\\\\%:]+$",
              "minLength": 1,
              "maxLength": 1000
            }
          },
          "required": ["format", "smiles"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "format": {"const": "inchi"},
            "inchi": {
              "type": "string",
              "pattern": "^InChI=",
              "maxLength": 2000
            }
          },
          "required": ["format", "inchi"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "format": {"const": "pubchem_cid"},
            "cid": {
              "type": "integer",
              "minimum": 1,
              "maximum": 999999999
            }
          },
          "required": ["format", "cid"],
          "additionalProperties": false
        }
      ]
    },
    "caption": {"type": "string", "maxLength": 200},
    "constraints": {
      "type": "object",
      "properties": {
        "maxAtoms": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
        "maxBonds": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100}
      },
      "additionalProperties": false
    }
  },
  "required": ["contentHash", "format", "data"],
  "additionalProperties": false
}
```

### 2.4 Reader DocJSON Schema v1.0 (`content-engine/schemas-shared/reader.v1.schema.json`)

**CRITICAL: This is the exact schema that M4 MUST produce to ensure Reader compatibility.**

```json
{
  "$id": "reader.v1.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Reader DocJSON Contract",
  "description": "Exact schema that M4 Assembler must produce for Reader compatibility",
  "type": "object",
  "required": ["meta", "sections"],
  "properties": {
    "meta": {
      "type": "object",
      "required": ["title", "grade", "subject", "version"],
      "properties": {
        "title": { "type": "string" },
        "grade": { "type": "string" },
        "subject": { "type": "string" },
        "version": { "type": "string" }
      },
      "additionalProperties": false
    },
    "sections": {
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "required": ["id", "type", "md"],
            "properties": {
              "id": {"type": "string"},
              "type": {"const": "paragraph"},
              "md": {"type": "string"}
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": ["id", "type", "tex", "check"],
            "properties": {
              "id": {"type": "string"},
              "type": {"const": "equation"},
              "tex": {"type": "string"},
              "check": {
                "type": "object",
                "required": ["vars", "expr", "expect", "tol"],
                "properties": {
                  "vars": {"type": "object", "additionalProperties": {"type": "number"}},
                  "expr": {"type": "string"},
                  "expect": {"type": "number"},
                  "tol": {"type": "number"}
                },
                "additionalProperties": false
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": ["id", "type", "specRef"],
            "properties": {
              "id": {"type": "string"},
              "type": {"const": "plot"},
              "specRef": {"type": "string"}
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": ["id", "type", "smiles"],
            "properties": {
              "id": {"type": "string"},
              "type": {"const": "chem"},
              "smiles": {"type": "string"},
              "caption": {"type": "string"}
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": ["id", "type", "specRef"],
            "properties": {
              "id": {"type": "string"},
              "type": {"const": "diagram"},
              "specRef": {"type": "string"}
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": ["id", "type", "widget"],
            "properties": {
              "id": {"type": "string"},
              "type": {"const": "widget"},
              "widget": {
                "type": "object",
                "required": ["kind", "expr", "params"],
                "properties": {
                  "kind": {"const": "formula-playground"},
                  "expr": {"type": "string"},
                  "params": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": ["name", "min", "max", "step", "default"],
                      "properties": {
                        "name": {"type": "string"},
                        "min": {"type": "number"},
                        "max": {"type": "number"},
                        "step": {"type": "number"},
                        "default": {"type": "number"}
                      },
                      "additionalProperties": false
                    }
                  },
                  "display": {
                    "type": "object",
                    "properties": {"latex": {"type": "string"}},
                    "additionalProperties": false
                  }
                },
                "additionalProperties": false
              }
            },
            "additionalProperties": false
          }
        ]
      }
    }
  },
  "additionalProperties": false
}
```

---

## 3) Enhanced Module Specifications

### 3.1 M1: Plan Generator

**Inputs:**
```typescript
interface PlanRequest {
  title: string;
  subject: "Physics" | "Chemistry" | "Mathematics";
  grade: string;
  difficulty: "comfort" | "hustle" | "advanced";
  chapter_pdf_url?: string;
  reference_materials?: string[];
}
```

**Outputs:** `DocPlan.v1` (versioned envelope + payload)

**Validation Gates:**
- G1: AJV schema validation
- G2: Beat dependency graph validation (no cycles)
- G3: Asset suggestion format validation

**Caching Key:** `sha256(PlanRequest + templateVersion)`

### 3.2 M2: Scaffold Generator + Adapter

**Inputs:** `DocPlan.v1.x` (compatible versions)

**Outputs:**
- `Scaffold.v1` (internal format)
- `SectionContext.v1` (adapted for M3)

**Adapter Logic:**
```typescript
class ScaffoldToContextAdapter {
  transform(scaffold: Scaffold): SectionContext[] {
    return scaffold.sections.map(section => ({
      envelope: { /* versioning info */ },
      payload: {
        context: {
          chapterId: slugify(scaffold.meta.title),
          sectionId: section.id,
          sectionTitle: section.title,
          difficulty: scaffold.meta.difficulty,
          subject: scaffold.meta.subject,
          assetMarkers: section.where_assets_go,
          transitions: section.transitions,
          conceptSequence: section.concept_sequence
        },
        runningState: /* initialized or carried forward */
      }
    }));
  }
}
```

**Validation Gates:**
- G1: AJV schema validation
- G2: Asset marker reference validation
- G3: Section flow validation

### 3.3 M3: Section Generator

**Inputs:** `SectionContext.v1.x` (single section)

**Outputs:** `SectionDoc.v1`

**Content Generation Process:**
1. Parse asset markers from context
2. Generate interleaved prose + assets
3. Validate all LaTeX expressions with KaTeX
4. Validate all mathematical expressions numerically
5. Generate PlotSpec/DiagramSpec/WidgetSpec as needed
6. Update RunningState for next section

**Validation Gates:**
- G1: AJV schema validation
- G2: KaTeX parse validation
- G3: Mathematical expression validation (enhanced with seeded trials)
- G4: PlotSpec expression lexer validation
- G5: RDKit SMILES validation
- G6: Diagram topology validation
- **G11: Dimensional analysis validation** (ensures unit consistency)

### 3.4 M4: Assembler

**Inputs:** `SectionDoc.v1.x[]` (all sections)

**Outputs:** Reader-compatible files:
- `chapters/<slug>.json` (Final DocJSON)
- `plots/<slug>/*.json` (PlotSpec files)
- `diagrams/<slug>/*.json` (DiagramSpec files)

**Assembly Process:**
1. Merge all SectionDoc payloads
2. Extract embedded PlotSpec/DiagramSpec to separate files
3. Generate cross-references and update specRef fields
4. Validate final DocJSON against Reader schema
5. Write all files with deterministic naming

**Validation Gates:**
- G1: Final DocJSON schema validation
- G2: Cross-reference uniqueness validation
- G3: File path consistency validation
- **G10: Reader DocJSON contract validation** (CRITICAL: Must pass reader.v1.schema.json)

---

## 4) Error Handling & Repair System

### 4.1 Enhanced Error Taxonomy

```typescript
type ModuleError =
  // Module-specific errors
  | { code: "E-M1-SCHEMA-DOCPLAN", module: "M1", data: AjvError[], correlationId: string }
  | { code: "E-M1-BEAT-CYCLES", module: "M1", data: { cycle: string[] }, correlationId: string }
  | { code: "E-M2-SCAFFOLD-MARKERS", module: "M2", data: { invalidMarkers: string[] }, correlationId: string }
  | { code: "E-M3-KATEX-PARSE", module: "M3", data: { equation: string, error: string }, correlationId: string }
  | { code: "E-M3-MATH-NUMERIC", module: "M3", data: { expr: string, expected: number, actual: number }, correlationId: string }
  | { code: "E-M3-PLOT-LEXER", module: "M3", data: { expr: string, invalidTokens: string[] }, correlationId: string }
  | { code: "E-M3-SMILES-INVALID", module: "M3", data: { smiles: string, rdkitError: string }, correlationId: string }
  | { code: "E-M4-ASSEMBLY-DUPLICATES", module: "M4", data: { duplicateIds: string[] }, correlationId: string }
  // Cross-module errors
  | { code: "E-ADAPTER-VERSION", module: "ADAPTER", data: { expected: string, got: string }, correlationId: string }
  | { code: "E-CACHE-CORRUPTION", module: "CACHE", data: { key: string, expectedHash: string }, correlationId: string };
```

### 4.2 Repair Strategies

| Error Type | Repair Strategy | Max Attempts |
|------------|-----------------|--------------|
| Schema validation | Re-emit with AJV error context | 2 |
| KaTeX parse | Simplify expression, add escaping | 2 |
| Math numeric | Adjust tolerance, verify variables, run seeded trials | 2 |
| Plot lexer | Remove unsafe tokens, sanitize expr | 2 |
| SMILES invalid | Use canonical form, fallback molecules | 2 |
| Cross-reference | Rename with suffix, update refs | 1 |

### 4.3 FSM Halting Rules & Global Error Handling

**Pipeline Completion Rules:**

| Condition | Action | Rationale |
|-----------|--------|-----------|
| All modules pass validation | ✅ **PUBLISH** to Reader | Success path |
| Any module fails after max repair attempts | ❌ **HALT PIPELINE** | Fail-fast to prevent partial/corrupted output |
| M4 fails Reader schema validation (G10) | ❌ **CRITICAL HALT** | Reader incompatibility breaks entire system |
| Cache corruption detected | ⚠️ **INVALIDATE + RETRY** | Deterministic rebuild should fix corruption |
| Version incompatibility between modules | ⚠️ **ATTEMPT MIGRATION** | Try automatic schema migration first |

**Global Error Handling Strategy:**

```typescript
interface PipelineResult {
  status: 'SUCCESS' | 'PARTIAL_FAILURE' | 'CRITICAL_FAILURE';
  artifacts?: {
    chapterPath: string;
    plotSpecs: string[];
    diagramSpecs: string[];
  };
  errors: ModuleError[];
  correlationId: string;
  processingTime: number;
}

class ContentPipeline {
  async execute(request: PlanRequest): Promise<PipelineResult> {
    const correlationId = generateCorrelationId();
    const errors: ModuleError[] = [];

    try {
      // M1: Plan Generation
      const planResult = await this.executeModule('M1', request, correlationId);
      if (planResult.isError()) {
        return { status: 'CRITICAL_FAILURE', errors: planResult.errors, correlationId };
      }

      // M2: Scaffold + Adapter
      const scaffoldResult = await this.executeModule('M2', planResult.value, correlationId);
      if (scaffoldResult.isError()) {
        return { status: 'CRITICAL_FAILURE', errors: scaffoldResult.errors, correlationId };
      }

      // M3: Section Generation (parallel)
      const sectionResults = await Promise.allSettled(
        scaffoldResult.value.contexts.map(ctx =>
          this.executeModule('M3', ctx, correlationId)
        )
      );

      // Check if any sections failed permanently
      const failedSections = sectionResults.filter(r =>
        r.status === 'rejected' || r.value.isError()
      );

      if (failedSections.length > 0) {
        errors.push(...failedSections.flatMap(f => f.value?.errors || []));
        return { status: 'CRITICAL_FAILURE', errors, correlationId };
      }

      // M4: Assembly with CRITICAL Reader validation
      const sections = sectionResults.map(r => r.value.value);
      const assemblyResult = await this.executeModule('M4', sections, correlationId);

      if (assemblyResult.isError()) {
        // M4 failures are always critical (Reader compatibility)
        return { status: 'CRITICAL_FAILURE', errors: assemblyResult.errors, correlationId };
      }

      return {
        status: 'SUCCESS',
        artifacts: assemblyResult.value,
        errors: [],
        correlationId
      };

    } catch (error) {
      return {
        status: 'CRITICAL_FAILURE',
        errors: [{ code: 'E-PIPELINE-UNEXPECTED', module: 'PIPELINE', data: error, correlationId }],
        correlationId
      };
    }
  }

  private async executeModule<T, U>(
    moduleName: string,
    input: T,
    correlationId: string
  ): Promise<Result<U, ModuleError[]>> {
    const maxAttempts = 3;
    let attempt = 1;
    let lastErrors: ModuleError[] = [];

    while (attempt <= maxAttempts) {
      const result = await this.modules[moduleName].process(input);

      if (result.isSuccess()) {
        return result;
      }

      lastErrors = result.errors;

      // Try repair if attempts remaining
      if (attempt < maxAttempts) {
        const repairResult = await this.repairEngine.attemptRepair(
          moduleName,
          result.errors,
          input
        );

        if (repairResult.isSuccess()) {
          input = repairResult.value; // Use repaired input for next attempt
          await this.logCorrection(moduleName, result.errors, repairResult);
        }
      }

      attempt++;
    }

    // All repair attempts exhausted
    return Err(lastErrors);
  }
}
```

**No Partial Outputs:** The pipeline either produces a complete, valid chapter or fails entirely. No partial/corrupted files are written to preserve Reader stability.

### 4.4 Correction Logging

```json
{
  "correlationId": "ch-abc123",
  "timestamp": "2024-01-20T10:00:00Z",
  "module": "M3",
  "originalError": {
    "code": "E-M3-KATEX-PARSE",
    "data": { "equation": "F=ma^{unclosed", "error": "Missing closing brace" }
  },
  "repair": {
    "strategy": "add_missing_braces",
    "changes": [
      { "field": "tex", "from": "F=ma^{unclosed", "to": "F=ma^{\\text{unclosed}}" }
    ]
  },
  "validation": {
    "passed": true,
    "contentHash": "sha256:new_hash_after_repair"
  }
}
```

---

## 5) Deterministic Caching System

### 5.1 Content Hashing Strategy

All artifacts use SHA256 content hashing:

```typescript
function generateContentHash(spec: any, templateVersion: string): string {
  const normalized = normalizeObject(spec);
  const content = JSON.stringify(normalized) + templateVersion;
  return `sha256:${sha256(content)}`;
}

function normalizeObject(obj: any): any {
  return recursiveNormalize(obj);
}

function recursiveNormalize(obj: any): any {
  if (typeof obj === 'string') {
    return normalizeString(obj);
  } else if (Array.isArray(obj)) {
    return obj.map(recursiveNormalize);
  } else if (obj && typeof obj === 'object') {
    const sorted: Record<string, any> = {};
    // Sort keys deterministically for consistent hashing
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = recursiveNormalize(obj[key]);
    });
    return sorted;
  }
  return obj;
}

function normalizeString(text: string): string {
  return text
    // 1. Unicode NFC normalization (canonical composition)
    .normalize('NFC')
    // 2. Remove zero-width characters that could hide malicious content
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // 3. Replace multiple whitespace with single space
    .replace(/\s+/g, ' ')
    // 4. Trim leading/trailing whitespace
    .trim();
}
```

### 5.2 Cache Keys

- **PlotSpec compilation**: `cache/plots/${contentHash}.svg`
- **DiagramSpec compilation**: `cache/diagrams/${contentHash}.svg`
- **RDKit SMILES**: `cache/chem/${sha256(smiles)}.svg`
- **KaTeX rendering**: `cache/math/${sha256(tex)}.mathml`

### 5.3 Cache Validation

```typescript
interface CacheEntry {
  contentHash: string;
  templateVersion: string;
  timestamp: string;
  artifact: string; // file path or content
  metadata: {
    compiler: string;
    compilerVersion: string;
    dependencies: string[];
  };
}
```

---

## 6) Integration Gates & Validation Pipeline

### 6.1 Validation Gate Specifications

| Gate | Module | Check | Input | Output | Fail Condition |
|------|--------|-------|-------|--------|-----------------|
| G1 | All | AJV Schema | JSON object | ValidationResult | `additionalProperties` or missing `required` |
| G2 | M1 | Beat Dependencies | DocPlan.beats | DependencyGraph | Circular dependencies detected |
| G3 | M3 | KaTeX Parse | LaTeX string | AST | Parse error thrown |
| G4 | M3 | Math Numeric | Expression + vars | number | `|actual - expected| > tolerance` |
| G5 | M3 | Plot Lexer | Expression string | TokenList | Disallowed tokens found |
| G6 | M3 | RDKit SMILES | SMILES string | Molecule | Invalid molecule structure |
| G7 | M3 | Diagram Topology | DiagramSpec | ValidationResult | Missing required nodes or overlaps |
| G8 | M4 | Cross-ref Unique | ID list | ValidationResult | Duplicate IDs found |
| G9 | All | Unicode Sanitization | Text content | CleanText | Invalid UTF-8 or homoglyphs |
| G10 | M4 | Reader Contract | Final DocJSON | ValidationResult | Fails reader.v1.schema.json validation |
| G11 | M3 | Dimensional Analysis | Equation + units | UnitValidation | Unit dimensions don't match equation |

### 6.2 Pipeline Execution

```typescript
class ValidationPipeline {
  async validateModule<T>(
    module: string,
    input: T,
    gates: ValidationGate[]
  ): Promise<Result<T, ModuleError[]>> {
    const errors: ModuleError[] = [];
    let current = input;

    for (const gate of gates) {
      const result = await gate.validate(current);
      if (result.isError()) {
        const repairResult = await this.attemptRepair(module, gate, result.error, current);
        if (repairResult.isSuccess()) {
          current = repairResult.value;
          await this.logCorrection(module, gate, result.error, repairResult);
        } else {
          errors.push(result.error);
          break;
        }
      }
    }

    return errors.length > 0 ? Err(errors) : Ok(current);
  }
}
```

### 6.3 Security Constraints & Input Sanitization

**CRITICAL: All user inputs and LLM outputs must be sanitized to prevent injection attacks and malicious content.**

#### 6.3.1 Text Content Security

```typescript
class SecurityValidator {
  // Unicode normalization with homoglyph detection
  static validateText(text: string): SecurityResult {
    // 1. Detect homoglyph attacks (e.g., Cyrillic 'а' vs Latin 'a')
    const suspiciousMix = this.detectMixedScripts(text);
    if (suspiciousMix.risk === 'HIGH') {
      return { valid: false, code: 'E-SECURITY-HOMOGLYPH', data: suspiciousMix };
    }

    // 2. Remove dangerous Unicode categories
    const cleaned = text
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Control characters
      .replace(/[\u2000-\u206F]/g, ' ')             // General punctuation
      .replace(/[\uFFF0-\uFFFF]/g, '');             // Specials block

    // 3. Validate final length
    if (cleaned.length > MAX_TEXT_LENGTH) {
      return { valid: false, code: 'E-SECURITY-TEXT-TOO-LONG' };
    }

    return { valid: true, sanitized: normalizeString(cleaned) };
  }

  // LaTeX expression security
  static validateLatex(tex: string): SecurityResult {
    // Block dangerous TeX commands
    const dangerousCommands = [
      '\\write', '\\input', '\\include', '\\openin', '\\openout',
      '\\immediate', '\\expandafter', '\\csname', '\\endcsname',
      '\\catcode', '\\def', '\\gdef', '\\edef', '\\xdef'
    ];

    for (const cmd of dangerousCommands) {
      if (tex.includes(cmd)) {
        return { valid: false, code: 'E-SECURITY-LATEX-DANGEROUS', data: { command: cmd } };
      }
    }

    return { valid: true, sanitized: tex };
  }

  // Mathematical expression lexer (already implemented in validation gates)
  static validateMathExpr(expr: string): SecurityResult {
    // Only allow: [a-zA-Z0-9_\s+\-*/^().]
    const allowedPattern = /^[a-zA-Z0-9_\s+\-*/^().]*$/;
    if (!allowedPattern.test(expr)) {
      const invalidChars = expr.match(/[^a-zA-Z0-9_\s+\-*/^().]/g) || [];
      return { valid: false, code: 'E-SECURITY-EXPR-INVALID', data: { invalidChars } };
    }

    return { valid: true, sanitized: expr };
  }
}
```

#### 6.3.2 Compiler Security

**Tectonic (LaTeX → PDF → SVG) Security:**
- Run in sandboxed container with no network access
- Disable `\write18` shell escape commands
- Limit memory usage to 512MB per compilation
- Timeout after 30 seconds
- Only allow pre-approved package includes

**RDKit (SMILES → SVG) Security:**
- Validate SMILES against chemical grammar before processing
- Limit molecule complexity (max 100 atoms)
- Run in isolated Python environment
- No network access during rendering

**SVG Output Security:**
- Strip JavaScript from generated SVGs
- Remove `<script>` tags and `on*` event handlers
- Validate SVG against safe subset schema
- Ensure no external resource references

#### 6.3.3 File System Security

```typescript
class FileSystemSecurity {
  // Prevent path traversal attacks
  static validatePath(requestedPath: string, allowedBase: string): SecurityResult {
    const resolved = path.resolve(allowedBase, requestedPath);

    // Ensure path stays within allowed directory
    if (!resolved.startsWith(path.resolve(allowedBase))) {
      return { valid: false, code: 'E-SECURITY-PATH-TRAVERSAL', data: { requestedPath, resolved } };
    }

    // Block dangerous filenames
    const dangerous = ['..', '.env', 'package.json', 'node_modules'];
    if (dangerous.some(d => requestedPath.includes(d))) {
      return { valid: false, code: 'E-SECURITY-DANGEROUS-FILENAME' };
    }

    return { valid: true, sanitized: resolved };
  }

  // Content-addressed storage prevents tampering
  static validateContentHash(content: string, expectedHash: string): boolean {
    const actualHash = sha256(content);
    return actualHash === expectedHash.replace('sha256:', '');
  }
}
```

#### 6.3.4 Network Security

- All external LLM API calls use TLS 1.3
- API keys stored in environment variables, never in code
- Rate limiting: max 10 requests/minute per correlation ID
- Request/response logging for audit trails
- No user data sent to external services without explicit consent

### 6.4 Enhanced Validation: Seeded Trials & Dimensional Analysis

#### 6.4.1 Seeded Numeric Validation (Enhanced G3)

**Problem**: Single test case per equation can be cherry-picked to pass tolerance.

**Solution**: Multiple seeded trials with random variable values.

```typescript
interface NumericValidationConfig {
  seedCount: number; // Default: 5
  tolerance: number;
  variableRanges: Record<string, {min: number, max: number}>;
}

class EnhancedNumericValidator {
  static async validateEquation(
    equation: EquationSpec,
    config: NumericValidationConfig
  ): Promise<ValidationResult> {
    const results: TrialResult[] = [];

    for (let seed = 0; seed < config.seedCount; seed++) {
      // Generate seeded random values within realistic ranges
      const testVars = this.generateSeededVariables(
        equation.check.vars,
        config.variableRanges,
        seed
      );

      try {
        // Evaluate expression with test variables
        const actual = mathjs.evaluate(equation.check.expr, testVars);
        const expected = equation.check.expect;
        const withinTolerance = Math.abs(actual - expected) <= config.tolerance;

        results.push({
          seed,
          variables: testVars,
          actual,
          expected,
          passed: withinTolerance,
          error: withinTolerance ? null : `Expected ${expected}, got ${actual}`
        });

      } catch (error) {
        results.push({
          seed,
          variables: testVars,
          passed: false,
          error: `Evaluation failed: ${error.message}`
        });
      }
    }

    const passedCount = results.filter(r => r.passed).length;
    const passRate = passedCount / config.seedCount;

    // Require 80% of trials to pass (allows for numerical precision issues)
    if (passRate < 0.8) {
      return {
        valid: false,
        code: 'E-M3-MATH-SEEDED-FAILURE',
        data: {
          passRate,
          requiredRate: 0.8,
          trials: results
        }
      };
    }

    return { valid: true, data: { trials: results, passRate } };
  }

  private static generateSeededVariables(
    baseVars: Record<string, number>,
    ranges: Record<string, {min: number, max: number}>,
    seed: number
  ): Record<string, number> {
    const rng = new SeededRandom(seed);
    const testVars: Record<string, number> = {};

    for (const [name, baseValue] of Object.entries(baseVars)) {
      const range = ranges[name];
      if (range) {
        // Generate value within specified range
        testVars[name] = rng.uniform(range.min, range.max);
      } else {
        // Use variation around base value (±20%)
        const variation = baseValue * 0.2;
        testVars[name] = baseValue + rng.uniform(-variation, variation);
      }
    }

    return testVars;
  }
}
```

#### 6.4.2 Dimensional Analysis (G11)

**Problem**: Equations can pass numeric checks but have wrong physical units.

**Solution**: Parse units and verify dimensional consistency.

```typescript
interface UnitDimensions {
  length: number;    // L
  mass: number;      // M
  time: number;      // T
  current: number;   // I
  temperature: number; // Θ
  amount: number;    // N
  luminosity: number; // J
}

class DimensionalAnalyzer {
  private static baseUnits: Record<string, UnitDimensions> = {
    'm': { length: 1, mass: 0, time: 0, current: 0, temperature: 0, amount: 0, luminosity: 0 },
    'kg': { length: 0, mass: 1, time: 0, current: 0, temperature: 0, amount: 0, luminosity: 0 },
    's': { length: 0, mass: 0, time: 1, current: 0, temperature: 0, amount: 0, luminosity: 0 },
    'A': { length: 0, mass: 0, time: 0, current: 1, temperature: 0, amount: 0, luminosity: 0 },
    'K': { length: 0, mass: 0, time: 0, current: 0, temperature: 1, amount: 0, luminosity: 0 },
    'mol': { length: 0, mass: 0, time: 0, current: 0, temperature: 0, amount: 1, luminosity: 0 },
    'cd': { length: 0, mass: 0, time: 0, current: 0, temperature: 0, amount: 0, luminosity: 1 },
    // Derived units
    'N': { length: 1, mass: 1, time: -2, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Force
    'J': { length: 2, mass: 1, time: -2, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Energy
    'W': { length: 2, mass: 1, time: -3, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Power
    'Pa': { length: -1, mass: 1, time: -2, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Pressure
  };

  static validateEquation(
    equation: EquationSpec,
    unitMap: Record<string, string>
  ): ValidationResult {
    try {
      // Parse equation to extract terms and operations
      const ast = this.parseEquationAST(equation.tex);

      // Assign dimensions to each variable based on unit map
      const variableDimensions: Record<string, UnitDimensions> = {};
      for (const [variable, unit] of Object.entries(unitMap)) {
        variableDimensions[variable] = this.parseUnit(unit);
      }

      // Analyze dimensional consistency
      const leftSide = this.analyzeDimensions(ast.left, variableDimensions);
      const rightSide = this.analyzeDimensions(ast.right, variableDimensions);

      // Check if both sides have same dimensions
      if (!this.dimensionsEqual(leftSide, rightSide)) {
        return {
          valid: false,
          code: 'E-M3-UNITS-MISMATCH',
          data: {
            leftDimensions: leftSide,
            rightDimensions: rightSide,
            equation: equation.tex
          }
        };
      }

      return { valid: true, data: { dimensions: leftSide } };

    } catch (error) {
      return {
        valid: false,
        code: 'E-M3-UNITS-PARSE-ERROR',
        data: { error: error.message, equation: equation.tex }
      };
    }
  }

  private static parseUnit(unitString: string): UnitDimensions {
    // Parse units like "kg⋅m/s²" or "N⋅m"
    // This is a simplified parser - production would need full unit grammar
    const baseUnit = unitString.split(/[⋅\/\^]/)[0];
    return this.baseUnits[baseUnit] || this.createDimensionlessUnit();
  }

  private static dimensionsEqual(a: UnitDimensions, b: UnitDimensions): boolean {
    const tolerance = 1e-10;
    return Math.abs(a.length - b.length) < tolerance &&
           Math.abs(a.mass - b.mass) < tolerance &&
           Math.abs(a.time - b.time) < tolerance &&
           Math.abs(a.current - b.current) < tolerance &&
           Math.abs(a.temperature - b.temperature) < tolerance &&
           Math.abs(a.amount - b.amount) < tolerance &&
           Math.abs(a.luminosity - b.luminosity) < tolerance;
  }
}
```

### 6.5 Deterministic ID Scheme & TeX Security

#### 6.5.1 Stable ID Convention

**Problem**: Non-deterministic IDs break highlights/links across rebuilds.

**Solution**: Predictable ID generation scheme.

```typescript
interface IDConventions {
  chapter: string;        // e.g., "laws-of-motion"
  section: string;        // e.g., "sec-1", "sec-2"
  equation: string;       // e.g., "eq-laws-of-motion-01"
  plot: string;          // e.g., "plot-laws-of-motion-01"
  diagram: string;       // e.g., "fig-laws-of-motion-01"
  widget: string;        // e.g., "wid-laws-of-motion-01"
  chemistry: string;     // e.g., "chem-laws-of-motion-01"
}

class IDGenerator {
  private counters: Record<string, number> = {};

  constructor(private chapterSlug: string) {}

  generateID(type: 'eq' | 'plot' | 'fig' | 'wid' | 'chem'): string {
    // Increment counter for this type
    this.counters[type] = (this.counters[type] || 0) + 1;

    // Format: {type}-{chapter-slug}-{zero-padded-sequence}
    const sequence = this.counters[type].toString().padStart(2, '0');
    return `${type}-${this.chapterSlug}-${sequence}`;
  }

  validateID(id: string, expectedType: string): ValidationResult {
    const pattern = new RegExp(`^${expectedType}-[a-z0-9-]+-\\d{2,}$`);
    if (!pattern.test(id)) {
      return {
        valid: false,
        code: 'E-M4-ID-FORMAT-INVALID',
        data: { id, expectedPattern: pattern.source }
      };
    }

    return { valid: true };
  }

  // Ensure IDs are collision-free within chapter
  checkCollisions(ids: string[]): ValidationResult {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const id of ids) {
      if (seen.has(id)) {
        duplicates.push(id);
      } else {
        seen.add(id);
      }
    }

    if (duplicates.length > 0) {
      return {
        valid: false,
        code: 'E-M4-ID-COLLISION',
        data: { duplicateIds: duplicates }
      };
    }

    return { valid: true };
  }
}
```

#### 6.5.2 TeX Package Allowlist

**Problem**: Uncontrolled package usage causes compilation variability.

**Solution**: Explicit allowlist enforced in template.

```typescript
class TeXSecurityValidator {
  private static allowedPackages = [
    // Core math packages
    'amsmath', 'amsfonts', 'amssymb', 'amsthm',

    // Graphics and plotting
    'pgfplots', 'tikz', 'graphicx',

    // Units and symbols
    'siunitx', 'gensymb',

    // Typography
    'inputenc', 'fontenc', 'lmodern',

    // Geometry
    'geometry', 'fancyhdr',

    // Tables and lists
    'array', 'tabularx', 'enumitem',

    // Cross-references
    'hyperref', 'cleveref'
  ];

  private static blockedCommands = [
    // File operations
    '\\input', '\\include', '\\InputIfFileExists',

    // Shell access
    '\\write18', '\\immediate\\write18',

    // Definition commands
    '\\def', '\\gdef', '\\edef', '\\xdef',

    // Category codes (can break parsing)
    '\\catcode', '\\active',

    // Expansion control
    '\\expandafter', '\\noexpand',

    // Output control
    '\\write', '\\openout', '\\closeout'
  ];

  static validateTeXTemplate(template: string): ValidationResult {
    // Check for unauthorized packages
    const packageMatches = template.match(/\\usepackage(?:\[.*?\])?\{([^}]+)\}/g) || [];
    const unauthorizedPackages: string[] = [];

    for (const match of packageMatches) {
      const packageName = match.match(/\{([^}]+)\}/)?.[1];
      if (packageName && !this.allowedPackages.includes(packageName)) {
        unauthorizedPackages.push(packageName);
      }
    }

    if (unauthorizedPackages.length > 0) {
      return {
        valid: false,
        code: 'E-SECURITY-TEX-UNAUTHORIZED-PACKAGE',
        data: { unauthorizedPackages, allowedPackages: this.allowedPackages }
      };
    }

    // Check for blocked commands
    for (const blockedCmd of this.blockedCommands) {
      if (template.includes(blockedCmd)) {
        return {
          valid: false,
          code: 'E-SECURITY-TEX-BLOCKED-COMMAND',
          data: { command: blockedCmd }
        };
      }
    }

    return { valid: true };
  }

  static generateSecureTemplate(content: string): string {
    return `
\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amsfonts,amssymb}
\\usepackage{pgfplots}
\\usepackage{siunitx}
\\usepackage[margin=1in]{geometry}

% Disable dangerous commands
\\let\\write\\undefined
\\let\\input\\undefined
\\let\\include\\undefined

\\begin{document}
${content}
\\end{document}
    `.trim();
  }
}
```

---

## 7) Monorepo Structure

```
/content-engine/
  /m1-plan/
    schemas/
      docplan.v1.schema.json
      docplan.v1.1.schema.json        # future version
    src/
      index.ts
      plan-generator.ts
      beat-validator.ts
    tests/
      unit/
      contract/
      fixtures/
    package.json                      # independent versioning

  /m2-scaffold/
    schemas/
      scaffold.v1.schema.json
    src/
      index.ts
      scaffold-generator.ts
      section-planner.ts
    tests/
    package.json

  /m3-section/
    schemas/
      sectiondoc.v1.schema.json
    src/
      index.ts
      content-generator.ts
      asset-processor.ts
    tests/
    package.json

  /m4-assembler/
    schemas/
      docjson_final.v1.schema.json
    src/
      index.ts
      file-writer.ts
      reference-resolver.ts
    tests/
    package.json

  /adapters/
    schemas/
      sectioncontext.v1.schema.json
    src/
      scaffold-to-context.ts
      version-negotiator.ts
    tests/
    package.json

  /schemas-shared/
    plotspec.v1.schema.json
    diagramspec.v1.schema.json
    widgetspec.v1.schema.json
    envelope.v1.schema.json
    reader.v1.schema.json              # CRITICAL: Exact Reader contract
    id-conventions.v1.schema.json      # Deterministic ID scheme

  /compilers/
    pgfplots/
      src/tectonic-wrapper.ts
      cache/                          # SHA256-keyed artifacts
    rdkit/
      src/smiles-to-svg.ts
      cache/
    diagram/
      src/json-to-svg.ts
      cache/

  /validators/
    src/
      ajv-validator.ts
      katex-validator.ts
      math-validator.ts
      unicode-normalizer.ts
      expr-lexer.ts
    tests/

  /fsm/
    src/
      validation-pipeline.ts
      repair-engine.ts
      state-machine.ts
    tests/

  /cache/
    plots/                            # SHA256-keyed SVG files
    diagrams/                         # SHA256-keyed SVG files
    math/                             # SHA256-keyed MathML
    chem/                             # SHA256-keyed SVG files

  /artifacts/                         # Final outputs
    chapters/
    plots/
    diagrams/
    reports/
      validation-reports/
      correction-logs/

  package.json                        # Workspace root
  tsconfig.json                       # Shared TypeScript config
  nx.json                            # Monorepo orchestration
```

---

## 8) API Contracts

### 8.1 Module Interfaces

```typescript
interface ModuleBase<TInput, TOutput> {
  readonly name: string;
  readonly version: string;
  readonly compatibleVersions: string[];

  canHandle(envelope: Envelope<TInput>): boolean;
  process(input: Envelope<TInput>): Promise<Result<Envelope<TOutput>, ModuleError[]>>;
  validate(output: Envelope<TOutput>): Promise<ValidationResult>;
}

interface M1PlanGenerator extends ModuleBase<PlanRequest, DocPlan> {
  generatePlan(request: PlanRequest): Promise<Result<DocPlan, ModuleError[]>>;
}

interface M2ScaffoldGenerator extends ModuleBase<DocPlan, Scaffold> {
  generateScaffold(plan: DocPlan): Promise<Result<Scaffold, ModuleError[]>>;
}

interface M3SectionGenerator extends ModuleBase<SectionContext, SectionDoc> {
  generateSection(context: SectionContext): Promise<Result<SectionDoc, ModuleError[]>>;
}

interface M4Assembler extends ModuleBase<SectionDoc[], ReaderFiles> {
  assembleChapter(sections: SectionDoc[]): Promise<Result<ReaderFiles, ModuleError[]>>;
}
```

### 8.2 HTTP API (Optional)

```typescript
// REST endpoints for external integration
POST /content-engine/v1/plan
POST /content-engine/v1/scaffold
POST /content-engine/v1/section
POST /content-engine/v1/assemble

// Response format
interface APIResponse<T> {
  success: boolean;
  data?: T;
  errors?: ModuleError[];
  metadata: {
    correlationId: string;
    processingTime: number;
    cacheHit: boolean;
    contentHash: string;
  };
}
```

---

## 9) Development & Testing Strategy

### 9.1 Contract Testing

```typescript
// Each module has contract tests
describe('M3 Section Generator Contract', () => {
  test('should handle SectionContext v1.0.0', async () => {
    const mockContext = createMockSectionContext('1.0.0');
    const result = await sectionGenerator.process(mockContext);

    expect(result.isSuccess()).toBe(true);
    expect(result.value.envelope.version).toMatch(/^1\.\d+\.\d+$/);
    await expectSchemaValid(result.value, 'sectiondoc.v1.schema.json');
  });

  test('should reject incompatible versions', async () => {
    const futureContext = createMockSectionContext('2.0.0');
    expect(sectionGenerator.canHandle(futureContext)).toBe(false);
  });
});

// Cross-module integration tests
describe('M2→M3 Integration', () => {
  test('adapter should transform Scaffold to SectionContext', async () => {
    const scaffold = loadFixture('sample-scaffold.json');
    const adapter = new ScaffoldToContextAdapter();
    const contexts = adapter.transform(scaffold);

    for (const context of contexts) {
      expect(sectionGenerator.canHandle(context)).toBe(true);
      const result = await sectionGenerator.process(context);
      expect(result.isSuccess()).toBe(true);
    }
  });
});
```

### 9.2 Deployment Strategy

```yaml
# Independent module deployment
version: '3.8'
services:
  m1-plan:
    image: content-engine/m1-plan:v1.2.0
    environment:
      - SCHEMA_VERSION=1.0.0
      - CACHE_TTL=3600

  m2-scaffold:
    image: content-engine/m2-scaffold:v1.1.5
    environment:
      - ACCEPTS_DOCPLAN_VERSIONS=1.0.0,1.1.0
      - PRODUCES_SCAFFOLD_VERSION=1.0.0
      - PRODUCES_CONTEXT_VERSION=1.0.0

  m3-section:
    image: content-engine/m3-section:v1.3.0
    environment:
      - ACCEPTS_CONTEXT_VERSIONS=1.0.0
      - KATEX_VERSION=0.16.22

  m4-assembler:
    image: content-engine/m4-assembler:v1.0.8
    environment:
      - ACCEPTS_SECTIONDOC_VERSIONS=1.0.0
      - OUTPUT_FORMAT=reader-v1

  cache-redis:
    image: redis:alpine
    volumes:
      - cache-data:/data

volumes:
  cache-data:
```

---

## 10) Migration & Compatibility

### 10.1 Schema Evolution Rules

- **PATCH** (1.0.0 → 1.0.1): Bug fixes, no schema changes
- **MINOR** (1.0.0 → 1.1.0): Add optional fields, relax constraints
- **MAJOR** (1.0.0 → 2.0.0): Breaking changes, required field modifications

### 10.2 Version Negotiation

```typescript
class VersionNegotiator {
  canAccept(producerVersion: string, consumerVersions: string[]): boolean {
    return consumerVersions.some(cv =>
      semver.satisfies(producerVersion, cv)
    );
  }

  selectBestVersion(available: string[], requested: string): string {
    const compatible = available.filter(v =>
      semver.satisfies(v, requested)
    );
    return semver.maxSatisfying(compatible, requested) || available[0];
  }
}
```

### 10.3 Migration Examples

```typescript
// DocPlan v1.0.0 → v1.1.0 (adds optional "prerequisites" field)
class DocPlanMigrator {
  migrate(from: '1.0.0', to: '1.1.0', data: DocPlanV1): DocPlanV1_1 {
    return {
      ...data,
      payload: {
        ...data.payload,
        prerequisites: [] // sensible default
      }
    };
  }
}
```

---

## Summary

This production-ready architecture provides:

1. **True modularity** through versioned envelopes and adapters
2. **Deterministic caching** for sub-second rebuild times
3. **Comprehensive validation** with typed error handling
4. **Schema evolution** support without breaking changes
5. **Independent deployment** of each module
6. **Contract-first development** enabling parallel team work

The system transforms LLM content generation from brittle prompt engineering into a robust, testable, and maintainable pipeline that scales with team size and complexity requirements.

**Next Steps:**
1. Implement core schemas and validation pipeline
2. Build module scaffolding with contract tests
3. Develop caching infrastructure with content hashing
4. Create deployment automation for independent modules
5. Establish monitoring and error tracking per module