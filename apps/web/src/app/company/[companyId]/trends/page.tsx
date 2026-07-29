"use client";
import { use, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Trends = {
  snapshots: { at: string; verticalId: string | null; summary: any }[];
  published: { at: string | null }[];
  perVertical: { verticalId: string; name: string; total: number; strong: number; pct: number }[];
};

/** Minimal dependency-free SVG line chart. */
function LineChart({ points, label, yMax, color = "#2563eb" }: { points: { x: number; y: number }[]; label: string; yMax?: number; color?: string }) {
  const W = 640, H = 180, PAD = 34;
  if (points.length < 2) return <div className="flex h-[180px] items-center justify-center text-sm text-gray-400">Not enough data yet — each gap check adds a point.</div>;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const top = yMax ?? (Math.max(...ys) * 1.15 || 1);
  const sx = (x: number) => PAD + ((x - x0) / (x1 - x0 || 1)) * (W - PAD * 2);
  const sy = (y: number) => H - PAD + -((y / top) * (H - PAD * 2));
  const path = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {gridYs.map((gy, i) => (
        <g key={i}>
          <line x1={PAD} x2={W - PAD} y1={sy(gy)} y2={sy(gy)} stroke="#e5e7eb" strokeWidth={1} />
          <text x={PAD - 6} y={sy(gy) + 4} textAnchor="end" fontSize={10} fill="#9ca3af">{Math.round(gy * 10) / 10}</text>
        </g>
      ))}
      <path d={path} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" />
      {points.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3} fill={color} />)}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="#9ca3af">{label}</text>
      <text x={PAD} y={12} fontSize={10} fill="#9ca3af">
        {new Date(x0).toLocaleDateString()} — {new Date(x1).toLocaleDateString()}
      </text>
    </svg>
  );
}

export default function TrendsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [data, setData] = useState<Trends | null>(null);
  useEffect(() => {
    fetch(`${API}/api/companies/${companyId}/trends`).then((r) => r.json()).then(setData);
  }, [companyId]);

  if (!data) return <div className="py-12 text-center text-gray-400">Loading…</div>;

  // company-wide snapshots -> coverage % over time
  const coveragePoints = data.snapshots
    .filter((s) => !s.verticalId)
    .map((s) => ({ x: new Date(s.at).getTime(), y: Number(s.summary?.coveragePct ?? s.summary?.coverage ?? 0) }))
    .filter((p) => !Number.isNaN(p.y));
  // fall back to per-vertical snapshots averaged per day if no company-wide ones
  const fallback = coveragePoints.length < 2
    ? Object.values(
        data.snapshots.reduce((acc, s) => {
          const day = new Date(s.at).toISOString().slice(0, 10);
          const v = Number(s.summary?.coveragePct ?? s.summary?.coverage ?? 0);
          if (Number.isNaN(v)) return acc;
          (acc[day] ??= { x: new Date(day).getTime(), ys: [] as number[] }).ys.push(v);
          return acc;
        }, {} as Record<string, { x: number; ys: number[] }>),
      ).map((d) => ({ x: d.x, y: d.ys.reduce((a, b) => a + b, 0) / d.ys.length }))
    : coveragePoints;

  // cumulative published articles over time
  const pubDates = data.published.map((p) => (p.at ? new Date(p.at).getTime() : 0)).filter(Boolean).sort((a, b) => a - b);
  const cumulative = pubDates.map((t, i) => ({ x: t, y: i + 1 }));

  return (
    <div>
      <h1 className="text-2xl font-bold">Trends</h1>
      <p className="mt-1 text-sm text-gray-500">Coverage history builds a point every time a gap check runs (weekly cycle or “Check gaps”).</p>

      <div className="mt-6 rounded-xl border bg-white p-5">
        <div className="text-sm font-semibold">Answer coverage % over time</div>
        <div className="mt-3"><LineChart points={fallback.sort((a, b) => a.x - b.x)} label="coverage %" yMax={100} /></div>
      </div>

      <div className="mt-4 rounded-xl border bg-white p-5">
        <div className="text-sm font-semibold">Published articles (cumulative)</div>
        <div className="mt-3"><LineChart points={cumulative} label="articles live" color="#16a34a" /></div>
      </div>

      <div className="mt-4 rounded-xl border bg-white p-5">
        <div className="text-sm font-semibold">Coverage by industry (today)</div>
        <div className="mt-3 space-y-2">
          {data.perVertical.map((v) => (
            <div key={v.verticalId}>
              <div className="flex justify-between text-xs text-gray-600">
                <span>{v.name}</span><span>{v.strong}/{v.total} · {v.pct}%</span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(v.pct, 100)}%` }} />
              </div>
            </div>
          ))}
          {data.perVertical.length === 0 && <div className="text-sm text-gray-400">No verticals yet.</div>}
        </div>
      </div>
    </div>
  );
}
