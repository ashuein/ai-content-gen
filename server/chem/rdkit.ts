import { spawn } from 'node:child_process';
import { optimize } from 'svgo';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function smilesToSVG(smiles: string): Promise<string> {
	const httpUrl = process.env.RDKIT_URL;
	if (httpUrl) {
		try {
			const url = `${httpUrl.replace(/\/$/, '')}/svg?smiles=${encodeURIComponent(smiles)}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`RDKit HTTP ${res.status}`);
			return await res.text();
		} catch (err) {
			// fall through to local CLI
		}
	}
	return runLocalPython(smiles);
}

function runLocalPython(smiles: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const py = process.env.RDKIT_PYTHON || 'python';
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = path.dirname(__filename);
		const script = path.join(__dirname, 'render.py');
		const args = [script, smiles];
		const proc = spawn(py, args, { cwd: process.cwd(), shell: false });
		let out = '';
		let err = '';
		proc.stdout.on('data', d => (out += d.toString()))
		proc.stderr.on('data', d => (err += d.toString()))
		proc.on('close', code => {
			if (code === 0 && out.includes('<svg')) {
				try { resolve(optimize(out, { multipass: true }).data) } catch { resolve(out) }
			} else {
				reject(new Error(err || `RDKit CLI failed (code ${code})`))
			}
		});
	});
}
