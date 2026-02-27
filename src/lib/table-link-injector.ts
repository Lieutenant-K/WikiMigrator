import { execFile } from "child_process";
import path from "path";
import type { ConvertLogger } from "./logger";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "extract_table_links.py");
const TIMEOUT_MS = 3 * 60 * 1000; // 3분

// brew, pyenv 등 사용자 설치 경로 보완
const EXEC_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH,
].join(":");

// --- 타입 정의 ---

interface CellLink {
  text: string;
  uri: string;
}

interface CellWithLinks {
  row: number;
  col: number;
  links: CellLink[];
}

export interface TableLinkData {
  page: number;
  table_index: number;
  row_count: number;
  col_count: number;
  header_texts: string[];
  cells: CellWithLinks[];
}

interface TableLinkExtractionResult {
  tables: TableLinkData[];
  total_pages: number;
}

/** 마크다운 내 테이블 위치 */
interface MarkdownTable {
  startLine: number;
  endLine: number; // exclusive
  headerTexts: string[];
  lines: string[];
}

// --- Python 스크립트 호출 ---

export async function extractTableLinksFromPDF(
  pdfPath: string,
  log: ConvertLogger
): Promise<TableLinkExtractionResult> {
  log.section("테이블 링크 추출 (PyMuPDF)");
  log.info(`PDF: ${pdfPath}`);

  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      [SCRIPT_PATH, pdfPath],
      {
        timeout: TIMEOUT_MS,
        env: { ...process.env, PATH: EXEC_PATH },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          log.error(`테이블 링크 스크립트 실행 실패: ${error.message}`);
          if (stderr) log.error(`stderr: ${stderr}`);
          reject(new Error(`테이블 링크 추출 실패: ${error.message}`));
          return;
        }

        if (stderr) log.warn(`PyMuPDF stderr: ${stderr.trim()}`);

        try {
          // PyMuPDF가 find_tables() 호출 시 stdout에 권고 메시지를 출력할 수 있음
          // JSON 시작 위치를 찾아 파싱
          const jsonStart = stdout.indexOf("{");
          const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
          const result: TableLinkExtractionResult = JSON.parse(jsonStr);

          if ("error" in result) {
            reject(new Error(`PyMuPDF 오류: ${(result as Record<string, unknown>).error}`));
            return;
          }

          const totalLinks = result.tables.reduce(
            (sum, t) => sum + t.cells.reduce((s, c) => s + c.links.length, 0),
            0
          );
          log.info(`추출된 테이블: ${result.tables.length}개, 링크: ${totalLinks}개`);

          resolve(result);
        } catch (parseError) {
          reject(new Error(`JSON 파싱 실패: ${parseError instanceof Error ? parseError.message : "알 수 없는 오류"}`));
        }
      }
    );
  });
}

// --- 마크다운 테이블 식별 ---

function findMarkdownTables(lines: string[]): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  let i = 0;

  while (i < lines.length) {
    // | 로 시작하는 줄 찾기
    if (!lines[i].trimStart().startsWith("|")) {
      i++;
      continue;
    }

    const startLine = i;
    const tableLines: string[] = [];

    // 연속된 | 줄 수집
    while (i < lines.length && lines[i].trimStart().startsWith("|")) {
      tableLines.push(lines[i]);
      i++;
    }

    // 최소 3줄 (헤더 + 구분선 + 데이터 1행) 확인
    if (tableLines.length < 2) continue;

    // 두 번째 줄이 구분선인지 확인 (|---|---|)
    const separatorLine = tableLines[1];
    if (!/^\|[\s\-:|]+\|/.test(separatorLine)) continue;

    // 헤더 텍스트 추출
    const headerCells = parseCellTexts(tableLines[0]);

    tables.push({
      startLine,
      endLine: startLine + tableLines.length,
      headerTexts: headerCells,
      lines: tableLines,
    });
  }

  return tables;
}

/** 마크다운 테이블 행에서 셀 텍스트 배열 추출 */
function parseCellTexts(line: string): string[] {
  // 앞뒤 | 제거 후 | 로 분할
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEnd = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutEnd.split("|").map((cell) => cell.trim());
}

// --- 테이블 매칭 ---

function normalizeForMatch(text: string): string {
  return text.replace(/<br>/g, " ").replace(/\s+/g, "").toLowerCase();
}

function matchTables(
  mdTables: MarkdownTable[],
  pymuTables: TableLinkData[],
  log: ConvertLogger
): Map<number, number> {
  // pymuTable index → mdTable index
  const matches = new Map<number, number>();
  const usedMdIndices = new Set<number>();

  for (let pi = 0; pi < pymuTables.length; pi++) {
    const pymu = pymuTables[pi];
    let bestMdIdx = -1;
    let bestScore = 0;

    for (let mi = 0; mi < mdTables.length; mi++) {
      if (usedMdIndices.has(mi)) continue;

      const md = mdTables[mi];
      const score = computeHeaderSimilarity(pymu.header_texts, md.headerTexts);
      if (score > bestScore) {
        bestScore = score;
        bestMdIdx = mi;
      }
    }

    if (bestMdIdx >= 0 && bestScore > 0) {
      matches.set(pi, bestMdIdx);
      usedMdIndices.add(bestMdIdx);
      log.info(`  테이블 매칭: PyMuPDF[${pi}] ↔ MD[${bestMdIdx}] (score=${bestScore.toFixed(2)})`);
    } else {
      log.warn(`  테이블 매칭 실패: PyMuPDF[${pi}] (headers: ${pymu.header_texts.join(", ")})`);
    }
  }

  return matches;
}

function computeHeaderSimilarity(pymuHeaders: string[], mdHeaders: string[]): number {
  if (pymuHeaders.length === 0 || mdHeaders.length === 0) return 0;

  const minLen = Math.min(pymuHeaders.length, mdHeaders.length);
  let matchCount = 0;

  for (let i = 0; i < minLen; i++) {
    const pymuNorm = normalizeForMatch(pymuHeaders[i]);
    const mdNorm = normalizeForMatch(mdHeaders[i]);

    if (pymuNorm.length === 0 && mdNorm.length === 0) {
      matchCount += 0.5;
    } else if (pymuNorm === mdNorm) {
      matchCount += 1;
    } else if (pymuNorm.includes(mdNorm) || mdNorm.includes(pymuNorm)) {
      matchCount += 0.8;
    }
  }

  return matchCount / Math.max(pymuHeaders.length, mdHeaders.length);
}

// --- 셀 내 링크 주입 ---

/**
 * 메인 함수: 마크다운 텍스트에 테이블 링크를 주입한다.
 */
export function injectTableLinks(
  markdown: string,
  tableLinkData: TableLinkData[],
  log: ConvertLogger
): string {
  log.section("테이블 링크 주입");

  const lines = markdown.split("\n");
  const mdTables = findMarkdownTables(lines);

  log.info(`마크다운 테이블: ${mdTables.length}개 감지`);
  log.info(`PyMuPDF 테이블 (링크 포함): ${tableLinkData.length}개`);

  if (mdTables.length === 0 || tableLinkData.length === 0) {
    log.info("매칭할 테이블 없음 → 원본 반환");
    return markdown;
  }

  const matches = matchTables(mdTables, tableLinkData, log);

  let totalInjected = 0;

  for (const [pymuIdx, mdIdx] of matches) {
    const pymuTable = tableLinkData[pymuIdx];
    const mdTable = mdTables[mdIdx];
    const injected = processMatchedTable(lines, mdTable, pymuTable, log);
    totalInjected += injected;
  }

  log.info(`총 ${totalInjected}개 링크 주입 완료`);
  return lines.join("\n");
}

function processMatchedTable(
  lines: string[],
  mdTable: MarkdownTable,
  pymuTable: TableLinkData,
  log: ConvertLogger
): number {
  let injectedCount = 0;

  for (const cellData of pymuTable.cells) {
    const { row, col, links } = cellData;

    // PyMuPDF row → 마크다운 줄 인덱스 매핑
    // row 0 = 헤더 (줄 0), row 1 = 데이터 첫 행 (줄 2, 구분선 뒤), row N = 줄 N+1
    const mdLineOffset = row === 0 ? 0 : row + 1;
    const absoluteLineIdx = mdTable.startLine + mdLineOffset;

    if (absoluteLineIdx >= mdTable.endLine) {
      log.warn(`  행 초과: row=${row}, mdLineOffset=${mdLineOffset}`);
      continue;
    }

    const originalLine = lines[absoluteLineIdx];
    const cells = splitTableRow(originalLine);

    if (col >= cells.length) {
      log.warn(`  열 초과: col=${col}, cells.length=${cells.length}`);
      continue;
    }

    const cellText = cells[col];
    const updatedCell = injectLinksIntoCell(cellText, links);

    if (updatedCell !== cellText) {
      cells[col] = updatedCell;
      lines[absoluteLineIdx] = "| " + cells.join(" | ") + " |";
      // 실제 주입된 링크 수 계산: 새로 추가된 [text](url) 패턴 수
      const oldLinkCount = (cellText.match(/\[[^\]]*\]\([^)]*\)/g) || []).length;
      const newLinkCount = (updatedCell.match(/\[[^\]]*\]\([^)]*\)/g) || []).length;
      injectedCount += newLinkCount - oldLinkCount;
    }
  }

  return injectedCount;
}

/** 마크다운 테이블 행을 셀 배열로 분할 (| 내부의 마크다운 링크 보호) */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  // 앞뒤 | 제거
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);

  // 마크다운 링크 내부의 | 를 임시 플레이스홀더로 교체
  const placeholder = "\x00PIPE\x00";
  let protected_ = inner;

  // [text](url) 패턴 내부의 | 보호
  protected_ = protected_.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (match) => {
    return match.replace(/\|/g, placeholder);
  });

  // 이스케이프된 \| 보호
  protected_ = protected_.replace(/\\\|/g, placeholder);

  const cells = protected_.split("|").map((cell) => {
    return cell.replace(new RegExp(placeholder.replace(/\x00/g, "\\x00"), "g"), "|").trim();
  });

  return cells;
}

/**
 * 셀 텍스트에 링크를 주입한다.
 * <br> 기준으로 줄 분리 후 줄 단위 매칭.
 */
function injectLinksIntoCell(cellText: string, links: CellLink[]): string {
  // <br> 기준으로 분리
  const segments = cellText.split("<br>");
  const remainingLinks = [...links];

  const updatedSegments = segments.map((segment) => {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment || remainingLinks.length === 0) return segment;

    // 이미 링크화된 텍스트인지 확인
    if (/^\[.*\]\(.*\)$/.test(trimmedSegment)) return segment;

    // 긴 링크 텍스트 우선 매칭 (더 구체적인 것 먼저)
    const sortedLinks = [...remainingLinks].sort(
      (a, b) => b.text.length - a.text.length
    );

    let result = segment;

    for (const link of sortedLinks) {
      const linkIdx = remainingLinks.indexOf(link);
      if (linkIdx === -1) continue;

      const normalizedSegment = normalizeText(trimmedSegment);
      const normalizedLinkText = normalizeText(link.text);

      if (!normalizedLinkText) continue;

      // 1순위: 줄 전체가 링크 텍스트와 일치
      if (normalizedSegment === normalizedLinkText) {
        const escapedText = escapeMarkdownLink(trimmedSegment);
        result = result.replace(trimmedSegment, `[${escapedText}](${link.uri})`);
        remainingLinks.splice(linkIdx, 1);
        break;
      }

      // 2순위: 부분 매칭 — 세그먼트 내에 링크 텍스트가 포함
      const matchPos = findTextInSegment(result, link.text);
      if (matchPos !== null) {
        const { start, end, matched } = matchPos;
        // 이미 링크 내부가 아닌지 확인
        if (!isInsideLink(result, start)) {
          const escapedText = escapeMarkdownLink(matched);
          result = result.slice(0, start) + `[${escapedText}](${link.uri})` + result.slice(end);
          remainingLinks.splice(linkIdx, 1);
        }
      }
    }

    return result;
  });

  return updatedSegments.join("<br>");
}

function normalizeText(text: string): string {
  // Marker가 테이블 셀 내 | 를 공백으로 변환하므로, 매칭 시 | 도 공백으로 치환
  return text.replace(/[|\s]+/g, " ").trim();
}

function escapeMarkdownLink(text: string): string {
  return text.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** 세그먼트 내에서 링크 텍스트 위치 찾기 (공백 정규화 매칭 포함) */
function findTextInSegment(
  segment: string,
  linkText: string
): { start: number; end: number; matched: string } | null {
  // 직접 매칭
  const directIdx = segment.indexOf(linkText);
  if (directIdx >= 0) {
    return { start: directIdx, end: directIdx + linkText.length, matched: linkText };
  }

  // 공백 정규화 매칭
  const normalizedLink = normalizeText(linkText);
  const normalizedSegment = normalizeText(segment);
  const normIdx = normalizedSegment.indexOf(normalizedLink);
  if (normIdx >= 0) {
    // 원본 세그먼트에서 대응하는 위치 찾기
    let origStart = -1;
    let origEnd = -1;
    let normPos = 0;

    for (let i = 0; i < segment.length; i++) {
      if (/\s/.test(segment[i]) && (i === 0 || /\s/.test(segment[i - 1]))) continue;
      const normChar = /\s/.test(segment[i]) ? " " : segment[i];
      if (normPos === normIdx && origStart === -1) origStart = i;
      normPos += normChar.length === 0 ? 0 : 1;
      if (normPos === normIdx + normalizedLink.length && origEnd === -1) {
        origEnd = i + 1;
        break;
      }
    }

    if (origStart >= 0 && origEnd >= 0) {
      return { start: origStart, end: origEnd, matched: segment.slice(origStart, origEnd) };
    }
  }

  return null;
}

/** 주어진 위치가 기존 마크다운 링크 내부인지 확인 */
function isInsideLink(text: string, position: number): boolean {
  const linkRegex = /\[([^\]]*)\]\(([^)]*)\)/g;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    if (position >= match.index && position < match.index + match[0].length) {
      return true;
    }
  }
  return false;
}
