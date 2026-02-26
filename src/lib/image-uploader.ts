import { Client } from "@notionhq/client";
import { promises as fs } from "fs";
import path from "path";
import type { ConvertLogger } from "./logger";

/**
 * Notion File Upload API를 사용하여 로컬 이미지 파일을 업로드한다.
 *
 * 흐름:
 * 1. fileUploads.create() → 업로드 객체 생성 (id 발급)
 * 2. fileUploads.send()   → 파일 바이너리 전송
 * 3. fileUploads.retrieve() → 상태 확인 (uploaded인지 검증)
 * 4. 반환된 id를 image 블록의 file_upload 참조로 사용
 */

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE_MAP[ext] || "application/octet-stream";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 단일 이미지 파일을 Notion에 업로드하고 file_upload ID를 반환한다.
 */
async function uploadSingleImage(
  client: Client,
  filePath: string,
  relativePath: string,
  log: ConvertLogger
): Promise<string> {
  const filename = path.basename(filePath);
  const contentType = getContentType(filePath);
  const stat = await fs.stat(filePath);
  const fileSize = formatFileSize(stat.size);

  log.info(`  [create] ${relativePath} (${fileSize}, ${contentType})`);

  // Step 1: 업로드 객체 생성
  const fileUpload = await client.fileUploads.create({
    mode: "single_part",
    filename,
    content_type: contentType,
  });

  log.info(`  [create] 완료 → id=${fileUpload.id}, status=${fileUpload.status}`);

  // Step 2: 파일 바이너리 전송
  const fileBuffer = await fs.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: contentType });

  log.info(`  [send] 파일 전송 중... (${fileSize})`);

  const sendResponse = await client.fileUploads.send({
    file_upload_id: fileUpload.id,
    file: {
      filename,
      data: blob,
    },
  });

  log.info(`  [send] 완료 → status=${sendResponse.status}`);

  // Step 3: 업로드 상태 확인
  const verified = await client.fileUploads.retrieve({
    file_upload_id: fileUpload.id,
  });

  if (verified.status !== "uploaded") {
    const msg = `업로드 상태 이상: status=${verified.status} (expected: uploaded)`;
    log.error(`  [verify] ${msg}`);
    throw new Error(msg);
  }

  log.info(
    `  [verify] 확인 완료 → status=${verified.status}, ` +
    `content_length=${verified.content_length ?? "null"}, ` +
    `expiry_time=${verified.expiry_time ?? "null"}`
  );

  return fileUpload.id;
}

/**
 * 여러 이미지를 Notion에 업로드하고,
 * 마크다운에서 참조하는 상대 경로 → file_upload ID 매핑을 반환한다.
 */
export async function uploadImages(
  client: Client,
  imageMap: Map<string, string>,
  log: ConvertLogger
): Promise<Map<string, string>> {
  const uploadMap = new Map<string, string>();

  log.section(`이미지 업로드 (${imageMap.size}개)`);

  let successCount = 0;
  let failCount = 0;

  for (const [relativePath, absolutePath] of imageMap) {
    try {
      const fileUploadId = await uploadSingleImage(client, absolutePath, relativePath, log);
      uploadMap.set(relativePath, fileUploadId);
      successCount++;
      log.info(`  ✓ 성공: ${relativePath} → ${fileUploadId}`);
    } catch (err) {
      failCount++;
      const message = err instanceof Error ? err.message : "알 수 없는 오류";
      log.error(`  ✗ 실패: ${relativePath} → ${message}`);
    }
  }

  log.info(`이미지 업로드 완료: 성공 ${successCount}개, 실패 ${failCount}개`);

  return uploadMap;
}
