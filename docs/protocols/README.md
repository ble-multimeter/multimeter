# Driver protocol specs

One markdown per driver — transport, handshake, frame format, decode, controls, and verification
state, derived from the driver source under `packages/protocol/src/drivers/`. For the device support
matrix, see [`../HARDWARE.md`](../HARDWARE.md).

## State legend

| State | Meaning |
|-------|---------|
| ✅ `verified` | Confirmed on physical hardware. |
| 🔄 `expected` | Same driver as a `verified` device; not yet confirmed on this model. |
| ⏳ `untested` | No device on this driver confirmed yet. |
| 📋 `planned` | No driver yet. |

## Drivers

| Driver | Models | Transport · routing | State | Spec |
|--------|--------|---------------------|-------|------|
| `uni-t` | UT60BT, UT161A–E | ISSC · name | UT60BT ✅ `verified`, UT161 🔄 `expected` | [uni-t.md](uni-t.md) |
| `ut117c` | UT117C | ISSC · name | ⏳ `untested` | [ut117c.md](ut117c.md) |
| `ut171` | UT171A/B/C | ISSC · name | ⏳ `untested` | [ut171.md](ut171.md) |
| `ut181a` | UT181A | ISSC · name | ⏳ `untested` | [ut181a.md](ut181a.md) |
| `ut202bt` | UT202BT (clamp) | ISSC · name | 🔄 `expected` | [ut202bt.md](ut202bt.md) |
| `ut219p` | UT219P (power clamp) | ISSC · name | ⏳ `untested` | [ut219p.md](ut219p.md) |
| `bdm` | Aneng / BSIDE / ZOYI / BABATools | `0xFFF0` · sniff 10/11 B | AN9002, ZT-5B ✅ `verified` | [bdm.md](bdm.md) |
| `owon-plus` | Owon B35T+/B41T+/OW18E/CM2100B | `0xFFF0` · sniff 6 B | ⏳ `untested` | [owon-plus.md](owon-plus.md) |
| `owon-old` | Owon B35T (legacy text) | `0xFFF0` · sniff 14 B | ⏳ `untested` | [owon-old.md](owon-old.md) |
| `voltcraft` | Voltcraft VC800/VC900 | `0xFFF0` · sniff 15 B | ⏳ `untested` | [voltcraft.md](voltcraft.md) |
| `ai-care` | AICARE AP-570C-APP (clamp) | `0xFFB0` · service | ⏳ `untested` | [ai-care.md](ai-care.md) |

## Transport & routing

Two transports, two routing strategies:

- **UNI-T line** — shares the ISSC "Transparent UART" service
  `49535343-fe7d-4ae5-8fa9-9fafd205e455` (notify `…1e4d…`, write `…8841…`, write-fallback `…6daa…`).
  Each model emits **nothing** until a model-specific handshake, so they cannot be frame-sniffed; the
  session routes them by advertised **name**.
- **Generic "Bluetooth DMM" clones** — **free-stream** measurements with no handshake. Four families
  share GATT `0xFFF0` (notify `0xFFF4`, write `0xFFF3`) and are told apart by **frame length** via
  each driver's `sniff()`: `bdm` 10/11 B · `owon-plus` 6 B · `owon-old` 14 B · `voltcraft` 15 B.
  `ai-care` owns its own `0xFFB0` service outright, so it needs no sniff. This family is receive-only.
  `bdm` itself spans device-types selected by descrambled `byte[2]` — S_5G (10 B) and AB_300 (11 B)
  are decoded; QB_5G/P_66 aren't (see [bdm.md](bdm.md)).
