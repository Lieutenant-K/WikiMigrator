import { ipcMain, dialog, BrowserWindow } from "electron";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import path from "path";
import { getAppPaths } from "./app-paths";
import { getMainWindow, showNotification, setDockProgress } from "./main";

// lib 모듈 import
import { setLogDir, ConvertLogger } from "../src/lib/logger";
import { setMarkerTmpDir, convertPdfToMarkdown, cleanupTempFiles } from "../src/lib/marker";
import { setImageExtractorPaths, extractImagesWithPyMuPDF, insertImageReferences, stripPageSeparators } from "../src/lib/image-extractor";
import { setTableLinkPaths, extractTableLinksFromPDF, injectTableLinks } from "../src/lib/table-link-injector";
import { setBulletRestorerPaths, extractBulletsFromPDF, restoreBulletMarkers } from "../src/lib/bullet-restorer";
import { setFileBrowserDirs, listFiles, readFileContent, isPathSafe, resolveFilePath } from "../src/lib/file-browser";
import { createNotionClient, createNotionPage, searchPages } from "../src/lib/notion";
import { uploadImages, uploadPdfToNotion } from "../src/lib/image-uploader";
import {
  normalizeCodeBlockIndentation,
  preprocessMarkdownImages,
  convertMarkdownToNotionBlocks,
  extractTitleFromMarkdown,
  replaceImageBlocks,
} from "../src/lib/converter";

// 확장 PATH (brew, pyenv 등)
const EXTENDED_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  `${process.env.HOME}/.local/bin`,
  `${process.env.HOME}/Library/Python/3.11/bin`,
  `${process.env.HOME}/Library/Python/3.12/bin`,
  `${process.env.HOME}/Library/Python/3.13/bin`,
  process.env.PATH,
].join(":");

const BASE_PIPELINE_STEPS = [
  "PDF 파일 저장",
  "PDF → Markdown 변환",
  "이미지 추출",
  "테이블 링크 복원",
  "불릿 마커 복원",
  "코드 블록 정규화",
  "마크다운 저장",
  "이미지 업로드",
  "Notion 블록 변환",
  "Notion 페이지 생성",
];

function buildPipelineSteps(attachPdf: boolean): string[] {
  if (attachPdf) {
    return [
      ...BASE_PIPELINE_STEPS.slice(0, -1),
      "PDF 원본 업로드",
      "Notion 페이지 생성",
    ];
  }
  return [...BASE_PIPELINE_STEPS];
}

function initLibPaths(): void {
  const paths = getAppPaths();

  setLogDir(paths.logs);
  setMarkerTmpDir(paths.tmp);
  setFileBrowserDirs({
    logs: paths.logs,
    markdown: paths.outputMarkdown,
  });

  // PyMuPDF: 프로덕션에서는 번들 바이너리, 개발 모드에서는 Python 스크립트
  const pymupdfExists = (() => {
    try {
      require("fs").accessSync(paths.pymupdfTools, require("fs").constants.X_OK);
      return true;
    } catch {
      return false;
    }
  })();

  if (pymupdfExists) {
    setImageExtractorPaths({ tmpDir: paths.tmp, pymupdfToolsPath: paths.pymupdfTools });
    setTableLinkPaths({ pymupdfToolsPath: paths.pymupdfTools });
    setBulletRestorerPaths({ pymupdfToolsPath: paths.pymupdfTools });
  } else {
    setImageExtractorPaths({
      tmpDir: paths.tmp,
      scriptPath: path.join(paths.scripts, "extract_images.py"),
    });
    setTableLinkPaths({
      scriptPath: path.join(paths.scripts, "extract_table_links.py"),
    });
    setBulletRestorerPaths({
      scriptPath: path.join(paths.scripts, "extract_bullets.py"),
    });
  }
}

function sendEvent(data: object): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("convert-event", data);
  }
}

export function registerIpcHandlers(): void {
  initLibPaths();

  // --- get-pages ---
  ipcMain.handle("get-pages", async (_event, token: string) => {
    try {
      const client = createNotionClient(token);
      const pages = await searchPages(client);
      return { pages };
    } catch (err) {
      const message = err instanceof Error ? err.message : "페이지 조회 실패";
      throw new Error(message);
    }
  });

  // --- list-files ---
  ipcMain.handle("list-files", async (_event, type: string) => {
    if (!["logs", "markdown", "all"].includes(type)) {
      throw new Error("유효하지 않은 type 파라미터");
    }
    const files = await listFiles(type as "logs" | "markdown" | "all");
    return { files, total: files.length };
  });

  // --- read-file ---
  ipcMain.handle("read-file", async (_event, dir: string, name: string) => {
    if (!["logs", "markdown"].includes(dir)) {
      throw new Error("접근할 수 없는 디렉토리");
    }
    if (!isPathSafe(name)) {
      throw new Error("잘못된 파일명");
    }
    const result = await readFileContent(dir, name);
    if (!result) return null;
    return {
      name,
      type: dir === "logs" ? "log" : "markdown",
      content: result.content,
      size: result.size,
      modifiedAt: result.modifiedAt,
    };
  });

  // --- download-file ---
  ipcMain.handle("download-file", async (_event, dir: string, name: string) => {
    if (!["logs", "markdown"].includes(dir)) return null;
    if (!isPathSafe(name)) return null;

    const filePath = resolveFilePath(dir, name);
    if (!filePath) return null;

    try {
      const buffer = await fs.readFile(filePath);
      return { buffer: buffer.buffer, fileName: name };
    } catch {
      return null;
    }
  });

  // --- select-files (네이티브 파일 다이얼로그) ---
  ipcMain.handle("select-files", async () => {
    const win = getMainWindow();
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const files = [];
    for (const filePath of result.filePaths) {
      const buffer = await fs.readFile(filePath);
      files.push({
        name: path.basename(filePath),
        buffer: buffer.buffer,
        size: buffer.length,
      });
    }
    return files;
  });

  // --- check-marker ---
  ipcMain.handle("check-marker", async () => {
    return new Promise<{ installed: boolean; path?: string }>((resolve) => {
      execFile("which", ["marker_single"], {
        env: { ...process.env, PATH: EXTENDED_PATH },
      }, (error, stdout) => {
        if (error) {
          resolve({ installed: false });
        } else {
          resolve({ installed: true, path: stdout.trim() });
        }
      });
    });
  });

  // --- install-marker ---
  ipcMain.handle("install-marker", async () => {
    // pipx를 먼저 시도, 실패하면 pip install --user
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      execFile("pipx", ["install", "marker-pdf"], {
        env: { ...process.env, PATH: EXTENDED_PATH },
        timeout: 5 * 60 * 1000,
      }, (pipxErr) => {
        if (!pipxErr) {
          resolve({ success: true });
          return;
        }

        execFile("pip3", ["install", "--user", "marker-pdf"], {
          env: { ...process.env, PATH: EXTENDED_PATH },
          timeout: 5 * 60 * 1000,
        }, (pipErr, _stdout, stderr) => {
          if (pipErr) {
            resolve({ success: false, error: stderr || pipErr.message });
          } else {
            resolve({ success: true });
          }
        });
      });
    });
  });

  // --- convert (메인 변환 파이프라인) ---
  ipcMain.handle("convert", async (_event, params: {
    accessToken: string;
    parentPageId: string;
    attachPdf: boolean;
    fileBuffers: Array<{ name: string; buffer: ArrayBuffer; size: number }>;
  }) => {
    const { accessToken, parentPageId, attachPdf, fileBuffers } = params;

    if (!accessToken) throw new Error("Notion 토큰이 제공되지 않았습니다.");
    if (!parentPageId) throw new Error("대상 페이지를 선택해주세요.");
    if (fileBuffers.length === 0) throw new Error("PDF 파일을 업로드해주세요.");

    const client = createNotionClient(accessToken);
    const paths = getAppPaths();
    const PIPELINE_STEPS = buildPipelineSteps(attachPdf);
    const TOTAL_STEPS = PIPELINE_STEPS.length;

    const savedFiles: string[] = [];

    try {
      await fs.mkdir(paths.tmp, { recursive: true });

      for (let fileIndex = 0; fileIndex < fileBuffers.length; fileIndex++) {
        const { name: fileName, buffer: rawBuffer, size } = fileBuffers[fileIndex];
        const buffer = Buffer.from(rawBuffer);
        const log = new ConvertLogger(fileName);

        const emitProgress = (stepIndex: number) => {
          // Dock 진행률 업데이트
          const overallProgress = (fileIndex + stepIndex / TOTAL_STEPS) / fileBuffers.length;
          setDockProgress(overallProgress);

          sendEvent({
            type: "progress",
            fileIndex,
            fileName,
            step: PIPELINE_STEPS[stepIndex],
            stepIndex,
            totalSteps: TOTAL_STEPS,
            message: `${PIPELINE_STEPS[stepIndex]}...`,
          });
        };

        if (!fileName.toLowerCase().endsWith(".pdf")) {
          log.error("PDF 파일이 아닙니다.");
          sendEvent({
            type: "result",
            fileIndex,
            fileName,
            status: "error",
            error: "PDF 파일만 지원합니다.",
            logFile: log.logFileName,
          });
          await log.flush();
          continue;
        }

        const mdFileName = fileName.replace(/\.pdf$/i, ".md");
        let mdSaved = false;

        try {
          log.info(`대상 페이지: ${parentPageId}`);
          log.info(`파일 크기: ${size} bytes`);

          // 0. PDF 파일 저장
          emitProgress(0);
          log.section("PDF 파일 저장");
          const pdfPath = path.join(
            paths.tmp,
            `${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`
          );
          await fs.writeFile(pdfPath, buffer);
          savedFiles.push(pdfPath);
          log.info(`임시 파일 저장: ${pdfPath}`);

          // 1. Marker로 PDF → Markdown 변환
          emitProgress(1);
          const { markdown: paginatedMarkdown } = await convertPdfToMarkdown(pdfPath, log);

          // 2. PyMuPDF로 원본 이미지 추출
          emitProgress(2);
          let imageMap = new Map<string, string>();
          let markdownWithImages = paginatedMarkdown;

          try {
            const { metadata, imageMap: pymuPdfImageMap } = await extractImagesWithPyMuPDF(pdfPath, log);
            imageMap = pymuPdfImageMap;

            if (metadata.images.length > 0) {
              markdownWithImages = insertImageReferences(
                paginatedMarkdown, metadata.images, log,
                metadata.page_text_blocks, metadata.page_heights
              );
            } else {
              markdownWithImages = stripPageSeparators(paginatedMarkdown);
              log.info("PyMuPDF에서 추출된 이미지 없음");
            }
          } catch (pymuPdfError) {
            log.warn(
              `PyMuPDF 이미지 추출 실패, 이미지 없이 진행: ${pymuPdfError instanceof Error ? pymuPdfError.message : "알 수 없는 오류"}`
            );
            markdownWithImages = stripPageSeparators(paginatedMarkdown);
          }

          // 3. 테이블 내 하이퍼링크 복원
          emitProgress(3);
          try {
            const tableLinkData = await extractTableLinksFromPDF(pdfPath, log);
            if (tableLinkData.tables.length > 0) {
              markdownWithImages = injectTableLinks(markdownWithImages, tableLinkData.tables, log);
            }
          } catch (tableLinkError) {
            log.warn(
              `테이블 링크 추출 실패, 링크 없이 진행: ${tableLinkError instanceof Error ? tableLinkError.message : "알 수 없는 오류"}`
            );
          }

          // 4. 벡터 불릿 복원
          emitProgress(4);
          try {
            const bulletData = await extractBulletsFromPDF(pdfPath, log);
            if (bulletData.bullets.length > 0) {
              markdownWithImages = restoreBulletMarkers(markdownWithImages, bulletData.bullets, log);
            }
          } catch (bulletError) {
            log.warn(
              `벡터 불릿 복원 실패, 불릿 없이 진행: ${bulletError instanceof Error ? bulletError.message : "알 수 없는 오류"}`
            );
          }

          // 5. 코드 블록 들여쓰기 정규화
          emitProgress(5);
          log.section("코드 블록 들여쓰기 정규화");
          const markdown = normalizeCodeBlockIndentation(markdownWithImages, log);

          // 6. 변환된 Markdown을 .md 파일로 저장
          emitProgress(6);
          await fs.mkdir(paths.outputMarkdown, { recursive: true });
          const mdPath = path.join(paths.outputMarkdown, mdFileName);
          await fs.writeFile(mdPath, markdown, "utf-8");
          mdSaved = true;
          log.info(`마크다운 파일 저장: ${mdPath}`);

          // 7. 이미지를 Notion File Upload API로 업로드
          emitProgress(7);
          let uploadMap = new Map<string, string>();
          if (imageMap.size > 0) {
            uploadMap = await uploadImages(client, imageMap, log);
          } else {
            log.info("이미지 없음 → 업로드 건너뜀");
          }

          // 마크다운 전처리
          log.section("마크다운 이미지 전처리");
          const { processed: processedMarkdown } = preprocessMarkdownImages(markdown, log);

          // 8. Martian으로 Markdown → Notion Blocks 변환
          emitProgress(8);
          const { topLevelBlocks, deferredAppends } = convertMarkdownToNotionBlocks(processedMarkdown, log);
          const title = extractTitleFromMarkdown(markdown) || fileName.replace(".pdf", "");

          if (uploadMap.size > 0) {
            log.section("이미지 블록 교체 (placeholder → file_upload)");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            replaceImageBlocks(topLevelBlocks as any[], uploadMap, log);
            for (const deferred of deferredAppends) {
              replaceImageBlocks(deferred.children, uploadMap, log);
            }
          }

          // 9. PDF 원본 업로드 (옵션)
          if (attachPdf) {
            emitProgress(9);
            try {
              const pdfUploadId = await uploadPdfToNotion(client, buffer, fileName, log);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              topLevelBlocks.unshift(
                { type: "pdf", pdf: { type: "file_upload", file_upload: { id: pdfUploadId } } } as any,
                { type: "divider", divider: {} } as any,
              );
              log.info(`PDF 블록을 문서 최상단에 삽입 (upload_id=${pdfUploadId})`);
            } catch (pdfErr) {
              const pdfMsg = pdfErr instanceof Error ? pdfErr.message : "알 수 없는 오류";
              log.warn(`PDF 원본 업로드 실패 (변환 결과에는 영향 없음): ${pdfMsg}`);
            }
          }

          // 10 (또는 9). Notion 페이지 생성
          emitProgress(TOTAL_STEPS - 1);
          const pageId = await createNotionPage(client, parentPageId, title, topLevelBlocks, deferredAppends, log);

          log.info(`최종 결과: 성공 (pageId=${pageId})`);
          sendEvent({
            type: "result",
            fileIndex,
            fileName,
            status: "success",
            pageId,
            logFile: log.logFileName,
            mdFile: mdFileName,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "변환 실패";
          log.error(`최종 결과: 실패 → ${message}`);
          if (err instanceof Error && err.stack) {
            log.error(`스택 트레이스:\n${err.stack}`);
          }
          sendEvent({
            type: "result",
            fileIndex,
            fileName,
            status: "error",
            error: message,
            logFile: log.logFileName,
            mdFile: mdSaved ? mdFileName : undefined,
          });
        } finally {
          const logPath = await log.flush();
          console.log(`[WikiMigrator] 로그 저장: ${logPath}`);
        }
      }

      sendEvent({ type: "done" });

      // Dock 진행률 리셋
      setDockProgress(-1);

      // 변환 완료 알림
      const successCount = fileBuffers.length; // 대략적 — 실제 성공 수는 프론트엔드에서 추적
      showNotification("WikiMigrator", `${successCount}개 파일 변환 완료`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "처리 중 오류 발생";
      sendEvent({ type: "result", fileIndex: -1, fileName: "", status: "error", error: message });
      sendEvent({ type: "done" });
      setDockProgress(-1);
    } finally {
      // 임시 파일 정리
      for (const filePath of savedFiles) {
        try { await fs.unlink(filePath); } catch { /* 무시 */ }
      }
      try {
        const entries = await fs.readdir(getAppPaths().tmp);
        for (const entry of entries) {
          if (entry.startsWith("output_") || entry.startsWith("pymupdf_")) {
            await cleanupTempFiles(path.join(getAppPaths().tmp, entry));
          }
        }
      } catch { /* 무시 */ }
    }
  });
}
