"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import FileViewer from "@/components/FileViewer";

interface FileEntry {
  name: string;
  type: "log" | "markdown";
  size: number;
  modifiedAt: string;
  path: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FilesPage() {
  const [activeTab, setActiveTab] = useState<"all" | "logs" | "markdown">(
    "all"
  );
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [contentLoading, setContentLoading] = useState(false);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/files?type=all");
      if (!res.ok) throw new Error("파일 목록을 불러올 수 없습니다");
      const data = await res.json();
      setFiles(data.files);
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const handleFileSelect = async (file: FileEntry) => {
    if (selectedFile?.path === file.path) {
      setSelectedFile(null);
      setFileContent("");
      return;
    }

    setSelectedFile(file);
    setContentLoading(true);
    try {
      const res = await fetch(`/api/files/${file.path}`);
      if (!res.ok) throw new Error("파일을 불러올 수 없습니다");
      const data = await res.json();
      setFileContent(data.content);
    } catch {
      setFileContent("파일을 불러오는 중 오류가 발생했습니다.");
    } finally {
      setContentLoading(false);
    }
  };

  const handleDownload = (file: FileEntry) => {
    const a = document.createElement("a");
    a.href = `/api/files/${file.path}?download=true`;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const filteredFiles = files.filter((f) => {
    const matchesTab =
      activeTab === "all" ||
      (activeTab === "logs" && f.type === "log") ||
      (activeTab === "markdown" && f.type === "markdown");
    const matchesSearch =
      !searchQuery ||
      f.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const tabCounts = {
    all: files.filter(
      (f) =>
        !searchQuery ||
        f.name.toLowerCase().includes(searchQuery.toLowerCase())
    ).length,
    logs: files.filter(
      (f) =>
        f.type === "log" &&
        (!searchQuery ||
          f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    ).length,
    markdown: files.filter(
      (f) =>
        f.type === "markdown" &&
        (!searchQuery ||
          f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    ).length,
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-bold">WikiMigrator</h1>
            <nav className="flex items-center gap-4 text-sm">
              <Link
                href="/"
                className="text-gray-400 hover:text-gray-600 transition"
              >
                변환
              </Link>
              <Link href="/files" className="text-black font-medium">
                파일
              </Link>
            </nav>
          </div>
          <button
            onClick={fetchFiles}
            className="text-sm text-gray-400 hover:text-gray-600 transition"
          >
            새로고침
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 px-6 py-10">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="space-y-2">
            <h2 className="text-3xl font-bold">저장된 파일</h2>
            <p className="text-gray-500">
              변환 과정에서 생성된 로그와 마크다운 파일을 확인하고 다운로드할
              수 있습니다.
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

          {/* Tabs */}
          <div className="flex gap-2">
            {(["all", "logs", "markdown"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === tab
                    ? "bg-black text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {tab === "all"
                  ? "전체"
                  : tab === "logs"
                    ? "로그"
                    : "마크다운"}
                <span className="ml-1.5 text-xs opacity-70">
                  ({tabCounts[tab]})
                </span>
              </button>
            ))}
          </div>

          {/* Search */}
          <input
            type="text"
            placeholder="파일명으로 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent text-sm"
          />

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <svg
                className="animate-spin h-6 w-6 text-gray-400"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            </div>
          )}

          {/* File List */}
          {!loading && filteredFiles.length === 0 && (
            <div className="text-center py-12 text-gray-400 text-sm">
              {searchQuery
                ? "검색 결과가 없습니다."
                : "저장된 파일이 없습니다."}
            </div>
          )}

          {!loading && filteredFiles.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
              {filteredFiles.map((file) => (
                <div
                  key={file.path}
                  onClick={() => handleFileSelect(file)}
                  className={`flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 transition ${
                    selectedFile?.path === file.path ? "bg-blue-50" : ""
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`text-xs font-mono px-2 py-0.5 rounded shrink-0 ${
                        file.type === "log"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {file.type === "log" ? "LOG" : "MD"}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {file.name}
                      </p>
                      <p className="text-xs text-gray-400">
                        {formatFileSize(file.size)} ·{" "}
                        {formatDate(file.modifiedAt)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownload(file);
                    }}
                    className="text-xs text-gray-400 hover:text-gray-600 shrink-0 ml-2 transition"
                  >
                    다운로드
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* File Viewer */}
          {selectedFile && (
            <FileViewer
              file={selectedFile}
              content={fileContent}
              loading={contentLoading}
              onClose={() => {
                setSelectedFile(null);
                setFileContent("");
              }}
              onDownload={() => handleDownload(selectedFile)}
            />
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto text-center text-xs text-gray-400">
          WikiMigrator · PDF to Notion Converter
        </div>
      </footer>
    </div>
  );
}
