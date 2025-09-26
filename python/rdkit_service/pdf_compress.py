import sys
from pathlib import Path
from typing import Optional

from pypdf import PdfWriter


def compress_pdf(input_path: str, output_path: str, lossless: bool = True, image_quality: Optional[int] = None) -> None:
    src = Path(input_path)
    dst = Path(output_path)
    writer = PdfWriter(clone_from=str(src))

    # Lossless page stream compression first
    if lossless:
        for page in writer.pages:
            try:
                page.compress_content_streams(level=9)
            except Exception:
                pass

    # Optional image quality reduction
    if image_quality is not None:
        try:
            for page in writer.pages:
                for img in getattr(page, "images", []):
                    try:
                        img.replace(img.image, quality=int(image_quality))
                    except Exception:
                        # Best-effort per image
                        pass
        except Exception:
            pass

    # De-duplicate identical objects and drop orphans
    try:
        writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    except Exception:
        # Not fatal if not available on this version
        pass

    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("wb") as f:
        writer.write(f)


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: python pdf_compress.py <input.pdf> <output.pdf> [image_quality]")
        return 2
    input_pdf = sys.argv[1]
    output_pdf = sys.argv[2]
    quality = int(sys.argv[3]) if len(sys.argv) > 3 else None
    compress_pdf(input_pdf, output_pdf, lossless=True, image_quality=quality)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


