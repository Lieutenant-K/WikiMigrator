import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import type { ConvertLogger } from "./logger";

const TMP_DIR = path.join(process.cwd(), "tmp");
const TIMEOUT_MS = 5 * 60 * 1000; // 5분

// brew 등 사용자 설치 경로가 누락되지 않도록 PATH를 보완
const EXEC_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH,
].join(":");

export interface MarkerResult {
  markdown: string;
  /** 이미지 파일명(마크다운에서 참조하는 상대 경로) → 절대 파일 경로 매핑 */
  imageMap: Map<string, string>;
}

export async function convertPdfToMarkdown(
  pdfPath: string,
  log: ConvertLogger
): Promise<MarkerResult> {
  await fs.mkdir(TMP_DIR, { recursive: true });

  const outputDir = path.join(
    TMP_DIR,
    `output_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(outputDir, { recursive: true });

  log.section("PDF → Markdown 변환 (Marker)");
  log.info(`입력 PDF: ${pdfPath}`);
  log.info(`출력 디렉토리: ${outputDir}`);
  log.info(`명령어: marker_single ${pdfPath} --output_format markdown --output_dir ${outputDir} --disable_image_extraction --paginate_output`);

  return new Promise((resolve, reject) => {
    execFile(
      "marker_single",
      [
        pdfPath,
        "--output_format", "markdown",
        "--output_dir", outputDir,
        "--disable_image_extraction",
        "--paginate_output",
      ],
      { timeout: TIMEOUT_MS, env: { ...process.env, PATH: EXEC_PATH } },
      async (error, stdout, stderr) => {
        if (error) {
          log.error(`Marker 실행 실패: ${error.message}`);
          if (stderr) log.error(`stderr: ${stderr}`);
          reject(
            new Error(`Marker 변환 실패: ${error.message}\n${stderr}`)
          );
          return;
        }

        if (stdout) log.info(`Marker stdout: ${stdout.trim()}`);
        if (stderr) log.warn(`Marker stderr: ${stderr.trim()}`);

        try {
          const result = await readMarkerOutput(outputDir, log);
          resolve(result);
        } catch (readError) {
          reject(readError);
        }
      }
    );
  });
}

async function readMarkerOutput(outputDir: string, log: ConvertLogger): Promise<MarkerResult> {
  const entries = await fs.readdir(outputDir, { recursive: true });

  let markdown = "";
  let mdDir = "";
  const imageMap = new Map<string, string>();

  log.info(`Marker 출력 파일 목록:`);
  for (const entry of entries) {
    const entryStr = String(entry);
    const fullPath = path.join(outputDir, entryStr);
    const stat = await fs.stat(fullPath);
    if (stat.isFile()) {
      log.info(`  ${entryStr} (${stat.size} bytes)`);
    }
  }

  // 먼저 .md 파일을 찾아서 디렉토리를 확인
  for (const entry of entries) {
    const entryStr = String(entry);
    const fullPath = path.join(outputDir, entryStr);
    const stat = await fs.stat(fullPath);

    if (stat.isFile() && entryStr.endsWith(".md")) {
      markdown = await fs.readFile(fullPath, "utf-8");
      mdDir = path.dirname(fullPath);
      log.info(`마크다운 파일: ${entryStr} (${markdown.length}자)`);
    }
  }

  if (!markdown) {
    log.error("Marker 출력에서 Markdown 파일을 찾을 수 없습니다.");
    throw new Error("Marker 출력에서 Markdown 파일을 찾을 수 없습니다.");
  }

  // 이미지 파일 수집
  for (const entry of entries) {
    const entryStr = String(entry);
    const fullPath = path.join(outputDir, entryStr);
    const stat = await fs.stat(fullPath);

    if (stat.isFile() && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(entryStr)) {
      const relativePath = path.relative(mdDir, fullPath);
      imageMap.set(relativePath, fullPath);
    }
  }

  log.info(`발견된 이미지: ${imageMap.size}개`);
  for (const [rel, abs] of imageMap) {
    const stat = await fs.stat(abs);
    log.info(`  ${rel} → ${abs} (${stat.size} bytes)`);
  }

  // 마크다운 내 이미지 참조 확인
  const imageRefs = markdown.match(/!\[.*?\]\(.*?\)/g) || [];
  log.info(`마크다운 내 이미지 참조: ${imageRefs.length}개`);
  for (const ref of imageRefs) {
    const urlMatch = ref.match(/\((.*?)\)/);
    const url = urlMatch ? urlMatch[1] : "(파싱 실패)";
    const matched = imageMap.has(url) ? "✓ 매칭됨" : "✗ 매칭 안됨";
    log.info(`  ${url} → ${matched}`);
  }

  return { markdown, imageMap };
}

export async function cleanupTempFiles(outputDir: string): Promise<void> {
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
  } catch {
    // 정리 실패는 무시
  }
}
