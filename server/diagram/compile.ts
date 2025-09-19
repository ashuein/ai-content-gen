import type { DiagramSpec } from '../../types';
import { optimize } from 'svgo';

export function compileDiagramToSVG(spec: DiagramSpec): string {
  const { width, height, grid, snap } = spec.canvas;
  const nodes = spec.nodes.map(n => snap ? snapNode(n, grid) : n);
  if (spec.rules?.requiredNodes) {
    const ids = new Set(nodes.map(n => (n as any).id));
    for (const r of spec.rules.requiredNodes) {
      if (!ids.has(r)) throw new Error(`Missing required node: ${r}`);
    }
  }
  const elements: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'point') {
      elements.push(`<circle cx="${n.x}" cy="${n.y}" r="3" fill="#000" />`);
      if (n.label) elements.push(`<text x="${n.x + 6}" y="${n.y - 6}" font-size="12">${escapeXml(n.label)}</text>`);
    } else if (n.kind === 'arrow') {
      const [x1, y1] = n.from; const [x2, y2] = n.to;
      elements.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#000"/></marker></defs>`);
      elements.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" marker-end="url(#arrow)"/>`);
      if (n.label) elements.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 8}" font-size="12">${escapeXml(n.label)}</text>`);
    }
  }
  if (spec.labels) {
    for (const lb of spec.labels) {
      const target = nodes.find(n => (n as any).id === lb.of);
      if (target && target.kind === 'arrow') {
        const [x1, y1] = target.from; const [x2, y2] = target.to;
        const xm = (x1 + x2) / 2 + (lb.dx || 0);
        const ym = (y1 + y2) / 2 + (lb.dy || 0);
        elements.push(`<text x="${xm}" y="${ym}" font-size="12">${escapeXml(lb.text)}</text>`);
      }
    }
  }
  const rawSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#fff" />
  ${elements.join('\n')}
</svg>`;
  const { data } = optimize(rawSvg, { multipass: true });
  return data;
}

function snapNode(node: DiagramSpec['nodes'][number], grid: number): any {
  const snapVal = (v: number) => Math.round(v / grid) * grid;
  if (node.kind === 'point') return { ...node, x: snapVal(node.x), y: snapVal(node.y) };
  const [x1, y1] = node.from; const [x2, y2] = node.to;
  return { ...node, from: [snapVal(x1), snapVal(y1)] as [number, number], to: [snapVal(x2), snapVal(y2)] as [number, number] };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
