// A half-radial (180°) analog needle gauge — the meter card's "dial" view, a companion to the
// digital readout. Pure presentation: it takes a normalized needle position (see protocol's
// gaugeFraction, which honors the meter's range) and renders a graduated instrument face — a
// moving-coil-style scale (major + minor ticks, numbered) with a tapered needle on a pivot screw.
//
// Always drawn dark-on-cream: it sits on the card's warm "backlit LCD" panel (a fixed light
// surface), so it uses the stone ramp (not theme-remapped) rather than theming with the app.
// Decorative for AT (aria-hidden): the precise value is always spelled out by the adjacent digits.

const CX = 100;
const CY = 96;
const R = 80; // arc radius within a 200×120 viewBox

// Point on the gauge at normalized position `frac` (0 = left, 0.5 = top, 1 = right), radius `r`.
function pt(frac: number, r: number): [number, number] {
  const ang = Math.PI * (1 - frac); // π (left) → 0 (right), sweeping over the top
  return [CX + r * Math.cos(ang), CY - r * Math.sin(ang)];
}

const MAJORS = [0, 0.2, 0.4, 0.6, 0.8, 1]; // numbered divisions
// Minor ticks every 0.05, skipping the major positions.
const MINORS = Array.from({ length: 21 }, (_, i) => i / 20).filter(
  f => !MAJORS.some(m => Math.abs(m - f) < 1e-6),
);

// Compact scale number (k for thousands; trims trailing zeros): 2, 2.5, 20, 1k, …
function fmtScale(n: number): string {
  if (n >= 1000) return `${+(n / 1000).toPrecision(2)}k`;
  return `${+n.toPrecision(3)}`;
}

export function DialGauge({
  fraction,
  fullScale,
  unit,
  overload,
}: {
  fraction: number | null;
  fullScale: number;
  unit: string;
  overload: boolean;
}) {
  const [ax, ay] = pt(0, R);
  const [bx, by] = pt(1, R);
  const hasNeedle = fraction !== null;
  // The needle is drawn pointing up and rotated into place, so it can CSS-transition smoothly as
  // the reading moves (reduced-motion disables the transition globally — see index.css).
  const angleDeg = hasNeedle ? (fraction - 0.5) * 180 : 0;
  const needleFill = overload ? 'fill-red-600' : 'fill-stone-800';
  const tip = CY - (R - 13);

  return (
    <svg viewBox="0 0 200 120" className="w-full" role="img" aria-hidden="true">
      {/* Scale arc */}
      <path
        d={`M ${ax} ${ay} A ${R} ${R} 0 0 1 ${bx} ${by}`}
        fill="none"
        className="stroke-stone-500"
        strokeWidth={2}
        strokeLinecap="round"
      />

      {/* Minor ticks */}
      {MINORS.map(f => {
        const [ox, oy] = pt(f, R);
        const [ix, iy] = pt(f, R - 5);
        return (
          <line key={f} x1={ox} y1={oy} x2={ix} y2={iy} className="stroke-stone-400" strokeWidth={1} />
        );
      })}

      {/* Major ticks + numbers */}
      {MAJORS.map(f => {
        const [ox, oy] = pt(f, R);
        const [ix, iy] = pt(f, R - 10);
        const [lx, ly] = pt(f, R - 19);
        return (
          <g key={f}>
            <line x1={ox} y1={oy} x2={ix} y2={iy} className="stroke-stone-600" strokeWidth={1.8} />
            <text
              x={lx}
              y={ly + 3.5}
              className="fill-stone-600"
              fontSize={9}
              textAnchor="middle"
            >
              {fmtScale(f * fullScale)}
            </text>
          </g>
        );
      })}

      {/* Unit, low-center under the pivot (the digits below carry it too, so it's a light touch) */}
      {unit && (
        <text x={CX} y={CY + 18} className="fill-stone-500" fontSize={10} textAnchor="middle">
          {unit}
        </text>
      )}

      {/* Tapered needle (blade up + short counterweight tail) + pivot screw. Rotated via a CSS
          transform (not the SVG attribute) so it tweens smoothly; transform-box/origin pin the
          pivot to the gauge center in viewBox units. Omitted when there's nothing to point at. */}
      {hasNeedle && (
        <g
          className="transition-transform duration-300 ease-out"
          style={{
            transform: `rotate(${angleDeg}deg)`,
            transformOrigin: `${CX}px ${CY}px`,
            transformBox: 'view-box',
          }}
        >
          <polygon
            points={`${CX},${tip} ${CX + 3},${CY} ${CX},${CY + 12} ${CX - 3},${CY}`}
            className={needleFill}
          />
        </g>
      )}
      <circle cx={CX} cy={CY} r={5.5} className="fill-stone-400" />
      <circle cx={CX} cy={CY} r={2.5} className="fill-stone-700" />
    </svg>
  );
}
