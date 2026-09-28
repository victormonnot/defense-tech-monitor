import { headers } from "next/headers";
import { Dashboard } from "@/components/dashboard";
import { assertAdminRequest } from "@/lib/request-access";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Admin() {
  assertAdminRequest(
    new Request("http://localhost/admin", { headers: await headers() }),
  );
  return <Dashboard initialData={getSnapshot()} />;
}
