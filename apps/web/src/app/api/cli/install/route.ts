import { NextResponse } from "next/server";

export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/docs", request.url), {
    status: 302,
    headers: {
      "cache-control": "no-store",
    },
  });
}
