# RDKit SVG Service (FastAPI)
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from rdkit import Chem
from rdkit.Chem import Draw

app = FastAPI(title="RDKit SVG Service")

@app.get("/health")
def health():
	return {"status": "ok"}

@app.get("/svg")
def svg(smiles: str):
	try:
		mol = Chem.MolFromSmiles(smiles)
		if mol is None:
			raise ValueError("Invalid SMILES")
		d2d = Draw.MolDraw2DSVG(400, 300)
		d2d.DrawMolecule(mol)
		d2d.FinishDrawing()
		svg = d2d.GetDrawingText()
		return Response(content=svg, media_type="image/svg+xml")
	except Exception as e:
		raise HTTPException(status_code=400, detail=str(e))
