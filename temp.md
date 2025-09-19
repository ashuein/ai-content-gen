\[#content-engine-audit-v2.1]

## 1) Verdict (strict)

i) **Yes—this draft is \~90–95% complete and implementation-ready.** It captures the contract-first, modular pipeline, versioned envelopes, Reader DocJSON contract, validation gates (G1–G10), cache-by-hash, and compiler/security constraints we discussed.&#x20;
ii) **Blockers?** None hard.
iii) **Must-do touch-ups (below)** will prevent edge-case regressions and simplify future refactors.

---

## 2) What’s solid (keep as-is)

1. **Versioned envelopes + compatibility matrix** across M1–M4. ✔&#x20;
2. **Adapter to SectionContext** decoupling M2→M3. ✔&#x20;
3. **Reader DocJSON schema (v1)** and **G10: Reader contract gate** at M4. ✔&#x20;
4. **Deterministic caching** (SHA256 + templateVersion) for PGFPlots/RDKit/Diagram/KaTeX. ✔&#x20;
5. **Security**: no shell-escape, SVG sanitizer, LaTeX denylist, path traversal guards. ✔&#x20;
6. **Typed error taxonomy + repair strategies** and **FSM halting rules** (no partial publish). ✔&#x20;
7. **Monorepo structure** mirroring module boundaries + shared schemas. ✔&#x20;

---

## 3) Gaps to close before “freeze” (small, high-ROI)

|  # | Add / Change                                                                                                                      | Why (failure it prevents)                                                        | Where to put it                                                                                 |                                                               |                                                                                                           |
| -: | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
|  1 | **WidgetSpec schema (explicit)** for `formula-playground` and (future) `plot` widgets (param constraints, debounce, sample caps). | Prevents LLM inventing fields; caps runtime cost.                                | `/schemas-shared/widgetspec.v1.schema.json`; tighten `Reader DocJSON` to reference it.          |                                                               |                                                                                                           |
|  2 | **ChemSpec schema** allowing \`smiles                                                                                             | inchi                                                                            | pubchem\_cid\` (oneOf) + atom/count caps.                                                       | RDKit parse fallback paths become explicit; fewer hard fails. | `/schemas-shared/chemspec.v1.schema.json`; have M3 emit ChemSpec, M4 dereference to `smiles` for Reader.  |
|  3 | **Dimensional-analysis gate (G11)** with per-section unit map (L, T, M, etc.).                                                    | Catches equation “correct-looking” numeric passes with unit errors.              | `/validators/units.ts`; add G11 after G4 in M3; store unit map in ValidationReport.             |                                                               |                                                                                                           |
|  4 | **Deterministic ID scheme** for anchors (`eq:<slug>-<seq>`, `fig:<slug>-<seq>`; collision test).                                  | Stable highlights/links across rebuilds; avoids duplicate IDs caught only at M4. | Document in Reader contract; add G8b “ID format check” in M4.                                   |                                                               |                                                                                                           |
|  5 | **Numeric checks with k seeded trials** (k=3–5) per equation (not single example).                                                | Prevents cherry-picked `vars` passing tolerance.                                 | Extend G4 to run multiple seeds; record seeds in report.                                        |                                                               |                                                                                                           |
|  6 | **Visual regression (SSIM ≥ 0.99)** for compiled SVGs (PGFPlots/Diagram) against goldens (DPR 1/2/3).                             | Detects layout/style drift from template or sanitizer updates.                   | `/validators/visual.ts`; optional in CI “strict” job.                                           |                                                               |                                                                                                           |
|  7 | **Explicit TeX package allowlist** for tectonic (`pgfplots`, `tikz`, `amsmath`, `siunitx` …) enforced in template.                | Stops accidental dependency creep / compile variability.                         | Pin in `compilers/pgfplots/tectonic-wrapper.ts`.                                                |                                                               |                                                                                                           |
|  8 | **Reader highlight anchor contract** (`{section_id, startOffset, endOffset, text_hash}`) documented.                              | Future Reader updates won’t break annotations.                                   | Add to `reader.v1.schema.json` as `annotations` meta or separate `reader-anchors.schema.json`.  |                                                               |                                                                                                           |
|  9 | **SLOs/KPIs** (build time, cache hit rate, validation pass-rate) with thresholds.                                                 | Keeps “automated” healthy under scale; alerts on drift.                          | Add to `/fsm/state-machine.ts` metrics + README “Ops”.                                          |                                                               |                                                                                                           |

---

## 4) Quick “go/no-go” checklist

1. All schemas validate with `additionalProperties:false`. ✅&#x20;
2. M4 validates output against **Reader DocJSON v1** (G10). ✅&#x20;
3. Compiler sandboxing + sanitizer rules are written and pinned. ✅&#x20;
4. **Add** WidgetSpec + ChemSpec + Units gate (G11) + seeded numeric tests. ⏳
5. **Add** deterministic ID convention doc + (optional) SSIM regression. ⏳

**Decision:** **Go**, with items **#1–#5** scheduled immediately (they’re <1–2 dev-days total). After those, freeze the spec and start module implementation.

---

## 5) Naming question (again, briefly)

* Stick with `content-engine/m{1..4}-<verb>`; **do not** prepend `CG_`. It’s clearer, grep-able, and plays nice with tooling.&#x20;

---

If you want, I’ll draft **WidgetSpec v1** + **ChemSpec v1** + a tiny **units gate** stub next, so your repo is truly “green to build.”
