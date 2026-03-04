import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { getAppPaths } from "./app-paths";
import { getMainWindow } from "./main";

// ── 타입 ──

export type MarkerEnvStatus =
  | { state: "ready"; markerSinglePath: string }
  | { state: "no-venv" }
  | { state: "no-marker" }
  | { state: "no-python" };

interface SetupEvent {
  phase: string;
  message: string;
  progress?: number; // 0~100
  error?: string;
}

// ── 경로 헬퍼 ──

function getBundledPythonPath(): string {
  return path.join(getAppPaths().bundledPython, "bin", "python3");
}

function getVenvPythonPath(): string {
  return path.join(getAppPaths().markerEnv, "bin", "python3");
}

function getVenvPipPath(): string {
  return path.join(getAppPaths().markerEnv, "bin", "pip3");
}

export function getMarkerSinglePath(): string {
  return path.join(getAppPaths().markerEnv, "bin", "marker_single");
}

// ── 상태 확인 ──

/**
 * pyvenv.cfg의 home 경로가 현재 번들된 Python과 일치하는지 검증한다.
 * 앱 업데이트로 번들 Python 버전이 바뀌면 venv를 재생성해야 한다.
 */
async function isVenvValid(): Promise<boolean> {
  const paths = getAppPaths();
  const cfgPath = path.join(paths.markerEnv, "pyvenv.cfg");
  try {
    const content = await fs.readFile(cfgPath, "utf-8");
    const homeMatch = content.match(/^home\s*=\s*(.+)$/m);
    if (!homeMatch) return false;
    const venvHome = homeMatch[1].trim();
    const expectedHome = path.join(paths.bundledPython, "bin");
    return venvHome === expectedHome;
  } catch {
    return false;
  }
}

/**
 * marker 환경 상태를 확인한다.
 */
export async function checkMarkerEnv(): Promise<MarkerEnvStatus> {
  const pythonPath = getBundledPythonPath();

  // 1. 번들된 Python이 존재하는지 확인
  try {
    await fs.access(pythonPath, fs.constants.X_OK);
  } catch {
    return { state: "no-python" };
  }

  // 2. venv가 유효한지 확인
  const venvPython = getVenvPythonPath();
  try {
    await fs.access(venvPython, fs.constants.X_OK);
  } catch {
    return { state: "no-venv" };
  }

  // venv의 Python 버전이 번들 Python과 일치하는지 확인
  if (!(await isVenvValid())) {
    return { state: "no-venv" };
  }

  // 3. marker_single이 존재하는지 확인
  const markerSinglePath = getMarkerSinglePath();
  try {
    await fs.access(markerSinglePath, fs.constants.X_OK);
    return { state: "ready", markerSinglePath };
  } catch {
    return { state: "no-marker" };
  }
}

// ── 설치 ──

/**
 * 진행률 이벤트를 렌더러로 전송한다.
 */
function sendSetupEvent(data: SetupEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("marker-setup-event", data);
  }
}

/**
 * execFile을 Promise로 감싼다.
 */
function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * venv를 생성하고 marker-pdf를 설치한다.
 */
export async function setupMarkerEnv(): Promise<{
  success: boolean;
  error?: string;
  markerSinglePath?: string;
}> {
  const paths = getAppPaths();
  const pythonPath = getBundledPythonPath();

  try {
    // Phase 1: Python 확인
    sendSetupEvent({ phase: "python-check", message: "Python 확인 중...", progress: 5 });
    try {
      await fs.access(pythonPath, fs.constants.X_OK);
    } catch {
      throw new Error("번들된 Python을 찾을 수 없습니다.");
    }

    // Phase 2: 기존 venv 정리 (무효하거나 불완전한 경우)
    sendSetupEvent({ phase: "venv-create", message: "Python 가상환경 생성 중...", progress: 10 });

    const venvPython = getVenvPythonPath();
    let needCreateVenv = false;

    try {
      await fs.access(venvPython, fs.constants.X_OK);
      // venv가 존재하지만 유효하지 않으면 재생성
      if (!(await isVenvValid())) {
        console.log("[marker-env] 기존 venv가 유효하지 않음 → 재생성");
        await fs.rm(paths.markerEnv, { recursive: true, force: true });
        needCreateVenv = true;
      }
    } catch {
      needCreateVenv = true;
    }

    if (needCreateVenv) {
      // 불완전한 디렉토리가 남아있을 수 있으므로 제거
      await fs.rm(paths.markerEnv, { recursive: true, force: true }).catch(() => {});
      await execFileAsync(pythonPath, ["-m", "venv", paths.markerEnv], { timeout: 60_000 });
      console.log("[marker-env] venv 생성 완료");
    }

    // Phase 3: pip 업그레이드
    sendSetupEvent({ phase: "pip-upgrade", message: "pip 업그레이드 중...", progress: 20 });
    try {
      await execFileAsync(
        getVenvPythonPath(),
        ["-m", "pip", "install", "--upgrade", "pip"],
        { timeout: 120_000 },
      );
    } catch (e) {
      // pip 업그레이드 실패는 치명적이지 않음
      console.warn("[marker-env] pip 업그레이드 실패 (계속 진행):", e);
    }

    // Phase 4: marker-pdf 설치 (spawn으로 실시간 로그)
    sendSetupEvent({ phase: "marker-install", message: "marker-pdf 설치 중... (1~3분 소요)", progress: 30 });

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(getVenvPipPath(), ["install", "marker-pdf", "--no-cache-dir"], {
        env: {
          ...process.env,
          PATH: `${path.join(paths.markerEnv, "bin")}:${process.env.PATH}`,
          VIRTUAL_ENV: paths.markerEnv,
        },
      });

      let stderr = "";
      let lastProgress = 30;
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error("marker-pdf 설치 시간 초과 (10분)"));
      }, 10 * 60 * 1000);

      proc.stdout?.on("data", (data: Buffer) => {
        const line = data.toString();
        console.log("[marker-install]", line.trim());

        // pip 출력 기반 진행률 추정
        if (line.includes("Collecting")) lastProgress = Math.min(lastProgress + 3, 75);
        if (line.includes("Downloading")) lastProgress = Math.min(lastProgress + 2, 80);
        if (line.includes("Installing")) lastProgress = Math.min(lastProgress + 5, 90);
        if (line.includes("Successfully")) lastProgress = 92;

        sendSetupEvent({
          phase: "marker-install",
          message: line.trim().slice(0, 120),
          progress: lastProgress,
        });
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        // pip의 일반 진행률 출력은 stderr로 나옴
        if (chunk.includes("Collecting") || chunk.includes("Downloading") || chunk.includes("Installing")) {
          if (chunk.includes("Collecting")) lastProgress = Math.min(lastProgress + 3, 75);
          if (chunk.includes("Downloading")) lastProgress = Math.min(lastProgress + 2, 80);
          if (chunk.includes("Installing")) lastProgress = Math.min(lastProgress + 5, 90);
          if (chunk.includes("Successfully")) lastProgress = 92;

          sendSetupEvent({
            phase: "marker-install",
            message: chunk.trim().slice(0, 120),
            progress: lastProgress,
          });
        }
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`marker-pdf 설치 실패 (exit=${code}): ${stderr.slice(-500)}`));
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`marker-pdf 설치 프로세스 오류: ${err.message}`));
      });
    });

    // Phase 5: 검증
    sendSetupEvent({ phase: "verify", message: "설치 확인 중...", progress: 95 });
    const markerSinglePath = getMarkerSinglePath();
    try {
      await fs.access(markerSinglePath, fs.constants.X_OK);
    } catch {
      throw new Error("marker_single 바이너리를 찾을 수 없습니다. 설치가 불완전할 수 있습니다.");
    }

    sendSetupEvent({ phase: "done", message: "설치 완료!", progress: 100 });
    return { success: true, markerSinglePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "알 수 없는 오류";
    sendSetupEvent({ phase: "error", message: msg, error: msg });
    return { success: false, error: msg };
  }
}
