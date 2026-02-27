#!/usr/bin/env python3
"""
PDF에서 PyMuPDF(fitz)를 사용하여 테이블 셀 내부의 하이퍼링크를 추출한다.
각 테이블의 셀별 링크 텍스트와 URI를 JSON으로 반환한다.

Usage: python3 extract_table_links.py <pdf_path>

Output JSON (stdout):
{
  "tables": [
    {
      "page": 0,
      "table_index": 0,
      "row_count": 5,
      "col_count": 2,
      "header_texts": ["열1 헤더", "열2 헤더"],
      "cells": [
        {
          "row": 0, "col": 1,
          "links": [
            { "text": "링크 텍스트", "uri": "https://..." }
          ]
        }
      ]
    }
  ],
  "total_pages": 10
}
"""
import sys
import json
import pymupdf


def extract_table_links(pdf_path):
    doc = pymupdf.open(pdf_path)
    total_pages = len(doc)
    result_tables = []

    for page_num in range(total_pages):
        page = doc[page_num]

        # 1. 페이지의 모든 URI 링크 수집
        page_links = []
        for link in page.get_links():
            uri = link.get("uri")
            if uri:
                page_links.append({
                    "uri": uri,
                    "rect": pymupdf.Rect(link["from"]),
                })

        if not page_links:
            continue

        # 2. 테이블 감지
        finder = page.find_tables()
        if not finder.tables:
            continue

        for table_idx, table in enumerate(finder.tables):
            table_bbox = pymupdf.Rect(table.bbox)

            # 테이블 영역과 교차하는 링크만 필터링
            table_links = [
                lk for lk in page_links
                if table_bbox.intersects(lk["rect"])
            ]

            if not table_links:
                continue

            cells_data = []
            header_texts = []

            # 3. rows[row].cells[col]로 셀 순회
            for row_idx in range(table.row_count):
                row = table.rows[row_idx]
                for col_idx, cell_rect_tuple in enumerate(row.cells):
                    if cell_rect_tuple is None:
                        # 헤더 지문용: 빈 셀
                        if row_idx == 0:
                            header_texts.append("")
                        continue

                    cell_r = pymupdf.Rect(cell_rect_tuple)

                    # 헤더 지문 수집 (첫 행의 셀 텍스트)
                    if row_idx == 0:
                        cell_text = page.get_text("text", clip=cell_r).strip()
                        # 줄바꿈을 공백으로 치환하고 앞부분만 사용
                        cell_text = " ".join(cell_text.split())[:50]
                        header_texts.append(cell_text)

                    # 4. 셀 rect와 교차하는 링크 필터링
                    cell_links = []
                    for lk in table_links:
                        if cell_r.intersects(lk["rect"]):
                            # clip 텍스트로 링크 텍스트 추출 (검증 완료: 28/28 정확)
                            link_text = page.get_text(
                                "text", clip=lk["rect"]
                            ).strip()
                            link_text = " ".join(link_text.split())

                            if link_text:
                                cell_links.append({
                                    "text": link_text,
                                    "uri": lk["uri"],
                                })

                    if cell_links:
                        cells_data.append({
                            "row": row_idx,
                            "col": col_idx,
                            "links": cell_links,
                        })

            if cells_data:
                result_tables.append({
                    "page": page_num,
                    "table_index": table_idx,
                    "row_count": table.row_count,
                    "col_count": table.col_count,
                    "header_texts": header_texts,
                    "cells": cells_data,
                })

    doc.close()

    return {
        "tables": result_tables,
        "total_pages": total_pages,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({
            "error": "Usage: extract_table_links.py <pdf_path>"
        }))
        sys.exit(1)

    pdf_path = sys.argv[1]

    import os
    if not os.path.exists(pdf_path):
        print(json.dumps({"error": f"PDF file not found: {pdf_path}"}))
        sys.exit(1)

    try:
        result = extract_table_links(pdf_path)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
