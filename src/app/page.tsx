import { headers } from "next/headers";
import { Dashboard } from "@/components/dashboard";
import { PublicMonitor } from "@/components/public-monitor";
import { getPublicSnapshot } from "@/lib/public-monitor";
import {
  assertAdminAccess,
  assertRequestAccess,
  isPublicReadOnlyEnabled,
} from "@/lib/request-access";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const access = assertRequestAccess(
    new Request("http://localhost/", { headers: await headers() }),
  );
  if (isPublicReadOnlyEnabled()) {
    return <PublicMonitor initialData={await getPublicSnapshot()} />;
  }

  assertAdminAccess(access);
  const snapshot = await getSnapshot();

  return <Dashboard initialData={snapshot} />;
}
