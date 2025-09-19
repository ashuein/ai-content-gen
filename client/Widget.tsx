import React, { useMemo, useState } from 'react';
import type { FormulaWidgetSpec } from '../types';
import { create, all } from 'mathjs';

const math = create(all, { matrix: 'Array' });

export const Widget: React.FC<{ spec: FormulaWidgetSpec }> = ({ spec }) => {
  const [params, setParams] = useState<Record<string, number>>(
    Object.fromEntries(spec.params.map(p => [p.name, p.default]))
  );

  const value = useMemo(() => {
    try {
      const scope = { ...params } as any;
      const node = math.parse(spec.expr);
      return node.evaluate(scope);
    } catch {
      return NaN;
    }
  }, [params, spec.expr]);

  const pathD = useMemo(() => {
    try {
      const samples = 200;
      const minX = 0, maxX = 10;
      const width = 360, height = 160, padding = 24;
      const node = math.parse(spec.expr);
      const scope: any = { ...params, x: 0 };
      const xs = Array.from({ length: samples }, (_, i) => minX + (i * (maxX - minX)) / (samples - 1));
      const ys = xs.map(x => {
        scope.x = x;
        const y = node.evaluate(scope);
        return Number.isFinite(y) ? y : NaN;
      });
      const finiteYs = ys.filter(Number.isFinite) as number[];
      const minY = Math.min(...finiteYs, 0);
      const maxY = Math.max(...finiteYs, 1);
      const sx = (x: number) => padding + ((x - minX) / (maxX - minX)) * (width - 2 * padding);
      const sy = (y: number) => height - padding - ((y - minY) / (maxY - minY || 1)) * (height - 2 * padding);
      let d = '';
      xs.forEach((x, i) => {
        const y = ys[i];
        if (!Number.isFinite(y)) return;
        d += (d ? ' L ' : 'M ') + sx(x).toFixed(2) + ' ' + sy(y).toFixed(2);
      });
      return { d, width, height, padding };
    } catch {
      return { d: '', width: 360, height: 160, padding: 24 };
    }
  }, [params, spec.expr]);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        {spec.params.map(p => (
          <label key={p.name} style={{ display: 'grid', gap: 4 }}>
            <span>{p.name}: {params[p.name].toFixed(3)}</span>
            <input
              type="range"
              min={p.min}
              max={p.max}
              step={p.step}
              value={params[p.name]}
              onChange={e => setParams(s => ({ ...s, [p.name]: Number(e.target.value) }))}
            />
          </label>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <strong>Value</strong>: {Number.isFinite(value) ? value.toFixed(6) : '—'}
      </div>
      {pathD.d && (
        <svg width={pathD.width} height={pathD.height} role="img" aria-label="formula curve">
          <rect x="0" y="0" width={pathD.width} height={pathD.height} fill="#fff" stroke="#ddd" />
          <path d={pathD.d} fill="none" stroke="#1976d2" strokeWidth="2" />
        </svg>
      )}
    </div>
  );
};
