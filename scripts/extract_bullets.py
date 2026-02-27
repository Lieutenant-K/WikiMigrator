#!/usr/bin/env python3
"""
PDF에서 PyMuPDF(fitz)를 사용하여 벡터 그래픽 불릿 마커를 추출한다.
Confluence 등에서 내보낸 PDF의 불릿은 텍스트가 아닌 벡터 도형(■, ○)으로
렌더링되어 Marker가 인식하지 못한다. 이 스크립트는 해당 도형을 감지하고
대응하는 텍스트 라인을 함께 반환한다.

Usage: python3 extract_bullets.py <pdf_path>

Output JSON (stdout):
{
  "bullets": [
    {
      "page": 3,
      "y": 206.5,
      "indent_level": 0,
      "text": "preview / detail 타입별로 동작..."
    }
  ],
  "total_pages": 4
}
"""
import sys
import os
import json
import pymupdf


# 불릿 도형 크기 필터 (포인트 단위)
BULLET_MIN_SIZE = 1.0
BULLET_MAX_SIZE = 5.0

# 불릿 y좌표와 텍스트 라인 y좌표 허용 오차 (포인트)
Y_TOLERANCE = 5.0

# indent_level 클러스터링 시 x좌표 허용 오차 (포인트)
X_CLUSTER_TOLERANCE = 3.0

# 텍스트 최대 길이
TEXT_MAX_LEN = 200


def _find_table_rects(page):
    """페이지 내 모든 테이블의 bounding box를 반환한다."""
    rects = []
    try:
        # find_tables()가 stdout에 안내 메시지를 출력하므로 억제
        import io, contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            finder = page.find_tables()
        for table in finder.tables:
            rects.append(pymupdf.Rect(table.bbox))
    except Exception:
        pass
    return rects


def _is_inside_any_rect(point_rect, rects):
    """point_rect가 rects 중 하나에 포함되는지 확인한다."""
    for r in rects:
        if r.contains(point_rect):
            return True
    return False


def _extract_bullet_shapes(page, table_rects):
    """
    페이지의 벡터 도형 중 불릿 후보를 추출한다.

    불릿 조건:
    - 크기: BULLET_MIN_SIZE < width ≤ BULLET_MAX_SIZE, height 동일
    - 위치: 테이블 영역 밖
    - 형태: 채워진(filled) 도형 또는 윤곽선(stroke) 도형
    """
    bullets = []
    drawings = page.get_drawings()

    for d in drawings:
        r = d["rect"]
        w = r.x1 - r.x0
        h = r.y1 - r.y0

        # 크기 필터
        if not (BULLET_MIN_SIZE < w <= BULLET_MAX_SIZE and
                BULLET_MIN_SIZE < h <= BULLET_MAX_SIZE):
            continue

        # 테이블 내부 제외
        if _is_inside_any_rect(r, table_rects):
            continue

        bullets.append({
            "x": round(r.x0, 1),
            "y": round(r.y0, 1),
            "y_center": round((r.y0 + r.y1) / 2, 1),
        })

    # y좌표 순 정렬
    bullets.sort(key=lambda b: b["y"])
    return bullets


def _cluster_indent_levels(bullets):
    """
    불릿의 x좌표를 클러스터링하여 indent_level을 산출한다.
    가장 왼쪽 x = level 0, 그 다음 = level 1, ...
    """
    if not bullets:
        return []

    # 고유 x좌표 수집 (허용 오차 내 동일 그룹)
    x_values = sorted(set(b["x"] for b in bullets))
    clusters = []
    for x in x_values:
        merged = False
        for c in clusters:
            if abs(x - c) <= X_CLUSTER_TOLERANCE:
                merged = True
                break
        if not merged:
            clusters.append(x)

    clusters.sort()

    # 각 불릿에 indent_level 할당
    for b in bullets:
        level = 0
        for i, cx in enumerate(clusters):
            if abs(b["x"] - cx) <= X_CLUSTER_TOLERANCE:
                level = i
                break
        b["indent_level"] = level

    return bullets


def _find_text_for_bullet(page, bullet_y_center):
    """
    불릿의 y좌표에 대응하는 텍스트 라인을 찾는다.
    get_text('dict')의 line 단위로 y좌표 매칭.
    """
    data = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE)

    best_line = None
    best_dist = float("inf")

    for block in data["blocks"]:
        if block.get("type", 0) != 0:  # 텍스트 블록만
            continue

        for line in block["lines"]:
            line_bbox = line["bbox"]
            line_y_center = (line_bbox[1] + line_bbox[3]) / 2

            dist = abs(line_y_center - bullet_y_center)
            if dist < best_dist and dist <= Y_TOLERANCE:
                # 라인 텍스트 조합
                text = "".join(span["text"] for span in line["spans"]).strip()
                if text:
                    best_dist = dist
                    best_line = text

    if best_line and len(best_line) > TEXT_MAX_LEN:
        best_line = best_line[:TEXT_MAX_LEN]

    return best_line


def extract_bullets(pdf_path):
    doc = pymupdf.open(pdf_path)
    total_pages = len(doc)
    all_bullets = []

    for page_num in range(total_pages):
        page = doc[page_num]

        # 테이블 영역 감지
        table_rects = _find_table_rects(page)

        # 불릿 도형 추출
        shapes = _extract_bullet_shapes(page, table_rects)
        if not shapes:
            continue

        # indent_level 산출
        _cluster_indent_levels(shapes)

        # 각 불릿에 대응하는 텍스트 찾기
        for shape in shapes:
            text = _find_text_for_bullet(page, shape["y_center"])
            if not text:
                continue

            all_bullets.append({
                "page": page_num,
                "y": shape["y"],
                "indent_level": shape["indent_level"],
                "text": text,
            })

    doc.close()

    return {
        "bullets": all_bullets,
        "total_pages": total_pages,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: extract_bullets.py <pdf_path>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]

    if not os.path.exists(pdf_path):
        print(json.dumps({"error": f"PDF file not found: {pdf_path}"}))
        sys.exit(1)

    try:
        result = extract_bullets(pdf_path)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
