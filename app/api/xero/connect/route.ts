import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { STATE_COOKIE, authUrl, xeroConfigured } from "@/lib/xero/oauth";

export async function GET(request: NextRequest) {
  if (!xeroConfigured()) return NextResponse.redirect(new URL("/xero-bills?xero_error=config", request.url));
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authUrl(state));
  res.cookies.set(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", maxAge: 600, path: "/api/xero" });
  return res;
}
