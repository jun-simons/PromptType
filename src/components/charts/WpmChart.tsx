/** WPM over time (cumulative), raw speed, and red dots for seconds with errors. */
export default function WpmChart({ wpm, raw, err }: { wpm: number[]; raw: number[]; err: number[] }) {
  const n = wpm.length;
  if (n < 2) return <div className="chart empty">test too short for a chart</div>;

  const W = 640;
  const H = 170;
  const P = { l: 34, r: 10, t: 12, b: 22 };
  const peak = Math.max(10, ...wpm, ...raw);
  const max = Math.ceil((peak * 1.1) / 20) * 20;
  const x = (i: number) => P.l + (i / (n - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - v / max) * (H - P.t - P.b);
  const path = (a: number[]) => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const ticks = [0, max / 2, max];
  const xTicks = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Words per minute over time">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={P.l - 8} y={y(t) + 3} textAnchor="end">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} className="axis" x={x(i)} y={H - 6} textAnchor="middle">
            {i + 1}s
          </text>
        ))}
        <path className="raw" d={path(raw)} />
        <path className="wpm" d={path(wpm)} />
        {err.map((e, i) => (e > 0 ? <circle key={i} className="err" cx={x(i)} cy={y(raw[i] ?? 0)} r={2.5 + Math.min(e, 4) * 0.8} /> : null))}
      </svg>
    </div>
  );
}
