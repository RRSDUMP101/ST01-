"""Min / Max from what is really used, and the reorder warning (เตือนสั่งซื้อ).

Usage comes from, in this order:
  1. issues in this program (PD / OU documents, movements.Ledger.daily_out)
  2. the per-day จ่ายออก columns of the company's "สต๊อกเหล็ก" sheet (StockItem.extra["issues"])
  3. no history yet: a default from the model BOMs - keep enough for `default_beds` beds (ค่าเริ่มต้น)
Formulas (days are calendar days):
    d   = average use per day over the history window      σ = standard deviation of the daily use
    Safety stock = z × σ × √lead      Min (จุดสั่งซื้อ) = d × lead + Safety stock
    Max = Min + d × review            available = on hand − reserved for open jobs
    order when available ≤ Min: order = Max − available (rounded up)
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from .stock import StockItem, StockList, _key

Z_SCORES = {0.90: 1.28, 0.95: 1.65, 0.98: 2.05, 0.99: 2.33}

RS_ORDER = "ต่ำกว่า Min – สั่งซื้อ"
RS_NEAR = "ใกล้ Min"
RS_OK = "พอ"
RS_OVER = "เกิน Max"
RS_NO_DATA = "ไม่มีข้อมูลการใช้"
RS_ORDER_STATES = (RS_ORDER, RS_NEAR, RS_OVER, RS_OK, RS_NO_DATA)

SRC_HISTORY = "ยอดใช้จริง"
SRC_DEFAULT = "ค่าเริ่มต้นจากแบบกระบะ"
SRC_CURRENT = "ค่าเดิม"


@dataclass
class ReplenishParams:
    lead_days: float = 7  # order -> delivered
    review_days: float = 14  # how often the store orders
    service: float = 0.95
    history_days: int = 90
    default_beds: float = 2  # no history: keep parts for this many beds (Min)
    batch_beds: float = 3  # ... and order up to this many more beds (Max)

    @property
    def z(self) -> float:
        return Z_SCORES.get(round(self.service, 2), 1.65)


@dataclass
class ReplenishLine:
    code: str
    name: str
    unit: str
    on_hand: float
    reserved: float
    min_now: float
    max_now: float
    avg_day: float = 0
    days_with_use: int = 0
    min_new: float = 0
    max_new: float = 0
    source: str = ""
    status: str = RS_NO_DATA
    order_qty: float = 0
    item: StockItem | None = None

    @property
    def available(self) -> float:
        return self.on_hand - self.reserved

    @property
    def days_cover(self) -> float | None:
        return self.available / self.avg_day if self.avg_day > 0 else None


def usage_by_item(stock: StockList, daily_out: dict[str, dict[str, float]] | None = None) -> dict[str, dict[str, float]]:
    """{key: {date: qty}}; key = code, or '#name' for lines without a code (สต๊อกเหล็ก)."""
    out: dict[str, dict[str, float]] = {}
    for key, days in (daily_out or {}).items():
        k = _key(key) if not key.startswith("#") else key
        for d, q in days.items():
            out.setdefault(k, {})[d] = out.get(k, {}).get(d, 0) + q
    for item in stock.items:
        issues = item.extra.get("issues") if item.extra else None
        if issues:
            k = _key(item.code) if item.code else "#" + item.name
            for d, q in issues.items():
                out.setdefault(k, {})[d] = out.get(k, {}).get(d, 0) + float(q)
        period = item.extra.get("issue_period") if item.extra else None
        if period:  # days of the sheet without issues count as 0
            k = _key(item.code) if item.code else "#" + item.name
            for d in period:
                out.setdefault(k, {}).setdefault(d, 0)
    return out


def per_bed_qty(models) -> dict[str, float]:
    """Most pieces of a code used in one bed in any model (for the default Min/Max)."""
    out: dict[str, float] = {}
    for m in models or []:
        seen: dict[str, float] = {}
        for r in m.rows:
            for c in r.codes:
                seen[_key(c)] = seen.get(_key(c), 0) + r.qty / max(1, len(r.codes))
        for k, q in seen.items():
            out[k] = max(out.get(k, 0), q)
    return out


def _stats(days: dict[str, float], today: date, window: int) -> tuple[float, float, int, int]:
    """(average per day, std dev per day, days with use, span in days)."""
    since = today - timedelta(days=window)
    use = {date.fromisoformat(d[:10]): q for d, q in days.items() if _iso(d) and date.fromisoformat(d[:10]) > since}
    if not use:
        # history older than the window (e.g. a ledger of last year): use its own span
        use = {date.fromisoformat(d[:10]): q for d, q in days.items() if _iso(d)}
        if not use:
            return 0, 0, 0, 0
        first, last = min(use), max(use)
        last = max(last, first + timedelta(days=29))  # at least a month: one old issue is not a daily rate
    else:
        first, last = min(min(use), since + timedelta(days=1)), today
    span = max(1, (last - first).days + 1)
    series = [use.get(first + timedelta(days=i), 0) for i in range(span)]
    avg = sum(series) / span
    sd = statistics.pstdev(series) if span > 1 else 0
    return avg, sd, sum(1 for q in use.values() if q > 0), span


def _iso(text: str) -> bool:
    try:
        date.fromisoformat(str(text)[:10])
        return True
    except ValueError:
        return False


def compute(stock: StockList, params: ReplenishParams | None = None, daily_out: dict | None = None,
            reserved: dict[str, float] | None = None, models=None, today: date | None = None) -> list[ReplenishLine]:
    params = params or ReplenishParams()
    today = today or date.today()
    usage = usage_by_item(stock, daily_out)
    reserved = reserved or {}
    beds = per_bed_qty(models)
    lines = []
    from . import stock as stock_mod

    for item in stock.items:
        k = _key(item.code) if item.code else "#" + item.name
        # the same part under another code (Express RRS-… <-> stock-count 01-…)
        keys = [k] + ([_key(c) for c in stock_mod.XREF_LOOKUP(item.code)] if item.code and stock_mod.XREF_LOOKUP else [])
        days: dict[str, float] = {}
        for key in keys:
            for d, q in usage.get(key, {}).items():
                days[d] = days.get(d, 0) + q
        line = ReplenishLine(item.code, item.name, item.unit_name, item.on_hand,
                             sum(reserved.get(key, 0) for key in keys), item.min_qty, item.max_qty, item=item)
        avg, sd, used_days, _span = _stats(days, today, params.history_days)
        k = next((key for key in keys if key in beds), k)
        if used_days:
            line.avg_day, line.days_with_use = avg, used_days
            safety = params.z * sd * math.sqrt(params.lead_days)
            line.min_new = math.ceil(round(avg * params.lead_days + safety, 6))
            line.max_new = max(line.min_new, math.ceil(round(line.min_new + avg * params.review_days, 6)))
            line.source = SRC_HISTORY
        elif k in beds:
            line.min_new = math.ceil(beds[k] * params.default_beds)
            line.max_new = math.ceil(beds[k] * (params.default_beds + params.batch_beds))
            line.source = SRC_DEFAULT
        elif item.min_qty or item.max_qty:
            line.min_new, line.max_new, line.source = item.min_qty, item.max_qty, SRC_CURRENT
        else:
            line.status = RS_NO_DATA
            lines.append(line)
            continue
        lo, hi = line.min_new, max(line.max_new, line.min_new)
        if line.available <= lo:
            line.status = RS_ORDER
            line.order_qty = math.ceil(max(0.0, hi - line.available))
        elif line.available <= lo * 1.2 or (line.days_cover is not None and line.days_cover <= params.lead_days * 1.5):
            line.status = RS_NEAR
        elif hi and line.available > hi * 1.5:
            line.status = RS_OVER
        else:
            line.status = RS_OK
        lines.append(line)
    order = {s: i for i, s in enumerate(RS_ORDER_STATES)}
    return sorted(lines, key=lambda x: (order[x.status], x.code or x.name))


def apply_min_max(lines: list[ReplenishLine], only_sources: tuple[str, ...] = (SRC_HISTORY, SRC_DEFAULT)) -> int:
    """Write the suggested Min / Max into the stock items. Returns items changed."""
    n = 0
    for line in lines:
        if line.item is not None and line.source in only_sources and (
                line.item.min_qty != line.min_new or line.item.max_qty != line.max_new):
            line.item.min_qty, line.item.max_qty = line.min_new, line.max_new
            n += 1
    return n


REPLENISH_HEADERS = ["รหัสสินค้า", "รายการ", "หน่วย", "คงเหลือ", "จองให้งาน", "ใช้ได้", "ใช้เฉลี่ย/วัน", "พอใช้ (วัน)",
                     "Min เดิม", "Max เดิม", "Min แนะนำ", "Max แนะนำ", "ที่มา", "สถานะ", "ควรสั่ง"]


def replenish_row(line: ReplenishLine) -> list:
    cover = line.days_cover
    return [line.code, line.name, line.unit, _r(line.on_hand), _r(line.reserved), _r(line.available),
            round(line.avg_day, 3) if line.avg_day else "", round(cover, 1) if cover is not None else "",
            _r(line.min_now), _r(line.max_now), _r(line.min_new), _r(line.max_new), line.source, line.status,
            _r(line.order_qty) if line.order_qty else ""]


def _r(v: float):
    v = round(v, 3)
    return int(v) if float(v).is_integer() else v


def export_replenish(lines: list[ReplenishLine], path: str | Path, params: ReplenishParams,
                     only_orders: bool = False) -> None:
    from .tabular import write_table

    rows = [replenish_row(x) for x in lines if not only_orders or x.order_qty > 0]
    title = [["ใบขอซื้อ (ร่าง) จากจุดสั่งซื้อ" if only_orders else "Min / Max จากยอดใช้จริง และเตือนสั่งซื้อ"],
             ["ระยะเวลาสั่งของ (วัน)", params.lead_days, "รอบสั่ง (วัน)", params.review_days,
              "ระดับบริการ", f"{params.service:.0%}", "ข้อมูลย้อนหลัง (วัน)", params.history_days]]
    write_table(path, REPLENISH_HEADERS, rows, title_rows=title, sheet_title="MinMax")
