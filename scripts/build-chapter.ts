import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { DocJSON, PlotSpec, DiagramSpec } from '../types';
import { renderTeXToHTML } from '../server/math/tex';
import { checkEquation } from '../validator/equation';
import { compilePlotToSVG } from '../server/pgf/compile';
import { smilesToSVG } from '../server/chem/rdkit';
import { compileDiagramToSVG } from '../server/diagram/compile';

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function loadJson<T>(filePath: string): Promise<T> {
  const buf = await fs.readFile(filePath, 'utf8');
  return JSON.parse(buf) as T;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const root = process.cwd();
  const outDir = path.join(root, 'CR_rendered');
  await ensureDir(outDir);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const docSchema = await loadJson<any>(path.join(root, 'schema', 'docjson.schema.json'));
  const plotSchema = await loadJson<any>(path.join(root, 'schema', 'plotspec.schema.json'));
  const diagramSchema = await loadJson<any>(path.join(root, 'schema', 'diagramspec.schema.json'));
  const validateDoc = ajv.compile(docSchema);
  const validatePlot = ajv.compile(plotSchema);
  const validateDiagram = ajv.compile(diagramSchema);

  // Resolve input chapter path: --input, CHAPTER_INPUT, or sensible defaults
  const argv = process.argv.slice(2);
  let chapterInput: string | undefined;
  const inputFlagIndex = argv.findIndex((a) => a === '--input' || a === '-i');
  if (inputFlagIndex >= 0 && argv[inputFlagIndex + 1]) {
    chapterInput = argv[inputFlagIndex + 1];
  }
  if (!chapterInput && process.env.CHAPTER_INPUT) {
    chapterInput = process.env.CHAPTER_INPUT;
  }

  let chapterPath = chapterInput ? path.resolve(root, chapterInput) : '';
  if (!chapterPath) {
    const candidate1 = path.join(root, 'CR_chapters', 'gravitation.json');
    const candidate2 = path.join(root, 'CR_chapters', 'hello-chapter.json');
    if (await fileExists(candidate1)) {
      chapterPath = candidate1;
    } else {
      chapterPath = candidate2;
    }
  }

  const chapter = await loadJson<DocJSON>(chapterPath);
  if (!validateDoc(chapter)) {
    console.error('DocJSON schema errors:', validateDoc.errors);
    throw new Error('Schema validation failed for DocJSON');
  }

  const renderedSections: any[] = [];
  for (const section of chapter.sections) {
    if (section.type === 'equation') {
      checkEquation(section.check);
      const html = renderTeXToHTML(section.tex);
      renderedSections.push({ ...section, html });
    } else if (section.type === 'plot') {
      const specPath = path.join(root, section.specRef);
      const spec = await loadJson<PlotSpec>(specPath);
      if (!validatePlot(spec)) {
        console.error('PlotSpec errors:', validatePlot.errors);
        throw new Error(`PlotSpec validation failed: ${section.id}`);
      }
      const svg = await compilePlotToSVG(spec);
      renderedSections.push({ ...section, svg });
    } else if (section.type === 'chem') {
      const svg = await smilesToSVG(section.smiles);
      renderedSections.push({ ...section, svg });
    } else if (section.type === 'diagram') {
      const specPath = path.join(root, section.specRef);
      const spec = await loadJson<DiagramSpec>(specPath);
      if (!validateDiagram(spec)) {
        console.error('DiagramSpec errors:', validateDiagram.errors);
        throw new Error(`DiagramSpec validation failed: ${section.id}`);
      }
      const svg = compileDiagramToSVG(spec);
      renderedSections.push({ ...section, svg });
    } else if (section.type === 'paragraph' || section.type === 'widget') {
      renderedSections.push(section);
    } else {
      throw new Error(`Unknown section type: ${(section as any).type}`);
    }
  }

  const out = { meta: chapter.meta, sections: renderedSections };
  const outPath = path.join(outDir, 'chapter.json');
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
