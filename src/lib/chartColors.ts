// Chart line-color presets (PLAN §6 QoL). uPlot paints to canvas, so the line color is a
// JS hex, not a Tailwind class — and it can't ride the theme variable swap. Each preset
// therefore carries an explicit light/dark hex: the light variant is a shade darker for
// contrast on white, the dark variant brighter for contrast on near-black (the same logic
// LiveChart's built-in emerald already used). The chosen key is a global preference,
// persisted like the theme, and drives both the live line and the PNG export.

export interface ChartColor {
  key: string;
  label: string;
  light: string; // stroke on a white background
  dark: string; // stroke on a near-black background
}

export const CHART_COLORS: ChartColor[] = [
  { key: 'emerald', label: 'Emerald', light: '#059669', dark: '#34d399' },
  { key: 'sky', label: 'Sky', light: '#0284c7', dark: '#38bdf8' },
  { key: 'violet', label: 'Violet', light: '#7c3aed', dark: '#a78bfa' },
  { key: 'amber', label: 'Amber', light: '#d97706', dark: '#fbbf24' },
  { key: 'rose', label: 'Rose', light: '#e11d48', dark: '#fb7185' },
];

export const DEFAULT_CHART_COLOR = 'emerald';

// Resolve a preset key to the right hex for the active theme. Unknown keys fall back to the
// default so a stale localStorage value can never blank the line.
export function resolveStroke(key: string, dark: boolean): string {
  const c = CHART_COLORS.find((x) => x.key === key) ?? CHART_COLORS[0];
  return dark ? c.dark : c.light;
}
