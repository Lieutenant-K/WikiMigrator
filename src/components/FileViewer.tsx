import React from "react";

interface FileEntry {
  name: string;
  type: "log" | "markdown";
  size: number;
  modifiedAt: string;
  path: string;
}

interface FileViewerProps {
  file: FileEntry;
  content: string;
  loading: boolean;
  onClose: () => void;
  onDownload: () => void;
}

function renderLogContent(content: string): React.ReactNode {
  return content.split("\n").map((line, i) => {
    let colorClass = "text-gray-600";
    if (line.includes("[ERROR]")) colorClass = "text-red-600";
    else if (line.includes("[WARN]")) colorClass = "text-amber-600";
    else if (line.includes("===")) colorClass = "text-gray-800 font-semibold";

    return (
      <div key={i} className={colorClass}>
        <span className="text-gray-300 select-none mr-3">
          {String(i + 1).padStart(4)}
        </span>
        {line}
      </div>
    );
  });
}

export default function FileViewer({
  file,
  content,
  loading,
  onClose,
  onDownload,
}: FileViewerProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <svg
            className="animate-spin h-4 w-4"
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
          파일을 불러오는 중...
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`text-xs font-mono px-2 py-0.5 rounded shrink-0 ${
              file.type === "log"
                ? "bg-amber-100 text-amber-700"
                : "bg-blue-100 text-blue-700"
            }`}
          >
            {file.type === "log" ? "LOG" : "MD"}
          </span>
          <span className="text-sm font-medium truncate">{file.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onDownload}
            className="text-xs text-gray-400 hover:text-gray-600 transition px-2 py-1"
          >
            다운로드
          </button>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition px-2 py-1 text-sm font-bold"
          >
            x
          </button>
        </div>
      </div>
      <pre className="p-4 text-xs font-mono overflow-auto max-h-[600px] whitespace-pre-wrap break-words bg-white">
        {file.type === "log" ? renderLogContent(content) : content}
      </pre>
    </div>
  );
}
