import katex from 'katex';

export function renderTeXToHTML(tex: string): string {
  try {
    return katex.renderToString(tex, {
      throwOnError: true,
      output: 'mathml',
      strict: 'error',
      trust: false,
      displayMode: true
    });
  } catch (err) {
    const message = (err as Error)?.message || 'KaTeX render error';
    throw new Error(message);
  }
}
