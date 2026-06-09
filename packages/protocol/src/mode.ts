// A human-readable label for the meter's current measurement mode — what the rotary dial + SELECT
// have landed on (e.g. "DC Voltage", "AC Current", "Resistance"). The raw `function` code (DCV,
// ACmV, OHM…) is terse and the AC/DC distinction is split across `function` + `acdc`; this folds
// them into one clear phrase for the card's annunciator. Pure; falls back to the raw code.

import type { Reading } from './types';

// Function code → measured quantity. AC/DC is added from `acdc` separately, so AC and DC variants
// map to the same quantity here. Unknown codes fall through to the raw string.
const QUANTITY: Record<string, string> = {
  ACV: 'Voltage',
  DCV: 'Voltage',
  ACmV: 'Voltage',
  DCmV: 'Voltage',
  LozV: 'Voltage',
  LPF: 'Voltage',
  LPFA: 'Voltage',
  'AC/DC': 'Voltage',
  INRUSH: 'Current',
  DCA: 'Current',
  ACA: 'Current',
  DCmA: 'Current',
  ACmA: 'Current',
  DCuA: 'Current',
  ACuA: 'Current',
  'AC+DC': 'Current',
  'AC+DC2': 'Current',
  OHM: 'Resistance',
  CONT: 'Continuity',
  DIODE: 'Diode',
  CAP: 'Capacitance',
  Hz: 'Frequency',
  '%': 'Duty cycle',
  '°C': 'Temperature',
  '°F': 'Temperature',
  HFE: 'hFE',
  Live: 'Live wire',
  NCV: 'NCV',
};

/** Clear label for the meter's current mode, e.g. "DC Voltage" / "Resistance". */
export function modeLabel(r: Reading): string {
  const quantity = QUANTITY[r.function] ?? r.function;
  return r.acdc ? `${r.acdc} ${quantity}` : quantity;
}
