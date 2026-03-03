"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import FileViewer from "@/components/FileViewer";

interface NotionPage {
  id: string;
  title: string;
  icon: string | null;
}

interface ConvertResult {
  fileName: string;
  status: "success" | "error";
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
      status: "success" | "error";
      pageId?: string;
      error?: string;
      logFile?: string;
      mdFile?: string;
    }
  | { type: "done" };

interface FileProgress {
  fileName: string;
  stepIndex: number;
  totalSteps: number;
  stepName: string;
  message: string;
  result?: ConvertResult;
}

const TOKEN_STORAGE_KEY = "notion_token";

export default function Home() {
  const [token, setToken] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }
    return "";
  });
  const [tokenInput, setTokenInput] = useState("");
  const [isConnected, setIsConnected] = useState(() => {
    if (typeof window !== "undefined") {
      return !!localStorage.getItem(TOKEN_STORAGE_KEY);
    }
    return false;
  });
  const [pages, setPages] = useState<NotionPage[]>([]);
  const [selectedPage, setSelectedPage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
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
  const convertedFilesRef = useRef<File[]>([]);
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null);
  const [attachPdf, setAttachPdf] = useState(false);

  const fetchPages = useCallback(
    async (accessToken: string) => {
      setLoadingPages(true);
      try {
        const res = await fetch("/api/pages", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.status === 401) {
          setIsConnected(false);
          setToken("");
          localStorage.removeItem(TOKEN_STORAGE_KEY);
          setError("유효하지 않은 토큰입니다. 다시 입력해주세요.");
          return;
        }
        const data = await res.json();
        if (data.error) {
          setError(data.error);
        } else if (data.pages) {
          setPages(data.pages);
        }
      } catch {
        setError("페이지 목록을 불러오는데 실패했습니다.");
      } finally {
        setLoadingPages(false);
      }
    },
    []
  );

  const handleConnect = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;

    setConnectingToken(true);
    setError("");

    try {
      const res = await fetch("/api/pages", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "토큰 검증에 실패했습니다. 올바른 Internal Integration Token인지 확인해주세요.");
        return;
      }

      const data = await res.json();
      setToken(trimmed);
      setIsConnected(true);
      localStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
      setTokenInput("");

      if (data.pages) {
        setPages(data.pages);
      }
    } catch {
      setError("연결 중 오류가 발생했습니다.");
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf")
    );
    setFiles((prev) => [...prev, ...droppedFiles]);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        const selectedFiles = Array.from(e.target.files).filter((f) =>
          f.name.toLowerCase().endsWith(".pdf")
        );
        setFiles((prev) => [...prev, ...selectedFiles]);
      }
    },
    []
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleConvert = async () => {
    if (!selectedPage || files.length === 0 || !token) return;

    setConverting(true);
    setResults([]);
    setError("");
    setViewingFile(null);
    setViewerContent("");

    // 파일별 진행 상태 초기화
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

    try {
      const formData = new FormData();
      formData.append("parentPageId", selectedPage);
      formData.append("attachPdf", String(attachPdf));
      files.forEach((file) => formData.append("files", file));

      const res = await fetch("/api/convert", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "변환 중 오류가 발생했습니다.");
        setFileProgresses([]);
        setConverting(false);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const collectedResults: ConvertResult[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;

          const json = line.slice(6);
          let event: StreamEvent;
          try {
            event = JSON.parse(json);
          } catch {
            continue;
          }

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
                  message: event.status === "success" ? "완료" : "실패",
                  result,
                };
              }
              return next;
            });
          } else if (event.type === "done") {
            setFiles([]);
          }
        }
      }
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
      const formData = new FormData();
      formData.append("parentPageId", selectedPage);
      formData.append("attachPdf", String(attachPdf));
      formData.append("files", file);

      const res = await fetch("/api/convert", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        setFileProgresses((prev) => {
          const next = [...prev];
          next[uiIndex] = {
            ...next[uiIndex],
            message: "재시도 실패",
            result: {
              fileName: file.name,
              status: "error",
              error: data.error || "재시도 중 오류가 발생했습니다.",
            },
          };
          return next;
        });
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

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
        }
      }
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
      const res = await fetch(`/api/files/${dir}/${encodeURIComponent(fileName)}`);
      const data = await res.json();
      if (data.content) {
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

  const handleDownloadFile = (type: "log" | "markdown", fileName: string) => {
    const dir = type === "log" ? "logs" : "markdown";
    window.open(`/api/files/${dir}/${encodeURIComponent(fileName)}?download=true`, "_blank");
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
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-bold">WikiMigrator</h1>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/" className="text-black font-medium">
                변환
              </Link>
              <Link
                href="/files"
                className="text-gray-400 hover:text-gray-600 transition"
              >
                파일
              </Link>
            </nav>
          </div>
          {isConnected && (
            <div className="flex items-center gap-3">
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
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 px-6 py-10">
        <div className="max-w-4xl mx-auto space-y-8">
          <div className="text-center space-y-2">
            <h2 className="text-3xl font-bold">PDF to Notion</h2>
            <p className="text-gray-500">
              PDF 파일을 업로드하면 Notion 페이지로 변환합니다.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              {error}
              <button
                onClick={() => setError("")}
                className="float-right font-bold"
              >
                x
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
                  <li>
                    생성된 Integration의 Internal Integration Secret을 복사하세요.
                  </li>
                  <li>
                    변환할 Notion 페이지에서 Integration을 연결(Connection)하세요.
                  </li>
                </ol>
              </div>
              <div className="flex gap-3">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleConnect();
                  }}
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
                토큰은 브라우저의 localStorage에만 저장되며 서버에 저장되지 않습니다.
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
                  <div className="text-gray-400 text-sm">
                    페이지 목록 불러오는 중...
                  </div>
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
                        {page.icon ? `${page.icon} ` : ""}
                        {page.title}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Step 3: Upload PDFs */}
              <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
                <h3 className="text-lg font-semibold">2. PDF 파일 업로드</h3>
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${
                    dragOver
                      ? "border-black bg-gray-50"
                      : "border-gray-300 hover:border-gray-400"
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
                    <p className="text-gray-500">
                      PDF 파일을 드래그하거나 클릭하여 선택
                    </p>
                    <p className="text-gray-400 text-xs">
                      여러 파일을 동시에 업로드할 수 있습니다.
                    </p>
                  </div>
                </div>

                {/* File list */}
                {files.length > 0 && (
                  <div className="space-y-2">
                    {files.map((file, index) => (
                      <div
                        key={`${file.name}-${index}`}
                        className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-red-500 text-lg shrink-0">
                            PDF
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {file.name}
                            </p>
                            <p className="text-xs text-gray-400">
                              {formatFileSize(file.size)}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => removeFile(index)}
                          className="text-gray-400 hover:text-red-500 shrink-0 ml-2"
                        >
                          x
                        </button>
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
                  <span className="text-sm text-gray-600">
                    PDF 원본을 Notion 페이지에 첨부
                  </span>
                </label>
              </div>

              {/* Convert button */}
              <button
                onClick={handleConvert}
                disabled={converting || retryingIndex !== null || !selectedPage || files.length === 0}
                className="w-full bg-black text-white py-4 rounded-xl font-semibold text-lg hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
              >
                {converting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    변환 중...
                  </span>
                ) : (
                  `${files.length}개 파일 변환하기`
                )}
              </button>

              {/* Progress + Results */}
              {fileProgresses.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
                  <h3 className="text-lg font-semibold">변환 진행 상황</h3>
                  <div className="space-y-3">
                    {fileProgresses.map((fp, index) => (
                      <div key={index}>
                        {fp.result ? (
                          /* 완료된 파일: 결과 행 */
                          <>
                            <div
                              className={`flex items-center justify-between rounded-lg px-4 py-3 ${
                                fp.result.status === "success"
                                  ? "bg-green-50"
                                  : "bg-red-50"
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <span
                                  className={
                                    fp.result.status === "success"
                                      ? "text-green-500"
                                      : "text-red-500"
                                  }
                                >
                                  {fp.result.status === "success" ? "OK" : "ERR"}
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
                                  <span className="text-xs text-red-500">
                                    {fp.result.error}
                                  </span>
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
                                  onClose={() => {
                                    setViewingFile(null);
                                    setViewerContent("");
                                  }}
                                  onDownload={() => {
                                    const fileName = viewingFile.type === "log" ? fp.result!.logFile : fp.result!.mdFile;
                                    if (fileName) handleDownloadFile(viewingFile.type, fileName);
                                  }}
                                />
                              </div>
                            )}
                          </>
                        ) : (
                          /* 미완료 파일: 진행 바 */
                          <div className="bg-gray-50 rounded-lg px-4 py-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                {fp.stepIndex >= 0 && (
                                  <span className="inline-block w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin shrink-0" />
                                )}
                                <span className="text-sm font-medium">{fp.fileName}</span>
                              </div>
                              <span className="text-xs text-gray-400">
                                {fp.stepIndex >= 0
                                  ? `${fp.stepIndex + 1} / ${fp.totalSteps}`
                                  : "대기 중"}
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
                            {fp.stepIndex >= 0 && (
                              <p className="text-xs text-gray-500">{fp.message}</p>
                            )}
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
    </div>
  );
}
