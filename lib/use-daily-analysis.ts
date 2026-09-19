"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Analysis, ProjectionModel } from "@/lib/polis-math";

type AnalysisOpinion = { id: string; tagId: string; text: string };
type DailyAnalysis = {
  analysis: Analysis | null;
  opinions: AnalysisOpinion[];
  projectionModel: ProjectionModel | null;
  snapshotId: string | null;
  computedAt: number | null;
  stats: { sessions: number; votes: number } | null;
  updating: boolean;
};
type AnalysisResponse = {
  analysisUnchanged?: boolean;
  analysisOpinions?: AnalysisOpinion[];
  analysis?: Analysis | null;
  projectionModel?: ProjectionModel | null;
  snapshotId?: string | null;
  analysisComputedAt?: number | null;
  analysisStats?: { sessions: number; votes: number } | null;
  analysisUpdating?: boolean;
  error?: string;
};
const EMPTY: DailyAnalysis = { opinions: [], analysis: null, projectionModel: null, snapshotId: null, computedAt: null, stats: null, updating: false };
type State = { sessionToken: string; daily: DailyAnalysis; loading: boolean; error: string; revision: number };
const EMPTY_STATE: State = { sessionToken: "", daily: EMPTY, loading: false, error: "", revision: 0 };

/** Daily models are independent of community reads, so polling cannot replace current answers. */
export function useDailyAnalysis(sessionToken: string) {
  const [state, setState] = useState<State>(EMPTY_STATE);
  const snapshot = useRef<string | null>(null);
  const generation = useRef(0);
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionToken) return;
    const currentGeneration = generation.current;
    const request = ++latestRequest.current;
    const stillCurrent = () => generation.current === currentGeneration && latestRequest.current === request;
    setState(previous => ({ ...(previous.sessionToken === sessionToken ? previous : EMPTY_STATE), sessionToken, loading: true }));
    try {
      const query = snapshot.current ? `?snapshot=${encodeURIComponent(snapshot.current)}` : "";
      const response = await fetch(`/api/analysis${query}`, { headers: { "x-session-token": sessionToken }, cache: "no-store" });
      const result = await response.json() as AnalysisResponse;
      if (!response.ok) throw new Error(result.error || "意見の地図を読み込めませんでした。");
      if (!stillCurrent()) return;
      if (result.analysisUnchanged && result.snapshotId === snapshot.current) {
        setState(previous => ({ ...previous, error: "", daily: { ...previous.daily, updating: result.analysisUpdating === true } }));
        return;
      }
      snapshot.current = result.snapshotId || null;
      const daily = {
        analysis: result.analysis || null,
        opinions: result.analysisOpinions || [],
        projectionModel: result.projectionModel || null,
        snapshotId: result.snapshotId || null,
        computedAt: result.analysisComputedAt || null,
        stats: result.analysisStats || null,
        updating: result.analysisUpdating === true,
      };
      setState(previous => ({ ...previous, daily, error: "", revision: previous.revision + 1 }));
    } catch (cause) {
      if (stillCurrent()) setState(previous => ({ ...previous, error: cause instanceof Error ? cause.message : "意見の地図を読み込めませんでした。" }));
    } finally {
      if (stillCurrent()) setState(previous => ({ ...previous, loading: false }));
    }
  }, [sessionToken]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    snapshot.current = null;
    if (!sessionToken) return;
    void refresh();
    const checkVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(checkVisible, 60_000);
    document.addEventListener("visibilitychange", checkVisible);
    return () => {
      generation.current = currentGeneration + 1;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkVisible);
    };
  }, [sessionToken, refresh]);

  // A new session sees no position from the old one, even before effects run.
  const current = state.sessionToken === sessionToken ? state : EMPTY_STATE;
  return { ...current.daily, loading: current.loading, error: current.error, refresh, revision: current.revision };
}
