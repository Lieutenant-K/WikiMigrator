#!/usr/bin/env python3
"""
PyMuPDF 도구 통합 CLI.
PyInstaller로 단일 바이너리로 번들링하여 Electron 앱에 포함한다.

Usage:
  pymupdf-tools extract-images <pdf_path> <output_dir>
  pymupdf-tools extract-table-links <pdf_path>
  pymupdf-tools extract-bullets <pdf_path>
"""
import sys
import json

from extract_images import extract_images
from extract_table_links import extract_table_links
from extract_bullets import extract_bullets


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: pymupdf-tools <command> [args...]\n"
                     "Commands: extract-images, extract-table-links, extract-bullets"
        }))
        sys.exit(1)

    command = sys.argv[1]

    try:
        if command == "extract-images":
            if len(sys.argv) != 4:
                print(json.dumps({
                    "error": "Usage: pymupdf-tools extract-images <pdf_path> <output_dir>"
                }))
                sys.exit(1)
            pdf_path = sys.argv[2]
            output_dir = sys.argv[3]
            result = extract_images(pdf_path, output_dir)
            print(json.dumps(result, ensure_ascii=False))

        elif command == "extract-table-links":
            if len(sys.argv) != 3:
                print(json.dumps({
                    "error": "Usage: pymupdf-tools extract-table-links <pdf_path>"
                }))
                sys.exit(1)
            pdf_path = sys.argv[2]
            result = extract_table_links(pdf_path)
            print(json.dumps(result, ensure_ascii=False))

        elif command == "extract-bullets":
            if len(sys.argv) != 3:
                print(json.dumps({
                    "error": "Usage: pymupdf-tools extract-bullets <pdf_path>"
                }))
                sys.exit(1)
            pdf_path = sys.argv[2]
            result = extract_bullets(pdf_path)
            print(json.dumps(result, ensure_ascii=False))

        else:
            print(json.dumps({
                "error": f"Unknown command: {command}\n"
                         "Available: extract-images, extract-table-links, extract-bullets"
            }))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
