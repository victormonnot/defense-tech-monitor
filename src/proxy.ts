import { NextRequest, NextResponse } from "next/server";
import { assertRequestAccess, RequestAccessError } from "@/lib/request-access";

export function proxy(request: NextRequest) {
  try {
    assertRequestAccess(request);
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
