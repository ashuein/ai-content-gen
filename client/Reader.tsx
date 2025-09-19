import React, { useEffect, useMemo, useState } from 'react';
import type { DocJSON, Section } from '../types';
import { Widget } from './Widget';
import katex from 'katex';

type RenderedSection =
  | (Section & { type: 'equation'; html?: string })
  | (Section & { type: 'plot' | 'chem' | 'diagram'; svg?: string })
  | Section;

export const Reader: React.FC = () => {
  const [chapter, setChapter] = useState<{ meta: DocJSON['meta']; sections: RenderedSection[] } | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const run = async () => {
      try {
        setLog(l => [...l, 'Fetching pre-rendered chapter...']);
        const res = await fetch('/chapter.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setChapter(data);
        setLog(l => [...l, 'Loaded chapter.']);
      } catch (err: any) {
        setLog(l => [...l, `Failed to load chapter: ${err?.message || String(err)}`]);
      }
    };
    run();
  }, []);

  const toc = useMemo(() => (chapter?.sections ?? []).map(s => s.id), [chapter]);

  return (
    <div id="layout">
      <main>
        {chapter ? (
          <>
            <h1>{chapter.meta.title}</h1>
            {(chapter.sections as RenderedSection[]).map((s) => (
              <section key={s.id} className="section" id={s.id}>
                {s.type === 'paragraph' && <p dangerouslySetInnerHTML={{ __html: renderMarkdownInline(s.md) }} />}
                {s.type === 'equation' && s.html && (
                  <div className="equation" dangerouslySetInnerHTML={{ __html: s.html }} />
                )}
                {s.type === 'plot' && s.svg && (
                  <div className="svg-container" dangerouslySetInnerHTML={{ __html: s.svg }} />
                )}
                {s.type === 'chem' && s.svg && (
                  <figure className="svg-container" dangerouslySetInnerHTML={{ __html: s.svg }} />
                )}
                {s.type === 'diagram' && s.svg && (
                  <div className="svg-container" dangerouslySetInnerHTML={{ __html: s.svg }} />
                )}
                {s.type === 'widget' && <Widget spec={s.widget} />}
              </section>
            ))}
          </>
        ) : (
          <p>Loading...</p>
        )}
      </main>
      <aside>
        <h3>Sections</h3>
        <ul>
          {toc.map(id => (
            <li key={id}><a href={`#${id}`}>{id}</a></li>
          ))}
        </ul>
        <h3>Debug</h3>
        <pre className="debug">{log.join('\n')}</pre>
      </aside>
    </div>
  );
};

function renderMarkdownInline(md: string): string {
  // Escape basic HTML
  let html = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Inline code first: protect with placeholders
  const codeSpans: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_m, g1) => {
    const idx = codeSpans.push(g1) - 1;
    return `%%CODE_${idx}%%`;
  });
  // KaTeX inline math: $...$ (non-greedy, ignore escaped \$)
  html = html.replace(/(^|[^\\])\$([^$]+?)\$/g, (match, before, body) => {
    try {
      const rendered = katex.renderToString(body, { throwOnError: false, displayMode: false, strict: 'ignore' });
      return `${before}${rendered}`;
    } catch {
      return match; // leave as-is on error
    }
  });
  // Restore code spans
  html = html.replace(/%%CODE_(\d+)%%/g, (_m, idx) => `<code>${codeSpans[Number(idx)]}</code>`);
  return html;
}
