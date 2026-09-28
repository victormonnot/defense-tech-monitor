import { NextRequest, NextResponse } from "next/server";
import {
  assertAdminAccess,
  assertRequestAccess,
  RequestAccessError,
} from "@/lib/request-access";

export function proxy(request: NextRequest) {
  try {
    const access = assertRequestAccess(request);
    const path = decodeURIComponent(request.nextUrl.pathname);
    const publicRead =
      path === "/api/public-monitor" &&
      (request.method === "GET" || request.method === "HEAD");
    if (
      path === "/admin" ||
      path.startsWith("/admin/") ||
      ((path === "/api" || path.startsWith("/api/")) && !publicRead)
    )
      assertAdminAccess(access);
    return NextResponse.next();
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof RequestAccessError
            ? error.message
            : "L’accès à l’application est momentanément indisponible.",
      },
      {
        status: error instanceof RequestAccessError ? error.status : 503,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}

export const config = {
  matcher: ["/:path*"],
};
