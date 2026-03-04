import { app } from "electron";
import path from "path";
import { promises as fs } from "fs";

export interface AppPaths {
  /** ~/Library/Application Support/WikiMigrator */
  appData: string;
  /** ~/Library/Application Support/WikiMigrator/tmp */
  tmp: string;
  /** ~/Library/Application Support/WikiMigrator/logs */
  logs: string;
  /** ~/Library/Application Support/WikiMigrator/output_markdown */
  outputMarkdown: string;
  /** 번들된 pymupdf-tools 바이너리 경로 */
  pymupdfTools: string;
  /** 번들된 scripts 디렉토리 (개발 모드) */
  scripts: string;
  /** 번들된 standalone Python 경로 (resources/python) */
  bundledPython: string;
  /** marker-pdf venv 경로 (~/Library/Application Support/WikiMigrator/marker-env) */
  markerEnv: string;
}

let cachedPaths: AppPaths | null = null;

export function getAppPaths(): AppPaths {
  if (cachedPaths) return cachedPaths;

  const appData = path.join(app.getPath("userData"));
  const isDev = !app.isPackaged;

  let pymupdfTools: string;
  let scripts: string;
  let bundledPython: string;

  if (isDev) {
    // 개발 모드: 프로젝트 루트 기준
    pymupdfTools = path.join(app.getAppPath(), "resources", "pymupdf-tools");
    scripts = path.join(app.getAppPath(), "scripts");
    bundledPython = path.join(app.getAppPath(), "resources", "python");
  } else {
    // 프로덕션: extraResources 경로
    pymupdfTools = path.join(process.resourcesPath, "pymupdf-tools");
    scripts = path.join(process.resourcesPath, "scripts");
    bundledPython = path.join(process.resourcesPath, "python");
  }

  cachedPaths = {
    appData,
    tmp: path.join(appData, "tmp"),
    logs: path.join(appData, "logs"),
    outputMarkdown: path.join(appData, "output_markdown"),
    pymupdfTools,
    scripts,
    bundledPython,
    markerEnv: path.join(appData, "marker-env"),
  };

  return cachedPaths;
}

/**
 * 앱 디렉토리 구조를 초기화한다 (첫 실행 시 디렉토리 생성).
 */
export async function ensureAppDirectories(): Promise<void> {
  const paths = getAppPaths();
  await fs.mkdir(paths.tmp, { recursive: true });
  await fs.mkdir(paths.logs, { recursive: true });
  await fs.mkdir(paths.outputMarkdown, { recursive: true });
}
