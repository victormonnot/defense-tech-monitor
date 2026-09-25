import { Dashboard } from "@/components/dashboard";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const snapshot = await getSnapshot();

  return <Dashboard initialData={snapshot} />;
}
