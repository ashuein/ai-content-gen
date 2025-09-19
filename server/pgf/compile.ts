import type { PlotSpec } from '../../types';
import { optimize } from 'svgo';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const allowedExpr = /^[a-zA-Z0-9_\s+\-*/^().]*$/;

export function validateExpr(expr: string) {
	if (!allowedExpr.test(expr)) {
		throw new Error('PlotSpec expr contains illegal tokens');
	}
}

function resolveRepoPathRelative(binPath: string | undefined): string {
	if (!binPath) return '';
	if (binPath.startsWith('./') || binPath.startsWith('.\\')) {
		return path.resolve(process.cwd(), binPath);
	}
	return binPath;
}

async function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }>
{
	return new Promise((resolve) => {
		const ps = spawn(cmd, args, { cwd, shell: false, env: env ?? process.env });
		let out = '';
		let err = '';
		ps.stdout.on('data', (d) => (out += d.toString()));
		ps.stderr.on('data', (d) => (err += d.toString()));
		ps.on('close', (code) => resolve({ code: code ?? 0, stdout: out, stderr: err }));
	});
}

function sanitizeTeXText(s?: string): string {
	if (!s) return '';
	// Escape TeX special chars conservatively
	return s
		.replace(/\\/g, '\\\\')
		.replace(/([#%&$_^{}])/g, '\\$1');
}

function buildTeXFromSpec(spec: PlotSpec, exprReplaced: string): string {
	const xmin = spec.x.min;
	const xmax = spec.x.max;
	const ymin = spec.y.min;
	const ymax = spec.y.max;
	const samples = Math.max(11, spec.style?.samples ?? 201);
	const grid = spec.style?.grid ? ',grid=both' : '';
	// Pass axis labels as raw LaTeX (no escaping) so math renders correctly
	const xlabel = spec.x.label ?? '';
	const ylabel = spec.y.label ?? '';
	const labelOpts = `${xlabel ? `,xlabel={${xlabel}}` : ''}${ylabel ? `,ylabel={${ylabel}}` : ''}`;
	return `\\documentclass[tikz,border=2pt]{standalone}
\\usepackage{pgfplots}
\\pgfplotsset{compat=1.18}
\\begin{document}
\\begin{tikzpicture}
\\begin{axis}[xmin=${xmin}, xmax=${xmax}, ymin=${ymin}, ymax=${ymax}, samples=${samples}${grid}${labelOpts}]
\\addplot[blue, thick, domain=${xmin}:${xmax}] expression{${exprReplaced}};
\\end{axis}
\\end{tikzpicture}
\\end{document}
`;
}

function substituteParams(expr: string, params?: Record<string, number>): string {
	if (!params) return expr;
	let out = expr;
	for (const [name, value] of Object.entries(params)) {
		// replace occurrences of param names with numeric literal (safe: names are [a-zA-Z0-9_])
		const re = new RegExp(`\\b${name}\\b`, 'g');
		out = out.replace(re, String(value));
	}
	return out;
}

export async function compilePlotToSVG(spec: PlotSpec): Promise<string> {
	if (spec.kind !== 'pgfplot') throw new Error('Unsupported plot kind');
	validateExpr(spec.expr);

	const exprWithParams = substituteParams(spec.expr, spec.params);
	validateExpr(exprWithParams);
	const tex = buildTeXFromSpec(spec, exprWithParams);

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pgfplot-'));
	const texPath = path.join(tmpDir, 'plot.tex');
	const pdfPath = path.join(tmpDir, 'plot.pdf');
	await fs.writeFile(texPath, tex, 'utf8');

	const tectonicBin = resolveRepoPathRelative(process.env.TECTONIC_BIN) || 'tectonic';
	const dvisvgmBin = resolveRepoPathRelative(process.env.DVISVGM_PATH) || 'dvisvgm';

	const tRun = await run(tectonicBin, [texPath, '--outdir', tmpDir, '--chatter', 'minimal', '--keep-logs'], tmpDir);
	if (tRun.code !== 0 || !(await fileExists(pdfPath))) {
		throw new Error(`Tectonic failed: ${tRun.stderr || tRun.stdout}`);
	}

	// Ensure Ghostscript is discoverable by dvisvgm by prepending its folder to PATH
	const gsPath = resolveRepoPathRelative(process.env.GHOSTSCRIPT_PATH);
	const gsDir = gsPath ? path.dirname(gsPath) : '';
	const env = { ...process.env } as NodeJS.ProcessEnv;
	if (gsDir) {
		env.PATH = gsDir + path.delimiter + (env.PATH || '');
	}
	// Propagate fontconfig env for Windows to suppress warnings and locate fonts
	if (process.env.FONTCONFIG_FILE) env.FONTCONFIG_FILE = process.env.FONTCONFIG_FILE;
	if (process.env.FONTCONFIG_PATH) env.FONTCONFIG_PATH = process.env.FONTCONFIG_PATH;
	if (process.env.FONTCONFIG_CACHE) env.FONTCONFIG_CACHE = process.env.FONTCONFIG_CACHE;
	// Common aliases sometimes used by fontconfig builds on Windows
	if (process.env.FC_CONFIG_FILE) env.FC_CONFIG_FILE = process.env.FC_CONFIG_FILE;
	if (process.env.FC_CONFIG_DIR) env.FC_CONFIG_DIR = process.env.FC_CONFIG_DIR;

	// Fontmap + font-format for deterministic embedding
	const fontmapPath = resolveRepoPathRelative(process.env.DVISVGM_FONTMAP) || path.join(process.cwd(), 'fontmaps', 'tex2sys.map');
	const fontFormat = process.env.DVISVGM_FONT_FORMAT || 'woff2';

	// dvisvgm expects: --pdf <input.pdf> [options] --stdout
	const vRun = await run(dvisvgmBin, ['--pdf', pdfPath, `--fontmap=${fontmapPath}`, `--font-format=${fontFormat}`, '--stdout'], tmpDir, env);
	if (vRun.code !== 0 || !vRun.stdout) {
		throw new Error(`dvisvgm failed: ${vRun.stderr || '(no stdout)'}`);
	}

	const optimized = optimize(vRun.stdout, { multipass: true }).data;
	return optimized;
}

async function fileExists(p: string): Promise<boolean> {
	try { await fs.access(p); return true; } catch { return false; }
}
