export function Spark({
  data,
  className,
  up,
}: {
  data: number[];
  className?: string;
  up: boolean;
}) {
  if (data.length < 2) return <div className={className} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = Math.max(max - min, 1e-12);
  const w = 120;
  const h = 36;
  const d = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 2) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      aria-hidden
      preserveAspectRatio="none"
    >
      <path
        d={d}
        fill="none"
        stroke={up ? "var(--color-up)" : "var(--color-down)"}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
