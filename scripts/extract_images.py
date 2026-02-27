#!/usr/bin/env python3
"""
PDF에서 PyMuPDF(fitz)를 사용하여 모든 임베디드 이미지를 추출한다.
각 이미지에 대해 인접 텍스트(anchor_text)를 함께 기록하여
마크다운 내 정확한 삽입 위치를 결정할 수 있도록 한다.

Usage: python3 extract_images.py <pdf_path> <output_dir>

Output JSON (stdout):
{
  "images": [
    {
      "filename": "page0_img0.png",
      "page": 0,
      "y_position": 150.5,
      "width": 400,
      "height": 300,
      "anchor_text": "서버 구성 방법은 다음과 같다."
    }
  ],
  "total_pages": 10
}
"""
import sys
import os
import json
import pymupdf


MIN_IMAGE_SIZE = 1024  # 1KB 미만 이미지 필터링 (아이콘/장식)
ANCHOR_TEXT_MAX_LEN = 80  # anchor_text 최대 길이
CALIBRATION_TEXT_MAX_LEN = 120  # 보정 포인트용 텍스트 최대 길이


def find_anchor_text(page, image_y, image_bottom_y):
    """
    이미지 인접 텍스트를 찾는다.
    1순위: 이미지 위의 텍스트 (anchor_above)
    2순위: 이미지 아래의 텍스트 (anchor_below) — 위에 텍스트가 없을 때

    Returns: (text, position)
        position: "above" 이면 이미지를 텍스트 뒤에 삽입
                  "below" 이면 이미지를 텍스트 앞에 삽입
    """
    blocks = page.get_text("blocks")
    # 텍스트 블록만 필터링 (type=0이 텍스트, type=1이 이미지)
    text_blocks = [b for b in blocks if b[6] == 0 and b[4].strip()]

    # y좌표(상단) 기준으로 정렬
    text_blocks.sort(key=lambda b: b[1])

    # 1순위: 이미지 위에 있는 텍스트 (하단이 이미지 상단보다 위)
    best_above = None
    for block in text_blocks:
        block_bottom = block[3]  # y1 (하단 좌표)
        if block_bottom <= image_y + 5:  # 약간의 여유 허용
            best_above = block

    if best_above is not None:
        text = _normalize_anchor(best_above[4])
        return (text, "above")

    # 2순위: 이미지 아래에 있는 첫 번째 텍스트
    for block in text_blocks:
        block_top = block[1]  # y0 (상단 좌표)
        if block_top >= image_bottom_y - 5:
            text = _normalize_anchor(block[4])
            return (text, "below")

    return ("", "above")


def _normalize_anchor(raw_text):
    """anchor_text를 정규화한다."""
    text = raw_text.strip()
    text = " ".join(text.split())
    if len(text) > ANCHOR_TEXT_MAX_LEN:
        text = text[-ANCHOR_TEXT_MAX_LEN:]
    return text


def extract_page_text_blocks(page):
    """
    페이지 내 모든 텍스트 블록의 y좌표와 텍스트를 추출한다.
    좌표 기반 보간의 보정 포인트(calibration point) 생성에 사용된다.
    """
    blocks = page.get_text("blocks")
    result = []
    for b in blocks:
        if b[6] == 0 and b[4].strip():  # type==0 (텍스트), 비어있지 않음
            text = b[4].strip()
            text = " ".join(text.split())
            if len(text) > CALIBRATION_TEXT_MAX_LEN:
                text = text[:CALIBRATION_TEXT_MAX_LEN]
            result.append({
                "y": round(b[1], 1),
                "y_bottom": round(b[3], 1),
                "text": text,
            })
    result.sort(key=lambda x: x["y"])
    return result


def extract_images(pdf_path, output_dir):
    doc = pymupdf.open(pdf_path)
    total_pages = len(doc)
    os.makedirs(output_dir, exist_ok=True)

    images = []
    seen_xrefs = set()
    page_text_blocks = {}
    page_heights = {}

    for page_num in range(total_pages):
        page = doc[page_num]
        page_text_blocks[str(page_num)] = extract_page_text_blocks(page)
        page_heights[str(page_num)] = round(page.rect.height, 1)
        image_list = page.get_images(full=True)
        image_info_list = page.get_image_info(xrefs=True)

        for img_index, img in enumerate(image_list):
            xref = img[0]

            if xref in seen_xrefs:
                continue
            seen_xrefs.add(xref)

            try:
                base_image = doc.extract_image(xref)
            except Exception:
                continue

            if not base_image or not base_image.get("image"):
                continue

            image_bytes = base_image["image"]
            image_ext = base_image.get("ext", "png")

            if len(image_bytes) < MIN_IMAGE_SIZE:
                continue

            filename = f"page{page_num}_img{img_index}.{image_ext}"
            filepath = os.path.join(output_dir, filename)

            with open(filepath, "wb") as f:
                f.write(image_bytes)

            # bbox 정보 찾기
            y_position = 0.0
            y_bottom = 0.0
            width = base_image.get("width", 0)
            height = base_image.get("height", 0)

            for info in image_info_list:
                if info.get("xref") == xref:
                    bbox = info.get("bbox", (0, 0, 0, 0))
                    y_position = bbox[1]  # top-y
                    y_bottom = bbox[3]    # bottom-y
                    break

            anchor_text, anchor_position = find_anchor_text(page, y_position, y_bottom)

            images.append({
                "filename": filename,
                "page": page_num,
                "y_position": round(y_position, 1),
                "width": width,
                "height": height,
                "anchor_text": anchor_text,
                "anchor_position": anchor_position,
            })

    doc.close()

    # 페이지 → y좌표 순 정렬
    images.sort(key=lambda x: (x["page"], x["y_position"]))

    return {
        "images": images,
        "total_pages": total_pages,
        "page_text_blocks": page_text_blocks,
        "page_heights": page_heights,
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(json.dumps({"error": "Usage: extract_images.py <pdf_path> <output_dir>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]

    if not os.path.exists(pdf_path):
        print(json.dumps({"error": f"PDF file not found: {pdf_path}"}))
        sys.exit(1)

    try:
        result = extract_images(pdf_path, output_dir)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
