import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const WEB_BUILD_ID = process.env.NEXT_PUBLIC_XMATRIX_WEB_BUILD_ID?.trim() || "";

export async function GET() {
  return NextResponse.json(
    { buildId: WEB_BUILD_ID },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    }
  );
}
