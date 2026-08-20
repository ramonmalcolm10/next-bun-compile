import { NextRequest, NextResponse } from "next/server";

/**
 * Deliberately scoped to /ppr-guarded alone: middleware coverage revokes
 * a route's tier-1/tier-2 eligibility, and every other fixture route is
 * asserted to keep it.
 *
 * What this stands in for is any auth gate — the decision to redirect,
 * and the cookie carrying where the user was headed, are both made here,
 * before the route renders a single byte.
 */
export function proxy(request: NextRequest) {
  // Sliding-expiry session refresh: re-issue the caller's session cookie on a
  // normal 200 pass-through. Stands in for any auth proxy that touches the
  // session on each navigation — the response body is shared and cacheable,
  // but the head now carries one caller's identity.
  if (request.nextUrl.pathname === "/sliding") {
    const res = NextResponse.next();
    const who = request.cookies.get("who")?.value;
    if (who) res.cookies.set("session", who);
    return res;
  }

  if (request.nextUrl.searchParams.has("bounce")) {
    const res = NextResponse.redirect(new URL("/", request.url));
    res.cookies.set("guarded", "1");
    return res;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/ppr-guarded", "/sliding"],
};
