"""สต็อกเหล็ก: the steel register (size, thickness, material) with the balance of the stock, and the laser sheets."""

from conftest import SAMPLES

from partlist_studio.core import laser, nesting, steel
from partlist_studio.core.stock import StockItem, item_size_mm

REGISTER = SAMPLES / "steel_stock_sample.xlsx"


def test_register_columns_are_read():
    stock = steel.read_register(REGISTER)
    assert len(stock.items) == 11 and not stock.has_quantities  # no balances in the file
    plate = next(i for i in stock.items if i.code == "01-B00 -0104")
    assert (plate.material, plate.spec, item_size_mm(plate)) == ("STEEL", "3", (1219.2, 2530))
    assert plate.extra["item_kind"] == "วัตถุดิบ" and plate.is_sheet
    fb = next(i for i in stock.items if i.code.startswith("01-FB0"))
    assert steel.form_of(fb) == steel.FORM_BAR and not fb.is_sheet
    # a name in feet after a full stop: 'มม.4*8'
    assert item_size_mm(StockItem(name="แผ่นอลูมิเนียมหนา 6 มม.4*8")) == (1219.2, 2438.4)


def test_lines_weight_reservation_and_status():
    stock = steel.read_register(REGISTER)
    stock.items.append(StockItem(code="RRS-A-021-80", name="เหล็กฉากฝาข้าง 80", unit="ชิ้น", on_hand=8))  # a part
    plate = next(i for i in stock.items if i.code == "01-B00 -0103")
    plate.on_hand, plate.min_qty = 5, 3
    prog = laser.CutProgram(no="LC-1", material="SS400", family="STEEL", thickness=3, sheet_w=1219, sheet_h=2440,
                            sheet_code="01-B00 -0103", repeat=4, cut_sheets=1)
    done = laser.CutProgram(no="LC-0", material="SS400", family="STEEL", thickness=3, sheet_w=1219, sheet_h=2440,
                            sheet_code="01-B00 -0103", repeat=9, status=laser.ST_DONE)
    lines = steel.steel_lines(stock, [prog, done])
    assert "RRS-A-021-80" not in [s.item.code for s in lines]  # a finished part is not steel stock
    assert lines[0].form == steel.FORM_SHEET and lines[-1].form == steel.FORM_BAR  # plates first
    line = next(s for s in lines if s.item is plate)
    assert line.kg_each == round(1219 * 2440 * 3 * 7.85e-6, 2) and line.kg_total == round(line.kg_each * 5, 1)
    assert (line.reserved, line.after, line.status) == (3, 2, steel.ST_LOW)  # 3 sheets still to cut, Min 3
    plate.on_hand = 2  # the queue still needs 3
    assert next(s for s in steel.steel_lines(stock, [prog]) if s.item is plate).status == steel.ST_SHORT
    unknown = steel.steel_lines(stock, [], origin={id(i): ("สต็อกเหล็ก: x", False) for i in stock.items})
    sus = next(s for s in unknown if s.family == "SUS")
    assert sus.status == steel.ST_NO_BALANCE and steel.rows([sus])[0][7] == ""  # no balance shown as 0
    assert "แผ่น 9" in steel.summary(lines)


def test_laser_sheet_per_stock_item():
    stock = steel.read_register(REGISTER)
    options = nesting.group_options(stock, "STEEL", 3)
    codes = [o[2] for o in options]
    assert codes == ["01-B00 -0103", "01-B00 -0104", "01-B00 -0105", "07-B00 -0101"]  # checker plate last
    assert nesting.is_special(options[-1]) and not nesting.is_special(options[0])
    square = [(0.0, 0.0), (400.0, 0.0), (400.0, 300.0), (0.0, 300.0)]
    part = nesting.NestPart("j", "RRS-T-019", "ฝาข้าง", "SS400", 3, 400, 300, 12, outline=[square])
    [auto] = nesting.plan([part], stock)
    assert not auto.chosen and not nesting.is_special((0, 0, auto.sheet_code, auto.sheet_name))
    assert len(auto.options) == 4
    # picked by code: the checker plate of the same size as 01-B00 -0103 can still be chosen by hand
    [picked] = nesting.plan([part], stock, chosen={auto.key: (1219.2, 2438.4, "07-B00 -0101")})
    assert picked.chosen and picked.sheet_code == "07-B00 -0101"
    [by_size] = nesting.plan([part], stock, chosen={auto.key: (1524, 3050)})  # an older choice: size only
    assert by_size.sheet_code == "01-B00 -0105"
