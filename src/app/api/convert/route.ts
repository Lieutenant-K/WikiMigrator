import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { convertPdfToMarkdown, cleanupTempFiles } from "@/lib/marker";
import { convertMarkdownToNotionBlocks, extractTitleFromMarkdown, replaceImageBlocks, preprocessMarkdownImages, normalizeCodeBlockIndentation } from "@/lib/converter";
import { extractImagesWithPyMuPDF, insertImageReferences, stripPageSeparators } from "@/lib/image-extractor";
import { extractTableLinksFromPDF, injectTableLinks } from "@/lib/table-link-injector";
import { createNotionClient, createNotionPage } from "@/lib/notion";
import { uploadImages } from "@/lib/image-uploader";
import { ConvertLogger } from "@/lib/logger";

const TMP_DIR = path.join(process.cwd(), "tmp");
const MD_OUTPUT_DIR = path.join(process.cwd(), "output_markdown");

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

  let savedFiles: string[] = [];

  try {
    const formData = await request.formData();
    const parentPageId = formData.get("parentPageId") as string;
    const files = formData.getAll("files") as File[];

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

    const client = createNotionClient(accessToken);
    const results: Array<{
      fileName: string;
      status: "success" | "error";
      pageId?: string;
      error?: string;
    }> = [];

    await fs.mkdir(TMP_DIR, { recursive: true });

    for (const file of files) {
      const fileName = file.name;
      const log = new ConvertLogger(fileName);

      if (!fileName.toLowerCase().endsWith(".pdf")) {
        log.error("PDF 파일이 아닙니다.");
        results.push({
          fileName,
          status: "error",
          error: "PDF 파일만 지원합니다.",
        });
        await log.flush();
        continue;
      }

      try {
        log.info(`대상 페이지: ${parentPageId}`);
        log.info(`파일 크기: ${file.size} bytes`);

        // 1. 파일을 임시 디렉토리에 저장
        log.section("PDF 파일 저장");
        const pdfPath = path.join(
          TMP_DIR,
          `${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`
        );
        const buffer = Buffer.from(await file.arrayBuffer());
        await fs.writeFile(pdfPath, buffer);
        savedFiles.push(pdfPath);
        log.info(`임시 파일 저장: ${pdfPath}`);

        // 2. Marker로 PDF → Markdown 변환 (이미지 추출 비활성화, 페이지 구분자 활성화)
        const { markdown: paginatedMarkdown } = await convertPdfToMarkdown(pdfPath, log);

        // 2.5. PyMuPDF로 원본 이미지 추출 + 마크다운에 이미지 참조 삽입
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

        // 2.6. 테이블 내 하이퍼링크 복원
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

        // 2.7. 코드 블록 들여쓰기 정규화 (Marker가 축소한 들여쓰기를 4칸으로 복원)
        log.section("코드 블록 들여쓰기 정규화");
        const markdown = normalizeCodeBlockIndentation(markdownWithImages, log);

        // 2-1. 변환된 Markdown을 .md 파일로 저장
        await fs.mkdir(MD_OUTPUT_DIR, { recursive: true });
        const mdFileName = fileName.replace(/\.pdf$/i, ".md");
        const mdPath = path.join(MD_OUTPUT_DIR, mdFileName);
        await fs.writeFile(mdPath, markdown, "utf-8");
        log.info(`마크다운 파일 저장: ${mdPath}`);

        // 3. 이미지를 Notion File Upload API로 업로드
        let uploadMap = new Map<string, string>();
        if (imageMap.size > 0) {
          uploadMap = await uploadImages(client, imageMap, log);
        } else {
          log.info("이미지 없음 → 업로드 건너뜀");
        }

        // 3-1. 마크다운 전처리: 로컬 이미지 경로 → placeholder URL 치환
        //      (Martian이 로컬 경로를 image 블록이 아닌 텍스트로 변환하는 문제 우회)
        log.section("마크다운 이미지 전처리");
        const { processed: processedMarkdown } = preprocessMarkdownImages(markdown, log);

        // 4. Martian으로 Markdown → Notion Blocks 변환 (전처리된 마크다운 사용)
        const { topLevelBlocks, deferredAppends } = convertMarkdownToNotionBlocks(processedMarkdown, log);
        const title = extractTitleFromMarkdown(markdown) || fileName.replace(".pdf", "");

        // 5. image 블록의 placeholder URL → file_upload 참조로 교체
        if (uploadMap.size > 0) {
          log.section("이미지 블록 교체 (placeholder → file_upload)");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          replaceImageBlocks(topLevelBlocks as any[], uploadMap, log);
          for (const deferred of deferredAppends) {
            replaceImageBlocks(deferred.children, uploadMap, log);
          }
        }

        // 6. Notion 페이지 생성 (깊이 초과 블록은 순차 append)
        const pageId = await createNotionPage(client, parentPageId, title, topLevelBlocks, deferredAppends, log);

        log.info(`최종 결과: 성공 (pageId=${pageId})`);
        results.push({ fileName, status: "success", pageId });
      } catch (err) {
        const message = err instanceof Error ? err.message : "변환 실패";
        log.error(`최종 결과: 실패 → ${message}`);
        if (err instanceof Error && err.stack) {
          log.error(`스택 트레이스:\n${err.stack}`);
        }
        results.push({ fileName, status: "error", error: message });
      } finally {
        const logPath = await log.flush();
        console.log(`[WikiMigrator] 로그 저장: ${logPath}`);
      }
    }

    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "처리 중 오류 발생";
    return NextResponse.json({ error: message }, { status: 500 });
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
}
