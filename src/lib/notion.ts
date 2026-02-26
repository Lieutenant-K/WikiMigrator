import { Client } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints";
import type { DeferredAppend } from "./converter";
import type { ConvertLogger } from "./logger";

const BLOCKS_PER_REQUEST = 100;

export function createNotionClient(accessToken: string): Client {
  return new Client({ auth: accessToken });
}

export async function searchPages(
  client: Client
): Promise<
  Array<{ id: string; title: string; icon: string | null }>
> {
  const response = await client.search({
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 50,
  });

  return response.results
    .filter((r): r is Extract<typeof r, { object: "page" }> => r.object === "page")
    .map((page) => {
      let title = "제목 없음";
      let icon: string | null = null;

      if ("properties" in page) {
        const titleProp = Object.values(page.properties).find(
          (p) => p.type === "title"
        );
        if (titleProp && titleProp.type === "title" && titleProp.title.length > 0) {
          title = titleProp.title.map((t) => t.plain_text).join("");
        }
      }

      if ("icon" in page && page.icon) {
        if (page.icon.type === "emoji") {
          icon = page.icon.emoji;
        }
      }

      return { id: page.id, title, icon };
    });
}

async function resolveBlockIdByPath(
  client: Client,
  pageId: string,
  path: string,
  cache: Map<string, string>
): Promise<string | null> {
  const cached = cache.get(path);
  if (cached) return cached;

  const parts = path.split(".").map(Number);

  let currentParentId = pageId;
  let resolvedPath = "";

  for (let depth = 0; depth < parts.length; depth++) {
    const index = parts[depth];
    resolvedPath = depth === 0 ? `${index}` : `${resolvedPath}.${index}`;

    const cachedId = cache.get(resolvedPath);
    if (cachedId) {
      currentParentId = cachedId;
      continue;
    }

    const childrenResponse = await client.blocks.children.list({
      block_id: currentParentId,
      page_size: 100,
    });

    for (let i = 0; i < childrenResponse.results.length; i++) {
      const result = childrenResponse.results[i];
      if ("id" in result) {
        const childPath = depth === 0
          ? `${i}`
          : `${resolvedPath.split(".").slice(0, depth).join(".")}.${i}`;
        cache.set(childPath, result.id);
      }
    }

    if (index >= childrenResponse.results.length) {
      return null;
    }

    const target = childrenResponse.results[index];
    if (!("id" in target)) return null;

    cache.set(resolvedPath, target.id);
    currentParentId = target.id;
  }

  return currentParentId;
}

async function appendBlocksInBatches(
  client: Client,
  parentBlockId: string,
  blocks: BlockObjectRequest[],
  log: ConvertLogger
): Promise<void> {
  for (let i = 0; i < blocks.length; i += BLOCKS_PER_REQUEST) {
    const batch = blocks.slice(i, i + BLOCKS_PER_REQUEST);
    const batchNum = Math.floor(i / BLOCKS_PER_REQUEST) + 1;
    const totalBatches = Math.ceil(blocks.length / BLOCKS_PER_REQUEST);

    log.info(`  블록 append 배치 ${batchNum}/${totalBatches} (${batch.length}개) → parent=${parentBlockId}`);

    await client.blocks.children.append({
      block_id: parentBlockId,
      children: batch,
    });

    log.info(`  블록 append 배치 ${batchNum}/${totalBatches} 완료`);
  }
}

export async function createNotionPage(
  client: Client,
  parentPageId: string,
  title: string,
  blocks: BlockObjectRequest[],
  deferredAppends: DeferredAppend[] = [],
  log?: ConvertLogger
): Promise<string> {
  // 로거가 없으면 무시하는 더미 로거 사용
  const l = log ?? { info: () => {}, warn: () => {}, error: () => {}, section: () => {} } as unknown as ConvertLogger;

  l.section("Notion 페이지 생성");
  l.info(`제목: "${title}"`);
  l.info(`상위 페이지: ${parentPageId}`);
  l.info(`전체 블록 수: ${blocks.length}개`);
  l.info(`deferred append: ${deferredAppends.length}개`);

  // 1단계: 첫 100개 블록으로 페이지 생성
  const firstBatch = blocks.slice(0, BLOCKS_PER_REQUEST);

  l.info(`[1단계] pages.create (블록 ${firstBatch.length}개 포함)`);

  const page = await client.pages.create({
    parent: { page_id: parentPageId },
    properties: {
      title: {
        title: [{ text: { content: title } }],
      },
    },
    children: firstBatch,
  });

  l.info(`[1단계] 페이지 생성 완료 → pageId=${page.id}`);

  // 2단계: 나머지 최상위 블록은 100개씩 append
  if (blocks.length > BLOCKS_PER_REQUEST) {
    const remaining = blocks.slice(BLOCKS_PER_REQUEST);
    l.info(`[2단계] 나머지 블록 append (${remaining.length}개)`);
    await appendBlocksInBatches(client, page.id, remaining, l);
    l.info(`[2단계] 완료`);
  }

  // 3단계: deferred appends 순차 실행
  if (deferredAppends.length > 0) {
    l.info(`[3단계] deferred append 시작 (${deferredAppends.length}개)`);
    const pathCache = new Map<string, string>();

    for (let i = 0; i < deferredAppends.length; i++) {
      const deferred = deferredAppends[i];
      l.info(`  deferred[${i}]: parentPath="${deferred.parentPath}", children=${deferred.children.length}개`);

      const parentNotionId = await resolveBlockIdByPath(
        client,
        page.id,
        deferred.parentPath,
        pathCache
      );

      if (!parentNotionId) {
        l.warn(`  deferred[${i}]: 경로 "${deferred.parentPath}"의 블록 ID를 찾을 수 없음 → 건너뜀`);
        continue;
      }

      l.info(`  deferred[${i}]: 경로 resolve 완료 → blockId=${parentNotionId}`);

      await appendBlocksInBatches(
        client,
        parentNotionId,
        deferred.children as BlockObjectRequest[],
        l
      );
    }

    l.info(`[3단계] 완료`);
  }

  return page.id;
}
