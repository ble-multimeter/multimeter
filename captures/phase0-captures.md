# Phase-0 captures — UT60BTk (2026-06-06)

Real frames from the physical unit, curated to one representative per (function, range, state).
These are the **fixtures for the Phase-1 `decode.ts` tests**. `flags` columns are bytes
`[14] [15] [16]` (A B C). Display = ASCII bytes `[5..11]` (shown trimmed). All frames verified
against the 16-bit checksum.

## Control / non-measurement

| hex | meaning |
|---|---|
| `ab cd 08 55 54 36 30 42 54 03 25` | GET-NAME response = `"UT60BT"` (11 bytes, not a measurement) |

## Measurement frames

| fn | function | range | hex | display | expect |
|---|---|---|---|---|---|
| 00 | ACV | 0 | `ab cd 10 00 30 20 20 32 37 34 2e 37 00 00 00 00 08 03 02` | `274.7` | 274.7 V, acdc=AC |
| 00 | ACV | 1 | `ab cd 10 00 31 20 20 30 2e 32 31 39 00 00 00 04 08 02 ff` | `0.219` | 0.219 V, AC, autorange-off |
| 00 | ACV | 2 | `ab cd 10 00 32 20 20 20 30 2e 32 36 00 00 00 04 08 02 ec` | `0.26` | 0.26 V, AC |
| 00 | ACV | 3 | `ab cd 10 00 33 20 20 20 20 31 2e 34 00 00 00 04 08 02 da` | `1.4` | 1.4 V, AC |
| 02 | DCV | 0 | `ab cd 10 02 30 20 2d 31 2e 33 32 35 00 00 00 00 00 03 00` | `-1.325` | -1.325 V, DC |
| 02 | DCV | 1 | `ab cd 10 02 31 20 2d 30 2e 30 30 31 00 00 00 04 00 02 fb` | `-0.001` | -0.001 V, DC |
| 02 | DCV | 2 | `ab cd 10 02 32 20 20 20 30 2e 30 30 00 00 00 04 00 02 de` | `0.00` | 0.00 V, DC |
| 02 | DCV | 3 | `ab cd 10 02 33 20 20 20 20 30 2e 30 00 00 00 04 00 02 cf` | `0.0` | 0.0 V, DC |
| 03 | DCmV | 1 | `ab cd 10 03 31 20 20 33 32 2e 34 32 00 00 00 00 00 02 f5` | `32.42` | 32.42 mV → base 0.03242 V |
| 04 | Hz | 0 | `ab cd 10 04 30 20 20 30 2e 30 30 30 00 00 00 00 08 02 f2` | `0.000` | 0.000 Hz, acdc=AC bit set |
| 06 | OHM | 0 | `ab cd 10 06 30 20 20 20 4f 4c 2e 20 00 00 00 00 00 03 07` | `OL.` | overload, value=null |
| 06 | OHM | 5 | `ab cd 10 06 35 20 20 20 4f 2e 4c 20 00 00 00 00 00 03 0c` | `O.L` | overload (dot moved), value=null |
| 07 | CONT | 0 | `ab cd 10 07 30 20 20 20 4f 4c 2e 20 00 00 00 04 00 03 0c` | `OL.` | overload, value=null |
| 08 | DIODE | 1 | `ab cd 10 08 31 20 20 2e 4f 4c 20 20 00 00 00 04 00 03 0e` | `.OL` | overload, value=null |
| 09 | CAP | 0 | `ab cd 10 09 30 20 20 30 2e 30 31 31 00 00 00 00 00 02 f1` | `0.011` | 0.011 nF → base 1.1e-11 F |
| 09 | CAP | 1 | `ab cd 10 09 31 20 20 2e 4f 4c 20 20 00 00 00 00 00 03 0b` | `.OL` | overload, value=null |
| 0a | °C | 0 | `ab cd 10 0a 30 20 20 20 20 20 30 20 00 00 00 04 00 02 b6` | `0` | 0 °C |
| 0a | °C | 0 | `ab cd 10 0a 30 20 20 20 4f 4c 20 20 00 00 00 04 00 03 01` | `OL` | overload (open probe), value=null |
| 0c | DCµA | 0 | `ab cd 10 0c 30 20 20 20 20 30 2e 30 00 00 00 04 00 02 d6` | `0.0` | 0.0 µA → base 0 A |
| 0e | DCmA | 0 | `ab cd 10 0e 30 20 20 20 20 30 2e 30 00 00 00 00 00 02 d4` | `0.0` | 0.0 mA → base 0 A |
| 14 | NCV | 0 | `ab cd 10 14 30 20 20 45 46 4c 4f 20 00 00 00 04 08 03 5e` | `EFLO` | NCV bar, value=null, AC bit set |
| 14 | NCV | 0 | `ab cd 10 14 30 20 20 20 20 20 2d 20 00 00 00 04 08 02 c5` | `-` | NCV bar, value=null |

## Notes for the decoder

- Overload is structural: trim, strip `.`, then `=== "OL"` (or `-OL`).
- `flags C` bit3 (`0x08`) = AC — set for ACV, Hz, NCV here; clear for all DC functions.
- `flags B` bit2 (`0x04`) = autorange-off — set on CONT/°C/µA/NCV and after manual RANGE.
- Checksum `[17][18]` = 16-bit big-endian sum of bytes `[0..16]`; use it to validate/resync.
