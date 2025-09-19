# Content Engine - Production-Ready LLM Content Generation

A modular, contract-first architecture for generating educational content with true Lego-brick modularity.

## 🏗️ Architecture Overview

This implementation follows the production-ready architecture specified in `con_gen_schema.md`, featuring:

- **4 Independent Modules**: M1-Plan → M2-Scaffold → M3-Section → M4-Assembler
- **Versioned Message Envelopes**: All inter-module communication uses semantic versioning
- **Contract-First Development**: Each module defines strict input/output schemas
- **Deterministic Caching**: SHA256 content hashing for sub-second rebuilds
- **11 Validation Gates**: Comprehensive error detection and repair strategies
- **FSM Pipeline Orchestration**: Fail-fast with no partial outputs

## 📁 Project Structure

```
content-engine/
├── m1-plan/                    # M1: Document planning module
│   ├── schemas/                # DocPlan v1.0 schema
│   ├── src/                    # Plan generation logic
│   └── tests/                  # Unit and contract tests
├── m2-scaffold/                # M2: Content scaffolding module
├── m3-section/                 # M3: Section generation module
├── m4-assembler/               # M4: Final assembly module
├── adapters/                   # Cross-module adapters
│   └── schemas/                # SectionContext v1.0 schema
├── schemas-shared/             # Shared schemas and contracts
│   ├── envelope.v1.schema.json       # Message envelope standard
│   ├── reader.v1.schema.json         # Reader DocJSON contract
│   ├── plotspec.v1.schema.json       # Mathematical plots
│   ├── diagramspec.v1.schema.json    # Geometric diagrams
│   ├── widgetspec.v1.schema.json     # Interactive widgets
│   ├── chemspec.v1.schema.json       # Chemical structures
│   └── id-conventions.v1.schema.json # Deterministic ID scheme
├── validators/                 # Validation pipeline (G1-G11)
├── fsm/                        # State machine orchestration
├── compilers/                  # Asset compilation (PGFPlots, RDKit, Diagram)
├── cache/                      # SHA256-keyed artifact cache
└── artifacts/                  # Final output files
```

## 🔧 Implementation Status

### ✅ Completed
- [x] Monorepo structure with proper module boundaries
- [x] Shared schemas (envelope, reader, plotspec, diagramspec, widgetspec, chemspec)
- [x] M1-Plan module with beat validation and dependency graph checking
- [x] SectionContext adapter schema for M2→M3 decoupling
- [x] TypeScript interfaces and core types
- [x] Deterministic content hashing utilities

### 🚧 In Progress
- [ ] M2-Scaffold module implementation
- [ ] M3-Section module with validation gates G1-G11
- [ ] M4-Assembler with Reader DocJSON output
- [ ] Validation pipeline with all 11 gates
- [ ] FSM pipeline orchestrator
- [ ] Compiler infrastructure (PGFPlots, RDKit, Diagram)

## 🎯 Key Features Implemented

### 1. Versioned Message Envelopes
Every inter-module communication uses standardized envelopes:
```typescript
interface Envelope<T> {
  version: string;           // Semantic version (e.g., "1.0.0")
  producer: string;          // Module identifier
  timestamp: string;         // ISO 8601 timestamp
  correlationId: string;     // Request tracking ID
  contentHash: string;       // SHA256 for integrity
  compatible?: string[];     // Compatible version ranges
}
```

### 2. Beat Dependency Validation (M1)
The M1-Plan module includes sophisticated validation:
- **Cycle Detection**: DFS-based algorithm prevents circular dependencies
- **Reference Integrity**: Ensures all prereq references exist
- **Asset Format Validation**: Enforces `type:name` pattern for asset suggestions

### 3. Deterministic Content Hashing
All artifacts use SHA256 hashing for cache keys:
```typescript
// Normalized for consistent hashing
const contentHash = crypto.createHash('sha256')
  .update(JSON.stringify(normalizedContent))
  .digest('hex');
```

### 4. Schema-First Development
Every module defines strict JSON schemas:
- Input validation with AJV
- Output contract enforcement
- Version compatibility checking
- `additionalProperties: false` for strict validation

## 🧪 Testing Strategy

### Unit Tests
Each module includes comprehensive unit tests:
```typescript
// Example: Beat validator tests
describe('BeatValidator', () => {
  test('should detect circular dependency', () => {
    const beats = createCircularDependency();
    const result = BeatValidator.validateDependencyGraph(beats);
    expect(result.valid).toBe(false);
  });
});
```

### Contract Tests
Cross-module integration verification:
```typescript
// Ensures M2 output is compatible with M3 input
test('adapter should transform Scaffold to SectionContext', () => {
  const scaffold = loadFixture('sample-scaffold.json');
  const contexts = adapter.transform(scaffold);
  expect(sectionGenerator.canHandle(contexts[0])).toBe(true);
});
```

## 🔍 Validation Gates

The system implements 11 validation gates across modules:

| Gate | Module | Purpose | Implementation Status |
|------|--------|---------|----------------------|
| G1 | All | AJV Schema Validation | ✅ Implemented |
| G2 | M1 | Beat Dependency Graph | ✅ Implemented |
| G3 | M1,M3 | Asset Format Validation | ✅ Implemented |
| G4 | M3 | Mathematical Expression | 🚧 Pending |
| G5 | M3 | Plot Expression Lexer | 🚧 Pending |
| G6 | M3 | RDKit SMILES Validation | 🚧 Pending |
| G7 | M3 | Diagram Topology | 🚧 Pending |
| G8 | M4 | Cross-reference Uniqueness | 🚧 Pending |
| G9 | All | Unicode Sanitization | 🚧 Pending |
| G10 | M4 | Reader Contract | 🚧 Pending |
| G11 | M3 | Dimensional Analysis | 🚧 Pending |

## 🚀 Getting Started

### Prerequisites
- Node.js ≥ 18.0.0
- npm ≥ 8.0.0

### Installation
```bash
cd content-engine
npm install
```

### Development
```bash
# Build all modules
npm run build

# Run tests
npm run test

# Validate schemas
npm run validate:schemas

# Start development mode
npm run dev
```

## 📋 Next Implementation Steps

1. **Complete M2-Scaffold Module**
   - Implement scaffold generation logic
   - Create SectionContext adapter
   - Add G1-G3 validation gates

2. **Build M3-Section Module**
   - Implement content generation pipeline
   - Add KaTeX validation (G3)
   - Implement dimensional analysis (G11)
   - Add seeded numeric validation

3. **Create M4-Assembler Module**
   - Implement Reader DocJSON assembly
   - Add deterministic ID generation
   - Implement G10 Reader contract validation

4. **Complete Validation Pipeline**
   - Implement remaining gates G4-G11
   - Add error repair strategies
   - Create correction logging system

5. **Build FSM Orchestrator**
   - Implement pipeline state machine
   - Add fail-fast error handling
   - Create correlation ID tracking

## 🎓 Educational Insights

This implementation demonstrates several advanced software engineering patterns:

1. **Contract-First Architecture**: Schemas define interfaces before implementation
2. **Versioned Message Passing**: Enables independent module evolution
3. **Content-Addressed Storage**: Deterministic caching with integrity guarantees
4. **Validation Pipeline Pattern**: Composable validation with repair strategies
5. **FSM-Based Orchestration**: Predictable state transitions with error handling

The architecture ensures that LLM content generation transforms from brittle prompt engineering into a robust, testable, and maintainable pipeline that scales with team size and complexity requirements.