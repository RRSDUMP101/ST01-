import json

import pytest

from conftest import SAMPLES
from partlist_studio.core.gsheets import SheetsClient, SheetsError, detect_mode, spreadsheet_key
from partlist_studio.core.models import Part, PartList
from partlist_studio.core.partlist_io import prepare_rows
from partlist_studio.core.stock import (ST_LOW, ST_MISSING, ST_OK, ST_SHORT, StockItem, StockList,
                                        apply_status_to_parts, check_requirements, export_requirements,
                                        find_stock_item)
from partlist_studio.core.tabular import read_table


def _job(build=3):
    pl = PartList(parts=[
        Part(part_no="RRS-TB-001", material="SS400", spec="t3.2 x 300 x 150", qty=2, weight=1.1),
        Part(part_no="RRS-TB-010", material="STKR400", spec="50x50x2.3", qty=4, unit="เส้น"),
        Part(part_no="STD-M10-30", name="Bolt", material="SS400", spec="M10", qty=8, process="ซื้อสำเร็จ"),
        Part(part_no="X-9", name="ยางกันกระแทก", qty=2),
    ])
    pl.info.build_qty = build
    return pl


def test_stock_file_header_detection():
    stock = StockList.from_file(SAMPLES / "store_stock.csv")
    assert len(stock.items) == 4
    plate = stock.items[0]
    assert plate.code == "RM-PL-SS400-3.2" and plate.on_hand == 180 and plate.by_weight


def test_matching_by_code_and_by_material_spec():
    stock = StockList.from_file(SAMPLES / "store_stock.csv")
    pl = _job()
    assert find_stock_item(pl.parts[0], stock).code == "RM-PL-SS400-3.2"  # SS400 + t3.2
    assert find_stock_item(pl.parts[1], stock).code == "RM-TB-STKR-50"
    assert find_stock_item(pl.parts[3], stock) is None
    pl.parts[3].stock_code = "PT-BOLT-M10-30"
    assert find_stock_item(pl.parts[3], stock).code == "PT-BOLT-M10-30"


def test_requirement_check():
    stock = StockList.from_file(SAMPLES / "store_stock.csv")
    lines = {(l.code or l.name): l for l in check_requirements(_job(build=3), stock)}
    plate = lines["RM-PL-SS400-3.2"]
    assert plate.required == pytest.approx(1.1 * 2 * 3)  # kg = weight x qty x vehicles
    assert plate.status == ST_OK
    tube = lines["RM-TB-STKR-50"]
    assert (tube.required, tube.balance, tube.status) == (12, -6, ST_SHORT)
    assert tube.suggest_order == 46  # back up to Max 40
    assert lines["PT-BOLT-M10-30"].status == ST_OK
    assert lines["ยางกันกระแทก"].status == ST_MISSING
    assert lines["ยางกันกระแทก"].suggest_order == 6


def test_low_stock_and_missing_weight():
    stock = StockList(items=[StockItem(code="RM1", material="SS400", spec="3.2", unit="kg", on_hand=10, min_qty=8)])
    pl = PartList(parts=[Part(part_no="A", material="SS400", spec="t3.2", qty=1, weight=3),
                         Part(part_no="B", material="SS400", spec="t3.2", qty=1)])
    [line] = check_requirements(pl, stock, build_qty=1)
    assert line.status == ST_LOW and line.balance == 7
    assert "B" in line.note


def test_apply_status_and_export(tmp_path):
    stock = StockList.from_file(SAMPLES / "store_stock.csv")
    pl = _job()
    lines = check_requirements(pl, stock)
    apply_status_to_parts(pl, stock, lines)
    assert [p.status for p in pl.parts] == ["พร้อม", "ขาด", "พร้อม", "รอตรวจ"]
    assert pl.parts[1].stock_code == "RM-TB-STKR-50"
    path = tmp_path / "po.xlsx"
    export_requirements(pl, lines, path, only_purchase=True)
    rows = read_table(path)
    header = next(i for i, r in enumerate(rows) if r[0] == "รหัสสินค้า")
    codes = [r[0] for r in rows[header + 1:]]
    assert "RM-TB-STKR-50" in codes and "PT-BOLT-M10-30" not in codes


def test_spreadsheet_key():
    url = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0"
    assert spreadsheet_key(url) == "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
    with pytest.raises(SheetsError):
        spreadsheet_key("not a sheet")


def test_detect_mode(tmp_path):
    sa = tmp_path / "sa.json"
    sa.write_text(json.dumps({"type": "service_account", "client_email": "bot@x.iam.gserviceaccount.com"}))
    oauth = tmp_path / "oauth.json"
    oauth.write_text(json.dumps({"installed": {"client_id": "x"}}))
    assert detect_mode(str(sa)) == "service"
    assert detect_mode(str(oauth)) == "oauth"


class FakeWorksheet:
    def __init__(self, title, values=None):
        self.title, self.values = title, values or []

    def get_all_values(self):
        return self.values

    def clear(self):
        self.values = []

    def update(self, values, range_name, value_input_option):
        self.values = values

    def format(self, *args):
        pass

    def freeze(self, rows):
        pass


class FakeSpreadsheet:
    url = "https://docs.google.com/spreadsheets/d/KEY"

    def __init__(self):
        self.tabs = {"Stock": FakeWorksheet("Stock", [["รหัสสินค้า", "คงเหลือ"], ["A", "5"], ["", ""]])}

    def worksheet(self, title):
        return self.tabs[title]

    def worksheets(self):
        return list(self.tabs.values())

    def add_worksheet(self, title, rows, cols):
        self.tabs[title] = FakeWorksheet(title)
        return self.tabs[title]


class FakeClient:
    def __init__(self):
        self.sheet = FakeSpreadsheet()

    def open_by_key(self, key):
        assert key == "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
        return self.sheet


def test_sheets_client_read_write_roundtrip():
    key = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
    client = SheetsClient("", client=FakeClient())
    assert client.read_rows(key, "Stock") == [["รหัสสินค้า", "คงเหลือ"], ["A", "5"]]
    rows = [["รหัสชิ้นส่วน", "จำนวน"], ["P-1", 2.0]]
    client.write_rows(key, "PartList", rows)
    back = client.read_rows(key, "PartList")
    assert back == [["รหัสชิ้นส่วน", "จำนวน"], ["P-1", 2]]
    assert prepare_rows(back).to_parts()[0].qty == 2
    assert client.worksheet_titles(key) == ["Stock", "PartList"]
