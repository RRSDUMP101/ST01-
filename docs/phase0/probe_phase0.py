"""Phase 0 probe: run the key cases of 02_CLAUDE_HANDOFF.md against ST01- core code at the current commit.

Fixture data only (made-up codes); temporary data dirs; nothing is written to the repository.
Usage (from the repository root): QT_QPA_PLATFORM=offscreen python docs/phase0/probe_phase0.py .
Expected at commit 0a0e6f1: the FAIL lines in docs/PHASE0_STOCK_QC_AUDIT.md section 3.1 (behaviour before Phase 1).
"""

from __future__ import annotations

import copy
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(ROOT / "src"))

from partlist_studio.core.catalog import PartStock  # noqa: E402
from partlist_studio.core.movements import DocLine, Ledger, StockDoc  # noqa: E402
from partlist_studio.core.stock import StockItem, StockList  # noqa: E402

results: list[tuple[str, str, str]] = []


def record(case: str, verdict: str, detail: str) -> None:
    results.append((case, verdict, detail))
    print(f"[{verdict}] {case}\n        {detail}")


def stock_of(*items: StockItem) -> StockList:
    return StockList(items=list(items), source="fixture")


# 1. Same SKU in warehouse A and B: issue from B
a = StockItem(code="TEST-001", name="fixture part", unit="ชิ้น", on_hand=10, location="A")
b = StockItem(code="TEST-001", name="fixture part", unit="ชิ้น", on_hand=10, location="B")
st = stock_of(a, b)
led = Ledger()
doc = led.new_doc("PD", [DocLine("TEST-001", "fixture part", 1, "ชิ้น", warehouse="B")])
led.post(doc, st)
record("1 SKU in A/B, PD from B", "FAIL" if a.on_hand != 10 else "PASS",
       f"after PD warehouse=B qty 1: A={a.on_hand:g}, B={b.on_hand:g} (line warehouse is not used to pick the item; "
       f"Movement has no warehouse field: {'warehouse' in json.dumps(led.to_dict()['movements'])})")

# 2. One left, two issues (sequential in one process = what serialisation gives at best)
x = StockItem(code="TEST-002", name="last piece", unit="ชิ้น", on_hand=1)
st = stock_of(x)
led = Ledger()
w1 = led.post(led.new_doc("PD", [DocLine("TEST-002", "last piece", 1, "ชิ้น")]), st)
w2 = led.post(led.new_doc("PD", [DocLine("TEST-002", "last piece", 1, "ชิ้น")]), st)
record("2 one available, two issues", "FAIL" if x.on_hand < 0 else "PASS",
       f"both documents posted; balance={x.on_hand:g}; warnings of 2nd: {w2}")

# 3. The same request sent again
x = StockItem(code="TEST-003", name="fixture", unit="ชิ้น", on_hand=5)
st = stock_of(x)
led = Ledger()
d = led.new_doc("PD", [DocLine("TEST-003", "fixture", 1, "ชิ้น")])
led.post(d, st)
again = led.post(d, st)  # same object
resent = copy.deepcopy(d)
resent.status = "ร่าง"  # e.g. a retried request that rebuilt the draft from the same payload
resent.doc_no = led.next_no("PD")
led.docs.append(resent)
led.post(resent, st)
record("3 same document object posted twice", "PASS" if again == ["เอกสารนี้บันทึกแล้ว"] else "FAIL",
       f"second post of the same object refused: {again}")
record("3b same request rebuilt (no idempotency key)", "FAIL" if x.on_hand == 3 else "PASS",
       f"balance after a resent copy = {x.on_hand:g} (start 5, one issue of 1 intended)")

# 4. A document with a bad line
x = StockItem(code="TEST-004", name="fixture", unit="ชิ้น", on_hand=5)
st = stock_of(x)
led = Ledger()
d = led.new_doc("PD", [DocLine("TEST-004", "fixture", 2, "ชิ้น"), DocLine("NO-SUCH-CODE", "?", 1, "ชิ้น"),
                       DocLine("TEST-004", "fixture", 1, "กก.")])
w = led.post(d, st)
record("4 multi-line document with unknown code + wrong unit", "FAIL" if x.on_hand != 5 else "PASS",
       f"status={d.status}; balance={x.on_hand:g} (start 5); warnings={w}; unit กก. vs ชิ้น not checked")

# 5. Cancel, cancel again
x = StockItem(code="TEST-005", name="fixture", unit="ชิ้น", on_hand=5)
st = stock_of(x)
led = Ledger()
d = led.new_doc("PD", [DocLine("TEST-005", "fixture", 2, "ชิ้น")])
led.post(d, st)
led.cancel(d, st)
led.cancel(d, st)
reversals = sum(1 for m in led.movements if m.remark == "ยกเลิกเอกสาร")
record("5 cancel twice", "PASS" if x.on_hand == 5 and reversals == 1 else "FAIL",
       f"balance={x.on_hand:g} (start 5); reversal movements={reversals}; original movements kept")

# 6. Future production counted as free stock
ps = PartStock("TEST-006", "fixture", on_hand=5, need=5, incoming=5)
record("6 open job needs 5, 5 more being made, 5 on hand", "FAIL" if ps.free > 0 else "PASS",
       f"reserved={ps.reserved:g}, free={ps.free:g} (reserved = min(on_hand, need - incoming)); no per-SO reservation")

# 7/8 + storage: through AppState (needs Qt only for QObject/QSettings)
try:
    from PySide6.QtCore import QCoreApplication

    app = QCoreApplication.instance() or QCoreApplication([])
    QCoreApplication.setOrganizationName("phase0-probe")
    QCoreApplication.setApplicationName("phase0-probe")
    from partlist_studio.ui.state import AppState

    with tempfile.TemporaryDirectory() as tmp:
        s = AppState(data_dir=tmp)
        s.add_stock_source("Express: stock.xlsx", stock_of(StockItem(code="TEST-008", name="fixture", unit="ชิ้น",
                                                                     on_hand=10)))
        s.post_doc(StockDoc("PD", lines=[DocLine("TEST-008", "fixture", 3, "ชิ้น")]))
        after_post = s.stock.items[0].on_hand
        s.add_stock_source("Express: stock.xlsx", stock_of(StockItem(code="TEST-008", name="fixture", unit="ชิ้น",
                                                                     on_hand=10)))  # the same file again
        after_reimport = s.stock.items[0].on_hand
        record("8 re-import the same Express file after a PD", "FAIL" if after_reimport != after_post else "PASS",
               f"after PD 3: {after_post:g}; after importing the same file again: {after_reimport:g}; "
               f"movements kept: {len(s.ledger.movements)} (balance and history now disagree)")

    with tempfile.TemporaryDirectory() as tmp:
        lib = Path(tmp) / "library.json"
        lib.write_text('{"stock_sources": {"Express: x": {"items": [{"code": "TEST-009", "on_hand": 4}]}}, "ledg',
                       encoding="utf-8")  # a file cut short (e.g. power lost while writing)
        size_before = lib.stat().st_size
        s = AppState(data_dir=tmp)
        loaded = len(s.stock.items)
        s.save_library()  # any later change saves
        text = lib.read_text(encoding="utf-8")
        record("storage: library.json cut short, then any save", "FAIL" if "TEST-009" not in text else "PASS",
               f"loaded items={loaded} (no error shown); file {size_before} bytes -> {len(text)} bytes; "
               f"TEST-009 still in file: {'TEST-009' in text}; write is not atomic (write_text), no backup copy")
except Exception as exc:  # noqa: BLE001
    record("AppState cases", "NOT RUN", f"{type(exc).__name__}: {exc}")

print("\nSUMMARY")
for case, verdict, _ in results:
    print(f"{verdict:8} {case}")
