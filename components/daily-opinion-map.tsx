"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "@/lib/polis-math";
import { paddedConvexHull, type MapPoint } from "@/lib/opinion-map-geometry";

export const GROUP_COLORS = ["#2455dd", "#bc5b2d", "#168978", "#7e4ac9"];
export function formatAnalysisDate(timestamp: number) {
  return new Date(timestamp).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
function prepareCanvas(element: HTMLCanvasElement | null) {
  if (!element) return null;
  const context = element.getContext("2d");
  if (!context) return null;
  const ratio = window.devicePixelRatio || 1;
  element.width = 500 * ratio;
  element.height = 345 * ratio;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, 500, 345);
  return context;
}
function traceOutline(context: CanvasRenderingContext2D, outline: readonly MapPoint[]) {
  context.beginPath();
  outline.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.closePath();
}

/** Daily regions stay fixed; answering repaints only the transparent personal layer. */
export function OpinionMap({ dailyAnalysis, personalPoint, compact = false }: { dailyAnalysis: Analysis; personalPoint: Analysis["points"][number] | null; compact?: boolean }) {
  const background = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [showPoints, setShowPoints] = useState(false);
  const map = useMemo(() => {
    const points = dailyAnalysis.points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    if (!points.length) return null;
    const padX = Math.max(maxX - minX, 0.1) * 0.15;
    const padY = Math.max(maxY - minY, 0.1) * 0.15;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const x = (value: number) => 35 + clamp((value - minX) / (maxX - minX)) * 430;
    const y = (value: number) => 310 - clamp((value - minY) / (maxY - minY)) * 275;
    const members = new Map<number, MapPoint[]>();
    const displayPoints = points.map(point => {
      const mapped = { x: x(point.x), y: y(point.y), group: point.group };
      const group = members.get(point.group);
      if (group) group.push(mapped); else members.set(point.group, [mapped]);
      return mapped;
    });
    const regions = dailyAnalysis.groups.flatMap(group => {
      const groupPoints = members.get(group.id);
      if (!groupPoints?.length) return [];
      return [{
        ...group,
        center: { x: groupPoints.reduce((sum, point) => sum + point.x, 0) / groupPoints.length, y: groupPoints.reduce((sum, point) => sum + point.y, 0) / groupPoints.length },
        outline: paddedConvexHull(groupPoints),
      }];
    });
    return { x, y, regions, points: displayPoints };
  }, [dailyAnalysis]);

  useEffect(() => {
    const paint = () => {
      const context = prepareCanvas(background.current);
      if (!context || !map) return;
      for (const region of map.regions) {
        const color = GROUP_COLORS[region.id] || GROUP_COLORS[0];
        traceOutline(context, region.outline);
        context.fillStyle = color; context.globalAlpha = 0.13; context.fill();
        context.strokeStyle = color; context.globalAlpha = 0.7;
        context.lineWidth = 1.6; context.lineJoin = "round"; context.setLineDash([3, 5]); context.stroke();
      }
      context.setLineDash([]);
      if (showPoints) {
        context.globalAlpha = 0.48;
        for (const point of map.points) {
          context.fillStyle = GROUP_COLORS[point.group] || GROUP_COLORS[0];
          context.beginPath(); context.arc(point.x, point.y, map.points.length > 5000 ? 1.5 : 2.5, 0, Math.PI * 2); context.fill();
        }
      }
      context.globalAlpha = 1;
      // Keep the count labels readable in the compact sidebar, too.
      const scale = 500 / Math.max(background.current?.getBoundingClientRect().width || 500, 150);
      const labelFont = Math.max(compact ? 22 : 19, 12 * scale);
      const countFont = Math.max(compact ? 18 : 16, 11 * scale);
      const lineHeight = Math.max(labelFont, countFont) * 1.2;
      const placed: { x: number; y: number; width: number; height: number }[] = [];
      context.textAlign = "center"; context.textBaseline = "middle";
      for (const region of map.regions) {
        const color = GROUP_COLORS[region.id] || GROUP_COLORS[0];
        const count = `${region.size.toLocaleString("ja-JP")} セッション`;
        context.font = `500 ${countFont}px system-ui, sans-serif`;
        const width = Math.max(context.measureText(count).width + 18, labelFont * 2 + 18);
        const height = lineHeight * 2 + 10;
        const candidates = [[0, 0], [0, -height], [0, height], [-width, 0], [width, 0], [-width, -height], [width, height]];
        let best = { x: region.center.x, y: region.center.y, width, height }, bestScore = Infinity;
        for (const [dx, dy] of candidates) {
          const x = Math.max(width / 2 + 5, Math.min(495 - width / 2, region.center.x + dx));
          const y = Math.max(height / 2 + 5, Math.min(340 - height / 2, region.center.y + dy));
          const overlap = placed.reduce((sum, box) => sum + Math.max(0, (width + box.width) / 2 + 5 - Math.abs(x - box.x)) * Math.max(0, (height + box.height) / 2 + 5 - Math.abs(y - box.y)), 0);
          const score = overlap * 1000 + (x - region.center.x) ** 2 + (y - region.center.y) ** 2;
          if (score < bestScore) { best = { x, y, width, height }; bestScore = score; }
        }
        placed.push(best);
        if (Math.hypot(best.x - region.center.x, best.y - region.center.y) > 2) {
          context.beginPath(); context.moveTo(region.center.x, region.center.y); context.lineTo(best.x, best.y);
          context.strokeStyle = color; context.globalAlpha = 0.55; context.lineWidth = 1.5; context.stroke();
        }
        context.beginPath(); context.roundRect(best.x - width / 2, best.y - height / 2, width, height, 8);
        context.fillStyle = "#ffffff"; context.globalAlpha = 0.88; context.fill(); context.globalAlpha = 1;
        context.fillStyle = color; context.font = `650 ${labelFont}px system-ui, sans-serif`;
        context.fillText(`${String.fromCharCode(65 + region.id)}群`, best.x, best.y - lineHeight / 2);
        context.fillStyle = "#40516d"; context.font = `500 ${countFont}px system-ui, sans-serif`;
        context.fillText(count, best.x, best.y + lineHeight / 2);
      }
    };
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [map, showPoints, compact]);

  useEffect(() => {
    const paint = () => {
      const context = prepareCanvas(overlay.current);
      if (!context || !map || !personalPoint) return;
      const color = GROUP_COLORS[personalPoint.group] || GROUP_COLORS[0];
      const x = map.x(personalPoint.x), y = map.y(personalPoint.y);
      const radius = compact ? 18 : 14;
      context.fillStyle = "#ffffff"; context.strokeStyle = color;
      context.lineWidth = compact ? 3 : 2.5;
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill(); context.stroke();
      context.beginPath(); context.arc(x, y, radius - 6, 0, Math.PI * 2); context.stroke();
      context.fillStyle = color;
      context.beginPath(); context.arc(x, y, compact ? 4 : 3, 0, Math.PI * 2); context.fill();
    };
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [map, personalPoint, compact]);

  const personalLabel = personalPoint ? `二重の輪が今回の回答から求めたあなたの暫定位置です。グループ${String.fromCharCode(65 + personalPoint.group)}の中心に最も近い位置です。` : "あなたの暫定位置はまだ表示していません。";
  const groupLabel = dailyAnalysis.groups.map(group => `${String.fromCharCode(65 + group.id)}群${group.size}セッション`).join("、");
  return <div className="opinion-map" style={{ width: "100%" }}>
    <div style={{ position: "relative", width: "100%", aspectRatio: "500 / 345" }} role="img" aria-label={`日次の回答傾向の地図。薄い領域は各群の分布の広がりです。分析対象${dailyAnalysis.eligible}セッション、${groupLabel}。${showPoints ? "一人ひとりの点も表示しています。" : "一人ひとりの点は非表示です。"}${personalLabel}地図の範囲を超える暫定位置は端に表示します。`}>
      <canvas ref={background} aria-hidden="true" style={{ display: "block", width: "100%", height: "100%" }} />
      <canvas ref={overlay} aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
    </div>
    <label className="daily-map-toggle" style={{ display: "flex", alignItems: "center", gap: 8, width: "fit-content", minHeight: 36, padding: "6px 0", fontSize: 12, lineHeight: 1.5, color: "#40516d", cursor: "pointer" }}>
      <input type="checkbox" checked={showPoints} onChange={event => setShowPoints(event.target.checked)} style={{ width: 16, height: 16, flexShrink: 0, accentColor: "#2455dd" }} />
      <span>一人ひとりの点も表示</span>
    </label>
  </div>;
}
