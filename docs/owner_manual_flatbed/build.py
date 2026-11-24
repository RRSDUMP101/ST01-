"""คู่มือการใช้งาน (Owner Manual) – กระบะพื้นเรียบคาร์โก้ RRS สำหรับ Ford Ranger Super Duty.

Section order and depth follow a carmaker's owner manual for a 3-way-opening cargo bed (photos sent by RRS,
21 Nov 2026): warranty, conversion components, safe driving, dimensions and weight, tailgate, side gates, tailgate
latch adjustment, removing and installing parts, plus loading, care and service-centre data. All wording,
values and drawings are RRS's own; RRS facts come from docs/FORD_SUPER_DUTY_INSTALL.md (flatbed model, part names,
bolt sizes, the 13-step assembly order and the Ford BEMM rules). python3 build.py && node pdf.js
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warranty_booklet"))
from common import *  # noqa: E402,F403
import drawings as D  # noqa: E402
import model as M  # noqa: E402
P = M.PT

set_footer("คู่มือการใช้งาน · กระบะพื้นเรียบคาร์โก้ RRS · Ford Ranger Super Duty")
B = "____"
ALL = ("Single Cab",)


def band(th, en):
    return f'<div class="sband"><b>{th}</b><span>{en}</span></div>'


def h3(th, en):
    return f'<h3>{th} <span class="en">({en})</span></h3>'


def h4(th, en):
    return f'<h4 class="sub">{th} <span class="en">({en})</span></h4>'


def forcab(*cabs):
    cabs = cabs or ALL
    return '<p class="for"><b>สำหรับ (For):</b> ' + " · ".join(f"กระบะพื้นเรียบคาร์โก้ {c}" for c in cabs) + "</p>"


def para(th, en):
    return f'<p>{th}<span class="en-line">{en}</span></p>'


def steps(*items, start=1):
    return f'<ol class="msteps" start="{start}">' + "".join(f"<li>{t}<span class=\"en-line\">{e}</span></li>" for t, e in items) + "</ol>"


def bullets(*items):
    return '<ul class="terms">' + "".join(f"<li>{t}<span class=\"en-line\">{e}</span></li>" for t, e in items) + "</ul>"


def warn(*items, title="ข้อควรระวัง (Warning)"):
    return f'<div class="wbox"><div class="wt">⚠ {title}</div>' + bullets(*items) + "</div>"


def remark(*items):
    return '<div class="remark"><b>หมายเหตุ (Remark)</b>' + "".join(f"<p>{t}<span class=\"en-line\">{e}</span></p>" for t, e in items) + "</div>"


def fig(svg, cap="", k=""):
    return f'<div class="figbox {k}">{svg}' + (f'<p class="cap">{cap}</p>' if cap else "") + "</div>"


def figs(*items):
    return '<div class="figrow">' + "".join(fig(s, c) for s, c in items) + "</div>"


# ---------------------------------------------------------------- cover
raw('''<div class="cover"><div class="stripe"></div>
<img class="biglogo" src="logo.png">
<div class="ctitle"><small>OWNER MANUAL</small><h1>คู่มือการใช้งาน</h1>
<p>กระบะพื้นเรียบคาร์โก้ RRS เปิด 3 ทาง<br><span style="color:#1257C8">RRS Cargo Flatbed · 3-way opening</span></p>
<p class="cabs">Single Cab<br>สำหรับ Ford Ranger Super Duty</p></div>
<div class="coverfig">''' + M.view("iso") + '''</div>
<div class="cfoot"><span>รหัสคู่มือ (P/N) ____________</span><span>Serial No. กระบะ ____________</span></div></div>''', "nocrop")

# ---------------------------------------------------------------- contents
TOC = [
    ("", "วิธีใช้คู่มือเล่มนี้", "How to use this manual", 3),
    ("", "เงื่อนไขการรับประกัน", "Warranty conditions", 4), ("", "ส่วนประกอบเพิ่มเติม", "Conversion components", 6),
    ("", "รายละเอียดชิ้นส่วน", "Part details", 7),
    ("", "เพื่อการขับขี่อย่างปลอดภัย", "For safe driving", 8),
    ("1", "ขนาดและน้ำหนัก", "Dimensions and weight", 11), ("1.1", "ขนาด", "Dimensions", 11), ("1.2", "น้ำหนัก", "Weight", 12),
    ("2", "ฝาท้าย – การล็อก / ปลดล็อก และการเปิด / ปิด", "Tailgate – locking, unlocking, opening and closing", 13),
    ("2.1", "การล็อก / ปลดล็อกฝาท้าย", "Locking / unlocking the tailgate", 13),
    ("2.2", "การเปิด / ปิดฝาท้าย", "Opening / closing the tailgate", 14),
    ("3", "ฝาข้าง – การล็อก / ปลดล็อก และการเปิด / ปิด", "Side gate – locking, unlocking, opening and closing", 15),
    ("3.1", "การล็อก / ปลดล็อกฝาข้าง", "Locking / unlocking the side gate", 15), ("3.2", "การเปิด / ปิดฝาข้าง", "Opening / closing the side gate", 16),
    ("4", "การปรับตั้งกลอนล็อก", "Adjusting the latch", 17),
    ("5", "การถอด / ประกอบชิ้นส่วนของกระบะ", "Removing / installing body parts", 18),
    ("5.1", "ตะแกรงกันหัว", "Headboard", 18), ("5.2", "ฝาท้าย", "Tailgate", 19), ("5.3", "ฝาข้างขวา / ซ้าย", "Side gate RH / LH", 20),
    ("5.4", "บังโคลน", "Mudguard", 21), ("5.5", "คอกเสริม", "Add-on rack", 22),
    ("6", "การบรรทุกและการผูกรัดสินค้า", "Loading and tying down", 25),
    ("7", "การดูแลรักษาและค่าแรงขัน", "Care, maintenance and torque values", 26),
    ("8", "ข้อมูลสำหรับศูนย์บริการ", "Service-centre data", 27),
]
rows = "".join(f'<tr class="{"grp" if "." not in n else ""}"><td class="n">{n}</td><td>{t} <span class="en">({e})</span></td><td class="pg">{p}</td></tr>' for n, t, e, p in TOC)
page("สารบัญ (Index)", band("สารบัญ", "Index") + f'<table class="toc"><colgroup><col style="width:9%"><col style="width:81%"><col style="width:10%"></colgroup><tbody>{rows}</tbody></table>')

page("วิธีใช้คู่มือ (How to use this manual)", band("วิธีใช้คู่มือเล่มนี้", "How to use this manual") +
     para("คู่มือเล่มนี้อธิบายการใช้งาน การดูแล และการถอดประกอบชิ้นส่วนของกระบะพื้นเรียบคาร์โก้ RRS เปิด 3 ทาง (ฝาข้างซ้าย ฝาข้างขวา และฝาท้าย) ที่ติดตั้งบน Ford Ranger Super Duty โปรดอ่านให้เข้าใจก่อนใช้งาน และเก็บไว้ในรถพร้อมสมุดรับประกัน",
          "This manual explains how to use, look after and remove or install the parts of the RRS 3-way-opening cargo flatbed fitted to the Ford Ranger Super Duty. Read it before use and keep it in the vehicle with the warranty booklet.") +
     h3("รุ่นที่ใช้คู่มือเล่มนี้", "Models covered") +
     table(["รุ่นเก๋ง (Cab)", "ความยาวพื้นกระบะ (Floor length)", "การเปิด (Opening)"], [
         ["Single Cab", "2,669 มม. (กระบะ 2.60 ม.)", "เปิด 3 ทาง (3-way)"]], [30, 40, 30]) +
     h3("สัญลักษณ์ในคู่มือ", "Symbols used") +
     table(["สัญลักษณ์", "ความหมาย (Meaning)"], [
         ['<span class="wt-in">⚠ ข้อควรระวัง (Warning)</span>', "ข้อปฏิบัติที่ถ้าไม่ทำตาม อาจทำให้บาดเจ็บสาหัสหรือเสียชีวิต หรือกระบะเสียหาย<span class=\"en-line\">Failure to follow it may cause serious injury, death or damage to the body.</span>"],
         ['<span class="rm-in">หมายเหตุ (Remark)</span>', "ข้อมูลเพิ่มเติม เช่น ค่าแรงขัน หรือน้ำหนักที่รับได้<span class=\"en-line\">Additional data such as torque values or load limits.</span>"],
         ['<span class="numdot">1</span>', "ลำดับขั้นตอน หรือลำดับการขันสลักในภาพ<span class=\"en-line\">Order of the steps, or the bolt tightening order in a drawing.</span>"]], [30, 70]) +
     para("ทิศทาง ซ้าย (LH) และ ขวา (RH) ในคู่มือนี้ มองจากท้ายรถไปทางหน้ารถ", "Left (LH) and right (RH) in this manual are as seen from the rear of the vehicle looking forward."))

# ---------------------------------------------------------------- warranty
page("เงื่อนไขการรับประกัน (Warranty conditions)", band("เงื่อนไขการรับประกัน", "Warranty conditions") +
     steps(("ชิ้นส่วนของกระบะได้รับการรับประกันนับตั้งแต่วันส่งมอบรถให้แก่ลูกค้า ตามวันที่ระบุในบัตรรับประกัน รายละเอียดและเงื่อนไขเพิ่มเติมเป็นไปตามสมุดรับประกันและการบำรุงรักษาของ RRS",
            "The body parts are covered from the vehicle delivery date shown on the warranty card. Further terms are as set out in the RRS Warranty and Maintenance Booklet."),
           ("การรับประกันครอบคลุมเฉพาะความบกพร่องอันเกิดจากวัสดุ ฝีมือการผลิต หรือการติดตั้งของ RRS โดย RRS รับผิดชอบทั้งค่าชิ้นส่วนและค่าแรง",
            "The warranty covers only defects in materials, workmanship or RRS installation, and covers both parts and labour."),
           ("ระยะเวลารับประกัน: โครงสร้างกระบะ 5 ปี · ฝาข้างและฝาท้าย 1 ปี · อุปกรณ์ประกอบ 1 ปี · คอเติมน้ำมันส่วนที่ RRS ย้ายหรือต่อ 2 ปี",
            "Warranty periods: body structure 5 years · side gates and tailgate 1 year · accessories 1 year · fuel filler parts moved or extended by RRS 2 years."),
           ("กรณีที่การรับประกันไม่มีผล แม้ยังอยู่ในระยะเวลารับประกัน", "Cases in which the warranty does not apply, even within the warranty period:")) +
     '<ol class="sublist">'
     '<li><b>4.1</b> ความเสียหายจากการใช้งานผิดวัตถุประสงค์ หรือไม่ปฏิบัติตามคำแนะนำในคู่มือเล่มนี้<span class="en-line">Damage from misuse or from not following the instructions in this manual.</span></li>'
     '<li><b>4.2</b> ความบกพร่องจากการดัดแปลง หรือการนำชิ้นส่วนไปซ่อมกับผู้ให้บริการที่ RRS ไม่ได้มอบหมาย<span class="en-line">Defects due to modification, or repair by a service provider not appointed by RRS.</span></li>'
     '<li><b>4.3</b> ความบกพร่องจากอุบัติเหตุ เหตุสุดวิสัย หรือภัยธรรมชาติ<span class="en-line">Defects due to accidents, force majeure or natural disasters.</span></li>'
     '<li><b>4.4</b> การบรรทุกเกิน 2,000 กก. หรือเกินพิกัดน้ำหนักรถรวมและน้ำหนักลงเพลาที่ Ford กำหนด<span class="en-line">Loads over 2,000 kg, or over the gross vehicle and axle load limits set by Ford.</span></li>'
     '<li><b>4.5</b> ความเสียหายของแชสซีส์และชิ้นส่วนเดิมของ Ford ซึ่งอยู่ในการรับประกันของ Ford<span class="en-line">Damage to the Ford chassis and original Ford parts, which are covered by Ford\'s warranty.</span></li></ol>')

page("เงื่อนไขการรับประกัน (Warranty conditions)", band("เงื่อนไขการรับประกัน", "Warranty conditions") +
     steps(("RRS ขอสงวนสิทธิ์ในการเปลี่ยนแปลงข้อกำหนดและเงื่อนไข โดยจะแจ้งให้ทราบล่วงหน้า", "RRS reserves the right to change these terms and conditions with prior notice."),
           ("เมื่อพบความผิดปกติ ให้หยุดใช้งานส่วนนั้น และแจ้ง RRS ภายใน 7 วันนับจากวันที่พบ พร้อมสมุดรับประกันและภาพถ่ายจุดที่เสียหาย",
            "If you find a fault, stop using that part and tell RRS within 7 days, with the warranty booklet and photos of the damage."),
           ("การเข้ารับการตรวจตามระยะที่กำหนดในหัวข้อ 7 เป็นเงื่อนไขของการรับประกันโครงสร้าง 5 ปี", "The periodic checks in section 7 are a condition of the 5-year structure warranty."), start=5) +
     h3("ติดต่อ RRS", "Contact RRS") +
     '<div class="contact"><img src="logo.png"><div><b>บริษัท รุ่งเรืองกระบะดั้มพ์ 101</b><br>โทรศัพท์ ____________________ · LINE ____________________<br>ที่อยู่ ____________________________________________</div></div>')

# ---------------------------------------------------------------- components
parts = [("1", "ตะแกรงกันหัว", "Headboard"), ("2", "ฝาข้างขวา / ซ้าย", "Side gate RH / LH"), ("3", "ฝาท้าย", "Tailgate"),
         ("4", "บานพับฝาข้าง (ข้างละ 3 จุด)", "Side gate hinges (3 per side)"), ("4", "กลอนล็อกฝา (มือจับ)", "Gate latch (handle)"),
         ("5", "ตะขอผ้าใบ / จุดผูกรัด", "Rope hooks / tie-down points"), ("6", "โรบาร์หลัง ไฟท้าย ป้ายทะเบียน", "Rear bar, tail lamps, number plate"),
         ("7", "บังโคลน", "Mudguard"), ("8", "แท่นยึดและขาเต้า (ยึดกับแชสซีส์)", "Mounting brackets (to the chassis)")]
page("ส่วนประกอบเพิ่มเติม (Conversion components)", band("ส่วนประกอบเพิ่มเติม", "Conversion components") + forcab() + M.view("iso", [("n", P["headboard"], 1, -130, -20), ("n", P["side_gate"], 2, -40, 120), ("n", P["tailgate"], 3, 110, 40),
                        ("n", P["hinge_sg"][2], 4, 0, 110), ("n", P["lever_rh"], 5, 100, -40), ("n", P["tiedown"][4], 6, 60, -120),
                        ("n", P["lamp_rh"], 7, 120, 30), ("n", P["mudguard"], 8, -30, 110), ("n", P["mount"], 9, -110, 90)], cls="m") +
     table(["#", "ชิ้นส่วน", "Part"], [[f'<span class="numdot">{n}</span>', t, f'<span class="en">{e}</span>'] for n, t, e in parts], [8, 50, 42], "plist"))

# ---------------------------------------------------------------- part details and how it is made (2D line art traced from RRS assembly footage, Nov 2026)
page("รายละเอียดชิ้นส่วน (Part details)", band("รายละเอียดชิ้นส่วน", "Part details") + forcab() +
     para("ภาพลายเส้นจากแบบ 3D ของกระบะ แสดงชิ้นส่วนที่อ้างถึงในคู่มือเล่มนี้ หมายเลขตรงกับตารางหน้าส่วนประกอบเพิ่มเติม",
          "Line drawings from the 3D model of the body, showing the parts this manual refers to. Numbers match the conversion-components table.") +
     M.view("iso", [("c", P["floor"], 55), ("n", P["floor"], 1, -90, -60), ("c", P["hinge_sg"][1], 30), ("n", P["hinge_sg"][1], 4, -60, 70),
                     ("c", P["lamp_rh"], 38), ("n", P["lamp_rh"], 7, 70, 60), ("c", P["headboard"], 70), ("n", P["headboard"], 2, -110, -40)], cls="h") +
     M.row(M.view("z_hinge_sg", cap="④ บานพับฝาข้าง (Side gate hinges)", cls="box"), M.view("z_hinge_tg", cap="⑦ ไฟท้าย และบานพับฝาท้าย (Lamps, tailgate hinges)", cls="box")) +
     table(["#", "ชิ้นส่วน (Part)", "ผู้ใช้ควรรู้ (What it means for you)"], [
         ['<span class="numdot">1</span>', "พื้นแผ่นเหล็ก 3 แผ่น ยึดกับคานขวาง<span class=\"en-line\">Three steel floor plates on cross members</span>",
          "ห้ามเจาะหรือเชื่อมเพิ่ม วางของหนักบนแนวคานขวาง<span class=\"en-line\">Do not drill or weld; set heavy loads over the cross members</span>"],
         ['<span class="numdot">4</span>', "บานพับฝาแบบแผ่นยึดที่ขอบพื้น<span class=\"en-line\">Plate hinges on the floor edge</span>",
          "จุดหล่อลื่นประจำเดือน (ดูหัวข้อ 7)<span class=\"en-line\">Monthly lubrication point (see 7)</span>"],
         ['<span class="numdot">7</span>', "กล่องไฟท้ายที่มุมกระบะ<span class=\"en-line\">Tail-lamp housing at the body corner</span>",
          "ห้ามใช้เป็นที่เหยียบ หรือผูกเชือก<span class=\"en-line\">Do not step on it or tie ropes to it</span>"],
         ['<span class="numdot">2</span>', "ตะแกรงกันหัวแผ่นเจาะรูหกเหลี่ยม<span class=\"en-line\">Headboard with hexagon-perforated panel</span>",
          "กันสินค้าเลื่อนเข้าหาเก๋ง ไม่ใช่จุดผูกรัดหลัก (ดูหัวข้อ 6)<span class=\"en-line\">Stops load moving forward; not a main tie-down point (see 6)</span>"]], [7, 43, 50], "plist"))

# ---------------------------------------------------------------- safe driving
page("เพื่อการขับขี่อย่างปลอดภัย (For safe driving)", band("เพื่อการขับขี่อย่างปลอดภัย", "For safe driving") +
     warn(("ห้ามขับรถขณะฝาท้ายหรือฝาข้างเปิดอยู่", "Do not drive with the tailgate or a side gate open."),
          ("ห้ามยืน นั่ง หรือโดยสารบนฝาท้ายที่เปิดอยู่ และบนพื้นกระบะ", "Do not stand, sit or ride on an open tailgate or on the bed."),
          ("การขับรถขณะฝาเปิด ทำให้ฝาแกว่งกระแทกบุคคลหรือรถคันอื่น เป็นเหตุให้บาดเจ็บหรือเสียชีวิตได้", "Driving with a gate open lets it swing and strike people or other vehicles, causing injury or death."),
          ("ก่อนเปิด / ปิดฝาท้ายหรือฝาข้าง และก่อนขนย้ายสิ่งของ ตรวจสภาพสินค้าบนพื้นกระบะ และพื้นที่รอบรถให้มีระยะเพียงพอต่อการทำงานอย่างปลอดภัย",
           "Before opening or closing a gate, and before moving the load, check the load on the bed and that there is enough room around the vehicle to work safely."),
          ("ตรวจบริเวณโดยรอบให้ปลอดภัย และระวังอย่าให้ฝาท้ายหรือฝาข้างหนีบนิ้วมือ", "Check the surroundings and keep fingers clear of the tailgate and side gates."),
          title="ข้อควรระวัง – ขณะขับขี่ (Warning – while driving)"))

page("เพื่อการขับขี่อย่างปลอดภัย (For safe driving)", band("เพื่อการขับขี่อย่างปลอดภัย", "For safe driving") +
     warn(("ห้ามให้เด็กเปิดหรือปิดฝาท้ายและฝาข้าง ฝาอาจหนีบมือ ศีรษะ แขน หรือคอของเด็ก เป็นเหตุให้บาดเจ็บสาหัสหรือเสียชีวิตได้",
           "Do not let children open or close the tailgate or side gates; a gate may pinch a child's hands, head, arms or neck, causing serious injury or death."),) +
     M.view("iso", [("c", P["lever_rh"], 45), ("c", P["hinge_tg"][2], 40), ("c", P["hinge_sg"][2], 40), ("c", (1270, 300, -930), 45)],
            "จุดที่อาจหนีบมือ: มุมฝา มือจับกลอน และบานพับ (Pinch points: gate corners, latch handles, hinges)", "m"))

page("เพื่อการขับขี่อย่างปลอดภัย (For safe driving)", band("เพื่อการขับขี่อย่างปลอดภัย", "For safe driving") +
     warn(("ตรวจการล็อกของมือจับกลอนทุกจุดให้สมบูรณ์ หากล็อกไม่สนิท ฝาอาจเปิดออกขณะขับรถ และเกิดอุบัติเหตุได้",
           "Check that every latch handle is fully locked. If not, a gate may open while driving and cause an accident.")) +
     M.row(M.view("z_lever", [("c", P["lever_rh"], 90)], "ลักษณะมือจับที่ล็อกสมบูรณ์ (Locked)", "box h"), M.view("z_lever_open", [("c", (1320, 236, 1093), 90)], "ลักษณะมือจับที่ไม่ได้ล็อก (Not locked)", "box h")) +
     warn(("ฝาท้ายที่เปิดไว้จะบังไฟท้ายและป้ายทะเบียน รถที่ตามมาจะมองไม่เห็นและอาจเกิดอุบัติเหตุ ก่อนขับรถ ตรวจให้แน่ใจว่าฝาท้ายปิดและล็อกแน่นหนาแล้ว",
           "An open tailgate hides the tail lamps and number plate from drivers behind and may cause an accident. Make sure the tailgate is closed and firmly locked before driving.")) +
     M.view("tg180", [("c", P["lamp_rh"], 60), ("c", P["lamp_lh"], 60), ("c", P["plate"], 55)], cls="h2"))

# ---------------------------------------------------------------- 1 dimensions
page("1. ขนาดและน้ำหนัก (Dimensions and weight)", band("1. ขนาดและน้ำหนัก", "Dimensions and weight") + h3("1.1 ขนาด", "Dimensions") + forcab("Single Cab") +
     M.view("top", [("t", (-65, 17, 0), "2,669 มม.", 0, 0), ("t", (-1300, 17, 0), "1,874 มม.", 0, 0)], "กระบะพื้นเรียบคาร์โก้ Single Cab – มองจากด้านบน (top view) จากแบบ 3D", "xxs") +
     table(["รายการ (Item)", "ค่า (Value)"], [["ความยาวพื้น × ความกว้างพื้น (Floor L × W)", "2,669 × 1,874 มม."], ["ความกว้างโครงหลัก (Main frame width)", "1,962 มม."],
                                             ["ความยาวรวม (Overall length)", "2,801 มม."], ["ความสูงฝาข้าง (Side gate height)", f"{B} มม."]], [60, 40]))

page("1. ขนาดและน้ำหนัก (Dimensions and weight)", band("1. ขนาดและน้ำหนัก", "Dimensions and weight") + forcab() +
     M.view("side", [], "กระบะพื้นเรียบคาร์โก้ Single Cab – มองจากด้านข้าง (side view) จากแบบ 3D", "m") +
     h3("1.2 น้ำหนัก", "Weight") +
     table(["รุ่น (Model)", "น้ำหนักกระบะ (Body weight)", "น้ำหนักบรรทุกสูงสุด (Max. payload)"], [
         ["กระบะพื้นเรียบคาร์โก้ Single Cab", f"{B} กก.", "2,000 กก."]], [44, 28, 28]) +
     remark(("น้ำหนักบรรทุกที่ใช้ได้จริงของรถแต่ละคันอาจต่ำกว่า 2,000 กก. ตามน้ำหนักรถที่ชั่งจริง ดูบัตรรับประกัน", "The actual payload of each vehicle may be below 2,000 kg depending on its weighed mass; see the warranty card.")))

# ---------------------------------------------------------------- 2 tailgate
page("2. ฝาท้าย (Tailgate)", band("2. ฝาท้ายกระบะ สามารถล็อก / ปลดล็อก และเปิด / ปิดได้โดยปฏิบัติตามขั้นตอนต่อไปนี้", "The tailgate can be locked / unlocked and opened / closed by the following procedures") + forcab() +
     h3("2.1 การล็อก / ปลดล็อกฝาท้าย", "Locking / unlocking the tailgate") +
     h4("2.1.1 การล็อก", "Locking") +
     steps(("ยกฝาท้ายขึ้นจนชิดเสามุมหลังทั้งสองข้าง", "Raise the tailgate until it rests against both rear corner posts."),
           ("ยกมือจับขึ้น แล้วดึงมือจับผ่านตะขอออกไปทางด้านนอกตัวรถ ทั้งฝั่งซ้ายและฝั่งขวา", "Lift the handle and move it over the hook toward the outside of the vehicle, left and right."),
           ("กดมือจับลงจนแนบกับฝา", "Press the handle down until it sits flat against the gate.")) +
     M.row(M.view("z_lever_open", [('a', (1320, 236, 1093), (1320, 140, 975))], "การล็อก (Locking): ดันมือจับกลับเข้าแนบฝา", "box h"), M.view("z_lever", [('a', (1320, 135, 961), (1320, 236, 1093))], "การปลดล็อก (Unlocking): ดึงปลายมือจับออก", "box h")) +
     h4("2.1.2 การปลดล็อก", "Unlocking") +
     steps(("จับฝาท้ายไว้ด้วยมือข้างหนึ่ง", "Hold the tailgate with one hand."),
           ("ยกมือจับขึ้น แล้วดันมือจับผ่านตะขอเข้าหาตัวรถ ทั้งฝั่งซ้ายและฝั่งขวา", "Lift the handle and move it over the hook toward the centre of the vehicle, left and right.")) +
     "")

page("2. ฝาท้าย (Tailgate)", band("2. ฝาท้าย", "Tailgate") + forcab() + h3("2.2 การเปิด / ปิดฝาท้าย", "Opening / closing the tailgate") +
     M.row(M.view("tg180", [("a", (1273, 330, 300), (1330, -250, 300))], "เปิด (Open)", "m"), M.view("iso", [("c", P["tailgate"], 120)], "ปิด (Close)", "m")) +
     steps(("ปลดล็อกตามหัวข้อ 2.1.2 โดยจับฝาท้ายไว้ที่ขอบบน", "Unlock as in 2.1.2 while holding the tailgate by its top edge."),
           ("ค่อย ๆ ลดฝาท้ายลงจนห้อยแนบท้ายกระบะ", "Lower the tailgate gently until it hangs against the rear of the body."),
           ("การปิด: ยกฝาขึ้นจนชิดเสามุมทั้งสองข้าง แล้วล็อกตามหัวข้อ 2.1.1", "To close: raise the gate against both corner posts, then lock as in 2.1.1.")) +
     warn(("ฝาท้ายไม่มีสลิงรั้ง เมื่อปลดล็อกฝาจะเปิดลงจนห้อยทันที จับฝาไว้ตลอด และอย่าปล่อยให้ฝาตกกระแทก", "The tailgate has no stays: once unlocked it swings straight down. Hold it all the way and never let it drop."),
          ("ขณะเปิดฝาท้าย ระวังฝาแกว่งกระแทกผู้ใช้งาน", "Take care the gate does not swing and strike you while opening it."),
          ("ห้ามขับรถขณะฝาท้ายเปิด ฝาบังไฟท้ายและป้ายทะเบียน", "Do not drive with the tailgate open; it hides the tail lamps and number plate.")) +
     remark(("ห้ามนั่ง ยืน หรือวางสิ่งของบนฝาท้ายที่เปิดอยู่", "Do not sit, stand or put loads on the open tailgate.")))

# ---------------------------------------------------------------- 3 side gates
page("3. ฝาข้าง (Side gate)", band("3. ฝาข้างกระบะ สามารถล็อก / ปลดล็อก และเปิด / ปิดได้โดยปฏิบัติตามขั้นตอนต่อไปนี้", "The side gate can be locked / unlocked and opened / closed by the following procedures") + forcab() +
     h3("3.1 การล็อก / ปลดล็อกฝาข้าง", "Locking / unlocking the side gate") +
     h4("3.1.1 การล็อก", "Locking") +
     steps(("ยกฝาข้างขึ้นจนชิดเสามุมหน้าและเสามุมหลัง", "Raise the side gate against the front and rear corner posts."),
           ("ยกมือจับขึ้น แล้วดึงมือจับผ่านตะขอไปทางหน้ารถ (กลอนหน้า) หรือทางท้ายรถ (กลอนหลัง)", "Lift each handle and move it over the hook toward the front (front latch) or the rear (rear latch)."),
           ("กดมือจับลงจนแนบกับฝา และตรวจว่าฝาไม่โยก", "Press each handle down flat and check that the gate does not rattle.")) +
     h4("3.1.2 การปลดล็อก", "Unlocking") +
     steps(("จับฝาข้างไว้ที่ขอบบน", "Hold the side gate by its top edge."),
           ("ยกมือจับขึ้น แล้วดันผ่านตะขอไปทางตรงข้ามกับการล็อก ทั้งกลอนหน้าและกลอนหลัง", "Lift each handle and move it over the hook the opposite way to locking, front and rear latch.")) +
     M.row(M.view("z_lever", [("c", P["lever_rh"], 90)], "ล็อก (locked)", "box h"), M.view("z_lever_open", [("c", (1320, 236, 1093), 90)], "ปลดล็อก (unlocked)", "box h")))

page("3. ฝาข้าง (Side gate)", band("3. ฝาข้าง", "Side gate") + forcab() + h3("3.2 การเปิด / ปิดฝาข้าง", "Opening / closing the side gate") +
     M.row(M.view("sg90", [("a", (0, 300, 982), (0, 30, 1260))], "เปิด (Open)"), M.view("iso", [("c", P["side_gate"], 150)], "ปิด (Close)")) +
     steps(("ปลดล็อกฝาท้าย หากกลอนหลังของฝาข้างอยู่ด้านในฝาท้าย", "Unlock the tailgate if the rear latch of the side gate is behind it."),
           ("ปลดล็อกฝาข้างตามหัวข้อ 3.1.2 แล้วค่อย ๆ ลดฝาลงจนห้อยข้างกระบะ", "Unlock the side gate as in 3.1.2 and lower it gently until it hangs beside the body."),
           ("การปิด: ยกฝาข้างขึ้น ล็อกตามหัวข้อ 3.1.1 แล้วจึงปิดและล็อกฝาท้าย", "To close: raise the side gate, lock it as in 3.1.1, then close and lock the tailgate.")) +
     warn(("ฝาข้างมีน้ำหนักมาก จับที่ขอบบนของฝา ยืนพ้นรัศมีการเปิด และอย่าปล่อยให้ฝาตกกระแทก", "The side gate is heavy: hold it by the top edge, stand clear of its swing and never let it drop."),
          ("ห้ามขับรถขณะฝาข้างเปิดหรือห้อยอยู่", "Never drive with a side gate open or hanging.")))

# ---------------------------------------------------------------- 4 adjust
page("4. การปรับตั้งกลอนล็อก (Adjusting the latch)", band("4. ขั้นตอนการปรับตั้งมือจับ", "How to adjust the handle") + forcab() +
     para("เมื่อล็อกมือจับแล้วรู้สึกว่าแน่นเกินไป หรือหลวมเกินไป ปรับตั้งได้ที่ตะขอบนเสามุม ดังนี้", "If a handle feels too tight or too loose when locked, adjust the hook on the corner post as follows.") +
     M.view("z_lever", [("c", (1265, 265, 955), 70), ("n", (1265, 265, 955), 1, -170, -60)], "หูล็อก ❶ และมือจับบนเสามุม (Keeper and handle on the corner post) – จากแบบ 3D", "box t") +
     steps(("ปลดล็อกมือจับที่ต้องการปรับ", "Unlock the handle to be adjusted."),
           (f"คลายน็อตล็อกของตะขอ ด้วยประแจแหวนหรือบล็อกเบอร์ {B}", f"Loosen the hook's lock nut with a {B} mm ring spanner or socket."),
           ("มือจับแน่นเกินไป: หมุนตะขอทวนเข็มนาฬิกา (คลายออก) · หลวมเกินไป: หมุนตามเข็มนาฬิกา (ขันเข้า) ครั้งละครึ่งรอบ", "Too tight: turn the hook counter-clockwise (out) · Too loose: turn it clockwise (in), half a turn at a time."),
           ("ลองล็อกจนมือจับกดลงได้ด้วยแรงมือพอดี และฝาไม่โยก", "Try the latch until the handle presses down with firm hand pressure and the gate does not rattle."),
           ("ขันน็อตล็อกให้แน่น แล้วลองล็อกและปลดล็อกอีกครั้ง", "Tighten the lock nut, then lock and unlock once more to check.")) +
     warn(("หากปรับแล้วยังล็อกไม่สนิท ตะขอคด หรือเกลียวเสีย ให้หยุดใช้งานฝานั้นและติดต่อ RRS", "If the latch still does not lock fully, or the hook is bent or the thread damaged, stop using that gate and contact RRS.")))

# ---------------------------------------------------------------- 5 removal
page("5. การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", band("5. ขั้นตอนการถอด / ประกอบชิ้นส่วนของกระบะ", "Replacing body parts – procedures") + forcab() +
     warn(("การถอดและประกอบตะแกรงกันหัว ฝาท้าย และฝาข้าง ต้องใช้ผู้ปฏิบัติงานอย่างน้อย 2 คน ชิ้นส่วนมีน้ำหนักมาก อาจตกทับทำให้บาดเจ็บได้",
           "Removing and installing the headboard, tailgate and side gates needs at least 2 people; the parts are heavy and can cause injury if dropped."),
          ("ใช้สลัก น็อต และแหวนของ RRS ขนาดและเกรดเดิมเท่านั้น และขันตามแรงขันในหัวข้อ 7", "Use RRS bolts, nuts and washers of the original size and grade only, and tighten to the values in section 7.")) +
     h3("5.1 การถอด / ประกอบตะแกรงกันหัว โดยการคลาย / ขันสลัก 8 จุด ตามลำดับในรูป", "Removing / installing the headboard by loosening / tightening 8 bolts in the order shown") +
     '<div class="side2">' + M.view("z_head", [("n", (-1378, 355, -702), 1, 0, 55), ("n", (-1378, 811, 448), 2, 0, -55), ("n", (-1378, 355, 702), 3, 0, 55), ("n", (-1378, 811, -448), 4, 0, -55), ("n", (-1378, 355, -90), 5, 0, 55), ("n", (-1378, 811, 91), 6, 0, -55), ("n", (-1378, 355, 90), 7, 0, 55), ("n", (-1378, 811, -91), 8, 0, -55)], "ตะแกรงกันหัว – ลำดับสลัก ❶–❽ (Headboard bolt order)") + '<div>' + steps(("เปิดฝาข้างทั้งสองข้าง เพื่อให้เข้าถึงสลักที่เสามุมหน้า", "Open both side gates to reach the bolts at the front corner posts."),
           ("ผู้ช่วยจับตะแกรงไว้ แล้วคลายสลักตามลำดับ ❽ → ❶ (ย้อนลำดับการขัน)", "With a helper holding the headboard, loosen the bolts in the order ❽ → ❶ (reverse of tightening)."),
           ("ยกตะแกรงขึ้นตรง ๆ ระวังอย่าให้กระแทกกระจกหลังเก๋ง", "Lift the headboard straight up, taking care not to strike the cab rear window."),
           ("การประกอบ: วางตะแกรงตั้งฉากกับพื้น ใส่สลักทุกตัวด้วยมือ ขันตามลำดับ ❶ → ❽ แล้วตรวจว่าตะแกรงไม่แตะเก๋ง", "To install: stand it square, start every bolt by hand, tighten in the order ❶ → ❽, then check it does not touch the cab.")) + '</div></div>' +
     remark(("สลักตะแกรงกันหัว: M8 / M6 และ M12×100 ที่เขาบน · แรงขันดูหัวข้อ 7", "Headboard bolts: M8 / M6 and M12×100 at the top horns · torque: see section 7.")))

page("5. การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", band("5. ขั้นตอนการถอด / ประกอบชิ้นส่วนของกระบะ", "Replacing body parts – procedures") + forcab() +
     h3("5.2 การถอด / ประกอบฝาท้าย โดยการคลาย / ขันสลักบานพับ 3 จุด ตามลำดับในรูป", "Removing / installing the tailgate by loosening / tightening the bolts of 3 hinges in the order shown") +
     M.view("z_hinge_tg", [("c", P["hinge_tg"][0], 45), ("n", P["hinge_tg"][0], 1, 0, -80), ("c", P["hinge_tg"][2], 45), ("n", P["hinge_tg"][2], 2, 0, -80), ("c", P["hinge_tg"][1], 45), ("n", P["hinge_tg"][1], 3, 0, -80)], "บานพับฝาท้าย 3 จุด ลำดับการขัน ❶–❸ (บานพับละ 2 สลัก)") +
     steps(("ปลดล็อกฝาท้าย และให้ผู้ช่วยจับฝาไว้ในแนวราบ", "Unlock the tailgate and have a helper hold it level."),
           ("คลายสลักบานพับตามลำดับ ❸ → ❶", "With a helper holding the tailgate level, loosen the hinge bolts in the order ❸ → ❶."),
           ("ยกฝาท้ายออกจากรางพับ และวางบนพื้นเรียบที่มีวัสดุรองกันรอย", "Lift the tailgate off the folding rail and lay it on a padded, level surface."),
           ("การประกอบ: วางฝาบนรางพับ ใส่สลัก น็อต และแหวนด้วยมือก่อน แล้วขันตามลำดับ ❶ → ❸", "To install: set the gate on the folding rail, start the bolts, nuts and washers by hand, then tighten in the order ❶ → ❸."),
           ("ปิดฝา และตรวจว่ากลอนทั้งสองข้างล็อกสนิท", "Close the gate and check both latches lock fully.")) +
     remark(("สลักบานพับฝา: M12×65 / M12×60 พร้อมน็อต M12 และแหวน 12 · แรงขันดูหัวข้อ 7", "Gate hinge bolts: M12×65 / M12×60 with M12 nuts and 12 mm washers · torque: see section 7."),
            ("จำนวนสลักจริงตามรุ่นการผลิต ให้ RRS ยืนยัน", "Actual number of bolts depends on the production batch; to be confirmed by RRS.")))

page("5. การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", band("5. ขั้นตอนการถอด / ประกอบชิ้นส่วนของกระบะ", "Replacing body parts – procedures") + forcab("Single Cab") +
     h3("5.3 การถอด / ประกอบฝาข้างขวา / ซ้าย โดยการคลาย / ขันสลักบานพับ 3 จุด ตามลำดับในรูป", "Removing / installing the side gate RH / LH by loosening / tightening the bolts of 3 hinges in the order shown") +
     M.view("z_hinge_sg", [("c", P["hinge_sg"][0], 40), ("n", P["hinge_sg"][0], 1, 0, -75), ("c", P["hinge_sg"][2], 40), ("n", P["hinge_sg"][2], 2, 0, -75), ("c", P["hinge_sg"][1], 40), ("n", P["hinge_sg"][1], 3, 0, -75)], "บานพับฝาข้าง 3 จุด ห่างกัน 900 มม. ลำดับการขัน ❶–❸ (บานพับละ 2 สลัก)") +
     steps(("เปิดฝาท้ายตามหัวข้อ 2.2", "Open the tailgate as in 2.2."),
           ("ปลดล็อกฝาข้าง แล้วผู้ช่วย 1 คนจับฝาไว้ในแนวตั้ง", "Unlock the side gate and have a helper hold it upright."),
           ("คลายสลักบานพับตามลำดับ ❸ → ❶ โดยเหลือสลักบานพับกลางไว้หลวม ๆ จนถึงตัวสุดท้าย", "Loosen the hinge bolts in the order ❸ → ❶, leaving the middle hinge bolts loosely in place until last."),
           ("ยกฝาข้างออกจากรางพับพร้อมกันทั้งสองคน และวางบนพื้นเรียบที่มีวัสดุรอง", "Lift the side gate off the folding rail together and lay it on a padded, level surface."),
           ("การประกอบ: วางฝาบนรางพับ ใส่สลักทุกตัวด้วยมือก่อน แล้วขันตามลำดับ ❶ → ❸", "To install: set the gate on the folding rail, start every bolt by hand, then tighten in the order ❶ → ❸."),
           ("ปิดฝา ตรวจว่ากลอนหน้าและกลอนหลังล็อกสนิท และฝาไม่ชนเสามุม", "Close the gate, check the front and rear latches lock fully and the gate clears the corner posts.")) +
     remark(("ทำแบบเดียวกันทั้งฝาข้างขวาและซ้าย · แรงขันดูหัวข้อ 7", "Same procedure for the right and left side gates · torque: see section 7.")))

page("5. การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", band("5. ขั้นตอนการถอด / ประกอบชิ้นส่วนของกระบะ", "Replacing body parts – procedures") + forcab() +
     h3("5.4 การถอด / ประกอบบังโคลน ที่ขายึด", "Removing / installing the mudguard at its brackets") +
     M.view("z_mud", [("c", P["mudguard"], 75), ("c", P["mudguard2"], 75)], "บังโคลนและขายึด (Mudguard and bracket) – จากแบบ 3D", "s") +
     steps(("จอดรถบนพื้นเรียบ ดับเครื่องยนต์ และหนุนล้อ", "Park on level ground, stop the engine and chock the wheels."),
           ("คลายสลักขายึดบังโคลนทีละตัวแบบไขว้ ขณะจับบังโคลนไว้", "Loosen the mudguard bracket bolts crosswise while holding the mudguard."),
           ("ถอดบังโคลนออก ระวังสายไฟไฟท้ายและสายกล้องที่เดินใกล้ขายึด", "Remove the mudguard, taking care of the tail-lamp and camera wiring near the bracket."),
           ("การประกอบ: ใส่สลักด้วยมือก่อน ขันแบบไขว้ และตรวจระยะห่างระหว่างบังโคลนกับยางตามคู่มือ Ford", "To install: start the bolts by hand, tighten crosswise and check the mudguard-to-tyre clearance per the Ford manual.")))

# ---------------------------------------------------------------- 6.5 add-on rack (from the 3D model; video 1000008358 shows the body without it)
RK = 420  # rack lift in the exploded view (mm)
up = lambda p: (p[0], p[1] + RK, p[2])
page("5. การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", band("5. ขั้นตอนการถอด / ประกอบชิ้นส่วนของกระบะ", "Replacing body parts – procedures") + forcab("Single Cab") +
     h3("5.5 การถอด / ประกอบคอกเสริม", "Removing / installing the add-on rack") +
     para("คอกเสริมเป็นชุดผนังที่ติดบนขอบบนของฝาข้างและฝาท้าย เพื่อเพิ่มความสูงของกระบะ ถอดออกได้เมื่อต้องการใช้กระบะแบบฝาเตี้ย (ภาพหน้าถัดไป)",
          "The add-on rack is a set of walls mounted on the top rails of the side gates and tailgate to raise the body. It can be removed when a low-sided body is needed (see next page).") +
     M.view("rack_exploded", [("n", up(P["side_rack"]), 1, 40, -110), ("n", up((0, 470, -960)), 1, 0, -100), ("n", up((1252, 500, -400)), 2, 110, -40),
                              ("n", up((1130, 870, 300)), 3, 60, -70), ("c", P["latch_sg"][0], 26), ("n", P["latch_sg"][0], 4, 70, 50),
                              ("c", up((1275, 590, 940)), 26), ("n", up((1275, 590, 940)), 5, 80, 20), ("c", up((-1320, 560, 935)), 26), ("n", up((-1320, 560, 935)), 6, 30, -60)], cls="h2") +
     table(["#", "ชิ้นส่วน (Part)", "จำนวน (Qty)"], [
         ['<span class="numdot">1</span>', "คอกเสริมข้าง ขวา / ซ้าย<span class=\"en-line\">Side rack RH / LH</span>", "2"],
         ['<span class="numdot">2</span>', "คอกเสริมท้าย<span class=\"en-line\">Tail rack</span>", "1"],
         ['<span class="numdot">3</span>', "ราวท่อ<span class=\"en-line\">Pipe hoop</span>", "1"],
         ['<span class="numdot">4</span>', "สลัก M12×1.25 พร้อมแหวนและน็อต ยึดคอกกับขอบบนฝา (ข้างละ 3 · ท้าย 3)<span class=\"en-line\">M12×1.25 bolt, washer and nut, rack to gate top rail (3 per side · 3 at the rear)</span>", "9"],
         ['<span class="numdot">5</span>', "สลักเสียบพร้อมกิ๊บล็อก มุมหลัง (คอกข้าง – คอกท้าย)<span class=\"en-line\">Pin and R-clip, rear corners (side rack – tail rack)</span>", "2"],
         ['<span class="numdot">6</span>', "สลักเสียบพร้อมกิ๊บล็อก มุมหน้า (คอกข้าง – เสาตะแกรงกันหัว)<span class=\"en-line\">Pin and R-clip, front corners (side rack – headboard post)</span>", "2"]], [7, 78, 15], "plist"))

page("5. การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", band("5. ขั้นตอนการถอด / ประกอบชิ้นส่วนของกระบะ", "Replacing body parts – procedures") + forcab("Single Cab") +
     h3("5.5 (ต่อ) จุดยึดคอกเสริม", "(cont.) Rack fixing points") +
     warn(("การยกคอกเสริมต้องใช้ผู้ปฏิบัติงานอย่างน้อย 2 คนต่อชิ้น ยกขึ้นตรง ๆ และห้ามปีนหรือยืนบนขอบฝาขณะยก", "Lift each rack piece with at least 2 people, straight up; never climb or stand on the gate rails while lifting."),
          ("ห้ามขับรถขณะคอกเสริมยึดไม่ครบทุกจุด และห้ามผูกรัดสินค้ากับคอกเสริมหรือราวท่อแทนจุดผูกรัดบนพื้น", "Never drive with the rack partly fixed, and never tie the load to the rack or hoop instead of the floor tie-down points.")) +
     M.row(M.view("z_rack_bolt", [("c", P["latch_sg"][0], 40), ("n", P["latch_sg"][0], 4, -90, -60)], "④ สลักยึดคอกกับขอบบนฝา (Fixed)", "box l"),
           M.view("z_rack_bolt_x", [("a", P["latch_sg"][0], (1143, 440, 957))], "④ ถอดสลักออก แล้วยกคอกขึ้น (Bolt out, lift)", "box l"),
           M.view("z_rack_rear", [("c", (1275, 590, 940), 120)], "⑤ มุมหลัง: สลักเสียบ + กิ๊บล็อก (Rear corner pin and R-clip)", "box l"),
           M.view("z_rack_front", [("c", (-1320, 560, 935), 120)], "⑥ มุมหน้า: สลักเสียบ + กิ๊บล็อก (Front corner pin and R-clip)", "box l")) +
     M.view("norack", [], "กระบะเมื่อถอดคอกเสริมออก (Body without the rack)", "xxs"))

page("5. การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", band("5. ขั้นตอนการถอด / ประกอบชิ้นส่วนของกระบะ", "Replacing body parts – procedures") + forcab("Single Cab") +
     h4("5.5.1 การถอดคอกเสริม", "Removing the rack") +
     steps(("ปิดและล็อกฝาข้างและฝาท้ายทุกด้าน และนำสินค้าออกจากกระบะ", "Close and lock all gates and unload the body."),
           ("ถอดกิ๊บล็อกและดึงสลักเสียบที่มุมหลังทั้งสองข้าง ⑤ และมุมหน้าทั้งสองข้าง ⑥ เก็บกิ๊บไว้กับสลัก", "Remove the R-clips and pull the pins at both rear corners ⑤ and both front corners ⑥; keep each clip with its pin."),
           ("คลายและถอดสลักยึด ④ ของคอกเสริมท้าย 3 ตัว แล้วยกคอกเสริมท้ายพร้อมราวท่อขึ้นตรง ๆ", "Remove the 3 fixing bolts ④ of the tail rack, then lift the tail rack and the hoop straight up."),
           ("คลายและถอดสลักยึด ④ ของคอกเสริมข้างทีละด้าน ด้านละ 3 ตัว แล้วยกคอกขึ้นตรง ๆ", "Remove the 3 fixing bolts ④ of each side rack, one side at a time, and lift the rack straight up."),
           ("วางคอกบนพื้นเรียบที่มีวัสดุรอง ใส่สลัก แหวน และน็อตกลับเข้ารูที่ขอบฝา เพื่อไม่ให้หายและกันน้ำเข้ารู", "Lay the racks on a padded, level surface; refit the bolts, washers and nuts in the gate-rail holes so they are not lost and water stays out.")) +
     h4("5.5.2 การประกอบคอกเสริม", "Installing the rack") +
     steps(("วางคอกเสริมข้างบนขอบบนฝาข้าง ให้รูของแผ่นยึดตรงกับรูบนขอบฝา ใส่สลัก ④ ด้วยมือก่อนครบ 3 ตัว", "Set each side rack on the side-gate top rail with its tab holes on the rail holes and start all 3 bolts ④ by hand."),
           ("วางคอกเสริมท้ายพร้อมราวท่อ และใส่สลัก ④ ด้วยมือครบ 3 ตัว", "Set the tail rack with the hoop and start its 3 bolts ④ by hand."),
           ("ใส่สลักเสียบที่มุมหลัง ⑤ และมุมหน้า ⑥ แล้วใส่กิ๊บล็อกให้ครบทุกตัว", "Fit the pins at the rear ⑤ and front ⑥ corners and lock each with its R-clip."),
           ("ขันสลัก ④ ทุกตัวให้แน่นตามแรงขันในหัวข้อ 7 แล้วเปิด–ปิดฝาข้างและฝาท้ายเพื่อตรวจว่าไม่ติดขัด", "Tighten all bolts ④ to the torque in section 7, then open and close the gates to check nothing binds.")) +
     remark(("ภาพจากแบบ 3D ของกระบะ Single Cab · แรงขันสลักยึดคอก และน้ำหนักคอกแต่ละชิ้น ให้ RRS ยืนยัน", "From the Single Cab 3D model · rack bolt torque and the weight of each rack piece to be confirmed by RRS.")))

# ---------------------------------------------------------------- 6 loading
page("6. การบรรทุกและการผูกรัด (Loading and tying down)", band("6. การบรรทุกและการผูกรัดสินค้า", "Loading and tying down") + forcab() +
     M.view("top", [("n", (-1155, 17, 800), 1, -45, 0), ("n", (-1155, 17, -800), 2, 45, 0), ("n", (-519, 17, 800), 3, -45, 0), ("n", (-519, 17, -800), 4, 45, 0), ("n", (132, 17, 800), 5, -45, 0), ("n", (132, 17, -800), 6, 45, 0), ("n", (782, 17, 800), 7, -45, 0), ("n", (782, 17, -800), 8, 45, 0)], "จุดผูกรัด 8 จุดบนพื้นกระบะ (8 tie-down points)", "t2") +
     table(["ควรทำ (Do)", "ไม่ควรทำ (Don't)"], [
         ["กระจายน้ำหนักทั่วพื้น ให้ของหนักอยู่ด้านหน้าและกึ่งกลางกระบะ<br><span class=\"en\">Spread the load, heavy items forward and centred.</span>", "กองของหนักไว้จุดเดียว หรือไว้ท้ายสุดของกระบะ<br><span class=\"en\">Pile heavy items in one spot or at the very rear.</span>"],
         ["รัดสินค้ากับตะขอผ้าใบและจุดผูกรัดของโครง ดึงสายเฉียงลง<br><span class=\"en\">Tie the load to the rope hooks and frame points, pulling down at an angle.</span>", "รัดสินค้ากับฝาข้าง ฝาท้าย หรือตะแกรงกันหัว<br><span class=\"en\">Tie the load to the side gates, tailgate or headboard.</span>"],
         ["วางสินค้าลงพื้นอย่างนุ่มนวล ใช้ไม้รองเมื่อใช้รถยกหรือเครน<br><span class=\"en\">Set loads down gently; use timber with a forklift or crane.</span>", "ทิ้งหรือกระแทกสินค้าลงพื้นกระบะ<br><span class=\"en\">Drop or bang loads onto the floor.</span>"],
         ["ตรวจความแน่นของสายรัดหลังขับไปไม่กี่กิโลเมตร<br><span class=\"en\">Re-check the straps after the first few kilometres.</span>", "ต่อเสริมฝาข้างให้สูงขึ้นเพื่อบรรทุกเพิ่ม<br><span class=\"en\">Extend the side gates upward to carry more.</span>"]], [50, 50], "dodont") +
     warn(("น้ำหนักบรรทุกบนกระบะต้องไม่เกิน 2,000 กก. และน้ำหนักรถรวมต้องไม่เกิน GVM 4,500 กก. ของ Ford", "The load on the body must not exceed 2,000 kg and the gross vehicle mass must not exceed Ford's 4,500 kg GVM.")))

# ---------------------------------------------------------------- 7 care & torque
page("7. การดูแลรักษาและค่าแรงขัน (Care and torque values)", band("7. การดูแลรักษาและค่าแรงขัน", "Care, maintenance and torque values") + forcab() +
     table(["ระยะ (Interval)", "รายการ (Item)", "ผู้ทำ (By)"], [
         ["ก่อนใช้งานทุกวัน<br><span class=\"en\">Every day</span>", ["กลอนล็อกทุกจุดล็อกสนิท<span class=\"en-line\">All latches lock fully</span>", "ไฟท้ายทำงาน<span class=\"en-line\">Tail lamps work</span>", "สายรัดสินค้าแน่น<span class=\"en-line\">Load straps are tight</span>"], "ผู้ใช้รถ<br><span class=\"en\">Driver</span>"],
         ["ทุกเดือน<br><span class=\"en\">Monthly</span>", ["หล่อลื่นบานพับ รางพับ กลอนล็อก และตะขอ<span class=\"en-line\">Lubricate hinges, folding rails, latches and hooks</span>"] , "ผู้ใช้รถ<br><span class=\"en\">Driver</span>"],
         ["1 เดือน / 1,000 กม. แรก<br><span class=\"en\">First month / 1,000 km</span>", ["ตรวจแรงขันสลักแท่นยึดกับแชสซีส์ และสลักบานพับฝา<span class=\"en-line\">Check mounting and hinge bolt torque</span>"], "RRS"],
         ["ทุก 6 เดือน / 10,000 กม.<br><span class=\"en\">Every 6 months / 10,000 km</span>", ["แรงขันสลักทุกจุด · รอยร้าวที่โครง แท่นยึด ตะแกรงกันหัว · สายไฟ<span class=\"en-line\">All bolt torques · cracks in frame, mounts, headboard · wiring</span>"], "RRS"],
         ["หลังล้างรถ หรือบรรทุกวัสดุกัดกร่อน<br><span class=\"en\">After washing or corrosive loads</span>", ["ล้างคราบออก และหล่อลื่นบานพับซ้ำ<span class=\"en-line\">Rinse off and re-lubricate the hinges</span>"], "ผู้ใช้รถ<br><span class=\"en\">Driver</span>"]], [27, 55, 18], "care") +
     h3("ค่าแรงขันมาตรฐาน", "Installation torque") +
     table(["จุดขัน (Joint)", "สลัก (Bolt)", "แรงขัน (Torque)"], [
         ["แท่นยึดกระบะกับแชสซีส์ (Body to chassis)", "M12 เกรด 10.9 ขึ้นไป", "95–125 N·m (Ford BEMM)"],
         ["บานพับฝาข้าง / ฝาท้าย (Gate hinges)", "M12×65 / M12×60", f"{B} N·m"],
         ["ตะแกรงกันหัว – เขาบน (Headboard top horns)", "M12×100", f"{B} N·m"],
         ["ตะแกรงกันหัว – แผงตะแกรง (Headboard panel)", "M8 / M6", f"{B} N·m"],
         ["ขายึดบังโคลน (Mudguard bracket)", f"{B}", f"{B} N·m"], ["คอกเสริมกับขอบฝา (Add-on rack to gate rail)", "M12×1.25", f"{B} N·m"]], [46, 26, 28]))

# ---------------------------------------------------------------- 8 service data
page("8. ข้อมูลสำหรับศูนย์บริการ (Service-centre data)", band("8. ข้อมูลสำหรับศูนย์บริการ", "Service-centre data") +
     para("ข้อกำหนดการติดตั้งกระบะบน Ford Ranger Super Duty ที่ศูนย์บริการต้องรักษาไว้เมื่อถอดหรือประกอบกระบะ ตามลำดับงานของ RRS และคู่มือ Ford BEMM",
          "Installation requirements on the Ford Ranger Super Duty that a service centre must keep when removing or refitting the body, per the RRS work sequence and the Ford BEMM.") +
     table(["รายการ (Item)", "ข้อกำหนด (Requirement)"], [
         ["ช่องห่างหลังเก๋ง (Cab-to-body gap)", "ไม่น้อยกว่า 28 มม."],
         ["สลักแท่นยึด (Mounting bolts)", "M12 เกรด 10.9 ขึ้นไป ขัน 95–125 N·m · ใช้จุดยึดครบ · ห้ามเชื่อมแชสซีส์"],
         ["ความกว้างตัวถัง (Body width)", "ไม่เกิน 1,960 มม. (Single Cab, กระจกมาตรฐาน)"],
         ["คอเติมน้ำมัน (Fuel filler)", "มุมปากเติมไม่น้อยกว่า 30° · ปลายท่อหายใจสูงจากพื้นไม่น้อยกว่า 850 มม."],
         ["ไฟท้าย (Tail lamps)", "ขอบล่างโคมสูงจากพื้นไม่น้อยกว่า 500 มม. · ใช้ชุดไฟท้ายของ Ford"],
         ["บังโคลน (Mudguard)", "ระยะห่างจากยางตามคู่มือ Ford"]], [36, 64]) +
     h3("ลำดับการประกอบกระบะของ RRS", "RRS body assembly sequence") +
     table(["ขั้น", "งาน (Work)"], [
         ["1–4", "งานบนจิ๊ก: โครงตัวล่าง → โครงตัวบน → แผ่นพื้น → ชิ้นเชื่อมย่อย (ขาเต้า บานพับ ตะขอผ้าใบ ขาป้ายทะเบียน)"],
         ["5–6", "ยกขึ้นรถ: ตรวจแท่นยึดบนแชสซีส์ วางกระบะ และขันสลักแท่นยึด"],
         ["7–12", "งานบนรถ: ตะแกรงกันหัว → ฝาข้างและฝาท้าย → โรบาร์หลัง → บังโคลน → คอเติมน้ำมัน → กล่องหลัง ไฟท้าย ป้ายทะเบียน กล้องมองหลัง"],
         ["13", "ตรวจขั้นสุดท้าย: ขันซ้ำทุกจุด ชั่งน้ำหนัก ตรวจรหัสข้อผิดพลาดของรถ"]], [12, 88]))

# ---------------------------------------------------------------- back cover
raw('''<div class="back"><img src="logo_white.png"><h2>บริษัท รุ่งเรืองกระบะดั้มพ์ 101</h2>
<p>ที่อยู่ ______________________________________________<br>โทรศัพท์ ____________________ · LINE ____________________<br>อีเมล ____________________ · เว็บไซต์ rungruengdump101.com</p>
<small>คู่มือการใช้งาน กระบะพื้นเรียบคาร์โก้ RRS · Owner Manual – RRS Cargo Flatbed · P/N ____________</small></div>''', "nocrop")

save("booklet.html", "RRS Owner Manual – Cargo Flatbed", extra_css=M.CSS + '''
.en{color:#5b6577;font-weight:normal;font-size:.82em}.en-line{display:block;color:#5b6577;font-size:.86em;margin-top:.3mm}
.sband{background:#0B2A5B;color:#fff;padding:2.6mm 4mm;border-left:4mm solid #00B4F0;margin:0 0 2.5mm}.sband b{display:block;font-size:13pt;line-height:1.3}.sband span{display:block;font-size:9pt;color:#b9d2f5;margin-top:.5mm}
p.for{font-size:9pt;color:#1257C8;margin:0 0 2.5mm}p.for b{color:#0B2A5B}
h3{margin:3.2mm 0 1.6mm}h4.sub{color:#0B2A5B;font-size:10.5pt;margin:2.5mm 0 1mm}
ol.msteps{padding-left:6mm;margin:0 0 2.5mm}ol.msteps li{margin-bottom:1.4mm;line-height:1.4}ol.msteps li::marker{color:#1257C8;font-weight:bold}
ol.sublist{list-style:none;padding-left:6mm;margin:0 0 3mm}ol.sublist li{margin-bottom:1.6mm}
.wbox{border:1.2pt solid #D9534F;border-radius:2mm;padding:2mm 3.5mm 1mm;margin:2.5mm 0;background:#FFF8F7}.wbox .wt{color:#B23B37;font-weight:bold;margin-bottom:1mm}
.wbox ul.terms{margin-bottom:1mm}
.remark{background:#EAF2FB;border-left:2.5pt solid #1257C8;padding:2mm 3.5mm;margin:2.5mm 0;font-size:9.6pt}.remark b{color:#0B2A5B}.remark p{margin:.6mm 0}
.figbox{margin:1mm 0 2mm;text-align:center}.figbox svg.dwg{width:100%;max-height:52mm}.figbox.s svg.dwg{max-height:34mm}.figbox.m svg.dwg{max-height:44mm}table.care td{padding:1.1mm 2.2mm;font-size:9pt}table.care ul.vl li{margin-bottom:.4mm}.figbox svg.dwg.small{max-height:44mm}
.figrow{display:flex;gap:5mm;align-items:flex-end}.figrow .figbox{flex:1}
.coverfig{position:absolute;top:150mm;left:30mm;right:16mm}.coverfig svg{width:100%;max-height:64mm}
.cover .ctitle h1{font-size:34pt}.cover .cabs{font-size:10pt;color:#5b6577;margin-top:3mm}
table.toc td{padding:.75mm 2.2mm;font-size:9.2pt}table.toc tr.grp td{background:#EAF2FB!important;color:#0B2A5B;font-weight:bold}table.toc td.pg{text-align:right;color:#1257C8;font-weight:bold}table.toc td.n{color:#1257C8;font-weight:bold}
table.plist td{padding:1.4mm 2.5mm}.numdot{display:inline-flex;width:6mm;height:6mm;border-radius:50%;background:#0B2A5B;color:#fff;font-weight:bold;align-items:center;justify-content:center;font-size:9pt}
.wt-in{color:#B23B37;font-weight:bold}.rm-in{color:#0B2A5B;font-weight:bold}
figure.ph{margin:0 0 2mm}figure.ph figcaption{font-size:8.2pt;padding:1mm 2.5mm}.phwrap{position:relative}.pin{position:absolute;width:6.5mm;height:6.5mm;border-radius:50%;background:#00B4F0;color:#0B2A5B;border:.8mm solid #fff;font-weight:bold;font-size:9pt;display:flex;align-items:center;justify-content:center;transform:translate(-50%,-50%);box-shadow:0 .4mm 1.2mm rgba(0,0,0,.35)}
.phrow{display:flex;gap:4mm;position:relative}.figbox.xl svg.dwg{max-height:98mm}.pgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin:3mm 0}.pcard{border:.8pt solid #c9d6ea;border-radius:2mm;padding:2mm;position:relative;text-align:center}.pcard .numdot{position:absolute;left:1.5mm;top:1.5mm}.pcard svg.dwg{width:100%;height:24mm}.pcard p{margin:1mm 0 0;font-size:9pt;line-height:1.3;font-weight:bold;color:#0B2A5B}.pcard .en-line{font-weight:normal}.phrow figure{flex:1}.phgrid{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:2mm 0}.phgrid figure.ph{margin:0}
table.dodont th:first-child{background:#1F9D6B}table.dodont th:last-child{background:#D9534F}
''')
