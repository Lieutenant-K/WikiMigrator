import { NextRequest, NextResponse } from "next/server";
import { createNotionClient, searchPages } from "@/lib/notion";

function extractToken(request: NextRequest): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

export async function GET(request: NextRequest) {
  const accessToken = extractToken(request);

  if (!accessToken) {
    return NextResponse.json(
      { error: "Notion 토큰이 제공되지 않았습니다." },
      { status: 401 }
    );
  }

  try {
    const client = createNotionClient(accessToken);
    const pages = await searchPages(client);
    return NextResponse.json({ pages });
  } catch (err) {
    const message = err instanceof Error ? err.message : "페이지 조회 실패";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
