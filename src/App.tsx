import { Link, useLocation } from "react-router-dom";
import Home from "./pages/Home";
import Files from "./pages/Files";

export default function App() {
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header with macOS drag region */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 titlebar-drag" style={{ paddingTop: "2rem" }}>
        <div className="max-w-4xl mx-auto flex items-center justify-between titlebar-no-drag">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-bold">WikiMigrator</h1>
            <nav className="flex items-center gap-4 text-sm">
              <Link
                to="/"
                className={
                  location.pathname === "/"
                    ? "text-black font-medium"
                    : "text-gray-400 hover:text-gray-600 transition"
                }
              >
                변환
              </Link>
              <Link
                to="/files"
                className={
                  location.pathname === "/files"
                    ? "text-black font-medium"
                    : "text-gray-400 hover:text-gray-600 transition"
                }
              >
                파일
              </Link>
            </nav>
          </div>
          {/* 연결 상태는 Home 페이지에서 관리 */}
        </div>
      </header>

      {/* 탭 전환 시 unmount 방지: CSS로 숨김 처리 */}
      <div className="flex-1 flex flex-col" style={{ display: location.pathname === "/" ? undefined : "none" }}>
        <Home />
      </div>
      <div className="flex-1 flex flex-col" style={{ display: location.pathname === "/files" ? undefined : "none" }}>
        <Files />
      </div>
    </div>
  );
}
