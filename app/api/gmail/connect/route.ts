import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { STATE_COOKIE, authUrl } from "@/lib/gmail/oauth";

export async function GET(request: NextRequest) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.TOKEN_ENCRYPTION_KEY) {
    return NextResponse.redirect(new URL("/inbox?error=config", request.url));
  }
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authUrl(request.nextUrl.origin, state));
  res.cookies.set(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", maxAge: 600, path: "/api/gmail" });
  return res;
}
