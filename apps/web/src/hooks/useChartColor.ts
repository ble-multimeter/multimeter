// Chart line-color preference (PLAN §6 QoL). Mirrors useTheme: owns the chosen preset key,
// persists it to localStorage, and is read globally so the choice applies to the live chart
// and every reopened session. The actual hex is resolved per-theme by resolveStroke at the
// point of use (chartColors.ts).

import { useEffect, useState } from 'react';
import { CHART_COLORS, DEFAULT_CHART_COLOR } from '../lib/chartColors';

const KEY = 'chartColor';

function initial(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && CHART_COLORS.some((c) => c.key === saved)) return saved;
  } catch {
    // ignore (private mode / blocked storage)
  }
  return DEFAULT_CHART_COLOR;
}

export function useChartColor() {
  const [colorKey, setColorKey] = useState<string>(initial);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, colorKey);
    } catch {
      // ignore
    }
  }, [colorKey]);

  return { colorKey, setColorKey };
}
