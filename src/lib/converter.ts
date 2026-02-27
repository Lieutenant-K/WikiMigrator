import { markdownToBlocks } from "@tryfabric/martian";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints";
import type { ConvertLogger } from "./logger";

/**
 * 마크다운 코드 블록 내부의 들여쓰기를 정규화한다.
 *
 * Marker(PDF→Markdown 변환기)는 PDF의 절대 좌표를 텍스트 들여쓰기로 변환할 때
 * 원래 4칸이어야 할 들여쓰기를 1칸 스페이스로 축소하는 경향이 있다.
 * 이 함수는 코드 블록(``` 펜스) 내부만 대상으로 들여쓰기를 복원한다.
 *
 * 알고리즘:
 * 1. ``` ~ ``` 사이의 코드 블록을 감지한다.
 * 2. 블록 내 최소 들여쓰기 단위(indent unit)를 파악한다.
 * 3. indent unit이 목표 크기(기본 4칸)보다 작으면 스케일링한다.
 *    새 들여쓰기 = (현재 들여쓰기 ÷ indent unit) × 목표 크기
 * 4. 코드 블록 외부의 텍스트는 일절 변경하지 않는다.
 */
const TARGET_INDENT_SIZE = 4;

export function normalizeCodeBlockIndentation(
  markdown: string,
  log: ConvertLogger
): string {
  const lines = markdown.split("\n");
  const result: string[] = [];

  let insideCodeBlock = false;
  let codeBlockLines: string[] = [];
  let codeBlockFence = ""; // 시작 펜스 라인 (``` 또는 ```swift 등)
  let normalizedCount = 0;

  for (const line of lines) {
    // 코드 블록 펜스 감지 (```, ````  등 — 최소 3개의 backtick)
    const fenceMatch = line.match(/^(\s*`{3,})/);

    if (fenceMatch && !insideCodeBlock) {
      // 코드 블록 시작
      insideCodeBlock = true;
      codeBlockFence = line;
      codeBlockLines = [];
      continue;
    }

    if (fenceMatch && insideCodeBlock) {
      // 코드 블록 종료 → 들여쓰기 정규화 후 출력
      const normalized = normalizeIndentation(codeBlockLines);
      if (normalized.changed) normalizedCount++;

      result.push(codeBlockFence);
      result.push(...normalized.lines);
      result.push(line); // 닫는 펜스
      insideCodeBlock = false;
      codeBlockLines = [];
      codeBlockFence = "";
      continue;
    }

    if (insideCodeBlock) {
      codeBlockLines.push(line);
    } else {
      result.push(line);
    }
  }

  // 닫히지 않은 코드 블록 처리 (비정상 마크다운 방어)
  if (insideCodeBlock) {
    const normalized = normalizeIndentation(codeBlockLines);
    if (normalized.changed) normalizedCount++;

    result.push(codeBlockFence);
    result.push(...normalized.lines);
  }

  if (normalizedCount > 0) {
    log.info(
      `코드 블록 들여쓰기 정규화: ${normalizedCount}개 블록의 들여쓰기를 ${TARGET_INDENT_SIZE}칸으로 복원`
    );
  } else {
    log.info("코드 블록 들여쓰기 정규화: 변경 필요 없음");
  }

  return result.join("\n");
}

/**
 * 코드 블록 내부 라인들의 들여쓰기를 분석하고 스케일링한다.
 */
function normalizeIndentation(lines: string[]): {
  lines: string[];
  changed: boolean;
} {
  // 1. 각 라인의 선행 스페이스 수 수집 (빈 줄, 공백만 있는 줄 제외)
  const indents: number[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^( +)/);
    if (match) {
      indents.push(match[1].length);
    }
  }

  // 들여쓰기가 있는 라인이 없으면 중괄호/대괄호 기반 자동 들여쓰기 시도
  if (indents.length === 0) {
    return reindentByBrackets(lines);
  }

  // 2. 최소 들여쓰기 단위 (indent unit) 파악
  const minIndent = Math.min(...indents);

  // 이미 목표 크기 이상이면 변경 불필요
  if (minIndent >= TARGET_INDENT_SIZE) {
    return { lines, changed: false };
  }

  // 최소 들여쓰기가 0이면 GCD로 indent unit 추정
  const indentUnit =
    minIndent > 0 ? minIndent : gcd(indents.filter((n) => n > 0));

  // indent unit을 판별할 수 없으면 변경하지 않음
  if (!indentUnit || indentUnit >= TARGET_INDENT_SIZE) {
    return { lines, changed: false };
  }

  // 3. 스케일링 적용
  const scaledLines = lines.map((line) => {
    if (line.trim().length === 0) return line; // 빈 줄 유지

    const match = line.match(/^( +)/);
    if (!match) return line; // 들여쓰기 없는 줄 유지

    const currentIndent = match[1].length;
    const indentLevel = Math.round(currentIndent / indentUnit);
    const newIndent = indentLevel * TARGET_INDENT_SIZE;

    return " ".repeat(newIndent) + line.slice(currentIndent);
  });

  return { lines: scaledLines, changed: true };
}

/**
 * 중괄호/대괄호 기반 자동 들여쓰기.
 *
 * Marker가 코드 블록의 모든 들여쓰기를 제거한 경우(0-indent)에 사용된다.
 * JSON이나 중괄호 기반 코드(Swift, Java 등)에서 { } [ ] 의 중첩 깊이로
 * 들여쓰기를 복원한다.
 *
 * 대상: 중괄호 또는 대괄호가 2쌍 이상 있는 코드 블록만 처리.
 * (단순 텍스트에 우연히 포함된 중괄호에 오작동하지 않도록)
 */
function reindentByBrackets(lines: string[]): {
  lines: string[];
  changed: boolean;
} {
  // 중괄호/대괄호 쌍 개수 확인
  const fullText = lines.join("\n");
  const openCount = (fullText.match(/[{[]/g) || []).length;
  const closeCount = (fullText.match(/[}\]]/g) || []).length;

  // 최소 2쌍 이상이어야 의미 있는 중첩 구조로 간주
  if (openCount < 2 || closeCount < 2) {
    return { lines, changed: false };
  }

  let depth = 0;
  const result: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      result.push("");
      continue;
    }

    // 닫는 괄호로 시작하면 먼저 depth 감소
    if (/^[}\]]/.test(trimmed)) {
      depth = Math.max(0, depth - 1);
    }

    result.push(" ".repeat(depth * TARGET_INDENT_SIZE) + trimmed);

    // 여는 괄호로 끝나면 depth 증가 (같은 줄에 닫는 괄호가 있으면 상쇄)
    const opens = (trimmed.match(/[{[]/g) || []).length;
    const closes = (trimmed.match(/[}\]]/g) || []).length;
    // 줄 시작의 닫는 괄호는 이미 위에서 처리했으므로, 나머지 변화량만 반영
    const netChange = opens - closes + (/^[}\]]/.test(trimmed) ? 1 : 0);
    depth = Math.max(0, depth + netChange);
  }

  return { lines: result, changed: true };
}

/** 양의 정수 배열의 최대공약수를 구한다. */
function gcd(numbers: number[]): number {
  if (numbers.length === 0) return 0;

  function gcd2(a: number, b: number): number {
    while (b !== 0) {
      [a, b] = [b, a % b];
    }
    return a;
  }

  return numbers.reduce((acc, n) => gcd2(acc, n));
}

/**
 * Martian은 로컬 파일 경로(http로 시작하지 않는)를 image 블록이 아닌 paragraph 텍스트로 변환한다.
 * 이를 우회하기 위해 마크다운의 이미지 참조를 임시 placeholder URL로 치환한다.
 *
 * 변환 흐름:
 * 1. 전처리: ![alt](local.jpeg) → ![alt](https://placeholder.wikimigrator.local/local.jpeg)
 * 2. Martian 변환: placeholder URL로 image 블록 정상 생성
 * 3. 후처리: image 블록의 placeholder URL → file_upload ID로 교체
 */
const IMAGE_PLACEHOLDER_PREFIX = "https://placeholder.wikimigrator.local/";

/**
 * 마크다운 내 이미지 참조에서 로컬 파일 경로를 placeholder URL로 치환한다.
 * http/https URL은 이미 유효하므로 변경하지 않는다.
 * @returns 치환된 마크다운 + 원본 경로 세트 (복원용)
 */
export function preprocessMarkdownImages(
  markdown: string,
  log: ConvertLogger
): { processed: string; localImagePaths: Set<string> } {
  const localImagePaths = new Set<string>();

  const processed = markdown.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (match, alt: string, url: string) => {
      // 이미 http/https URL이면 변경하지 않음
      if (/^https?:\/\//i.test(url)) {
        return match;
      }

      // 로컬 파일 경로 → placeholder URL로 치환
      localImagePaths.add(url);
      const placeholderUrl = `${IMAGE_PLACEHOLDER_PREFIX}${encodeURIComponent(url)}`;
      log.info(`  이미지 전처리: "${url}" → placeholder URL`);
      return `![${alt}](${placeholderUrl})`;
    }
  );

  if (localImagePaths.size > 0) {
    log.info(`로컬 이미지 경로 ${localImagePaths.size}개를 placeholder URL로 치환 완료`);
  } else {
    log.info("로컬 이미지 경로 없음 → 전처리 불필요");
  }

  return { processed, localImagePaths };
}

/**
 * Notion API는 한 번의 요청에서 블록의 children을 최대 2단계까지만 허용한다.
 * 하지만 Notion 데이터 구조 자체는 무제한 중첩을 지원하므로,
 * 깊이 초과 children을 별도 요청으로 나누어 보내면 원본 계층 구조를 보존할 수 있다.
 *
 * 전략:
 * 1. 블록 트리에서 깊이 2단계까지만 children을 유지한다.
 * 2. 깊이 3단계 이상의 children은 떼어내고, "나중에 append할 작업"으로 기록한다.
 * 3. 부모 블록의 위치를 인덱스 경로(예: "0.2.1")로 추적한다. (블록 객체에 속성을 추가하지 않음)
 * 4. notion.ts에서 실제 Notion 블록 ID와 인덱스 경로를 매핑하여 순차 append한다.
 */
const NOTION_MAX_NESTING_DEPTH = 2;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = Record<string, any>;

/**
 * 깊이 초과로 떼어낸 children을 나중에 append하기 위한 작업 단위.
 * parentPath: 부모 블록의 인덱스 경로 (예: "0.2.1" → 최상위[0] > children[2] > children[1])
 * children: 해당 부모에 append할 블록 배열 (이들도 깊이 2단계까지만 포함)
 */
export interface DeferredAppend {
  parentPath: string;
  children: AnyBlock[];
}

/**
 * 블록에서 children 배열을 꺼내는 헬퍼.
 */
function getChildren(block: AnyBlock): AnyBlock[] | null {
  const type = block.type as string | undefined;
  if (!type || !block[type]) return null;
  return block[type].children ?? null;
}

function setChildren(block: AnyBlock, children: AnyBlock[]): void {
  const type = block.type as string | undefined;
  if (!type || !block[type]) return;
  if (children.length > 0) {
    block[type].children = children;
  } else {
    delete block[type].children;
  }
}

function processBlock(
  block: AnyBlock,
  currentDepth: number,
  currentPath: string,
  deferred: DeferredAppend[]
): void {
  const children = getChildren(block);
  if (!children || children.length === 0) return;

  if (currentDepth >= NOTION_MAX_NESTING_DEPTH) {
    const detached = [...children];
    setChildren(block, []);

    for (let i = 0; i < detached.length; i++) {
      processBlock(detached[i], 1, `${i}`, deferred);
    }

    deferred.push({
      parentPath: currentPath,
      children: detached,
    });
    return;
  }

  for (let i = 0; i < children.length; i++) {
    processBlock(children[i], currentDepth + 1, `${currentPath}.${i}`, deferred);
  }
}

/** 블록 타입별 개수를 집계한다. */
function countBlockTypes(blocks: AnyBlock[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const block of blocks) {
    const type = (block.type as string) || "unknown";
    counts[type] = (counts[type] || 0) + 1;
    const children = getChildren(block);
    if (children && children.length > 0) {
      const childCounts = countBlockTypes(children);
      for (const [t, c] of Object.entries(childCounts)) {
        counts[t] = (counts[t] || 0) + c;
      }
    }
  }
  return counts;
}

export interface PreparedBlocks {
  /** 깊이 2단계까지만 children이 포함된 최상위 블록 배열 */
  topLevelBlocks: BlockObjectRequest[];
  /** 나중에 순차 append해야 할 작업 목록 (순서 유지 필수) */
  deferredAppends: DeferredAppend[];
}

export function convertMarkdownToNotionBlocks(
  markdown: string,
  log: ConvertLogger
): PreparedBlocks {
  log.section("Markdown → Notion Blocks 변환 (Martian)");

  const blocks = markdownToBlocks(markdown, {
    notionLimits: {
      truncate: true,
    },
  });

  const anyBlocks = blocks as AnyBlock[];

  log.info(`Martian 변환 결과: 최상위 블록 ${anyBlocks.length}개`);

  // 블록 타입 집계
  const typeCounts = countBlockTypes(anyBlocks);
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    log.info(`  ${type}: ${count}개`);
  }

  const deferred: DeferredAppend[] = [];

  for (let i = 0; i < anyBlocks.length; i++) {
    processBlock(anyBlocks[i], 1, `${i}`, deferred);
  }

  if (deferred.length > 0) {
    log.info(`깊이 초과로 분리된 deferred append: ${deferred.length}개`);
    for (const d of deferred) {
      log.info(`  parentPath="${d.parentPath}", children=${d.children.length}개`);
    }
  } else {
    log.info("깊이 초과 블록 없음 (모두 2단계 이내)");
  }

  return {
    topLevelBlocks: anyBlocks as BlockObjectRequest[],
    deferredAppends: deferred,
  };
}

/**
 * 블록 배열을 재귀 순회하면서 image 블록의 placeholder URL을
 * file_upload 참조로 교체한다.
 *
 * uploadMap: 원본 로컬 경로(예: "_page_0_Picture_6.jpeg") → file_upload ID
 * placeholder URL에서 원본 경로를 추출하여 uploadMap과 매칭한다.
 */
export function replaceImageBlocks(
  blocks: AnyBlock[],
  uploadMap: Map<string, string>,
  log?: ConvertLogger
): void {
  for (const block of blocks) {
    if (block.type === "image" && block.image) {
      const image = block.image;
      if (image.type === "external" && image.external?.url) {
        const url = image.external.url as string;

        // placeholder URL에서 원본 로컬 경로를 추출
        let originalPath: string | null = null;
        if (url.startsWith(IMAGE_PLACEHOLDER_PREFIX)) {
          originalPath = decodeURIComponent(url.slice(IMAGE_PLACEHOLDER_PREFIX.length));
        }

        // 1차: placeholder URL에서 추출한 원본 경로로 매칭 시도
        const lookupKey = originalPath ?? url;
        const fileUploadId = uploadMap.get(lookupKey);

        if (fileUploadId) {
          block.image = {
            type: "file_upload",
            file_upload: { id: fileUploadId },
          };
          log?.info(`  이미지 교체: "${lookupKey}" → file_upload(${fileUploadId})`);
        } else {
          log?.warn(`  이미지 매칭 실패: "${lookupKey}" (uploadMap에 없음)`);
        }
      }
    }

    const children = getChildren(block);
    if (children && children.length > 0) {
      replaceImageBlocks(children, uploadMap, log);
    }
  }
}

export function extractTitleFromMarkdown(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }

  const firstLine = markdown.split("\n").find((line) => line.trim().length > 0);
  return firstLine?.trim().replace(/^#+\s*/, "") || "Untitled";
}
