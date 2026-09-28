import { NextRequest, NextResponse } from "next/server";
import { getPublicSnapshot } from "@/lib/public-monitor";
import {
  assertRequestAccess,
  assertRequestOrigin,
  RequestAccessError,
} from "@/lib/request-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  try {
    const access = assertRequestAccess(request);
    assertRequestOrigin(request, access);
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
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return NextResponse.json(
    { snapshot: getPublicSnapshot() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
