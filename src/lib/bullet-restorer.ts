import { execFile } from "child_process";
import path from "path";
import type { ConvertLogger } from "./logger";

let SCRIPT_PATH = path.join(process.cwd(), "scripts", "extract_bullets.py");
const TIMEOUT_MS = 3 * 60 * 1000; // 3분
let USE_PYMUPDF_BINARY = false;
let PYMUPDF_TOOLS_PATH = "";

const EXEC_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH,
].join(":");

export function setBulletRestorerPaths(opts: {
  scriptPath?: string;
  pymupdfToolsPath?: string;
}): void {
  if (opts.scriptPath) SCRIPT_PATH = opts.scriptPath;
  if (opts.pymupdfToolsPath) {
    PYMUPDF_TOOLS_PATH = opts.pymupdfToolsPath;
    USE_PYMUPDF_BINARY = true;
  }
}

export interface BulletInfo {
  page: number;
  y: number;
  indent_level: number;
  text: string;
}

export interface BulletExtractionResult {
  bullets: BulletInfo[];
  total_pages: number;
}

/**
 * PyMuPDF Python 스크립트를 호출하여 PDF에서 벡터 불릿 마커를 추출한다.
 */
export async function extractBulletsFromPDF(
  pdfPath: string,
  log: ConvertLogger
): Promise<BulletExtractionResult> {
  log.section("벡터 불릿 추출 (PyMuPDF)");
  log.info(`PDF: ${pdfPath}`);

  const cmd = USE_PYMUPDF_BINARY ? PYMUPDF_TOOLS_PATH : "python3";
  const args = USE_PYMUPDF_BINARY
    ? ["extract-bullets", pdfPath]
    : [SCRIPT_PATH, pdfPath];

  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: TIMEOUT_MS,
        env: { ...process.env, PATH: EXEC_PATH },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          log.error(`벡터 불릿 추출 실패: ${error.message}`);
          if (stderr) log.error(`stderr: ${stderr}`);
          reject(new Error(`벡터 불릿 추출 실패: ${error.message}`));
          return;
        }

        if (stderr) log.warn(`stderr: ${stderr.trim()}`);

        try {
          const result: BulletExtractionResult = JSON.parse(stdout);

          if ("error" in result) {
            reject(new Error(`Python 스크립트 오류: ${(result as { error: string }).error}`));
            return;
          }

          log.info(`추출된 불릿: ${result.bullets.length}개`);
          for (const b of result.bullets) {
            log.info(`  페이지 ${b.page}, indent=${b.indent_level}: "${b.text.slice(0, 50)}..."`);
          }

          resolve(result);
        } catch (parseError) {
          reject(new Error(`JSON 파싱 실패: ${parseError}`));
        }
      }
    );
  });
}

/**
 * 마크다운에서 벡터 불릿에 해당하는 텍스트를 찾아 `- ` 마커를 복원한다.
 *
 * 처리 방식:
 * 1. 각 불릿의 텍스트를 마크다운에서 검색
 * 2. 이미 리스트 항목인 줄은 건너뜀 (Marker가 이미 처리)
 * 3. 독립 줄이면 `- ` 접두사 추가
 * 4. 다른 텍스트와 병합된 줄이면 분할 후 `- ` 추가
 */
export function restoreBulletMarkers(
  markdown: string,
  bullets: BulletInfo[],
  log: ConvertLogger
): string {
  log.section("벡터 불릿 마커 복원");

  const lines = markdown.split("\n");
  const processedLineIndices = new Set<number>();

  let restoredCount = 0;
  let skippedAlreadyList = 0;
  let splitCount = 0;

  // 코드 블록 영역 마킹
  const inCodeBlock = new Set<number>();
  let insideCode = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*`{3,}/.test(lines[i])) {
      insideCode = !insideCode;
    }
    if (insideCode) inCodeBlock.add(i);
  }

  // 불릿을 역순으로 처리 (하단→상단, 인덱스 시프트 방지)
  const sortedBullets = [...bullets].sort(
    (a, b) => b.page - a.page || b.y - a.y
  );

  for (const bullet of sortedBullets) {
    if (!bullet.text || bullet.text.trim().length < 2) continue;

    // 사전 필터: 이미 리스트 항목에 포함된 불릿이면 매칭 시도 자체를 건너뜀
    if (isAlreadyInListItem(lines, bullet.text, inCodeBlock)) {
      skippedAlreadyList++;
      continue;
    }

    const indent = "  ".repeat(bullet.indent_level);
    const matchResult = findBulletTextInLines(
      lines,
      bullet.text,
      inCodeBlock,
      processedLineIndices
    );

    if (!matchResult) continue;

    const { lineIndex, position } = matchResult;
    const line = lines[lineIndex];

    // 이미 리스트 항목이면 건너뜀 (사전 필터를 통과했지만 매칭 결과가 리스트인 경우)
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      skippedAlreadyList++;
      processedLineIndices.add(lineIndex);
      continue;
    }

    if (position === "full") {
      // 줄 전체가 불릿 텍스트와 매칭 → 접두사 추가
      lines[lineIndex] = `${indent}- ${line.trim()}`;
      restoredCount++;
      processedLineIndices.add(lineIndex);
    } else if (position === "start") {
      // 줄 앞부분이 불릿 텍스트 → 뒷부분 분할
      const splitIdx = findSplitIndex(line, bullet.text);
      if (splitIdx > 0) {
        const bulletPart = line.substring(0, splitIdx).trim();
        const restPart = line.substring(splitIdx).trim();
        lines[lineIndex] = `${indent}- ${bulletPart}`;
        lines.splice(lineIndex + 1, 0, restPart);
        restoredCount++;
        splitCount++;
        // 코드 블록 인덱스 시프트 보정
        shiftIndices(inCodeBlock, lineIndex + 1);
        processedLineIndices.add(lineIndex);
      }
    } else if (typeof position === "number") {
      // 줄 중간에서 발견 → 앞부분 유지, 불릿 텍스트부터 분할
      const beforePart = line.substring(0, position).trim();
      const bulletPart = line.substring(position).trim();
      lines[lineIndex] = beforePart;
      lines.splice(lineIndex + 1, 0, `${indent}- ${bulletPart}`);
      restoredCount++;
      splitCount++;
      shiftIndices(inCodeBlock, lineIndex + 1);
      // beforePart(lineIndex)는 다른 불릿의 텍스트일 수 있으므로 processed에 추가하지 않음
      processedLineIndices.add(lineIndex + 1);
    }
  }

  log.info(
    `불릿 복원 완료: ${restoredCount}개 복원, ` +
    `${splitCount}개 줄 분할, ` +
    `${skippedAlreadyList}개 이미 리스트 (건너뜀)`
  );

  return lines.join("\n");
}

/**
 * 마크다운 줄 배열에서 불릿 텍스트와 매칭되는 줄을 찾는다.
 *
 * @returns 매칭 결과:
 *   - position "full": 줄 전체가 불릿 텍스트
 *   - position "start": 줄이 불릿 텍스트로 시작 (뒤에 다른 텍스트 있음)
 *   - position number: 줄 중간에서 불릿 텍스트 시작 (offset)
 */
function findBulletTextInLines(
  lines: string[],
  bulletText: string,
  inCodeBlock: Set<number>,
  processedIndices: Set<number>
): { lineIndex: number; position: "full" | "start" | number } | null {
  const normalizedBullet = normalizeForMatch(bulletText);
  // 매칭에 사용할 접두 텍스트 (앞 30자)
  const bulletPrefix = normalizedBullet.slice(0, 30);

  if (bulletPrefix.length < 2) return null;

  for (let i = 0; i < lines.length; i++) {
    // 건너뛸 줄
    if (inCodeBlock.has(i)) continue;
    if (processedIndices.has(i)) continue;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("|")) continue; // 테이블 행
    if (trimmed.startsWith("#")) continue; // 제목

    const normalizedLine = normalizeForMatch(lines[i]);

    // 1차: 정규화된 전체 매칭
    if (normalizedLine === normalizedBullet) {
      return { lineIndex: i, position: "full" };
    }

    // 2차: 줄이 불릿 텍스트로 시작
    if (normalizedLine.startsWith(normalizedBullet) && normalizedLine.length > normalizedBullet.length) {
      return { lineIndex: i, position: "start" };
    }

    // 3차: 불릿 텍스트가 줄 중간에 위치 (접두 30자로 검색)
    const prefixPos = normalizedLine.indexOf(bulletPrefix);
    if (prefixPos > 0) {
      // 원본 줄에서 실제 오프셋 계산
      const originalOffset = findOriginalOffset(lines[i], bulletText);
      if (originalOffset > 0) {
        return { lineIndex: i, position: originalOffset };
      }
    }
  }

  // 4차: 더 짧은 접두(15자)로 재시도
  const shortPrefix = normalizedBullet.slice(0, 15);
  if (shortPrefix.length < 2) return null;

  for (let i = 0; i < lines.length; i++) {
    if (inCodeBlock.has(i)) continue;
    if (processedIndices.has(i)) continue;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("|") || trimmed.startsWith("#")) continue;
    if (/^\s*[-*+]\s/.test(lines[i]) || /^\s*\d+\.\s/.test(lines[i])) continue;

    const normalizedLine = normalizeForMatch(lines[i]);
    const pos = normalizedLine.indexOf(shortPrefix);

    if (pos === 0 && normalizedLine.length === normalizedBullet.length) {
      return { lineIndex: i, position: "full" };
    }
    if (pos === 0) {
      return { lineIndex: i, position: "start" };
    }
    if (pos > 0) {
      const originalOffset = findOriginalOffset(lines[i], bulletText);
      if (originalOffset > 0) {
        return { lineIndex: i, position: originalOffset };
      }
    }
  }

  return null;
}

/**
 * 원본 줄에서 불릿 텍스트의 시작 위치를 찾는다.
 * 공백 차이를 허용하기 위해 불릿 텍스트의 앞 15자를 기준으로 검색.
 */
function findOriginalOffset(originalLine: string, bulletText: string): number {
  // 정확한 매칭 시도
  const exactPos = originalLine.indexOf(bulletText.slice(0, 20));
  if (exactPos > 0) return exactPos;

  // 공백 정규화 매칭
  const bulletStart = bulletText.slice(0, 15).replace(/\s+/g, "").toLowerCase();
  if (bulletStart.length < 3) return -1;

  // 원본 줄에서 슬라이딩 윈도우로 검색
  for (let i = 1; i < originalLine.length - bulletStart.length; i++) {
    const window = originalLine.slice(i, i + 30).replace(/\s+/g, "").toLowerCase();
    if (window.startsWith(bulletStart)) {
      return i;
    }
  }

  return -1;
}

/**
 * 불릿 텍스트의 끝 위치를 기준으로 줄을 분할할 인덱스를 찾는다.
 */
function findSplitIndex(line: string, bulletText: string): number {
  // 정확한 매칭: 불릿 텍스트 끝 위치
  const exactEnd = line.indexOf(bulletText);
  if (exactEnd >= 0) {
    return exactEnd + bulletText.length;
  }

  // 공백 정규화 매칭
  const normalizedBullet = normalizeForMatch(bulletText);
  const normalizedLine = normalizeForMatch(line);
  const pos = normalizedLine.indexOf(normalizedBullet);
  if (pos >= 0) {
    // 정규화된 위치를 원본 위치로 역매핑 (근사치)
    return approximateOriginalEnd(line, bulletText);
  }

  return -1;
}

/**
 * 불릿 텍스트의 끝 부분(마지막 10자)을 원본 줄에서 찾아 분할 위치를 결정한다.
 */
function approximateOriginalEnd(line: string, bulletText: string): number {
  const suffix = bulletText.slice(-15);
  const pos = line.indexOf(suffix);
  if (pos >= 0) {
    const endPos = pos + suffix.length;
    // 분할 위치 뒤에 공백이 있으면 공백도 포함
    if (endPos < line.length && line[endPos] === " ") {
      return endPos + 1;
    }
    return endPos;
  }
  return -1;
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 마크다운 인라인 문법을 제거하여 원본 텍스트만 남긴다.
 * [text](url) → text, <url> → url
 */
function stripMarkdownInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1");
}

/**
 * 불릿 텍스트가 이미 리스트 항목 내에 존재하는지 사전 검사한다.
 * 마크다운 링크 문법을 strip한 뒤 비교하므로 [text](url) 패턴도 정확히 매칭.
 */
function isAlreadyInListItem(
  lines: string[],
  bulletText: string,
  inCodeBlock: Set<number>
): boolean {
  const normalizedBullet = stripMarkdownInline(bulletText)
    .replace(/\s+/g, "")
    .toLowerCase();
  const prefix = normalizedBullet.slice(0, 20);
  if (prefix.length < 3) return false;

  for (let i = 0; i < lines.length; i++) {
    if (inCodeBlock.has(i)) continue;
    if (!/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i])) continue;

    const normalizedLine = stripMarkdownInline(lines[i])
      .replace(/\s+/g, "")
      .toLowerCase();
    if (normalizedLine.includes(prefix)) return true;
  }
  return false;
}

/**
 * 줄 삽입 시 Set 인덱스를 시프트한다.
 */
function shiftIndices(indexSet: Set<number>, fromIndex: number): void {
  const shifted: number[] = [];
  for (const idx of indexSet) {
    if (idx >= fromIndex) {
      shifted.push(idx);
    }
  }
  for (const idx of shifted) {
    indexSet.delete(idx);
    indexSet.add(idx + 1);
  }
}
