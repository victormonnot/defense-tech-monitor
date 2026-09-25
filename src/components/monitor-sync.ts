import type { Snapshot } from "@/lib/types";

export class MonitorSyncGate {
  private generation = 0;
  private read: number | null = null;
  private write: number | null = null;

  beginRead(): number | null {
    if (this.write !== null || this.read !== null) return null;
    this.read = ++this.generation;
    return this.read;
  }

  acceptsRead(token: number): boolean {
    return (
      this.read === token && this.write === null && this.generation === token
    );
  }

  finishRead(token: number) {
    if (this.read === token) this.read = null;
  }

  cancelRead() {
    if (this.read === null) return;
    this.read = null;
    this.generation += 1;
  }

  beginWrite(): number | null {
    if (this.write !== null) return null;
    this.cancelRead();
    this.write = ++this.generation;
    return this.write;
  }

  finishWrite(token: number) {
    if (this.write === token) this.write = null;
  }
}

export function selectionSnapshotKey(
  snapshot: Pick<Snapshot, "articles" | "profile">,
) {
  return JSON.stringify([
    snapshot.articles.map(
      ({
        jev: _jev,
        feedAnalyses: _analyses,
        feedFeedback: _feedback,
        summary: _summary,
        ...article
      }) => article,
    ),
    snapshot.profile,
  ]);
}
