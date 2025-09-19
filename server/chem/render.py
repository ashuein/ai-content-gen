import sys
from typing import Optional

try:
	from rdkit import Chem
	from rdkit.Chem import Draw
except Exception as exc:
	print(f"ERROR: rdkit import failed: {exc}", file=sys.stderr)
	sys.exit(2)


def smiles_to_svg(smiles: str, width: int = 400, height: int = 300) -> str:
	mol = Chem.MolFromSmiles(smiles)
	if mol is None:
		raise ValueError("Invalid SMILES")
	d2d = Draw.MolDraw2DSVG(width, height)
	d2d.DrawMolecule(mol)
	d2d.FinishDrawing()
	svg = d2d.GetDrawingText()
	return svg


def main(argv: list[str]) -> int:
	if len(argv) < 2:
		print("Usage: python render.py <SMILES> [WIDTH] [HEIGHT]", file=sys.stderr)
		return 2
	smiles: str = argv[1]
	w: Optional[int] = int(argv[2]) if len(argv) > 2 else 400
	h: Optional[int] = int(argv[3]) if len(argv) > 3 else 300
	try:
		svg = smiles_to_svg(smiles, w, h)
		# ensure xml header exists
		if not svg.lstrip().startswith("<?xml"):
			svg = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" + svg
		print(svg)
		return 0
	except Exception as exc:
		print(f"ERROR: {exc}", file=sys.stderr)
		return 1


if __name__ == "__main__":
	sys.exit(main(sys.argv))
