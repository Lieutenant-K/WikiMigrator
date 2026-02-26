"use client";

import { useState, useCallback, useRef } from "react";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    try {
      const formData = new FormData();
      formData.append("parentPageId", selectedPage);
      files.forEach((file) => formData.append("files", file));

      const res = await fetch("/api/convert", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const data = await res.json();

      if (data.error) {
        setError(data.error);
      } else if (data.results) {
        setResults(data.results);
        setFiles([]);
      }
    } catch {
      setError("변환 중 오류가 발생했습니다.");
    } finally {
      setConverting(false);
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
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold">WikiMigrator</h1>
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

              {/* Convert button */}
              <button
                onClick={handleConvert}
                disabled={converting || !selectedPage || files.length === 0}
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

              {/* Results */}
              {results.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
                  <h3 className="text-lg font-semibold">변환 결과</h3>
                  <div className="space-y-2">
                    {results.map((result, index) => (
                      <div
                        key={index}
                        className={`flex items-center justify-between rounded-lg px-4 py-3 ${
                          result.status === "success"
                            ? "bg-green-50"
                            : "bg-red-50"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={
                              result.status === "success"
                                ? "text-green-500"
                                : "text-red-500"
                            }
                          >
                            {result.status === "success" ? "OK" : "ERR"}
                          </span>
                          <span className="text-sm">{result.fileName}</span>
                        </div>
                        {result.status === "success" && result.pageId && (
                          <a
                            href={`https://notion.so/${result.pageId.replace(/-/g, "")}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-blue-600 hover:underline"
                          >
                            Notion에서 보기
                          </a>
                        )}
                        {result.status === "error" && (
                          <span className="text-xs text-red-500">
                            {result.error}
                          </span>
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
