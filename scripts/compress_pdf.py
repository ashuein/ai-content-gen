#!/usr/bin/env python3
"""
Simple PDF compression using pypdf (PyPDF2 successor).
Usage: compress_pdf.py <input.pdf> <output.pdf>
"""
import sys
from pypdf import PdfReader, PdfWriter

def compress_pdf(input_path: str, output_path: str) -> None:
    reader = PdfReader(input_path)
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    # Compress content streams
    try:
        writer.compress_content_streams()
    except Exception:
        # Fallback: ignore if method not available
        pass
    with open(output_path, 'wb') as out_f:
        writer.write(out_f)

def main():
    if len(sys.argv) != 3:
        print("Usage: compress_pdf.py <input.pdf> <output.pdf>", file=sys.stderr)
        sys.exit(1)
    in_pdf, out_pdf = sys.argv[1], sys.argv[2]
    compress_pdf(in_pdf, out_pdf)

if __name__ == '__main__':
    main()