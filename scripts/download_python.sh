#!/bin/bash
#
# python-build-standalone에서 CPython을 다운로드하여 resources/python/에 배치한다.
# 결과물: resources/python/ (standalone Python, ~50MB)
#
# 사용법: bash scripts/download_python.sh
#
set -e

PYTHON_VERSION="3.12.13"
RELEASE_TAG="20260303"
ARCH="aarch64-apple-darwin"
ARCHIVE="cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${ARCH}-install_only_stripped.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/${ARCHIVE}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="$PROJECT_DIR/resources/python"

echo "=== Standalone Python 다운로드 ==="
echo "버전: CPython ${PYTHON_VERSION}"
echo "아카이브: ${ARCHIVE}"

# 이미 다운로드되어 있으면 스킵
if [ -x "$TARGET_DIR/bin/python3" ]; then
    EXISTING_VERSION=$("$TARGET_DIR/bin/python3" --version 2>&1 || true)
    if echo "$EXISTING_VERSION" | grep -q "$PYTHON_VERSION"; then
        echo "이미 다운로드되어 있습니다: $EXISTING_VERSION"
        echo "재다운로드하려면 resources/python/ 디렉토리를 삭제 후 다시 실행하세요."
        exit 0
    fi
fi

# 기존 디렉토리 정리
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

# 다운로드
echo ""
echo "다운로드 중... (${URL})"
TMPFILE=$(mktemp /tmp/python-standalone.XXXXXX.tar.gz)
curl -L --progress-bar -o "$TMPFILE" "$URL"

# 압축 해제 (tar.gz 내부는 python/ 디렉토리)
echo "압축 해제 중..."
tar -xzf "$TMPFILE" -C "$TARGET_DIR" --strip-components=1
rm -f "$TMPFILE"

# 실행 권한 확인
chmod +x "$TARGET_DIR/bin/python3"
chmod +x "$TARGET_DIR/bin/python3.12"

# 불필요한 파일 정리 (코드 서명 문제 방지 + 크기 축소)
echo "불필요한 파일 정리 중..."
# Windows 실행 파일 제거 (codesign이 .exe를 서명하려고 시도하면 실패)
find "$TARGET_DIR" -name "*.exe" -delete 2>/dev/null || true
# 테스트 디렉토리 제거
rm -rf "$TARGET_DIR/lib/python3.12/test" 2>/dev/null || true
rm -rf "$TARGET_DIR/lib/python3.12/unittest/test" 2>/dev/null || true
# __pycache__ 정리 (필요 시 런타임에서 재생성됨)
find "$TARGET_DIR" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
# .pyc 파일 제거 (런타임에서 재생성됨)
find "$TARGET_DIR" -name "*.pyc" -delete 2>/dev/null || true

# 검증
echo ""
echo "=== 다운로드 완료 ==="
"$TARGET_DIR/bin/python3" --version
echo "경로: $TARGET_DIR"
du -sh "$TARGET_DIR"
