import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Refreshes the Supabase session cookie and sends signed-out users to /login. */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(list) {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  // getClaims verifies the JWT signature locally when the project uses asymmetric signing keys (no network round trip);
  // otherwise supabase-js falls back to asking the Auth server, same as getUser(). Pages still query through RLS.
  const { data } = await supabase.auth.getClaims();
  const signedIn = !!data?.claims;
  const isLogin = request.nextUrl.pathname === "/login";
  if (!signedIn && !isLogin) return NextResponse.redirect(new URL("/login", request.url));
  if (signedIn && isLogin) return NextResponse.redirect(new URL("/", request.url));
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)"],
};
