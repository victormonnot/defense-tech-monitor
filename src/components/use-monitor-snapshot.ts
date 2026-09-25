"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/types";
import { MonitorSyncGate, selectionSnapshotKey } from "./monitor-sync";

export function useMonitorSnapshot(
  initialData: Snapshot,
  onSelectionChange: () => void,
) {
  const [data, setData] = useState(initialData);
  const [syncError, setSyncError] = useState<string | null>(null);
  const gate = useRef(new MonitorSyncGate());
  const pollController = useRef<AbortController | null>(null);
  const selectionKey = useRef<string | null>(null);
  if (selectionKey.current === null)
    selectionKey.current = selectionSnapshotKey(initialData);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const mounted = useRef(false);
  onSelectionChangeRef.current = onSelectionChange;

  const acceptSnapshot = useCallback((snapshot: Snapshot) => {
    const nextKey = selectionSnapshotKey(snapshot);
    if (selectionKey.current !== nextKey) {
      selectionKey.current = nextKey;
      onSelectionChangeRef.current();
    }
    setData(snapshot);
    setSyncError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current || document.visibilityState !== "visible") return;
    const token = gate.current.beginRead();
    if (token === null) return;
    const controller = new AbortController();
    pollController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/api/monitor", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Snapshot unavailable");
      const result = (await response.json()) as { snapshot?: Snapshot };
      if (!result.snapshot) throw new Error("Snapshot missing");
      if (mounted.current && gate.current.acceptsRead(token))
        acceptSnapshot(result.snapshot);
    } catch {
      if (mounted.current && gate.current.acceptsRead(token))
        setSyncError(
          "La mise à jour du flux a échoué. Nouvelle tentative automatique.",
        );
    } finally {
      window.clearTimeout(timeout);
      gate.current.finishRead(token);
      if (pollController.current === controller) pollController.current = null;
    }
  }, [acceptSnapshot]);

  const beginChange = useCallback(() => {
    const token = gate.current.beginWrite();
    if (token !== null) {
      pollController.current?.abort();
      pollController.current = null;
    }
    return token;
  }, []);

  const endChange = useCallback(
    (token: number) => {
      gate.current.finishWrite(token);
      void refresh();
    },
    [refresh],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
      else {
        gate.current.cancelRead();
        pollController.current?.abort();
        pollController.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      gate.current.cancelRead();
      pollController.current?.abort();
      pollController.current = null;
    };
  }, [refresh]);

  return { data, acceptSnapshot, beginChange, endChange, refresh, syncError };
}
