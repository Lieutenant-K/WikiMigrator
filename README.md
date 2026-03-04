# WikiMigrator

PDF 파일을 Notion 페이지로 변환하는 macOS 데스크톱 앱입니다.

[Marker](https://github.com/datalab-to/marker)로 PDF를 Markdown으로 변환한 뒤, [Martian](https://github.com/tryfabric/martian)으로 Notion 블록으로 변환하여 Notion API를 통해 페이지를 생성합니다.

## 변환 파이프라인

```
PDF 파일
  ↓  marker_single (Python CLI)
Markdown
  ↓  @tryfabric/martian
Notion Block 배열
  ↓  @notionhq/client
Notion 페이지 생성
```

## 설치 (일반 사용자)

1. [GitHub Releases](https://github.com/Lieutenant-K/WikiMigrator/releases)에서 최신 `.dmg` 파일을 다운로드합니다.
2. `.dmg`를 열고 WikiMigrator를 **Applications** 폴더에 드래그합니다.
3. 최초 실행 시 "확인되지 않은 개발자" 경고가 뜰 수 있습니다:
   - **시스템 설정 → 개인정보 보호 및 보안** 하단에서 "확인 없이 열기"를 클릭합니다.
4. 앱 첫 실행 시 **"초기 설정 필요"** 배너가 표시됩니다. **"설정 시작"** 버튼을 클릭하면 PDF 변환에 필요한 환경이 자동으로 구성됩니다. (최초 1회, 인터넷 연결 필요, 1~3분 소요)

> **Python이나 pip를 별도로 설치할 필요 없습니다.** 앱에 standalone Python이 내장되어 있으며, 첫 실행 시 자동으로 marker-pdf를 설치합니다.

## 사전 준비

### Notion Integration 생성

1. [notion.so/my-integrations](https://www.notion.so/my-integrations)에 접속합니다.
2. **새 Integration**을 생성합니다.
3. **Internal Integration Secret** (토큰)을 복사합니다.
4. 변환 대상이 될 Notion 페이지에서 **우측 상단 ··· 메뉴 → 연결(Connections) → 생성한 Integration을 추가**합니다.

> Integration이 연결된 페이지만 앱에서 조회/생성할 수 있습니다.

## 사용 방법

### Step 1 — Notion 토큰 입력

앱 화면에서 앞서 복사한 Internal Integration Token을 붙여넣고 **연결하기**를 클릭합니다.

### Step 2 — 대상 페이지 선택

Integration이 연결된 Notion 페이지 목록이 표시됩니다. 변환된 PDF가 하위 페이지로 추가될 상위 페이지를 선택합니다.

### Step 3 — PDF 업로드 및 변환

PDF 파일을 드래그앤드롭하거나 클릭하여 선택한 뒤 **변환하기**를 클릭합니다.

- 여러 파일을 동시에 업로드할 수 있습니다.
- 변환 진행률이 실시간으로 표시됩니다.
- 변환이 완료되면 각 파일별로 결과와 Notion 페이지 링크가 표시됩니다.

## 개발 환경 설정 (개발자용)

```bash
# 저장소 클론
git clone https://github.com/Lieutenant-K/WikiMigrator.git
cd WikiMigrator

# 의존성 설치
npm install

# 개발 서버 실행 (Vite + Electron 동시 기동)
npm run dev
```

### 주요 npm 스크립트

| 스크립트 | 설명 |
|----------|------|
| `npm run dev` | 개발 모드 (Vite + Electron 동시 실행) |
| `npm run build` | 프로덕션 빌드 (Renderer + Main) |
| `npm run dist` | `.dmg` 패키지 빌드 |
| `npm run dist:full` | Standalone Python + PyMuPDF + `.dmg` 전체 빌드 |
| `npm run build:pymupdf` | PyMuPDF 바이너리 번들 빌드 |
| `npm run build:python` | Standalone Python 다운로드 |

### .dmg 빌드

```bash
# 전체 빌드 (Standalone Python + PyMuPDF + DMG)
npm run dist:full

# 이미 리소스가 빌드되어 있으면
npm run dist
```

빌드된 `.dmg` 파일은 `release/` 디렉토리에 생성됩니다.

## 프로젝트 구조

```
WikiMigrator/
├── electron/                    # Electron Main 프로세스
│   ├── main.ts                  # 앱 진입점, BrowserWindow 생성
│   ├── preload.ts               # contextBridge API 노출
│   ├── ipc-handlers.ts          # IPC 핸들러 (변환, Notion API 등)
│   ├── app-paths.ts             # 앱 경로 유틸리티
│   └── marker-env.ts            # Marker venv 관리 (생성, 설치, 검증)
├── src/                         # Renderer 프로세스 (React)
│   ├── App.tsx                  # 라우팅 설정
│   ├── main.tsx                 # React 엔트리포인트
│   ├── pages/
│   │   ├── Home.tsx             # 메인 UI (토큰, 업로드, 변환)
│   │   └── Files.tsx            # 로그·마크다운 파일 브라우저
│   ├── components/
│   │   └── FileViewer.tsx       # 파일 뷰어 컴포넌트
│   └── lib/
│       ├── marker.ts            # marker_single CLI 래퍼
│       ├── converter.ts         # Martian 변환 + 제목 추출
│       ├── notion.ts            # Notion 클라이언트 및 페이지 생성
│       ├── image-extractor.ts   # PyMuPDF 이미지 추출
│       ├── image-uploader.ts    # Notion 이미지 업로드
│       ├── bullet-restorer.ts   # 불릿 리스트 복원
│       ├── table-link-injector.ts # 테이블 내 링크 복원
│       ├── logger.ts            # 변환 로그 관리
│       └── file-browser.ts      # 파일 탐색 유틸리티
├── scripts/
│   ├── pymupdf_cli.py           # PyMuPDF CLI (이미지 추출)
│   ├── build_pymupdf.sh         # PyMuPDF 바이너리 빌드 스크립트
│   ├── download_python.sh       # Standalone Python 다운로드 스크립트
│   ├── extract_images.py        # 이미지 추출 스크립트
│   ├── extract_bullets.py       # 불릿 추출 스크립트
│   └── extract_table_links.py   # 테이블 링크 추출 스크립트
├── resources/
│   ├── icon.icns                # 앱 아이콘
│   ├── entitlements.mac.plist   # macOS 엔타이틀먼트
│   └── python/                  # Standalone Python (빌드 시 생성)
├── electron-builder.yml         # Electron Builder 설정
├── vite.config.ts               # Vite 설정
├── tsconfig.json                # TypeScript 설정
└── package.json
```

## 기술 스택

- **Electron** — macOS 데스크톱 앱 프레임워크
- **Vite** — 빌드 도구 및 개발 서버
- **React** — UI 프레임워크
- **Tailwind CSS v4** — UI 스타일링
- **marker-pdf** — PDF → Markdown 변환 (Python CLI)
- **@tryfabric/martian** — Markdown → Notion Block 변환
- **@notionhq/client** — Notion API 클라이언트

## 라이선스

이 프로젝트는 [MIT 라이선스](LICENSE)로 배포됩니다.

**Marker 라이선스 주의:** 이 앱이 사용하는 [Marker](https://github.com/datalab-to/marker)는 연구/개인 사용/소규모 스타트업(자금 또는 매출 $5M 이하)에서 무료로 사용할 수 있습니다. 상업적 사용 시에는 Marker의 별도 상용 라이선스가 필요합니다.
