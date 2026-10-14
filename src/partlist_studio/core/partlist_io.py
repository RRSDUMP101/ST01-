"""Import/export of Part Lists as tables (ZWCAD TABLEEXPORT / Data Extraction CSV, Excel)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .mapping import CAD_HEADERS, auto_map, find_header_row
from .models import COLUMN_KEYS, COLUMN_LABELS, NUMERIC_COLUMNS, Part, PartList, parse_thickness
from .tabular import read_table, write_table


@dataclass
class TableImport:
    """A table read from a file plus how its columns map onto Part fields."""

    rows: list[list]
    header_index: int = 0
    mapping: dict[int, str] = field(default_factory=dict)

    @property
    def header(self) -> list:
        return self.rows[self.header_index] if self.rows else []

    @property
    def data_rows(self) -> list[list]:
        return self.rows[self.header_index + 1:]

    def to_parts(self) -> list[Part]:
        return rows_to_parts(self.data_rows, self.mapping)


def prepare_import(path: str | Path, sheet: str | None = None) -> TableImport:
    return prepare_rows(read_table(path, sheet))


def prepare_rows(rows: list[list]) -> TableImport:
    header_index = find_header_row(rows)
    mapping = auto_map(rows[header_index]) if rows else {}
    return TableImport(rows=rows, header_index=header_index, mapping=mapping)


def rows_to_parts(rows: list[list], mapping: dict[int, str]) -> list[Part]:
    parts = []
    for row in rows:
        values = {key: row[idx] for idx, key in mapping.items() if idx < len(row)}
        if not any(str(v).strip() for k, v in values.items() if k not in ("item_no", *NUMERIC_COLUMNS)):
            continue  # blank line or a totals row ("รวม 25")
        if _is_total_row(values):
            continue
        part = Part()
        for key, value in values.items():
            if str(value).strip() != "":
                part.set(key, value)
        if not part.thickness:  # no thickness column: 't3.2 x 300 x 150' in the size
            part.thickness = parse_thickness(part.spec, plain_number=False)
        parts.append(part)
    return parts


def _is_total_row(values: dict) -> bool:
    text = " ".join(str(values.get(k, "")) for k in ("part_no", "name")).strip().lower()
    return text in ("total", "รวม", "รวมทั้งสิ้น", "合计")


def export_parts(partlist: PartList, path: str | Path, style: str = "cad") -> None:
    """Write the part table.

    style="cad"  -> English headers, no title rows (for ZWCAD table / data link and re-import)
    style="thai" -> Thai headers with the job header (for store / production / printing)
    """
    rows = [[p.get(k) for k in COLUMN_KEYS] for p in partlist.parts]
    if style == "cad":
        write_table(path, [CAD_HEADERS[k] for k in COLUMN_KEYS], rows, sheet_title="BOM")
        return
    info = partlist.info
    title_rows = [
        ["Part List / รายการชิ้นส่วน"],
        ["SO", info.so_no, "ลูกค้า", info.customer, "รุ่นรถ", info.vehicle_model],
        ["แบบงาน", info.job_type, "เลขที่แบบ", info.drawing_no, "Rev.", info.revision],
        ["วันที่", info.created, "ผู้จัดทำ", info.prepared_by, "จำนวนผลิต (คัน)", info.build_qty],
    ]
    write_table(path, [COLUMN_LABELS[k] for k in COLUMN_KEYS], rows, title_rows=title_rows, sheet_title="Part List")
