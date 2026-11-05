"""ส่งเข้า Express: the documents, counts, new codes and Min/Max waiting to be keyed into Express."""

import openpyxl

from partlist_studio.core import express_out as xo
from partlist_studio.core.models import Part, PartList
from partlist_studio.core.movements import DocLine, Ledger
from partlist_studio.core.stock import StockItem, StockList


def _setup():
    stock = StockList(items=[StockItem(code="STORE-67-0850", name="สายถักหุ้มสายไฟ10mm.(สีดำ)", unit="ม้วน", on_hand=2,
                                       unit_cost=600, min_qty=2, max_qty=10),
                             StockItem(code="ST69-0001", name="กระดาษทรายแห้งกลมเบอร์80", unit="แผ่น", on_hand=40),
                             StockItem(code="01-B00-0015", name="เหล็กแผ่นดำ 4มม.4x8ฟุต", unit="แผ่น", on_hand=5,
                                       unit_cost=3226)])
    express = StockList(items=[StockItem(code="STORE-67-0850", name="สายถักหุ้มสายไฟ10mm.(สีดำ)", min_qty=2, max_qty=10),
                               StockItem(code="ST69-0001", name="กระดาษทราย"),
                               StockItem(code="01-B00-0015", name="เหล็กแผ่นดำ")])
    ledger = Ledger()
    pd = ledger.new_doc("PD", [DocLine("01-B00-0015", "เหล็กแผ่นดำ 4มม.4x8ฟุต", 2, "แผ่น", "01", 3226)],
                        job="SO6700001", remark="ช่างรองโตโยต้าระยองMR0DA8CB605903316", department="SET",
                        date="2026-07-08")
    ou = ledger.new_doc("OU", [DocLine("ST69-0001", "กระดาษทรายแห้งกลมเบอร์80", 15, "แผ่น")], remark="ช่างท๊อปฟู",
                        department="ST01", date="2026-10-17")
    rr = ledger.new_doc("RR", [DocLine("STORE-67-0850", "สายถักหุ้มสายไฟ10mm.(สีดำ)", 10, "ม้วน", "ST05", 600)],
                        vendor="อ-092", ref="PO6900012", date="2026-03-18")
    aj = ledger.new_doc("AJ", [DocLine("ST69-0001", "กระดาษทราย", -3, "แผ่น", "ST01", 5)], remark="ตรวจนับด้วยมือถือ")
    fr = ledger.new_doc("FR", [DocLine("RRS-A-033", "ตะขอ", 4, "ชิ้น")], job="SO6700002")
    draft = ledger.new_doc("PD", [DocLine("ST69-0001", "x", 1)])  # not saved: not sent
    for d in (pd, ou, rr, aj, fr):
        ledger.post(d, stock, StockList())
    return stock, express, ledger, (pd, ou, rr, aj, fr, draft)


def test_outbox_lists_saved_documents_without_express_number():
    stock, express, ledger, (pd, ou, rr, aj, fr, draft) = _setup()
    box = xo.outbox(ledger, stock, express)
    assert [d.doc_no for d in box.docs] == [rr.doc_no, pd.doc_no, ou.doc_no, aj.doc_no, fr.doc_no]  # by date
    assert draft not in box.docs
    assert [it.code for it, _ in box.new_items] == ["RRS-A-033"]  # FR of a piece Express does not have
    assert box.min_max == []  # Min/Max the same as in Express
    stock.items[1].min_qty, stock.items[1].max_qty = 20, 60
    box = xo.outbox(ledger, stock, express)
    assert [(m.item.code, m.order_qty, m.express_min) for m in box.min_max] == [("ST69-0001", 40, 0)]
    assert xo.express_remark(pd) == "SO6700001 ช่างรองโตโยต้าระยองMR0DA8CB605903316"
    assert xo.express_remark(ou) == "ช่างท๊อปฟู"
    pd.express_no = "PD6900503"
    assert pd not in xo.pending_docs(ledger)
    assert xo.new_codes(None, stock, ledger) == []  # no Express list: cannot tell


def test_outbox_workbook_like_the_express_screens_and_numbers_back(tmp_path):
    stock, express, ledger, (pd, ou, rr, aj, fr, _d) = _setup()
    box = xo.outbox(ledger, stock, express, PartList(parts=[Part(part_no="RRS-T-999-L", name="ฝาข้างซ้าย")]))
    out = tmp_path / "to_express.xlsx"
    assert xo.write_outbox(box, out, xo.Options(department="ST01"), ledger) == 5
    wb = openpyxl.load_workbook(out)
    assert wb.sheetnames[0] == xo.SUMMARY_SHEET and {pd.doc_no, rr.doc_no, xo.NEW_SHEET} <= set(wb.sheetnames)
    ws = wb[pd.doc_no]
    cells = [[c for c in row if c is not None] for row in ws.iter_rows(values_only=True)]
    assert cells[0][0].startswith("PD - จ่ายวัตถุดิบเพื่อผลิต")
    assert ["สำหรับแผนก", "SET", "เลขที่เอกสาร", "(Express ออกให้)", "วันที่", "08/07/69"] == cells[1]
    assert cells[2][:2] == ["หมายเหตุ", "SO6700001 ช่างรองโตโยต้าระยองMR0DA8CB605903316"]
    line = next(r for r in cells if r and r[0] == 1)
    assert line[:8] == [1, "01-B00-0015", "เหล็กแผ่นดำ 4มม.4x8ฟุต", "ST01", 2, "แผ่น", 3226, 6452]  # "01" → ST01
    rr_cells = [[c for c in row if c is not None] for row in wb[rr.doc_no].iter_rows(values_only=True)]
    assert rr_cells[1][:4] == ["ผู้จำหน่าย", "อ-092", "อ้างอิง (PO)", "PO6900012"]
    assert next(r for r in rr_cells if r and r[0] == 1)[3] == "ST05"
    aj_rows = [r for r in wb[aj.doc_no].iter_rows(values_only=True) if r[0] == 1]
    assert aj_rows[0][4:7] == (25, 22, -3)  # in the system (40 - OU 15), counted, difference
    new = [r[1] for r in wb[xo.NEW_SHEET].iter_rows(values_only=True) if isinstance(r[0], int)]
    assert new == ["RRS-A-033", "RRS-T-999-L"]
    # the store keys the documents in and writes the Express numbers in the summary sheet
    ws = wb[xo.SUMMARY_SHEET]
    head = next(i for i, r in enumerate(ws.iter_rows(values_only=True), start=1) if r[0] == "ลำดับ")
    ws.cell(head + 1, len(xo.SUMMARY_HEADERS)).value = "RR6900031"
    ws.cell(head + 2, len(xo.SUMMARY_HEADERS)).value = "PDMR6900077"
    wb.save(out)
    numbers = xo.read_express_numbers(out)
    assert numbers == {rr.doc_no: "RR6900031", pd.doc_no: "PDMR6900077"}
    assert xo.apply_express_numbers(ledger, numbers) == 2
    assert pd.express_no == "PDMR6900077" and all(m.express_no == "PDMR6900077" for m in ledger.movements
                                                   if m.doc_no == pd.doc_no)
    assert [d.doc_no for d in xo.pending_docs(ledger)] == [ou.doc_no, aj.doc_no, fr.doc_no]
