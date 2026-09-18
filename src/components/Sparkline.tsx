// Tiny dependency-free inline-SVG sparkline. Null values (e.g. a
// zero-exposure week) break the line rather than being drawn as 0.
// Decorative — the numeric sequence is always rendered as text beside it.

export default function Sparkline({
  values,
  width = 88,
  height = 24,
  className = 'text-cyan-500 dark:text-cyan-400',
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const nums = values.filter((v): v is number => v != null);
  if (values.length < 2 || nums.length === 0) return null;

  const pad = 3;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => (span === 0 ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2));

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) segments.push(current.join(' '));
      current = [];
    } else {
      current.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    }
  });
  if (current.length) segments.push(current.join(' '));

  const lastIdx = values.length - 1;
  const last = values[lastIdx];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={`shrink-0 ${className}`} aria-hidden="true" focusable="false">
      {segments.map((pts, i) =>
        pts.includes(' ') ? (
          <polyline key={i} points={pts} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <circle key={i} cx={pts.split(',')[0]} cy={pts.split(',')[1]} r="1.5" fill="currentColor" />
        ),
      )}
      {last != null && <circle cx={x(lastIdx)} cy={y(last)} r="2.25" fill="currentColor" />}
    </svg>
  );
}
