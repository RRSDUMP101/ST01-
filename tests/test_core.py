import json

import pytest

from conftest import SAMPLES
from partlist_studio.core.mapping import auto_map, find_header_row, match_header
from partlist_studio.core.models import Part, PartList, to_number
from partlist_studio.core.partlist_io import export_parts, prepare_import, prepare_rows
from partlist_studio.core.tabular import read_table


@pytest.mark.parametrize("raw, expected", [
    ("1,250.5", 1250.5), ("2 pcs", 2), ("", 0), (None, 0), (3.0, 3), ("t3.2", 3.2), ("abc", 0), (-4, -4),
])
def test_to_number(raw, expected):
    assert to_number(raw) == expected


@pytest.mark.parametrize("header, key", [
    ("Part Number", "part_no"), ("รหัสชิ้นส่วน", "part_no"), ("Qty.", "qty"), ("数量", "qty"),
    ("Mass (kg)", "weight"), ("น้ำหนัก/ชิ้น (kg)", "weight"), ("DWG NO", "drawing_no"), ("วัสดุ", "material"),
    ("Count", "qty"), ("รหัสสโตร์", "stock_code"), ("random", None), ("", None),
])
def test_match_header(header, key):
    assert match_header(header) == key


def test_header_row_skips_title_lines():
    rows = [["BOM - RRS-AS-100"], [], ["Item", "Part Number", "Name", "Qty"], ["1", "A", "x", "2"]]
    assert find_header_row(rows) == 2
    assert auto_map(rows[2]) == {0: "item_no", 1: "part_no", 2: "name", 3: "qty"}


def test_partlist_save_load_roundtrip(tmp_path):
    pl = PartList(parts=[Part(part_no="A-1", name="แผ่นข้าง", qty=2, weight=1.25)])
    pl.info.so_no, pl.info.build_qty = "SO1", 4
    path = tmp_path / "job.rrspl"
    pl.save(path)
    assert json.loads(path.read_text(encoding="utf-8"))["format"] == "rrs-partlist"
    loaded = PartList.load(path)
    assert loaded.parts[0].name == "แผ่นข้าง"
    assert loaded.info.build_qty == 4
    assert loaded.total_weight == 2.5


def test_import_zwcad_tableexport_csv():
    table = prepare_import(SAMPLES / "zwcad_tableexport_bom.csv")
    parts = table.to_parts()
    assert table.header_index == 1
    assert [p.part_no for p in parts][:2] == ["RRS-TB-001", "RRS-TB-002"]
    assert parts[2].qty == 4 and parts[0].weight == 10.85


def test_import_thai_windows_encoding(tmp_path):
    path = tmp_path / "bom_cp874.csv"
    path.write_bytes("ลำดับ,รหัส,ชื่อชิ้นส่วน,จำนวน\n1,P-01,แผ่นพื้น,3\n,,รวม,3\n".encode("cp874"))
    parts = prepare_import(path).to_parts()
    assert len(parts) == 1  # the "รวม" totals row is dropped
    assert parts[0].name == "แผ่นพื้น" and parts[0].qty == 3


def test_skip_blank_and_total_rows():
    table = prepare_rows([["Part No", "Name", "Qty"], ["A", "a", "1"], ["", "", ""], ["", "Total", "1"]])
    assert [p.part_no for p in table.to_parts()] == ["A"]


@pytest.mark.parametrize("suffix", [".csv", ".xlsx"])
def test_cad_export_reimports(tmp_path, suffix):
    pl = PartList(parts=[Part(item_no="1", part_no="A", name="ชิ้น A", material="SS400", qty=2, weight=1.5),
                         Part(item_no="2", part_no="B", name="ชิ้น B", qty=1)])
    path = tmp_path / f"bom{suffix}"
    export_parts(pl, path, style="cad")
    parts = prepare_import(path).to_parts()
    assert [(p.part_no, p.qty, p.weight) for p in parts] == [("A", 2, 1.5), ("B", 1, 0)]


def test_thai_report_has_job_header(tmp_path):
    pl = PartList(parts=[Part(part_no="A", qty=1)])
    pl.info.so_no = "SO-77"
    path = tmp_path / "report.xlsx"
    export_parts(pl, path, style="thai")
    rows = read_table(path)
    assert rows[0][0].startswith("Part List")
    assert "SO-77" in rows[1]
    assert prepare_import(path).to_parts()[0].part_no == "A"
