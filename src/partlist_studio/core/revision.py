"""Compare two revisions of a drawing / Part List / model BOM (เทียบ Rev.): what was added, removed,
changed in quantity, or changed in name, material, size, weight, flat pattern."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .models import Part, PartList
from .stock import _key

CH_ADDED = "เพิ่มใหม่"
CH_REMOVED = "ตัดออก"
CH_QTY = "จำนวนเปลี่ยน"
CH_CHANGED = "แก้ไข"
CH_SAME = "เหมือนเดิม"
CHANGE_ORDER = {CH_ADDED: 0, CH_REMOVED: 1, CH_QTY: 2, CH_CHANGED: 3, CH_SAME: 4}

FIELDS = [("name", "ชื่อ"), ("material", "วัสดุ"), ("spec", "ขนาด/ความหนา"), ("unit", "หน่วย"),
          ("weight", "น้ำหนัก/ชิ้น"), ("process", "กระบวนการ"), ("stock_code", "รหัสสโตร์")]


@dataclass
class Change:
    kind: str
    key: str
    code: str
    name: str
    old_qty: float = 0
    new_qty: float = 0
    diffs: list[tuple[str, str, str]] = field(default_factory=list)  # (field, old, new)

    @property
    def qty_delta(self) -> float:
        return self.new_qty - self.old_qty

    @property
    def detail(self) -> str:
        return " · ".join(f"{label}: {old or '-'} → {new or '-'}" for label, old, new in self.diffs)


_AUTO_NAME = re.compile(r"ชิ้นที่ \d+")


def _part_key(p: Part) -> str:
    if p.part_no:
        return "C:" + _key(p.part_no)
    return "N:" + _key(p.name) + "|" + _key(p.spec)


def _group(parts: list[Part]) -> dict[str, tuple[Part, float]]:
    out: dict[str, tuple[Part, float]] = {}
    for p in parts:
        k = _part_key(p)
        first, qty = out.get(k, (p, 0))
        out[k] = (first, qty + p.qty)
    return out


def _value(p: Part, key: str) -> str:
    v = getattr(p, key)
    if key == "weight":
        return f"{v:g}" if v else ""
    return str(v or "").strip()


def _outline_info(p: Part) -> str:
    if not p.outline:
        return ""
    xs = [x for x, _ in p.outline[0]]
    ys = [y for _, y in p.outline[0]]
    return f"{max(xs) - min(xs):.0f}x{max(ys) - min(ys):.0f} รู {len(p.outline) - 1}"


def compare_parts(old: list[Part], new: list[Part], weight_tol: float = 0.01) -> list[Change]:
    a, b = _group(old), _group(new)
    pairs = [(k, k) for k in a if k in b]
    gone = [k for k in a if k not in b]
    came = [k for k in b if k not in a]
    # parts without a code: the same flat pattern under another name, then the same name with another size
    for match in (lambda x, y: bool(_outline_info(x)) and _outline_info(x) == _outline_info(y)
                  and _key(x.spec) == _key(y.spec),
                  lambda x, y: _key(x.name) == _key(y.name)):
        for ka in list(gone):
            if not ka.startswith("N:"):
                continue
            kb = next((k for k in came if k.startswith("N:") and match(a[ka][0], b[k][0])), None)
            if kb:
                pairs.append((ka, kb))
                gone.remove(ka)
                came.remove(kb)
    out = []
    for ka, kb in pairs:
        (pa, qa), (pb, qb) = a[ka], b[kb]
        ch = Change(CH_SAME, kb, pb.part_no, pb.name, qa, qb)
        for key, label in FIELDS:
            va, vb = _value(pa, key), _value(pb, key)
            if key == "weight" and pa.weight and pb.weight and abs(pa.weight - pb.weight) <= weight_tol * pa.weight:
                continue
            if key == "name" and _AUTO_NAME.fullmatch(va) and _AUTO_NAME.fullmatch(vb):
                continue  # 'ชิ้นที่ 7' -> 'ชิ้นที่ 6': numbering given by the import, not a change
            if _key(va) != _key(vb):
                ch.diffs.append((label, va, vb))
        oa, ob = _outline_info(pa), _outline_info(pb)
        if oa and ob and oa != ob:
            ch.diffs.append(("รูปคลี่", oa, ob))
        if abs(qa - qb) > 1e-9:
            ch.kind = CH_QTY
        if ch.diffs:
            if abs(qa - qb) > 1e-9:
                ch.diffs.insert(0, ("จำนวน", f"{qa:g}", f"{qb:g}"))
            ch.kind = CH_CHANGED
        out.append(ch)
    out += [Change(CH_REMOVED, k, a[k][0].part_no, a[k][0].name, a[k][1], 0) for k in gone]
    out += [Change(CH_ADDED, k, b[k][0].part_no, b[k][0].name, 0, b[k][1]) for k in came]
    out.sort(key=lambda c: (CHANGE_ORDER[c.kind], c.code or c.name))
    return out


def summary(changes: list[Change]) -> dict[str, int]:
    out: dict[str, int] = {}
    for c in changes:
        out[c.kind] = out.get(c.kind, 0) + 1
    return out


def compare_info(old: PartList, new: PartList) -> list[tuple[str, str, str]]:
    """Header differences (Rev., drawing number, model ...)."""
    out = []
    for key, label in (("drawing_no", "เลขที่แบบ"), ("revision", "Rev."), ("vehicle_model", "รุ่นรถ"),
                       ("job_type", "แบบงาน"), ("customer", "ลูกค้า")):
        va, vb = getattr(old.info, key), getattr(new.info, key)
        if (va or vb) and va != vb:
            out.append((label, va, vb))
    return out


def partlist_from_file(path: str | Path, converter=None, densities=None) -> PartList:
    """A revision to compare: .rrspl, a drawing (.dwg/.dxf) or a table (.xlsx/.csv)."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".rrspl":
        return PartList.load(path)
    if suffix in (".dxf", ".dwg"):
        from . import dwg_io

        data = dwg_io.read_drawing(path, converter)
        pl = PartList(parts=[c.part for c in dwg_io.drawing_to_candidates(data, densities)])
        tb = data.title_block
        pl.info.drawing_no = tb.get("drawing_no", path.stem)
        pl.info.revision = tb.get("revision", "")
        return pl
    from .partlist_io import prepare_import

    return PartList(parts=prepare_import(path).to_parts())


COMPARE_HEADERS = ["การเปลี่ยนแปลง", "รหัส", "ชื่อ", "จำนวนเดิม", "จำนวนใหม่", "ต่าง", "รายละเอียด"]


def change_rows(changes: list[Change], include_same: bool = False) -> list[list]:
    return [[c.kind, c.code, c.name, _n(c.old_qty), _n(c.new_qty), _n(c.qty_delta) if c.qty_delta else "", c.detail]
            for c in changes if include_same or c.kind != CH_SAME]


def _n(v: float):
    v = round(v, 3)
    return int(v) if float(v).is_integer() else v


def export_compare(changes: list[Change], path: str | Path, old_name: str, new_name: str,
                   info: list[tuple[str, str, str]] | None = None) -> None:
    from .tabular import write_table

    counts = summary(changes)
    title = [["เทียบ Rev. แบบ / Part List"], ["เดิม", old_name, "ใหม่", new_name],
             [" · ".join(f"{k} {v}" for k, v in counts.items())]]
    for label, a, b in info or []:
        title.append([label, a, "→", b])
    write_table(path, COMPARE_HEADERS, change_rows(changes), title_rows=title, sheet_title="Compare")

