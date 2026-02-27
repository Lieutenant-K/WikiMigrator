import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import type { ConvertLogger } from "./logger";

const TMP_DIR = path.join(process.cwd(), "tmp");
const SCRIPT_PATH = path.join(process.cwd(), "scripts", "extract_images.py");
const TIMEOUT_MS = 3 * 60 * 1000; // 3분

// brew, pyenv 등 사용자 설치 경로 보완
const EXEC_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH,
].join(":");

// Marker --paginate_output 구분자 패턴
// Marker의 convert_div()는 "\n\n{PAGE_ID}----48----\n\n" + text 형식으로 생성하지만,
// cleanup_text()가 연속 줄바꿈을 정리하므로, 빈 페이지(이미지만 있는 페이지)의
// 인접 구분자 사이 \n\n\n\n이 \n\n으로 축소될 수 있다.
// 뒤쪽 \n\n을 패턴에서 제외하여 인접 구분자 간 \n\n 겹침 소비를 방지한다.
const PAGE_SEPARATOR_REGEX = /\n\n\{(\d+)\}-{48}/g;

/** PyMuPDF 스크립트가 반환하는 단일 이미지 메타데이터 */
export interface ExtractedImage {
  filename: string;
  page: number;
  y_position: number;
  width: number;
  height: number;
  anchor_text: string;
  /** "above": 이미지를 anchor 텍스트 뒤에 삽입, "below": anchor 텍스트 앞에 삽입 */
  anchor_position: "above" | "below";
}

/** PyMuPDF가 반환하는 단일 텍스트 블록 좌표 (보정 포인트용) */
export interface PageTextBlock {
  y: number;
  y_bottom: number;
  text: string;
}

/** 보정 포인트: 텍스트 블록이 마크다운 줄에 매칭된 결과 */
interface CalibrationPoint {
  y: number;
  lineIndex: number;
}

/** PyMuPDF 스크립트의 전체 결과 */
export interface ImageExtractionResult {
  images: ExtractedImage[];
  total_pages: number;
  page_text_blocks?: Record<string, PageTextBlock[]>;
  page_heights?: Record<string, number>;
}

/**
 * PyMuPDF Python 스크립트를 호출하여 PDF에서 원본 이미지를 추출한다.
 */
export async function extractImagesWithPyMuPDF(
  pdfPath: string,
  log: ConvertLogger
): Promise<{
  metadata: ImageExtractionResult;
  imageMap: Map<string, string>;
}> {
  const imageDir = path.join(
    TMP_DIR,
    `pymupdf_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(imageDir, { recursive: true });

  log.section("PyMuPDF 이미지 추출");
  log.info(`PDF: ${pdfPath}`);
  log.info(`이미지 출력 디렉토리: ${imageDir}`);

  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      [SCRIPT_PATH, pdfPath, imageDir],
      {
        timeout: TIMEOUT_MS,
        env: { ...process.env, PATH: EXEC_PATH },
        maxBuffer: 10 * 1024 * 1024,
      },
      async (error, stdout, stderr) => {
        if (error) {
          log.error(`PyMuPDF 스크립트 실행 실패: ${error.message}`);
          if (stderr) log.error(`stderr: ${stderr}`);
          reject(new Error(`PyMuPDF 이미지 추출 실패: ${error.message}`));
          return;
        }

        if (stderr) log.warn(`PyMuPDF stderr: ${stderr.trim()}`);

        try {
          const result: ImageExtractionResult = JSON.parse(stdout);

          if ("error" in result) {
            reject(new Error(`PyMuPDF 오류: ${(result as Record<string, unknown>).error}`));
            return;
          }

          log.info(`추출된 이미지: ${result.images.length}개 (총 ${result.total_pages} 페이지)`);

          if (result.page_text_blocks) {
            const blockCounts = Object.entries(result.page_text_blocks)
              .map(([p, blocks]) => `p${p}:${(blocks as PageTextBlock[]).length}`)
              .join(", ");
            log.info(`텍스트 블록 좌표: ${blockCounts}`);
          }
          if (result.page_heights) {
            const heights = Object.entries(result.page_heights)
              .map(([p, h]) => `p${p}:${h}`)
              .join(", ");
            log.info(`페이지 높이: ${heights}`);
          }

          const imageMap = new Map<string, string>();
          for (const img of result.images) {
            const absPath = path.join(imageDir, img.filename);
            imageMap.set(img.filename, absPath);

            const stat = await fs.stat(absPath);
            log.info(
              `  ${img.filename} (page=${img.page}, y=${img.y_position}, ` +
              `${img.width}x${img.height}, ${stat.size} bytes, ` +
              `anchor[${img.anchor_position}]="${img.anchor_text.slice(0, 40)}${img.anchor_text.length > 40 ? "..." : ""}")`
            );
          }

          resolve({ metadata: result, imageMap });
        } catch (parseError) {
          log.error(`PyMuPDF 출력 파싱 실패: ${stdout.slice(0, 500)}`);
          reject(new Error("PyMuPDF 출력 파싱 실패"));
        }
      }
    );
  });
}

/**
 * 마크다운에서 anchor_text와 매칭되는 위치를 찾아 해당 줄 인덱스를 반환한다.
 * 매칭 실패 시 -1을 반환한다.
 */
function findAnchorLineIndex(lines: string[], anchorText: string): number {
  // 한국어는 글자당 정보량이 높으므로 2자 이상이면 매칭 시도
  if (!anchorText || anchorText.trim().length < 2) return -1;

  // 1차: 정확한 부분 문자열 매칭
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(anchorText)) {
      return i;
    }
  }

  // 2차: anchor_text의 뒷부분(30자)으로 재시도
  const shortAnchor = anchorText.length > 30 ? anchorText.slice(-30) : anchorText;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(shortAnchor)) {
      return i;
    }
  }

  // 3차: 공백/줄바꿈을 무시한 유연한 매칭
  const normalizedAnchor = anchorText.replace(/\s+/g, "").toLowerCase();
  if (normalizedAnchor.length < 2) return -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const normalizedLine = lines[i].replace(/\s+/g, "").toLowerCase();
    if (normalizedLine.includes(normalizedAnchor)) {
      return i;
    }
  }

  // 4차: 짧은 부분(15자)으로 정규화 매칭
  const shortNormalized = normalizedAnchor.length > 15 ? normalizedAnchor.slice(-15) : normalizedAnchor;
  for (let i = lines.length - 1; i >= 0; i--) {
    const normalizedLine = lines[i].replace(/\s+/g, "").toLowerCase();
    if (normalizedLine.includes(shortNormalized)) {
      return i;
    }
  }

  return -1;
}

/**
 * 보정 포인트 배열에서 단조 증가하는 부분 수열만 유지한다.
 * y가 증가할 때 lineIndex도 증가해야 유효한 매칭이다.
 */
function filterMonotonic(points: CalibrationPoint[]): CalibrationPoint[] {
  if (points.length === 0) return [];

  const result: CalibrationPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].lineIndex > result[result.length - 1].lineIndex) {
      result.push(points[i]);
    }
  }
  return result;
}

/**
 * 페이지의 텍스트 블록들을 마크다운 줄에 매칭하여 보정 포인트를 생성한다.
 * 기존 findAnchorLineIndex()를 재사용하되, 매칭 성공한 것만 수집한다.
 */
function buildCalibrationPoints(
  lines: string[],
  textBlocks: PageTextBlock[],
  log: ConvertLogger,
  pageNum: number
): CalibrationPoint[] {
  const points: CalibrationPoint[] = [];
  const usedLineIndices = new Set<number>();

  for (const block of textBlocks) {
    const lineIndex = findAnchorLineIndex(lines, block.text);

    if (lineIndex >= 0 && !usedLineIndices.has(lineIndex)) {
      points.push({ y: block.y, lineIndex });
      usedLineIndices.add(lineIndex);
    }
  }

  points.sort((a, b) => a.y - b.y);

  const filtered = filterMonotonic(points);

  log.info(
    `  페이지 ${pageNum}: 보정 포인트 ${filtered.length}개 ` +
    `(텍스트 블록 ${textBlocks.length}개 중 ${points.length}개 매칭, ` +
    `${points.length - filtered.length}개 비단조 제거)`
  );

  return filtered;
}

/**
 * 보정 포인트를 기반으로 이미지 y좌표에 해당하는 마크다운 줄 인덱스를 보간한다.
 */
function interpolateLineIndex(
  imageY: number,
  calibrationPoints: CalibrationPoint[],
  totalLines: number,
  pageHeight: number | undefined
): number {
  const n = calibrationPoints.length;
  const h = pageHeight ?? 800;

  if (n === 0) {
    const ratio = Math.min(Math.max(imageY / h, 0), 1);
    return Math.round(ratio * (totalLines - 1));
  }

  if (n === 1) {
    const cp = calibrationPoints[0];
    if (imageY <= cp.y) {
      const ratio = cp.y > 0 ? imageY / cp.y : 0;
      return Math.round(ratio * cp.lineIndex);
    } else {
      const remainingY = h - cp.y;
      const remainingLines = totalLines - 1 - cp.lineIndex;
      if (remainingY <= 0) return totalLines - 1;
      const ratio = Math.min((imageY - cp.y) / remainingY, 1);
      return Math.round(cp.lineIndex + ratio * remainingLines);
    }
  }

  // 이미지가 첫 보정 포인트 위
  if (imageY <= calibrationPoints[0].y) {
    const cp = calibrationPoints[0];
    if (cp.y <= 0) return 0;
    const ratio = imageY / cp.y;
    return Math.max(0, Math.round(ratio * cp.lineIndex));
  }

  // 이미지가 마지막 보정 포인트 아래
  if (imageY >= calibrationPoints[n - 1].y) {
    const lastCp = calibrationPoints[n - 1];
    const remainingY = h - lastCp.y;
    const remainingLines = totalLines - 1 - lastCp.lineIndex;
    if (remainingY <= 0) return totalLines - 1;
    const ratio = Math.min((imageY - lastCp.y) / remainingY, 1);
    return Math.min(totalLines - 1, Math.round(lastCp.lineIndex + ratio * remainingLines));
  }

  // 두 보정 포인트 사이 → 선형 보간
  for (let i = 0; i < n - 1; i++) {
    const lo = calibrationPoints[i];
    const hi = calibrationPoints[i + 1];
    if (imageY >= lo.y && imageY <= hi.y) {
      const yRange = hi.y - lo.y;
      if (yRange <= 0) return lo.lineIndex;
      const t = (imageY - lo.y) / yRange;
      return Math.round(lo.lineIndex + t * (hi.lineIndex - lo.lineIndex));
    }
  }

  return Math.round(totalLines / 2);
}

/**
 * 삽입 대상 줄이 마크다운 테이블 내부인지 확인하고,
 * 테이블 내부라면 테이블 종료 직후의 줄 인덱스를 반환한다.
 */
function adjustForTable(lines: string[], targetIndex: number): number {
  if (targetIndex < 0 || targetIndex >= lines.length) return targetIndex;
  if (!lines[targetIndex].trimStart().startsWith("|")) return targetIndex;

  let endIndex = targetIndex;
  while (endIndex < lines.length && lines[endIndex].trimStart().startsWith("|")) {
    endIndex++;
  }

  return endIndex;
}

/**
 * Marker의 paginated markdown에 PyMuPDF로 추출한 이미지 참조를 삽입한다.
 *
 * 전략 (좌표 기반 보간):
 * 1. 마크다운을 페이지 구분자 기준으로 섹션 분할
 * 2. PyMuPDF 텍스트 블록을 마크다운 줄에 매칭하여 보정 포인트 생성
 * 3. 이미지 y좌표를 보정 포인트 사이에서 선형 보간하여 삽입 줄 결정
 * 4. 삽입 위치가 테이블 내부면 테이블 뒤로 밀어냄
 * 5. 페이지 구분자를 제거하여 최종 마크다운 생성
 *
 * pageTextBlocks가 없으면 기존 anchor_text 매칭으로 폴백한다.
 */
export function insertImageReferences(
  paginatedMarkdown: string,
  extractedImages: ExtractedImage[],
  log: ConvertLogger,
  pageTextBlocks?: Record<string, PageTextBlock[]>,
  pageHeights?: Record<string, number>
): string {
  const mode = pageTextBlocks ? "좌표 보간" : "anchor 텍스트 매칭 (레거시)";
  log.section(`이미지 참조 삽입 (${mode})`);

  // 이미지를 페이지별로 그룹화
  const imagesByPage = new Map<number, ExtractedImage[]>();
  for (const img of extractedImages) {
    const pageImages = imagesByPage.get(img.page) || [];
    pageImages.push(img);
    imagesByPage.set(img.page, pageImages);
  }

  log.info(`이미지가 있는 페이지: ${imagesByPage.size}개`);
  for (const [page, imgs] of imagesByPage) {
    log.info(`  페이지 ${page}: ${imgs.length}개 이미지`);
  }

  // 마크다운을 페이지 섹션으로 분할
  const separators: { index: number; pageNumber: number; fullMatch: string }[] = [];
  const regex = new RegExp(PAGE_SEPARATOR_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(paginatedMarkdown)) !== null) {
    separators.push({
      index: match.index,
      pageNumber: parseInt(match[1], 10),
      fullMatch: match[0],
    });
  }

  // 페이지 섹션 구성: { pageNumber (0-based), content }
  const sections: { pageNumber: number; content: string }[] = [];

  if (separators.length === 0) {
    // 구분자가 없으면 전체가 1페이지
    log.warn("페이지 구분자를 찾지 못함. 전체 마크다운을 하나의 페이지로 처리합니다.");
    sections.push({ pageNumber: 0, content: paginatedMarkdown });
  } else {
    // Marker의 page_id는 0-based이며, 첫 페이지에도 구분자가 붙음
    // 구분자 {N} 뒤의 내용이 페이지 N의 콘텐츠
    for (let i = 0; i < separators.length; i++) {
      const sep = separators[i];
      const start = sep.index + sep.fullMatch.length;
      const end = i + 1 < separators.length
        ? separators[i + 1].index
        : paginatedMarkdown.length;

      sections.push({
        pageNumber: sep.pageNumber,
        content: paginatedMarkdown.slice(start, end),
      });
    }
  }

  log.info(`마크다운 섹션 분할: ${sections.length}개`);

  let matchedCount = 0;
  let fallbackCount = 0;

  // 각 섹션에서 이미지 삽입
  const resultParts: string[] = [];

  for (const section of sections) {
    const pageImages = imagesByPage.get(section.pageNumber);

    if (!pageImages || pageImages.length === 0) {
      resultParts.push(section.content);
      continue;
    }

    const lines = section.content.split("\n");
    const pageKey = String(section.pageNumber);
    const textBlocks = pageTextBlocks?.[pageKey];
    const pageHeight = pageHeights?.[pageKey];

    const useInterpolation = textBlocks && textBlocks.length > 0;

    let calibrationPoints: CalibrationPoint[] = [];
    if (useInterpolation) {
      calibrationPoints = buildCalibrationPoints(
        lines, textBlocks, log, section.pageNumber
      );
    }

    // 이미지를 y_position 역순으로 처리 (뒤에서부터 삽입해야 인덱스가 안 밀림)
    const sortedImages = [...pageImages].sort((a, b) => b.y_position - a.y_position);

    for (const img of sortedImages) {
      let insertionIndex: number;

      if (useInterpolation) {
        // 좌표 기반 보간
        const rawIndex = interpolateLineIndex(
          img.y_position, calibrationPoints, lines.length, pageHeight
        );

        // rawIndex가 보정 포인트의 lineIndex와 일치하고,
        // 해당 보정 포인트의 y좌표가 이미지 y좌표보다 작으면(=텍스트가 이미지 위에 있으면)
        // splice는 해당 줄 "앞에" 삽입하므로 +1 해서 텍스트 "뒤에" 삽입해야 한다.
        let adjustedIndex = rawIndex;
        const matchedCp = calibrationPoints.find(
          cp => cp.lineIndex === rawIndex && cp.y < img.y_position
        );
        if (matchedCp) {
          adjustedIndex = rawIndex + 1;
        }
        insertionIndex = adjustForTable(lines, adjustedIndex);

        log.info(
          `  페이지 ${img.page}: "${img.filename}" → 보간 삽입 ` +
          `(y=${img.y_position}, raw_line=${rawIndex}, ` +
          `adjusted_line=${insertionIndex}, cp=${calibrationPoints.length}` +
          `${matchedCp ? `, +1 보정(cp.y=${matchedCp.y})` : ""})`
        );
        if (insertionIndex !== adjustedIndex) {
          log.info(`    → 테이블 회피: line ${adjustedIndex} → ${insertionIndex}`);
        }
        matchedCount++;
      } else {
        // 폴백: 기존 anchor 텍스트 매칭
        const lineIndex = findAnchorLineIndex(lines, img.anchor_text);

        if (lineIndex >= 0) {
          insertionIndex = img.anchor_position === "below"
            ? lineIndex
            : lineIndex + 1;
          matchedCount++;
          log.info(
            `  페이지 ${img.page}: "${img.filename}" → anchor 매칭 (line ${lineIndex})`
          );
        } else {
          insertionIndex = lines.length;
          fallbackCount++;
          log.warn(
            `  페이지 ${img.page}: "${img.filename}" → anchor 매칭 실패, 페이지 끝에 삽입`
          );
        }
      }

      const safeIndex = Math.max(0, Math.min(insertionIndex, lines.length));
      lines.splice(safeIndex, 0, "", `![](${img.filename})`, "");
    }

    resultParts.push(lines.join("\n"));
  }

  const result = resultParts.join("\n\n");

  log.info(
    `이미지 참조 삽입 완료: ${matchedCount}개 매칭 성공, ${fallbackCount}개 폴백`
  );
  log.info(`최종 마크다운 길이: ${result.length}자`);

  return result;
}

/**
 * Marker의 paginated markdown에서 페이지 구분자를 제거한다.
 */
export function stripPageSeparators(markdown: string): string {
  return markdown.replace(PAGE_SEPARATOR_REGEX, "");
}
