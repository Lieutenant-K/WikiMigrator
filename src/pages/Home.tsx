import { useState, useCallback, useRef, useEffect } from "react";
import FileViewer from "@/components/FileViewer";

interface NotionPage {
  id: string;
  title: string;
  icon: string | null;
}

interface ConvertResult {
  fileName: string;
  status: "success" | "error" | "cancelled";
  pageId?: string;
  error?: string;
  logFile?: string;
  mdFile?: string;
}

type StreamEvent =
  | {
      type: "progress";
      fileIndex: number;
      fileName: string;
      step: string;
      stepIndex: number;
      totalSteps: number;
      message: string;
    }
  | {
      type: "result";
      fileIndex: number;
      fileName: string;
      status: "success" | "error" | "cancelled";
      pageId?: string;
      error?: string;
      logFile?: string;
      mdFile?: string;
    }
  | { type: "done"; cancelled?: boolean };

interface FileProgress {
  fileName: string;
  stepIndex: number;
  totalSteps: number;
  stepName: string;
  message: string;
  result?: ConvertResult;
}

interface SelectedFile {
  name: string;
  buffer: ArrayBuffer;
  size: number;
}

const TOKEN_STORAGE_KEY = "notion_token";

export default function Home() {
  const [token, setToken] = useState(() => {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  });
  const [tokenInput, setTokenInput] = useState("");
  const [isConnected, setIsConnected] = useState(() => {
    return !!localStorage.getItem(TOKEN_STORAGE_KEY);
  });
  const [pages, setPages] = useState<NotionPage[]>([]);
  const [selectedPage, setSelectedPage] = useState("");
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [converting, setConverting] = useState(false);
  const [results, setResults] = useState<ConvertResult[]>([]);
  const [error, setError] = useState("");
  const [loadingPages, setLoadingPages] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [connectingToken, setConnectingToken] = useState(false);
  const [viewingFile, setViewingFile] = useState<{ resultIndex: number; type: "log" | "markdown" } | null>(null);
  const [viewerContent, setViewerContent] = useState("");
  const [viewerLoading, setViewerLoading] = useState(false);
  const [fileProgresses, setFileProgresses] = useState<FileProgress[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const convertedFilesRef = useRef<SelectedFile[]>([]);
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [attachPdf, setAttachPdf] = useState(false);
  const [markerStatus, setMarkerStatus] = useState<"checking" | "installed" | "missing" | "installing" | "error">("checking");
  const [setupProgress, setSetupProgress] = useState<{ phase: string; message: string; progress: number } | null>(null);
  const [setupError, setSetupError] = useState("");

  // Marker 설치 상태 확인
  useEffect(() => {
    window.electronAPI.checkMarker().then((result) => {
      setMarkerStatus(result.installed ? "installed" : "missing");
    });
  }, []);

  const handleInstallMarker = async () => {
    setMarkerStatus("installing");
    setSetupProgress({ phase: "start", message: "준비 중...", progress: 0 });
    setSetupError("");

    // 진행률 이벤트 리스너 등록
    const cleanup = window.electronAPI.onMarkerSetupEvent((data) => {
      if (data.phase === "error") {
        setSetupError(data.error || "알 수 없는 오류");
        setMarkerStatus("error");
      } else if (data.phase === "done") {
        setSetupProgress({ phase: "done", message: "설치 완료!", progress: 100 });
      } else {
        setSetupProgress({
          phase: data.phase,
          message: data.message,
          progress: data.progress || 0,
        });
      }
    });

    try {
      const result = await window.electronAPI.installMarker();
      if (result.success) {
        setMarkerStatus("installed");
      } else {
        setSetupError(result.error || "설치 실패");
        setMarkerStatus("error");
      }
    } catch {
      setSetupError("설치 중 예상치 못한 오류가 발생했습니다.");
      setMarkerStatus("error");
    } finally {
      cleanup();
      setSetupProgress(null);
    }
  };

  const fetchPages = useCallback(async (accessToken: string) => {
    setLoadingPages(true);
    try {
      const data = await window.electronAPI.getPages(accessToken);
      if (data.pages) {
        setPages(data.pages);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "페이지 목록을 불러오는데 실패했습니다.";
      if (message.includes("unauthorized") || message.includes("401")) {
        setIsConnected(false);
        setToken("");
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setError("유효하지 않은 토큰입니다. 다시 입력해주세요.");
      } else {
        setError(message);
      }
    } finally {
      setLoadingPages(false);
    }
  }, []);

  const handleConnect = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;

    setConnectingToken(true);
    setError("");

    try {
      const data = await window.electronAPI.getPages(trimmed);
      setToken(trimmed);
      setIsConnected(true);
      localStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
      setTokenInput("");

      if (data.pages) {
        setPages(data.pages);
      }
    } catch {
      setError("토큰 검증에 실패했습니다. 올바른 Internal Integration Token인지 확인해주세요.");
    } finally {
      setConnectingToken(false);
    }
  };

  const handleDisconnect = () => {
    setToken("");
    setIsConnected(false);
    setPages([]);
    setSelectedPage("");
    setResults([]);
    setFileProgresses([]);
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  };

  const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf")
    );
    const selectedFiles: SelectedFile[] = [];
    for (const file of droppedFiles) {
      const buffer = await readFileAsArrayBuffer(file);
      selectedFiles.push({ name: file.name, buffer, size: file.size });
    }
    setFiles((prev) => [...prev, ...selectedFiles]);
  }, []);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles: SelectedFile[] = [];
      const htmlFiles = Array.from(e.target.files).filter((f) =>
        f.name.toLowerCase().endsWith(".pdf")
      );
      for (const file of htmlFiles) {
        const buffer = await readFileAsArrayBuffer(file);
        selectedFiles.push({ name: file.name, buffer, size: file.size });
      }
      setFiles((prev) => [...prev, ...selectedFiles]);
    }
  }, []);

  const handleNativeFileSelect = async () => {
    const result = await window.electronAPI.selectFiles();
    if (result) {
      setFiles((prev) => [...prev, ...result]);
    }
  };

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const runConvert = async (
    filesToConvert: SelectedFile[],
    onProgress: (event: StreamEvent) => void,
  ) => {
    const cleanup = window.electronAPI.onConvertEvent((data) => {
      onProgress(data as StreamEvent);
    });

    try {
      await window.electronAPI.convert({
        accessToken: token,
        parentPageId: selectedPage,
        attachPdf,
        fileBuffers: filesToConvert.map(f => ({
          name: f.name,
          buffer: f.buffer,
          size: f.size,
        })),
      });
    } finally {
      cleanup();
    }
  };

  const handleCancelConvert = async () => {
    setCancelPending(true);
    await window.electronAPI.cancelConvert();
  };

  const handleConvert = async () => {
    if (!selectedPage || files.length === 0 || !token) return;

    setConverting(true);
    setCancelPending(false);
    setResults([]);
    setError("");
    setViewingFile(null);
    setViewerContent("");

    const totalSteps = attachPdf ? 11 : 10;
    const initialProgresses: FileProgress[] = files.map((f) => ({
      fileName: f.name,
      stepIndex: -1,
      totalSteps,
      stepName: "",
      message: "대기 중",
    }));
    setFileProgresses(initialProgresses);
    convertedFilesRef.current = [...files];

    const collectedResults: ConvertResult[] = [];

    try {
      await runConvert(files, (event) => {
        if (event.type === "progress") {
          setFileProgresses((prev) => {
            const next = [...prev];
            if (next[event.fileIndex]) {
              next[event.fileIndex] = {
                ...next[event.fileIndex],
                stepIndex: event.stepIndex,
                totalSteps: event.totalSteps,
                stepName: event.step,
                message: event.message,
              };
            }
            return next;
          });
        } else if (event.type === "result") {
          const result: ConvertResult = {
            fileName: event.fileName,
            status: event.status,
            pageId: event.pageId,
            error: event.error,
            logFile: event.logFile,
            mdFile: event.mdFile,
          };
          collectedResults.push(result);
          setResults([...collectedResults]);

          setFileProgresses((prev) => {
            const next = [...prev];
            if (next[event.fileIndex]) {
              next[event.fileIndex] = {
                ...next[event.fileIndex],
                stepIndex: next[event.fileIndex].totalSteps,
                message: event.status === "success" ? "완료" : event.status === "cancelled" ? "취소됨" : "실패",
                result,
              };
            }
            return next;
          });
        } else if (event.type === "done") {
          // 취소된 파일이 있으면 파일 목록 유지
          if (!event.cancelled) {
            setFiles([]);
          }
        }
      });
    } catch {
      setError("변환 중 오류가 발생했습니다.");
    } finally {
      setConverting(false);
    }
  };

  const handleRetry = async (uiIndex: number) => {
    const file = convertedFilesRef.current[uiIndex];
    if (!file || !selectedPage || !token) return;

    if (viewingFile?.resultIndex === uiIndex) {
      setViewingFile(null);
      setViewerContent("");
    }

    setRetryingIndex(uiIndex);
    const totalSteps = attachPdf ? 11 : 10;
    setFileProgresses((prev) => {
      const next = [...prev];
      next[uiIndex] = {
        fileName: file.name,
        stepIndex: -1,
        totalSteps,
        stepName: "",
        message: "재시도 대기 중...",
        result: undefined,
      };
      return next;
    });

    try {
      await runConvert([file], (event) => {
        if (event.type === "progress") {
          setFileProgresses((prev) => {
            const next = [...prev];
            if (next[uiIndex]) {
              next[uiIndex] = {
                ...next[uiIndex],
                stepIndex: event.stepIndex,
                totalSteps: event.totalSteps,
                stepName: event.step,
                message: event.message,
              };
            }
            return next;
          });
        } else if (event.type === "result") {
          const result: ConvertResult = {
            fileName: event.fileName,
            status: event.status,
            pageId: event.pageId,
            error: event.error,
            logFile: event.logFile,
            mdFile: event.mdFile,
          };
          setResults((prev) => {
            const next = [...prev];
            const existingIdx = next.findIndex((r) => r.fileName === file.name);
            if (existingIdx >= 0) {
              next[existingIdx] = result;
            } else {
              next.push(result);
            }
            return next;
          });
          setFileProgresses((prev) => {
            const next = [...prev];
            if (next[uiIndex]) {
              next[uiIndex] = {
                ...next[uiIndex],
                stepIndex: next[uiIndex].totalSteps,
                message: event.status === "success" ? "완료" : "실패",
                result,
              };
            }
            return next;
          });
        }
      });
    } catch {
      setFileProgresses((prev) => {
        const next = [...prev];
        next[uiIndex] = {
          ...next[uiIndex],
          message: "재시도 실패",
          result: {
            fileName: file.name,
            status: "error",
            error: "재시도 중 오류가 발생했습니다.",
          },
        };
        return next;
      });
    } finally {
      setRetryingIndex(null);
    }
  };

  const handleViewFile = async (resultIndex: number, type: "log" | "markdown") => {
    if (viewingFile?.resultIndex === resultIndex && viewingFile?.type === type) {
      setViewingFile(null);
      setViewerContent("");
      return;
    }

    const result = fileProgresses[resultIndex]?.result;
    if (!result) return;
    const fileName = type === "log" ? result.logFile : result.mdFile;
    if (!fileName) return;

    const dir = type === "log" ? "logs" : "markdown";
    setViewingFile({ resultIndex, type });
    setViewerLoading(true);
    setViewerContent("");

    try {
      const data = await window.electronAPI.readFile(dir, fileName);
      if (data?.content) {
        setViewerContent(data.content);
      } else {
        setViewerContent("파일을 불러올 수 없습니다.");
      }
    } catch {
      setViewerContent("파일을 불러오는 중 오류가 발생했습니다.");
    } finally {
      setViewerLoading(false);
    }
  };

  const handleDownloadFile = async (type: "log" | "markdown", fileName: string) => {
    const dir = type === "log" ? "logs" : "markdown";
    const data = await window.electronAPI.downloadFile(dir, fileName);
    if (data) {
      const blob = new Blob([data.buffer]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const handleRefreshPages = () => {
    if (token) {
      fetchPages(token);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <>
      {/* Main */}
      <main className="flex-1 px-6 py-10">
        <div className="max-w-4xl mx-auto space-y-8">
          <div className="text-center space-y-2">
            <h2 className="text-3xl font-bold">PDF to Notion</h2>
            <p className="text-gray-500">
              PDF 파일을 업로드하면 Notion 페이지로 변환합니다.
            </p>
          </div>

          {/* Marker 설치 배너 */}
          {markerStatus === "missing" && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg flex items-center justify-between">
              <div>
                <p className="font-medium">초기 설정이 필요합니다</p>
                <p className="text-sm text-amber-600">PDF 변환에 필요한 환경을 자동으로 구성합니다. (최초 1회, 1~3분 소요)</p>
              </div>
              <button
                onClick={handleInstallMarker}
                className="bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-700 transition whitespace-nowrap"
              >
                설정 시작
              </button>
            </div>
          )}
          {markerStatus === "installing" && setupProgress && (
            <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-lg space-y-2">
              <div className="flex items-center gap-3">
                <span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <span className="font-medium">환경 구성 중...</span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${setupProgress.progress}%` }}
                />
              </div>
              <p className="text-xs text-blue-600 truncate">{setupProgress.message}</p>
            </div>
          )}
          {markerStatus === "error" && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              <p className="font-medium">환경 설정 실패</p>
              <p className="text-sm mt-1">{setupError}</p>
              <button
                onClick={handleInstallMarker}
                className="mt-2 text-sm underline hover:text-red-800"
              >
                다시 시도
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              {error}
              <button onClick={() => setError("")} className="float-right font-bold">x</button>
            </div>
          )}

          {/* Connection status in header area */}
          {isConnected && (
            <div className="flex items-center justify-end gap-3 -mt-4">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span className="inline-block w-2 h-2 bg-green-500 rounded-full" />
                연결됨
              </div>
              <button
                onClick={handleDisconnect}
                className="text-xs text-gray-400 hover:text-red-500 transition"
              >
                연결 해제
              </button>
            </div>
          )}

          {/* Step 1: Connect Notion via Token */}
          {!isConnected ? (
            <div className="bg-white rounded-xl border border-gray-200 p-8 space-y-5">
              <h3 className="text-lg font-semibold">
                1. Notion Internal Integration Token 입력
              </h3>
              <div className="text-sm text-gray-500 space-y-2">
                <p>
                  Notion API에 접근하려면 Internal Integration Token이 필요합니다.
                </p>
                <ol className="list-decimal list-inside space-y-1 text-gray-400">
                  <li>
                    <a
                      href="https://www.notion.so/my-integrations"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:underline"
                    >
                      notion.so/my-integrations
                    </a>
                    {" "}에서 새 Integration을 생성하세요.
                  </li>
                  <li>생성된 Integration의 Internal Integration Secret을 복사하세요.</li>
                  <li>변환할 Notion 페이지에서 Integration을 연결(Connection)하세요.</li>
                </ol>
              </div>
              <div className="flex gap-3">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
                  placeholder="ntn_xxxxxxxxxxxxxxxxxxxx..."
                  className="flex-1 border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent font-mono"
                />
                <button
                  onClick={handleConnect}
                  disabled={connectingToken || !tokenInput.trim()}
                  className="bg-black text-white px-6 py-2.5 rounded-lg font-medium hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed transition whitespace-nowrap"
                >
                  {connectingToken ? "확인 중..." : "연결하기"}
                </button>
              </div>
              <p className="text-xs text-gray-400">
                토큰은 이 앱의 localStorage에만 저장됩니다.
              </p>
            </div>
          ) : (
            <>
              {/* Step 2: Select target page */}
              <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">1. 대상 페이지 선택</h3>
                  <button
                    onClick={handleRefreshPages}
                    disabled={loadingPages}
                    className="text-xs text-gray-400 hover:text-gray-600 transition"
                  >
                    {loadingPages ? "불러오는 중..." : "새로고침"}
                  </button>
                </div>
                <p className="text-gray-500 text-sm">
                  변환된 페이지가 추가될 상위 페이지를 선택하세요.
                  Integration이 연결된 페이지만 표시됩니다.
                </p>
                {loadingPages ? (
                  <div className="text-gray-400 text-sm">페이지 목록 불러오는 중...</div>
                ) : pages.length === 0 ? (
                  <div className="text-gray-400 text-sm">
                    표시할 페이지가 없습니다. Notion에서 Integration을 페이지에 연결했는지 확인해주세요.
                  </div>
                ) : (
                  <select
                    value={selectedPage}
                    onChange={(e) => setSelectedPage(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
                  >
                    <option value="">페이지를 선택하세요</option>
                    {pages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {page.icon ? `${page.icon} ` : ""}{page.title}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Step 3: Upload PDFs */}
              <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">2. PDF 파일 업로드</h3>
                  <button
                    onClick={handleNativeFileSelect}
                    className="text-xs text-gray-400 hover:text-gray-600 transition"
                  >
                    파일 선택...
                  </button>
                </div>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${
                    dragOver ? "border-black bg-gray-50" : "border-gray-300 hover:border-gray-400"
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <div className="space-y-2">
                    <div className="text-4xl text-gray-300">+</div>
                    <p className="text-gray-500">PDF 파일을 드래그하거나 클릭하여 선택</p>
                    <p className="text-gray-400 text-xs">여러 파일을 동시에 업로드할 수 있습니다.</p>
                  </div>
                </div>

                {files.length > 0 && (
                  <div className="space-y-2">
                    {files.map((file, index) => (
                      <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-red-500 text-lg shrink-0">PDF</span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{file.name}</p>
                            <p className="text-xs text-gray-400">{formatFileSize(file.size)}</p>
                          </div>
                        </div>
                        <button onClick={() => removeFile(index)} className="text-gray-400 hover:text-red-500 shrink-0 ml-2">x</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Options */}
              <div className="flex items-center gap-3 px-1">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={attachPdf}
                    onChange={(e) => setAttachPdf(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-black focus:ring-black cursor-pointer"
                  />
                  <span className="text-sm text-gray-600">PDF 원본을 Notion 페이지에 첨부</span>
                </label>
              </div>

              {/* Convert / Cancel button */}
              {converting ? (
                <button
                  onClick={handleCancelConvert}
                  disabled={cancelPending}
                  className="w-full bg-red-600 text-white py-4 rounded-xl font-semibold text-lg hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed transition"
                >
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {cancelPending ? "취소 요청 중..." : "변환 취소"}
                  </span>
                </button>
              ) : (
                <button
                  onClick={handleConvert}
                  disabled={retryingIndex !== null || !selectedPage || files.length === 0}
                  className="w-full bg-black text-white py-4 rounded-xl font-semibold text-lg hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
                >
                  {`${files.length}개 파일 변환하기`}
                </button>
              )}

              {/* Progress + Results */}
              {fileProgresses.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
                  <h3 className="text-lg font-semibold">변환 진행 상황</h3>
                  <div className="space-y-3">
                    {fileProgresses.map((fp, index) => (
                      <div key={index}>
                        {fp.result ? (
                          <>
                            <div className={`flex items-center justify-between rounded-lg px-4 py-3 ${
                              fp.result.status === "success" ? "bg-green-50" : fp.result.status === "cancelled" ? "bg-yellow-50" : "bg-red-50"
                            }`}>
                              <div className="flex items-center gap-3">
                                <span className={fp.result.status === "success" ? "text-green-500" : fp.result.status === "cancelled" ? "text-yellow-600" : "text-red-500"}>
                                  {fp.result.status === "success" ? "OK" : fp.result.status === "cancelled" ? "취소" : "ERR"}
                                </span>
                                <span className="text-sm">{fp.result.fileName}</span>
                              </div>
                              {fp.result.status === "success" && fp.result.pageId && (
                                <a
                                  href={`https://notion.so/${fp.result.pageId.replace(/-/g, "")}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm text-blue-600 hover:underline"
                                >
                                  Notion에서 보기
                                </a>
                              )}
                              {fp.result.status === "cancelled" && (
                                <div className="flex items-center gap-3">
                                  {fp.result.logFile && (
                                    <button
                                      onClick={() => handleViewFile(index, "log")}
                                      className={`text-xs px-2 py-1 rounded transition ${
                                        viewingFile?.resultIndex === index && viewingFile?.type === "log"
                                          ? "bg-amber-200 text-amber-800"
                                          : "bg-amber-100 text-amber-700 hover:bg-amber-200"
                                      }`}
                                    >
                                      로그 보기
                                    </button>
                                  )}
                                  <span className="text-xs text-yellow-600">취소됨</span>
                                </div>
                              )}
                              {fp.result.status === "error" && (
                                <div className="flex items-center gap-3">
                                  <button
                                    onClick={() => handleRetry(index)}
                                    disabled={converting || retryingIndex !== null}
                                    className="text-xs px-2.5 py-1 rounded font-medium transition bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    재시도
                                  </button>
                                  <div className="flex items-center gap-1">
                                    {fp.result.logFile && (
                                      <button
                                        onClick={() => handleViewFile(index, "log")}
                                        className={`text-xs px-2 py-1 rounded transition ${
                                          viewingFile?.resultIndex === index && viewingFile?.type === "log"
                                            ? "bg-amber-200 text-amber-800"
                                            : "bg-amber-100 text-amber-700 hover:bg-amber-200"
                                        }`}
                                      >
                                        로그 보기
                                      </button>
                                    )}
                                    {fp.result.mdFile && (
                                      <button
                                        onClick={() => handleViewFile(index, "markdown")}
                                        className={`text-xs px-2 py-1 rounded transition ${
                                          viewingFile?.resultIndex === index && viewingFile?.type === "markdown"
                                            ? "bg-blue-200 text-blue-800"
                                            : "bg-blue-100 text-blue-700 hover:bg-blue-200"
                                        }`}
                                      >
                                        마크다운 보기
                                      </button>
                                    )}
                                  </div>
                                  <span className="text-xs text-red-500">{fp.result.error}</span>
                                </div>
                              )}
                            </div>
                            {viewingFile?.resultIndex === index && (
                              <div className="mt-2">
                                <FileViewer
                                  file={{
                                    name: (viewingFile.type === "log" ? fp.result.logFile : fp.result.mdFile) || "",
                                    type: viewingFile.type === "log" ? "log" : "markdown",
                                    size: 0,
                                    modifiedAt: "",
                                    path: "",
                                  }}
                                  content={viewerContent}
                                  loading={viewerLoading}
                                  onClose={() => { setViewingFile(null); setViewerContent(""); }}
                                  onDownload={() => {
                                    const fName = viewingFile.type === "log" ? fp.result!.logFile : fp.result!.mdFile;
                                    if (fName) handleDownloadFile(viewingFile.type, fName);
                                  }}
                                />
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="bg-gray-50 rounded-lg px-4 py-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                {fp.stepIndex >= 0 && (
                                  <span className="inline-block w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin shrink-0" />
                                )}
                                <span className="text-sm font-medium">{fp.fileName}</span>
                              </div>
                              <span className="text-xs text-gray-400">
                                {fp.stepIndex >= 0 ? `${fp.stepIndex + 1} / ${fp.totalSteps}` : "대기 중"}
                              </span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-black h-2 rounded-full transition-all duration-300"
                                style={{
                                  width: fp.stepIndex >= 0
                                    ? `${((fp.stepIndex + 1) / fp.totalSteps) * 100}%`
                                    : "0%",
                                }}
                              />
                            </div>
                            {fp.stepIndex >= 0 && <p className="text-xs text-gray-500">{fp.message}</p>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 py-4 text-center text-xs text-gray-400">
        WikiMigrator - Marker + Martian + Notion API
      </footer>
    </>
  );
}
