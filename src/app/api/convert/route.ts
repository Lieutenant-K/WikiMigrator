import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { convertPdfToMarkdown, cleanupTempFiles } from "@/lib/marker";
import { convertMarkdownToNotionBlocks, extractTitleFromMarkdown, replaceImageBlocks, preprocessMarkdownImages, normalizeCodeBlockIndentation } from "@/lib/converter";
import { extractImagesWithPyMuPDF, insertImageReferences, stripPageSeparators } from "@/lib/image-extractor";
import { extractTableLinksFromPDF, injectTableLinks } from "@/lib/table-link-injector";
import { extractBulletsFromPDF, restoreBulletMarkers } from "@/lib/bullet-restorer";
import { createNotionClient, createNotionPage } from "@/lib/notion";
import { uploadImages, uploadPdfToNotion } from "@/lib/image-uploader";
import { ConvertLogger } from "@/lib/logger";

const TMP_DIR = path.join(process.cwd(), "tmp");
const MD_OUTPUT_DIR = path.join(process.cwd(), "output_markdown");

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
    // "Notion 페이지 생성" 앞에 "PDF 원본 업로드" 삽입
    return [
      ...BASE_PIPELINE_STEPS.slice(0, -1),
      "PDF 원본 업로드",
      "Notion 페이지 생성",
    ];
  }
  return [...BASE_PIPELINE_STEPS];
}

function sseWrite(controller: ReadableStreamDefaultController<Uint8Array>, data: object): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
}

function extractToken(request: NextRequest): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

export async function POST(request: NextRequest) {
  const accessToken = extractToken(request);

  if (!accessToken) {
    return NextResponse.json(
      { error: "Notion 토큰이 제공되지 않았습니다." },
      { status: 401 }
    );
  }

  let formData: FormData;
  let parentPageId: string;
  let attachPdf: boolean;
  let files: File[];

  try {
    formData = await request.formData();
    parentPageId = formData.get("parentPageId") as string;
    attachPdf = formData.get("attachPdf") === "true";
    files = formData.getAll("files") as File[];
  } catch {
    return NextResponse.json(
      { error: "요청 데이터를 파싱할 수 없습니다." },
      { status: 400 }
    );
  }

  if (!parentPageId) {
    return NextResponse.json(
      { error: "대상 페이지를 선택해주세요." },
      { status: 400 }
    );
  }

  if (files.length === 0) {
    return NextResponse.json(
      { error: "PDF 파일을 업로드해주세요." },
      { status: 400 }
    );
  }

  // 파일 데이터를 미리 버퍼에 읽어둠 (스트림 내부에서 formData 접근 불가)
  const fileBuffers: Array<{ name: string; buffer: Buffer; size: number }> = [];
  for (const file of files) {
    fileBuffers.push({
      name: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
      size: file.size,
    });
  }

  const client = createNotionClient(accessToken);

  const PIPELINE_STEPS = buildPipelineSteps(attachPdf);
  const TOTAL_STEPS = PIPELINE_STEPS.length;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const savedFiles: string[] = [];

      try {
        await fs.mkdir(TMP_DIR, { recursive: true });

        for (let fileIndex = 0; fileIndex < fileBuffers.length; fileIndex++) {
          const { name: fileName, buffer, size } = fileBuffers[fileIndex];
          const log = new ConvertLogger(fileName);

          const emitProgress = (stepIndex: number) => {
            sseWrite(controller, {
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
            sseWrite(controller, {
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
              TMP_DIR,
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
            await fs.mkdir(MD_OUTPUT_DIR, { recursive: true });
            const mdPath = path.join(MD_OUTPUT_DIR, mdFileName);
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

            // 9. PDF 원본 업로드 → 블록 배열 맨 앞에 삽입 (옵션)
            if (attachPdf) {
              emitProgress(9);
              try {
                const pdfUploadId = await uploadPdfToNotion(client, buffer, fileName, log);
                topLevelBlocks.unshift(
                  { type: "pdf", pdf: { type: "file_upload", file_upload: { id: pdfUploadId } } },
                  { type: "divider", divider: {} },
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
            sseWrite(controller, {
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
            sseWrite(controller, {
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

        sseWrite(controller, { type: "done" });
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "처리 중 오류 발생";
        sseWrite(controller, { type: "result", fileIndex: -1, fileName: "", status: "error", error: message });
        sseWrite(controller, { type: "done" });
        controller.close();
      } finally {
        // 임시 파일 정리
        for (const filePath of savedFiles) {
          try {
            await fs.unlink(filePath);
          } catch {
            // 무시
          }
        }
        // tmp 디렉토리 내 오래된 output 디렉토리 정리
        try {
          const entries = await fs.readdir(TMP_DIR);
          for (const entry of entries) {
            if (entry.startsWith("output_") || entry.startsWith("pymupdf_")) {
              await cleanupTempFiles(path.join(TMP_DIR, entry));
            }
          }
        } catch {
          // 무시
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
