import { NextRequest, NextResponse } from "next/server";
import { listFiles } from "@/lib/file-browser";

export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type") || "all";

  if (!["logs", "markdown", "all"].includes(type)) {
    return NextResponse.json(
      { error: "유효하지 않은 type 파라미터" },
      { status: 400 }
    );
  }

  const files = await listFiles(type as "logs" | "markdown" | "all");
  return NextResponse.json({ files, total: files.length });
}
