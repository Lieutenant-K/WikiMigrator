import { promises as fs } from "fs";
import path from "path";

export interface FileEntry {
  name: string;
  type: "log" | "markdown";
  size: number;
  modifiedAt: string;
  path: string;
}

const ALLOWED_DIRS: Record<string, string> = {
  logs: path.join(process.cwd(), "logs"),
  markdown: path.join(process.cwd(), "output_markdown"),
};

export function isPathSafe(fileName: string): boolean {
  if (
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0")
  ) {
    return false;
  }
  return true;
}

export function resolveFilePath(
  directory: string,
  fileName: string
): string | null {
  const baseDir = ALLOWED_DIRS[directory];
  if (!baseDir) return null;

  if (!isPathSafe(fileName)) return null;

  const resolved = path.resolve(baseDir, fileName);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    return null;
  }

  return resolved;
}

export async function listFiles(
  type: "logs" | "markdown" | "all"
): Promise<FileEntry[]> {
  const results: FileEntry[] = [];

  const dirs =
    type === "all"
      ? Object.entries(ALLOWED_DIRS)
      : [[type, ALLOWED_DIRS[type]]];

  for (const [dirKey, dirPath] of dirs) {
    try {
      const entries = await fs.readdir(dirPath as string);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;

        const fullPath = path.join(dirPath as string, entry);
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;

        results.push({
          name: entry,
          type: dirKey === "logs" ? "log" : "markdown",
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          path: `${dirKey}/${entry}`,
        });
      }
    } catch {
      // 디렉토리가 존재하지 않으면 무시
    }
  }

  results.sort(
    (a, b) =>
      new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
  );

  return results;
}

export async function readFileContent(
  directory: string,
  fileName: string
): Promise<{ content: string; size: number; modifiedAt: string } | null> {
  const filePath = resolveFilePath(directory, fileName);
  if (!filePath) return null;

  try {
    const [content, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);
    return {
      content,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}
