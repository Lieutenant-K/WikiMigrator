#!/bin/bash
#
# PyMuPDF 통합 CLI를 PyInstaller로 단일 바이너리로 빌드한다.
# 결과물: resources/pymupdf-tools
#
# 사용법: bash scripts/build_pymupdf.sh
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/resources"

echo "=== PyMuPDF CLI 빌드 시작 ==="
echo "스크립트 디렉토리: $SCRIPT_DIR"
echo "출력 디렉토리: $OUTPUT_DIR"

# PyInstaller가 설치되어 있는지 확인
if ! command -v pyinstaller &> /dev/null; then
    echo "PyInstaller가 설치되어 있지 않습니다. 설치합니다..."
    pip3 install pyinstaller
fi

# 빌드 실행
cd "$SCRIPT_DIR"

pyinstaller \
    --onefile \
    --name pymupdf-tools \
    --distpath "$OUTPUT_DIR" \
    --workpath "$PROJECT_DIR/build/pyinstaller" \
    --specpath "$PROJECT_DIR/build/pyinstaller" \
    --hidden-import=pymupdf \
    --collect-all pymupdf \
    pymupdf_cli.py

echo ""
echo "=== 빌드 완료 ==="
echo "바이너리: $OUTPUT_DIR/pymupdf-tools"

# 바이너리 크기 표시
if [ -f "$OUTPUT_DIR/pymupdf-tools" ]; then
    SIZE=$(du -h "$OUTPUT_DIR/pymupdf-tools" | cut -f1)
    echo "크기: $SIZE"
fi

# 빌드 임시 파일 정리
rm -rf "$PROJECT_DIR/build/pyinstaller"

echo "완료!"
