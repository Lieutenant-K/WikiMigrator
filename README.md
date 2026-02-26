# WikiMigrator

PDF 파일을 Notion 페이지로 변환하는 웹 서비스입니다.

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

## 기술 스택

- **Next.js 16** (App Router, Turbopack)
- **marker-pdf** — PDF → Markdown 변환 (Python CLI)
- **@tryfabric/martian** — Markdown → Notion Block 변환
- **@notionhq/client** — Notion API 클라이언트
- **Tailwind CSS v4** — UI 스타일링

## 사전 준비

### 1. Node.js

Node.js 18 이상이 필요합니다.

```bash
node -v  # v18 이상 확인
```

### 2. Python & Marker

PDF 변환을 위해 Python 환경에 `marker-pdf`가 설치되어 있어야 합니다.

```bash
pip install marker-pdf
```

설치 후 `marker_single` 명령어가 PATH에 있는지 확인합니다.

```bash
marker_single --help
```

> GPU가 있으면 변환 속도가 크게 향상됩니다. CPU만으로도 동작합니다.

### 3. Notion Integration 생성

1. [notion.so/my-integrations](https://www.notion.so/my-integrations)에 접속합니다.
2. **새 Integration**을 생성합니다.
3. **Internal Integration Secret** (토큰)을 복사합니다.
4. 변환 대상이 될 Notion 페이지에서 **우측 상단 ··· 메뉴 → 연결(Connections) → 생성한 Integration을 추가**합니다.

> Integration이 연결된 페이지만 앱에서 조회/생성할 수 있습니다.

## 설치 및 실행

```bash
# 저장소 클론
git clone <repository-url>
cd WikiMigrator

# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)에 접속합니다.

## 사용 방법

### Step 1 — Notion 토큰 입력

앱 화면에서 앞서 복사한 Internal Integration Token을 붙여넣고 **연결하기**를 클릭합니다.

- 토큰은 브라우저의 `localStorage`에만 저장되며, 서버에 영구 저장되지 않습니다.
- 연결 시 토큰의 유효성을 자동으로 검증합니다.

### Step 2 — 대상 페이지 선택

Integration이 연결된 Notion 페이지 목록이 표시됩니다. 변환된 PDF가 하위 페이지로 추가될 상위 페이지를 선택합니다.

### Step 3 — PDF 업로드 및 변환

PDF 파일을 드래그앤드롭하거나 클릭하여 선택한 뒤 **변환하기**를 클릭합니다.

- 여러 파일을 동시에 업로드할 수 있습니다.
- 변환이 완료되면 각 파일별로 결과와 Notion 페이지 링크가 표시됩니다.

## 프로젝트 구조

```
WikiMigrator/
├── package.json
├── tsconfig.json
├── next.config.ts
├── postcss.config.mjs
├── src/
│   ├── app/
│   │   ├── globals.css                 # Tailwind CSS 임포트
│   │   ├── layout.tsx                  # 루트 레이아웃
│   │   ├── page.tsx                    # 메인 UI (토큰 입력, 업로드, 변환)
│   │   └── api/
│   │       ├── convert/route.ts        # PDF 변환 → Notion 페이지 생성 API
│   │       └── pages/route.ts          # Notion 페이지 목록 조회 API
│   └── lib/
│       ├── marker.ts                   # marker_single CLI 래퍼
│       ├── converter.ts                # Martian 변환 + 제목 추출
│       └── notion.ts                   # Notion 클라이언트 및 페이지 생성
└── tmp/                                # 변환 중 임시 파일 (자동 정리됨)
```

## API 엔드포인트

모든 API는 `Authorization: Bearer <token>` 헤더로 Notion 토큰을 전달받습니다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/pages` | 토큰에 연결된 Notion 페이지 목록 조회 |
| POST | `/api/convert` | PDF 파일을 변환하여 Notion 페이지 생성 |

### POST `/api/convert`

**Content-Type:** `multipart/form-data`

| 필드 | 타입 | 설명 |
|------|------|------|
| `parentPageId` | string | 하위 페이지가 생성될 상위 Notion 페이지 ID |
| `files` | File[] | 변환할 PDF 파일 (복수 가능) |

## 주요 동작 방식

- **Marker CLI**: `marker_single` 명령어를 Node.js의 `child_process`로 실행합니다. 타임아웃은 5분입니다.
- **블록 분할 전송**: Notion API는 한 번에 최대 100개의 블록만 허용하므로, 첫 100개는 `pages.create()`에 포함하고 나머지는 `blocks.children.append()`로 100개씩 추가합니다.
- **임시 파일 관리**: 업로드된 PDF와 Marker 출력물은 `tmp/` 디렉토리에 저장되며, 변환 완료 후 자동으로 삭제됩니다.
- **제목 추출**: Markdown의 첫 번째 `# 제목`을 Notion 페이지 제목으로 사용합니다. 없으면 파일명을 사용합니다.

## 프로덕션 빌드

```bash
npm run build
npm start
```

## 라이선스

- **Marker**: 연구/개인 사용/소규모 스타트업(자금 또는 매출 $5M 이하) 무료. 상업적 사용 시 별도 라이선스 필요.
- **Martian**: MIT 라이선스.
