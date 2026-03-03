import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { isPathSafe, resolveFilePath, readFileContent } from "@/lib/file-browser";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;
  const download = request.nextUrl.searchParams.get("download") === "true";

  if (!pathSegments || pathSegments.length !== 2) {
    return NextResponse.json({ error: "잘못된 경로" }, { status: 400 });
  }

  const [directory, fileName] = pathSegments;

  if (!["logs", "markdown"].includes(directory)) {
    return NextResponse.json(
      { error: "접근할 수 없는 디렉토리" },
      { status: 403 }
    );
  }

  if (!isPathSafe(fileName)) {
    return NextResponse.json({ error: "잘못된 파일명" }, { status: 400 });
  }

  const filePath = resolveFilePath(directory, fileName);
  if (!filePath) {
    return NextResponse.json({ error: "잘못된 경로" }, { status: 400 });
  }

  if (download) {
    try {
      const fileBuffer = await fs.readFile(filePath);
      return new NextResponse(fileBuffer, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Content-Length": String(fileBuffer.length),
        },
      });
    } catch {
      return NextResponse.json(
        { error: "파일을 찾을 수 없습니다" },
        { status: 404 }
      );
    }
  }

  const result = await readFileContent(directory, fileName);
  if (!result) {
    return NextResponse.json(
      { error: "파일을 찾을 수 없습니다" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    name: fileName,
    type: directory === "logs" ? "log" : "markdown",
    content: result.content,
    size: result.size,
    modifiedAt: result.modifiedAt,
  });
}
