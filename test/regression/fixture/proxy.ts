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
  if (request.nextUrl.searchParams.has("bounce")) {
    const res = NextResponse.redirect(new URL("/", request.url));
    res.cookies.set("guarded", "1");
    return res;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/ppr-guarded"],
};
