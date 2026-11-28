"""คู่มือการใช้งาน (Owner Manual) – หางลากพ่วงตู้ทึบ RRS สำหรับ Ford Ranger Super Duty.

Same layout and voice as ../owner_manual_flatbed. Facts: ZW3D model "หางลาก ford พื้นเรียบ[.Z3" (read for sizes and
part positions in docs/TRAILER_INSTALL.md), the trailer warranty booklet (../trailer_booklet), work instructions
WI-PD-63 (trailer brake, 12-pin plug, breakaway) and WI-PD-62 (camera 1/2 switching), Ford BEMM E455418 (03/2026)
1.13–1.14, 2.3.2, 4.6.12. Drawings are 2D line art until a STEP export of the trailer is available.
python3 build.py && node pdf.js
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "warranty_booklet"))
from common import *  # noqa: E402,F403
import model as M  # noqa: E402
P = M.PT

set_footer("คู่มือการใช้งาน · หางลากพ่วงตู้ทึบ RRS · Ford Ranger Super Duty")
B = "____"


def band(th, en):
    return f'<div class="sband"><b>{th}</b><span>{en}</span></div>'


def h3(th, en):
    return f'<h3>{th} <span class="en">({en})</span></h3>'


def h4(th, en):
    return f'<h4 class="sub">{th} <span class="en">({en})</span></h4>'


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


def figs(*items, k=""):
    return '<div class="figrow">' + "".join(fig(s, c, k) for s, c in items) + "</div>"


def en(s):
    return f'<span class="en-line">{s}</span>'


# ---------------------------------------------------------------- cover
raw('''<div class="cover"><div class="stripe"></div>
<img class="biglogo" src="logo.png">
<div class="ctitle"><small>OWNER MANUAL</small><h1>คู่มือการใช้งาน</h1>
<p>หางลากพ่วงตู้ทึบ RRS<br><span style="color:#1257C8">RRS Enclosed Box Trailer</span></p>
<p class="cabs">ลากด้วย Ford Ranger Super Duty</p></div>
<div class="coverfig tr">''' + M.view("t_cover") + '''</div>
<div class="cfoot"><span>รหัสคู่มือ (P/N) ____________</span><span>เลขตัวถังหางลาก (VIN) ____________</span></div></div>''', "nocrop")

# ---------------------------------------------------------------- contents
TOC = [
    ("", "วิธีใช้คู่มือเล่มนี้", "How to use this manual", 3), ("", "การรับประกัน", "Warranty", 4),
    ("", "ส่วนประกอบหางลาก", "Trailer components", 5), ("", "เพื่อการลากจูงอย่างปลอดภัย", "For safe towing", 6),
    ("1", "ขนาดและน้ำหนัก", "Dimensions and weight", 8), ("1.1", "ขนาด", "Dimensions", 8), ("1.2", "น้ำหนักและพิกัดการลาก", "Weights and towing limits", 9),
    ("2", "การพ่วงและปลดพ่วง", "Coupling and uncoupling", 10), ("2.1", "การพ่วง", "Coupling", 10),
    ("2.2", "โซ่นิรภัยและสายเบรกฉุกเฉิน", "Safety chains and breakaway cable", 11), ("2.3", "ปลั๊กไฟ 12 ขา", "12-pin plug", 12),
    ("2.4", "การปลดพ่วง", "Uncoupling", 13),
    ("3", "เบรกหางลาก", "Trailer brakes", 14), ("3.1", "ตัวควบคุมเบรก", "Brake controller", 14), ("3.2", "ระบบเบรกฉุกเฉิน (Breakaway)", "Breakaway system", 14), ("3.3", "วาล์วล็อกเบรก", "Brake lock valve", 16),
    ("4", "ไฟและกล้องมองหลัง", "Lamps and rear camera", 17),
    ("5", "ประตูตู้", "Box doors", 18), ("5.1", "ประตูข้าง", "Side doors", 18), ("5.2", "ประตูท้ายและประตูหน้า", "Rear and front doors", 19), ("5.3", "กล่องเครื่องมือหน้า", "Front tool box", 20), ("5.4", "ระบบภายในกล่องเครื่องมือ", "Inside the tool box", 21),
    ("6", "การบรรทุก", "Loading", 23), ("7", "การขับขี่ขณะลากจูง", "Driving with the trailer", 24),
    ("8", "การดูแลรักษา", "Care and maintenance", 25), ("9", "แก้ปัญหาเบื้องต้น", "Troubleshooting", 26),
    ("10", "ข้อมูลทางเทคนิค", "Technical data", 27),
]
rows = "".join(f'<tr class="{"grp" if "." not in n else ""}"><td class="n">{n}</td><td>{t} <span class="en">({e})</span></td><td class="pg">{p}</td></tr>' for n, t, e, p in TOC)
page("สารบัญ (Index)", band("สารบัญ", "Index") + f'<table class="toc"><colgroup><col style="width:9%"><col style="width:81%"><col style="width:10%"></colgroup><tbody>{rows}</tbody></table>')

page("วิธีใช้คู่มือ (How to use this manual)", band("วิธีใช้คู่มือเล่มนี้", "How to use this manual") +
     para("คู่มือเล่มนี้อธิบายการพ่วง การใช้งาน และการดูแลหางลากพ่วงตู้ทึบ RRS ที่ลากด้วย Ford Ranger Super Duty โปรดอ่านก่อนลากครั้งแรก และเก็บไว้ในรถพร้อมสมุดรับประกัน",
          "This manual explains coupling, use and care of the RRS enclosed box trailer towed by the Ford Ranger Super Duty. Read it before the first tow and keep it in the vehicle with the warranty booklet.") +
     para("อ่านร่วมกับคู่มือผู้ใช้รถ Ford เรื่องการลากจูง น้ำหนักกดลูกบอล และการตั้งค่าตัวควบคุมเบรก ค่าในคู่มือรถ Ford มีผลเหนือคู่มือเล่มนี้เมื่อค่าต่างกัน",
          "Read it together with the Ford owner's guide on towing, ball download and brake-controller settings. Where values differ, the Ford owner's guide applies.") +
     h3("สัญลักษณ์ในคู่มือ", "Symbols used") +
     table(["สัญลักษณ์", "ความหมาย (Meaning)"], [
         ['<span class="wt-in">⚠ ข้อควรระวัง (Warning)</span>', "ข้อปฏิบัติที่ถ้าไม่ทำตาม อาจทำให้บาดเจ็บสาหัส เสียชีวิต หรือเกิดความเสียหาย" + en("Failure to follow it may cause serious injury, death or damage.")],
         ['<span class="rm-in">หมายเหตุ (Remark)</span>', "ข้อมูลเพิ่มเติม" + en("Additional information.")],
         ['<span class="numdot">1</span>', "ลำดับขั้นตอน หรือชิ้นส่วนในภาพ" + en("Order of the steps, or a part in a drawing.")]], [30, 70]) +
     para("คำว่า ซ้าย (LH) และ ขวา (RH) ในคู่มือนี้ มองจากท้ายหางลากไปทางหัวลาก", "Left (LH) and right (RH) are as seen from the rear of the trailer looking forward."))

page("การรับประกัน (Warranty)", band("การรับประกัน", "Warranty") +
     para("เงื่อนไขการรับประกันฉบับเต็มอยู่ในสมุดรับประกันและการบำรุงรักษาหางลากพ่วง RRS หน้านี้สรุปข้อที่ผู้ใช้ต้องปฏิบัติ",
          "The full terms are in the RRS trailer warranty and maintenance booklet. This page summarises what the user must do.") +
     steps(("น้ำหนักรวมหางลาก (ATM) ต้องไม่เกินค่าบนป้ายหางลาก พิกัดชุดลาก Ford และน้ำหนักรถลาก + หางลาก (GCM) 8,000 กก. ค่าที่ต่ำที่สุดใช้บังคับ",
            "The trailer's gross mass (ATM) must not exceed the trailer plate, the Ford towbar rating or the 8,000 kg combination (GCM), whichever is lowest."),
           ("ใช้ชุดลากของ Ford และลูกบอลขนาดตรงกับหัวต่อพ่วงเท่านั้น", "Use only a Ford towbar and a ball that matches the coupling."),
           ("เข้ารับการตรวจตามระยะในหัวข้อ 8 และเก็บบันทึกไว้ในสมุดรับประกัน", "Have the periodic checks of section 8 done and keep the records in the warranty booklet."),
           ("ห้ามตัด เจาะ เชื่อม หรือดัดแปลงโครง คานลาก และจุดยึดเพลา", "Do not cut, drill, weld or modify the frame, drawbar or axle mountings."),
           ("พบความผิดปกติ ให้หยุดลาก และแจ้ง RRS ภายใน 7 วัน พร้อมสมุดรับประกันและภาพความเสียหาย", "If you find a fault, stop towing and tell RRS within 7 days, with the warranty booklet and photos.")) +
     remark(("ระยะรับประกันแต่ละชุดชิ้นส่วนดูในสมุดรับประกัน (ค่าที่ RRS ประกาศ)", "Warranty periods for each part group: see the warranty booklet (as published by RRS).")))

page("ส่วนประกอบหางลาก (Trailer components)", band("ส่วนประกอบหางลาก", "Trailer components") +
     '<div class="side2 w">' + M.view("t_rear", [("n", P["hitch"], 1, 0, -90), ("n", P["wheel"], 2, -60, 90), ("n", P["fender"], 3, 80, 60), ("n", P["door"], 4, 70, -60),
                       ("n", P["lockbar"], 5, 70, 40), ("n", P["hinge"], 6, 80, -40), ("n", P["roof"], 7, 0, -70), ("n", P["lamp"], 8, -40, 80),
                       ("n", P["rear"], 9, -90, -30)], "ภาพจากแบบ 3D ของ RRS (มองจากด้านท้ายขวา)", "") + '<div>' + table(["#", "ชิ้นส่วน (Part)", "หน้าที่ (Function)"], [
         ['<span class="numdot">1</span>', "คานลาก · แผ่นยึดหัวต่อพ่วง" + en("Drawbar · coupling plate"), "ต่อกับลูกบอลของชุดลาก Ford"],
         ['<span class="numdot">2</span>', "ล้อและเพลา (2 เพลา)" + en("Wheels and axles (tandem)"), "รับน้ำหนักและเบรก"],
         ['<span class="numdot">3</span>', "บังโคลน" + en("Fenders"), "กันโคลนและหินกระเด็น"],
         ['<span class="numdot">4</span>', "ประตูข้าง ข้างละ 4 บาน" + en("Side doors, 4 per side"), "เปิดออกด้านนอก"],
         ['<span class="numdot">5</span>', "คานล็อกประตูและมือจับ" + en("Door locking bar and handle"), "ล็อกบานกับขอบตู้บน–ล่าง"],
         ['<span class="numdot">6</span>', "บานพับประตู" + en("Door hinges"), "บานละ 5 ตัว"],
         ['<span class="numdot">7</span>', "หลังคา · รางน้ำ" + en("Roof · gutter"), "กันน้ำ ห้ามบรรทุกบนหลังคา"],
         ['<span class="numdot">8</span>', "ไฟท้าย · ป้ายทะเบียน" + en("Tail lamps · number plate"), "ผ่านปลั๊ก 12 ขา"],
         ['<span class="numdot">9</span>', "ประตูท้าย" + en("Rear doors"), "บานคู่ บานพับสองฝั่ง"]], [7, 48, 45], "plist") + '</div></div>')

page("เพื่อการลากจูงอย่างปลอดภัย (For safe towing)", band("เพื่อการลากจูงอย่างปลอดภัย", "For safe towing") +
     warn(("ห้ามให้คนนั่งหรืออยู่ในตู้ขณะลาก", "Never carry people in the box while towing."),
          ("ห้ามยืนระหว่างรถลากกับหางลากขณะถอยพ่วงหรือปลดพ่วง", "Never stand between the car and the trailer while reversing to couple or uncoupling."),
          ("ห้ามปลดพ่วงบนทางลาดโดยไม่หนุนล้อหางลาก", "Never uncouple on a slope without chocking the trailer wheels."),
          ("ห้ามใส่ลูกบอล Ø50 ในชุดลาก 4.5 ตัน และห้ามตัด เจาะ หรือเชื่อมชุดลากของรถ", "Never fit a Ø50 ball to the 4.5 t towbar, and never cut, drill or weld the vehicle towbar."),
          ("หางลากสูงและกว้างกว่ารถ ระวังหลังคา สะพาน ป้าย และกิ่งไม้ ใช้กระจกมองข้างสำหรับลากเมื่อมองไม่เห็นท้ายหาง",
           "The trailer is taller and wider than the car: watch roofs, bridges, signs and branches; fit towing mirrors if you cannot see past it."),
          title="ข้อควรระวัง (Warning)") +
     h3("ตรวจเองก่อนลากทุกครั้ง", "Check before every tow") +
     table(["", "รายการ (Item)", "อ้างอิง"], [
         ['<span class="numdot">1</span>', "หัวต่อพ่วงล็อกบนลูกบอล ใส่สลักนิรภัยแล้ว" + en("Coupling locked on the ball, safety pin fitted"), "2.1"],
         ['<span class="numdot">2</span>', "โซ่นิรภัยคล้องไขว้ และสายเบรกฉุกเฉินต่อกับรถ" + en("Chains crossed, breakaway cable attached"), "2.2"],
         ['<span class="numdot">3</span>', "ปลั๊ก 12 ขาเสียบแน่น ไฟทุกดวงทำงาน" + en("12-pin plug in, all lamps work"), "2.3 · 4"],
         ['<span class="numdot">4</span>', "ตัวควบคุมเบรกตั้งค่าแล้ว ปลดวาล์วล็อกเบรก ทดสอบเบรกที่ความเร็วต่ำ" + en("Brake controller set, brake lock valve released, brakes tested at low speed"), "3"],
         ['<span class="numdot">5</span>', "ขาตั้งหน้ายกขึ้นสุดและล็อก เก็บลิ่มหนุนล้อ" + en("Jockey wheel fully up and locked, chocks stowed"), "2.1"],
         ['<span class="numdot">6</span>', "ลมยางและน็อตล้อ" + en("Tyre pressures and wheel nuts"), "8"],
         ['<span class="numdot">7</span>', "ประตูทุกบานปิดและล็อก สินค้ารัดแน่น" + en("All doors closed and locked, load secured"), "5 · 6"]], [8, 80, 12], "plist"))

page("เพื่อการลากจูงอย่างปลอดภัย (For safe towing)", band("เพื่อการลากจูงอย่างปลอดภัย", "For safe towing") +
     warn(("หางลากที่บรรทุกท้ายหนักกว่าหน้า (น้ำหนักกดลูกบอลน้อยหรือติดลบ) จะส่ายจนควบคุมไม่ได้ จัดของหนักไว้หน้าแนวเพลาเสมอ (หัวข้อ 6)",
           "A tail-heavy trailer (low or negative ball download) can sway out of control. Always keep heavy items ahead of the axles (section 6)."),
          ("ถ้าหางลากส่าย ให้ถอนคันเร่งช้า ๆ ถือพวงมาลัยตรง ห้ามเบรกกะทันหันและห้ามเร่งหนี ถ้าใช้ได้ ให้กดสั่งเบรกหางลากด้วยมือที่ตัวควบคุมเบรกเบา ๆ",
           "If the trailer sways, ease off the accelerator, hold the wheel straight, do not brake hard or accelerate; if fitted, apply the trailer brakes gently with the controller's manual lever."),
          ("ห้ามขับขณะประตูตู้เปิดหรือไม่ได้ล็อก", "Never drive with a box door open or unlocked."),
          title="ข้อควรระวัง – ขณะขับขี่ (Warning – while driving)") +
     M.view("t_load", [("t", (0, -1100, 1250), "หนัก (Heavy)", 0, 0), ("t", (0, 100, 1000), "กลาง", 0, 0), ("t", (0, 1600, 1100), "เบา (Light)", 0, 0), ("a", (0, -4330, 900), (0, -4330, 520))], "ของหนักไว้หน้าแนวเพลา ให้น้ำหนักกดลูกบอลประมาณ 10% ของน้ำหนักรวมหางลาก (Heavy items ahead of the axles, ball download ≈ 10%)", "m"))

# ---------------------------------------------------------------- 1 dimensions
page("1. ขนาดและน้ำหนัก (Dimensions and weight)", band("1. ขนาดและน้ำหนัก", "Dimensions and weight") + h3("1.1 ขนาด", "Dimensions") +
     M.view("t_side", [], "ด้านข้าง (Side view) – จากแบบ 3D", "m") +
     table(["รายการ (Item)", "ค่า (Value)"], [
         ["ความยาวรวม (ถึงหัวคานลาก ไม่รวมหัวต่อ)" + en("Overall length (to drawbar tip, excl. coupling)"), "ประมาณ 7,256 มม."],
         ["ตัวตู้ ยาว × กว้าง" + en("Box length × width"), "5,700 × 1,806 มม."],
         ["ความสูงภายในตู้" + en("Inside height"), "ประมาณ 2,247 มม."],
         ["ความกว้างรวม (ที่บังโคลน)" + en("Overall width (at fenders)"), "ประมาณ 2,394 มม."],
         ["ความสูงพื้นตู้จากพื้นถนน · ความสูงรวม" + en("Floor height · overall height"), f"{B} · {B} มม."],
         ["ประตู" + en("Doors"), "ข้างละ 4 บาน · ประตูท้าย · ประตูหน้า"]], [62, 38]) +
     para("ค่าจากแบบ 3D ของ RRS · ค่าจริงของคันนี้ดูที่ป้ายหางลาก", "Values from the RRS 3D model · see the trailer plate for this trailer."))

page("1. ขนาดและน้ำหนัก (Dimensions and weight)", band("1. ขนาดและน้ำหนัก", "Dimensions and weight") + h3("1.2 น้ำหนักและพิกัดการลาก", "Weights and towing limits") +
     table(["รายการ (Item)", "ค่า (Value)"], [
         ["น้ำหนักหางลากเปล่า" + en("Tare mass"), f"{B} กก."], ["น้ำหนักรวมสูงสุด (ATM) ตามป้ายหางลาก" + en("Aggregate trailer mass (ATM)"), f"{B} กก."],
         ["น้ำหนักบรรทุกสูงสุด" + en("Max. payload"), f"{B} กก."], ["น้ำหนักกดลูกบอล (วันส่งมอบ)" + en("Ball download (at delivery)"), f"{B} กก."]], [62, 38], "care") +
     h4("พิกัดชุดลากของ Ford", "Ford towbar ratings") +
     table(["รายการ", "3.5 ตัน", "4.5 ตัน"], [["ชุดลาก (Towbar)", "R1WZ-17D826-A", "RB3Z-17D826-A"], ["ลูกบอล (Ball)", "Ø50 มม.", "Ø70 มม."], ["พิกัดลาก (Towing capacity)", "3,500 กก.", "4,500 กก."]], [36, 32, 32], "care") +
     warn(("น้ำหนักรถลาก + หางลาก (GCM) ต้องไม่เกิน 8,000 กก. เช่น รถลากบรรทุกเต็ม GVM 4,500 กก. ลากหางลากได้ไม่เกิน 3,500 กก.",
           "The combination (GCM) must not exceed 8,000 kg: a car loaded to its 4,500 kg GVM may tow no more than 3,500 kg."),
          ("น้ำหนักกดลูกบอลไม่เกินค่าในคู่มือรถ Ford", "Ball download within the Ford owner's guide value.")) +
     para("ค่าตาม Ford BEMM E455418 (03/2026) ข้อ 1.13–1.14 · ชั่งน้ำหนักรวมเมื่อไม่แน่ใจ", "Values per Ford BEMM E455418 (03/2026) 1.13–1.14 · weigh the rig when unsure."))

# ---------------------------------------------------------------- 2 coupling
page("2. การพ่วงและปลดพ่วง (Coupling and uncoupling)", band("2. การพ่วงและปลดพ่วง", "Coupling and uncoupling") + h3("2.1 การพ่วง", "Coupling") +
     para("คานบอลเสียบในช่องรับของชุดลาก Ford และยึดด้วยสลักกับกิ๊บล็อก หัวต่อพ่วงเป็นแบบคันโยก (มือจับสีดำ) มีตัวบอกสถานะล็อก ขาตั้งหน้าเป็นแบบมือหมุน ยึดกับคานลากด้วยตัวรัดและลูกบิดสีแดง",
          "The ball mount slides into the Ford towbar receiver and is held by a hitch pin and clip. The coupling has a hand lever (black handle) with a lock indicator. The jockey wheel is wound by a crank and clamped to the drawbar by a red hand knob.") +
     M.row(M.view("p_ballmount", [("n", (-300, -58, -88), 1, -40, 60), ("n", (-300, 56, -88), 2, 30, -60), ("n", (0, 0, 25), 3, 50, -40)], "คานบอล: ❶ สลัก · ❷ กิ๊บล็อก · ❸ ลูกบอล"),
           M.view("p_cpl_open", [("a", (265, 0, 80), (214, 0, 205))], "ยกมือจับ – หัวต่อเปิด (Open)"),
           M.view("p_cpl_locked", [("c", (150, 0, 70), 30), ("n", (150, 0, 70), 4, 0, -70)], "กดลงจนล็อก ❹ ตัวบอกสถานะเขียว (Locked)")) +
     steps(("ตรวจคานบอล: เสียบสุดในช่องรับของชุดลาก ใส่สลักและกิ๊บล็อกแล้ว ลูกบอลขนาดตรงกับหัวต่อ ไม่สึก ไม่มีรอยร้าว", "Check the ball mount: fully in the receiver with pin and clip fitted; ball size matches the coupling, not worn or cracked."),
           ("จอดหางลากบนพื้นเรียบ หนุนล้อ หมุนขาตั้งหน้าให้หัวต่อสูงกว่าลูกบอล และยกมือจับหัวต่อขึ้น", "Park the trailer on level ground, chock the wheels, wind the jockey wheel until the coupling is above the ball and lift the coupling handle."),
           ("ถอยรถให้ลูกบอลอยู่ใต้หัวต่อ โดยมีผู้ให้สัญญาณยืนด้านข้าง ห้ามยืนระหว่างรถ", "Reverse the car until the ball is under the coupling, with a helper signalling from the side – never between the vehicles."),
           ("หมุนขาตั้งลดหัวต่อลงบนลูกบอลจนสุด กดมือจับลงจนล็อก ตัวบอกสถานะต้องเป็นสีเขียว แล้วใส่สลักนิรภัย (ถ้ามี)", "Wind the coupling fully onto the ball and press the handle down until it locks: the indicator must show green. Fit the safety pin (if fitted)."),
           ("หมุนขาตั้งขึ้นเล็กน้อย ถ้าท้ายรถยกตาม แสดงว่าล็อกแล้ว จากนั้นยกขาตั้งขึ้นสุด คลายลูกบิดแดง ดึงขาตั้งขึ้นให้พ้นพื้น หมุนล้อขาตั้งไปทางท้าย แล้วขันลูกบิดแดงให้แน่น", "Wind the jockey up slightly: if the car's rear lifts, the coupling is locked. Then wind it fully up, loosen the red knob, raise the jockey clear of the road, turn its wheel to the rear and tighten the knob."),
           ("ต่อโซ่นิรภัย สายเบรกฉุกเฉิน (2.2) และปลั๊ก 12 ขา (2.3) แล้วเก็บลิ่มหนุนล้อ", "Attach the safety chains and breakaway cable (2.2) and the 12-pin plug (2.3), then stow the chocks.")))

page("2. การพ่วงและปลดพ่วง (Coupling and uncoupling)", band("2. การพ่วงและปลดพ่วง", "Coupling and uncoupling") + h3("2.2 โซ่นิรภัยและสายเบรกฉุกเฉิน", "Safety chains and breakaway cable") +
     M.view("p_chains", [("n", (180, 0, -60), 1, 0, 70), ("n", (300, 40, 30), 2, 40, 150), ("n", (550, 80, 102), 3, 80, 40)], "❶ โซ่นิรภัยคล้องไขว้ใต้หัวต่อ · ❷ สายเบรกฉุกเฉิน (สายขดสีแดง) · ❸ สวิตช์เบรกฉุกเฉิน (กล่องดำ สลักห่วง) ข้างหัวต่อ") +
     steps(("คล้องโซ่นิรภัยทั้งสองเส้นกับจุดคล้องโซ่ของชุดลาก Ford แบบไขว้กันใต้หัวต่อ เพื่อรองรับหัวต่อถ้าหลุดจากลูกบอล", "Hook both safety chains to the Ford towbar chain points, crossed under the coupling so they catch it if it leaves the ball."),
           ("ปรับความยาวให้โซ่หย่อนพอเลี้ยวได้สุด แต่ไม่ลากพื้น", "Adjust so the chains allow full turns but do not drag on the road."),
           ("ตรวจว่าสลักห่วงเสียบสุดในสวิตช์ ❸ (กล่องดำข้างคานลากหลังหัวต่อ) แล้วเกี่ยวตะขอปลายสายขดสีแดง ❷ กับจุดยึดบนชุดลากของรถที่แยกจากจุดคล้องโซ่ ห้ามคล้องกับโซ่หรือลูกบอล", "Check the ring pin is fully home in switch ❸ (black box on the drawbar behind the coupling), then clip the hook of red coiled cable ❷ to a fixed point on the car's towbar separate from the chains – never to a chain or the ball.")) +
     warn(("สายเบรกฉุกเฉินต้องหย่อนพอเลี้ยวได้ แต่สั้นกว่าโซ่ เพื่อให้ดึงสลักก่อนที่โซ่จะตึง", "The breakaway cable must be slack enough for turns but shorter than the chains, so it pulls the pin before the chains go tight.")))

page("2. การพ่วงและปลดพ่วง (Coupling and uncoupling)", band("2. การพ่วงและปลดพ่วง", "Coupling and uncoupling") + h3("2.3 ปลั๊กไฟ 12 ขา", "12-pin plug") +
     '<div class="two2">' + M.view("p_plug12", [("t", (-17.0, -22.5, 2), "1", 0, 0), ("t", (0.0, -26.8, 2), "2", 0, 0), ("t", (17.0, -22.5, 2), "3", 0, 0), ("t", (21.2, -5.5, 2), "4", 0, 0), ("t", (17.0, 11.5, 2), "5", 0, 0), ("t", (0.0, 15.8, 2), "6", 0, 0), ("t", (-17.0, 11.5, 2), "7", 0, 0), ("t", (-21.2, -5.5, 2), "8", 0, 0), ("t", (-9.4, -13.2, 2), "9", 0, 0), ("t", (9.4, -13.2, 2), "10", 0, 0), ("t", (9.4, 2.2, 2), "11", 0, 0), ("t", (-9.4, 2.2, 2), "12", 0, 0)], "ปลั๊ก 12 ขาแบน (ภาพอธิบาย – ดูเลขบนปลั๊กจริง)") +
     table(["ขา", "สาย", "หน้าที่ (Function)"], [
         ["1", "เหลือง", "ไฟเลี้ยวซ้าย (LH turn)"], ["2", "ดำ", "ไฟถอย (Reversing)"], ["3", "ขาว", "กราวด์ (Earth)"], ["4", "เขียว", "ไฟเลี้ยวขวา (RH turn)"],
         ["5", "น้ำเงิน", "ไปวงจรรีเลย์เบรก – ยืนยันตามแบบ (Brake relay – confirm)"], ["6", "แดง", "ไฟเบรก (Stop)"], ["7", "น้ำตาล", "ไฟหรี่ (Tail)"], ["8–12", "ส้ม ชมพู ขาว เทา ม่วง", f"ตามแบบสายของรถคันนี้ {B}"]], [10, 28, 62], "plist care") + '</div>' +
     steps(("ตรวจหน้าสัมผัสปลั๊กทั้งสองฝั่งให้สะอาดและแห้ง", "Check both plug faces are clean and dry."),
           ("เสียบปลั๊กไฟสัญญาณ (สายขดสีดำ) เข้าเต้ารับกลมบนชุดลากของรถจนสุด และล็อกฝาปิด", "Push the lighting plug (black coiled cable) fully into the round socket on the car's towbar and latch the cover."),
           ("เสียบปลั๊กสายขดสีเขียว (สายไฟชาร์จแบตเตอรี่หางลาก) เข้าเต้ารับเหลี่ยมบนชุดลากจนล็อก จัดสายทั้งหมดให้หย่อนพอเลี้ยวได้ ไม่พันโซ่และไม่ลากพื้น", "Plug the green coiled cable (trailer battery charging lead) into the square socket on the towbar until it locks; leave all cables slack enough for turns, clear of the chains and the road."),
           ("ให้ผู้ช่วยตรวจไฟหรี่ ไฟเบรก ไฟเลี้ยว และไฟถอยทุกดวง (หัวข้อ 4)", "Have a helper check the tail, stop, turn and reversing lamps (section 4).")) +
     remark(("หน้าที่ขา 1–7 จาก WI-PD-63 · ขา 8–12 ให้ RRS ยืนยันตามแบบสาย", "Pins 1–7 from WI-PD-63 · pins 8–12 to be confirmed by RRS from the wiring drawing."),
            ("สายขดดำเข้าเต้ารับกลม · สายขดเขียวเข้าเต้ารับเหลี่ยม · RRS ยืนยันชนิดปลั๊กและหน้าที่สาย", "Black coiled cable to the round socket · green coiled cable to the square socket · RRS to confirm the plug types and what each lead carries.")))

page("2. การพ่วงและปลดพ่วง (Coupling and uncoupling)", band("2. การพ่วงและปลดพ่วง", "Coupling and uncoupling") + h3("2.4 การปลดพ่วง", "Uncoupling") +
     steps(("จอดบนพื้นเรียบและแข็ง เข้าเกียร์ P และดึงเบรกมือรถลาก", "Park on firm, level ground, select P and apply the car's parking brake."),
           ("หนุนล้อหางลากทั้งสองข้าง หน้าและหลัง", "Chock the trailer wheels on both sides, front and rear."),
           ("ลดขาตั้งหน้าลงจนแตะพื้นและรับน้ำหนัก", "Lower the jockey wheel until it takes the weight."),
           ("ถอดปลั๊กสายขดสีดำและสีเขียว เก็บใส่ที่เก็บ ปลดตะขอสายขดสีแดงและโซ่นิรภัย", "Unplug and stow the black and green coiled leads; unhook the red breakaway cable and the chains."),
           ("ถอดสลักนิรภัย ยกคันล็อก แล้วหมุนขาตั้งยกหัวต่อพ้นลูกบอล", "Remove the safety pin, lift the lever and wind the coupling clear of the ball."),
           ("เคลื่อนรถออกช้า ๆ ตรวจว่าหางลากอยู่นิ่ง และใส่ฝาครอบลูกบอล", "Drive the car away slowly, check the trailer stays put and refit the ball cover.")) +
     M.row(M.view("p_jockey_down", [("n", (0, 102, 360), 1, 90, 0), ("n", (110, 0, 620), 2, 90, -20)], "ขาตั้งลง: ❶ ลูกบิดแดง · ❷ มือหมุน (Down)", "m"),
           M.view("p_jockey_up", [("a", (150, 0, 300), (150, 0, 560))], "ยกขึ้นสุดก่อนลาก (Up before towing)", "m")) +
     warn(("ห้ามดึงสลักสายเบรกฉุกเฉินออกขณะจอดเพื่อใช้เป็นเบรกมือ แบตเตอรี่เบรกฉุกเฉินจะหมด", "Do not pull the breakaway pin to hold a parked trailer: it drains the breakaway battery."),
          ("ห้ามปลดพ่วงบนทางลาด และห้ามทิ้งหางลากโดยไม่หนุนล้อ", "Never uncouple on a slope or leave the trailer without chocks.")))

# ---------------------------------------------------------------- 3 brakes
page("3. เบรกหางลาก (Trailer brakes)", band("3. เบรกหางลาก", "Trailer brakes") +
     h3("3.1 ตัวควบคุมเบรก", "Brake controller") +
     para("เบรกหางลากสั่งงานจากตัวควบคุมเบรกบนรถลาก ผ่านขาสั่งเบรกของปลั๊ก 12 ขา Ford ส่งสัญญาณเบรกพ่วงเป็นสัญญาณพัลส์ ตัวควบคุมเบรกต้องรองรับสัญญาณนี้",
          "The trailer brakes are applied by the brake controller in the car through the brake-control pin of the 12-pin plug. Ford sends a pulsed signal; the controller must support it.") +
     steps(("ตั้งค่าแรงเบรก (Gain) ตามคู่มือตัวควบคุมเบรก โดยเริ่มจากค่าต่ำ", "Set the gain as the controller's manual says, starting low."),
           ("ขับช้า ๆ บนพื้นแห้ง ราว 30 กม./ชม. แล้วกดสั่งเบรกหางลากด้วยมือ หางลากควรหน่วงรถโดยล้อไม่ล็อก", "Drive slowly on a dry road at about 30 km/h and apply the trailer brakes by hand: the trailer should slow the car without locking its wheels."),
           ("ปรับค่าเพิ่มทีละขั้นจนได้ผลตามข้อ 2 และตั้งใหม่ทุกครั้งที่น้ำหนักบรรทุกเปลี่ยนมาก", "Raise the gain step by step until step 2 is met; reset it whenever the load changes a lot.")) +
     h3("3.2 ระบบเบรกฉุกเฉิน (Breakaway)", "Breakaway system") +
     para("ถ้าหางลากหลุดจากรถ สายคล้องจะดึงสลักออกจากสวิตช์เบรกฉุกเฉิน (ภาพหัวข้อ 2.2) และแบตเตอรี่ในชุดจะสั่งเบรกหางลากเต็มแรง กล่องเบรกฉุกเฉินมีปุ่มทดสอบ ❷ และไฟสถานะ ❸ บอกระดับแบตเตอรี่ แบตเตอรี่ต้องได้รับการดูแล ตรวจ และชาร์จให้พอก่อนเดินทางทุกครั้ง",
          "If the trailer breaks away, the cable pulls the pin out of the breakaway switch (drawing in 2.2) and the battery applies the trailer brakes fully. The breakaway unit has test button ❷ and lamps ❸ showing the battery state. The battery must be maintained, checked and sufficiently charged before every trip.") +
     M.view("p_ba_unit", [("n", (44, -26, 200), 1, -60, -40), ("n", (250, -10, 150), 2, 70, -30), ("n", (247, -12, 62), 3, 70, 0), ("t", (130, -2, 120), "Fully Charged · Recharge! · Charging", 0, 60)], "กล่องเบรกฉุกเฉิน: ❶ สวิตช์ไฟในตู้ · ❷ ปุ่มทดสอบ · ❸ ไฟสถานะแบตเตอรี่", "h"))

page("3. เบรกหางลาก (Trailer brakes)", band("3. เบรกหางลาก", "Trailer brakes") +
     h4("ตรวจก่อนลากทุกครั้ง", "Check before every tow") +
     steps(("กดปุ่ม TEST ❷ ค้างไว้ แล้วอ่านไฟสถานะ ❸", "Press and hold TEST ❷ and read lamps ❸."),
           ("ตรวจว่าสลักเบรกฉุกเฉินเสียบสุด และสายคล้องกับจุดยึดบนรถแล้ว (2.2)", "Check the breakaway pin is fully home and the cable is attached to the car (2.2).")) +
     table(["ไฟสถานะ (Lamp)", "ความหมาย (Meaning)", "สิ่งที่ต้องทำ (Action)"], [
         ["Fully Charged", "แบตเตอรี่เต็ม" + en("Battery full"), "ลากได้" + en("Ready to tow")],
         ["Recharge!", "แบตเตอรี่อ่อน" + en("Battery low"), "ห้ามลาก ชาร์จหรือแจ้ง RRS" + en("Do not tow; charge it or contact RRS")],
         ["Charging", "กำลังชาร์จ" + en("Charging"), "รอจนขึ้น Fully Charged" + en("Wait for Fully Charged")]], [26, 34, 40], "care") +
     warn(("ห้ามลากถ้าไฟแสดง Recharge! หรือไฟไม่ติดเมื่อกด TEST", "Do not tow if Recharge! shows or no lamp lights when TEST is pressed."),
          ("ถ้าสลักหลุดโดยไม่ตั้งใจ ให้เสียบกลับทันที เบรกจะค้างและแบตเตอรี่จะหมด", "If the pin is pulled by accident, refit it at once: the brakes stay on and the battery drains.")) +
     remark(("สีสายของกล่อง (สำหรับช่าง): ขาว = กราวด์ · น้ำเงิน = เบรก · ดำ = แบตเตอรี่", "Unit wire colours (for technicians): white = earth · blue = brakes · black = battery."),
            ("รุ่นกล่องเบรกฉุกเฉินและวิธีชาร์จให้ RRS ระบุ", "Breakaway unit model and charging method to be stated by RRS.")))

page("3. เบรกหางลาก (Trailer brakes)", band("3. เบรกหางลาก", "Trailer brakes") +
     h3("3.3 วาล์วล็อกเบรก", "Brake lock valve") +
     M.view("p_toolbox", [("c", (260, -26, 80), 40), ("n", (260, -26, 80), 1, -70, 40), ("t", (360, -3, 80), "Brake lock valve", 60, -70)], "❶ ปุ่มวาล์วล็อกเบรก ด้านหน้ากล่องเครื่องมือ", "m") +
     para("ปุ่มสีแดง ❶ ด้านหน้ากล่องเครื่องมือ (ป้ายเหลือง Brake lock valve – วาล์วล็อคเบรค) ใช้ล็อกเบรกหางลากค้างไว้ขณะจอด กดปุ่มลงเพื่อล็อก หมุนตามลูกศรบนปุ่มให้ปุ่มเด้งขึ้นเพื่อปลด",
          "Red button ❶ on the front of the tool box (yellow plate Brake lock valve) holds the trailer brakes on while parked: press it in to lock, turn it the way of the arrows so it pops out to release.") +
     steps(("จอดและหนุนล้อแล้ว กดปุ่ม ❶ เพื่อล็อกเบรก", "Once parked and chocked, press button ❶ to lock the brakes."),
           ("ก่อนออกรถ หมุนปลดให้ปุ่มเด้งขึ้น แล้วออกรถช้า ๆ ตรวจว่าล้อหางลากหมุนได้ไม่ฝืด", "Before moving off, turn it to release so it pops out, then pull away slowly and check the trailer wheels roll freely.")) +
     warn(("ห้ามลากขณะวาล์วล็อกเบรกอยู่ เบรกและยางจะร้อนและเสียหาย · วาล์วล็อกเบรกไม่ใช่สิ่งทดแทนลิ่มหนุนล้อ", "Never tow with the valve locked: brakes and tyres overheat. The valve does not replace wheel chocks.")) +
     remark(("ให้ RRS ยืนยันการทำงานและระยะเวลาที่ล็อกได้", "RRS to confirm how it works and how long it holds.")))

# ---------------------------------------------------------------- 4 lamps and camera
page("4. ไฟและกล้องมองหลัง (Lamps and rear camera)", band("4. ไฟและกล้องมองหลัง", "Lamps and rear camera") +
     '<div class="side2 n">' + M.view("tz_rear", [("c", P["lamp"], 60), ("c", (720, 2880, 560), 60), ("c", P["plate"], 70), ("c", (0, 2886, 2940), 70), ("n", (0, 2886, 2940), 2, 110, 40)], "ด้านท้าย: ไฟท้าย ป้ายทะเบียน (วงประ) และไฟบนหลังคา – จากแบบ 3D", "") + '<div>' + steps(("เปิดไฟหรี่ ตรวจไฟหรี่ ไฟบนหลังคา และไฟส่องป้ายทะเบียน", "Switch on the parking lamps: check tail, roof marker and number-plate lamps."),
           ("เหยียบเบรก ตรวจไฟเบรกทั้งสองข้าง", "Press the brake pedal: check both stop lamps."),
           ("เปิดไฟเลี้ยวทีละข้าง ไฟต้องกะพริบตรงข้างและพร้อมกับรถ", "Signal each way: the trailer lamp must flash on the correct side, in time with the car."),
           ("เข้าเกียร์ถอย ไฟถอยหางลากติด และจอแสดงภาพจากกล้องหางลาก", "Select reverse: the trailer reversing lamps light and the screen shows the trailer camera.")) + '</div></div>' +
     h4("ไฟในตู้", "Interior lamps") +
     para("ไฟในตู้ 2 ดวง เปิด–ปิดด้วยปุ่มสีดำบนกล่องเบรกฉุกเฉิน (หมายเลข ❶ ในภาพหัวข้อ 3.2) ปิดไฟทุกครั้งหลังใช้งาน",
          "The 2 interior lamps are switched on and off by the black knob on the breakaway unit (❶ in the drawing in 3.2). Switch them off after use.") +
     h4("กล้องมองหลัง", "Rear camera") +
     para("กล้อง ❷ บนหางลาก (กลางท้ายตู้ ดูวงประในภาพบน) แสดงบนจอเมื่อพ่วงและเข้าเกียร์ถอย · กล้อง ❶ บนรถลากใช้เมื่อไม่ได้พ่วง", "Trailer camera ❷ (top centre of the rear, circled above) shows on the screen when coupled and in reverse · car camera ❶ is used when not towing.") +
     remark(("ไฟ LED ที่กินกระแสต่ำกว่า 550 mA ต่อวงจร รถจะไม่ตรวจพบหางลาก ต้องใส่ชุดตัวต้านทานฝั่งหางลาก (Ford BEMM 4.6.12) – แจ้ง RRS", "LED lamps drawing under 550 mA per circuit are not detected by the car; a resistor kit is needed on the trailer (Ford BEMM 4.6.12) – contact RRS.")))

# ---------------------------------------------------------------- 5 doors
page("5. ประตูตู้ (Box doors)", band("5. ประตูตู้", "Box doors") + h3("5.1 ประตูข้าง", "Side doors") +
     '<div class="side2">' + M.view("tz_door", [("c", P["lockbar"], 70), ("n", P["lockbar"], 1, -110, 60), ("c", (-930, -870, 2790), 55), ("n", (-930, -870, 2790), 2, -110, 0), ("c", (-930, -870, 870), 55), ("n", (-930, -870, 870), 2, -110, 0)], "❶ มือจับคานล็อก · ❷ ลูกเบี้ยวล็อกบน–ล่าง", "box") + '<div>' + para("ประตูข้างแต่ละบานล็อกด้วยคานล็อกแนวตั้งแบบตู้คอนเทนเนอร์ หมุนด้วยมือจับกลางบาน ลูกเบี้ยวที่ปลายคานบน–ล่างจะเข้าล็อกกับตัวรับที่ขอบตู้",
          "Each side door locks with container-style vertical locking bars, turned by the handle at mid-height; cams at the top and bottom engage keepers on the box frame.") +
     steps(("จอดหางลากบนพื้นเรียบ ตู้จะไม่บิดและประตูเปิด–ปิดได้คล่อง", "Park the trailer on level ground so the box does not twist and the doors move freely."),
           ("ยกมือจับ ❶ ออกจากตัวล็อกมือจับ แล้วหมุนคานล็อกออกจนลูกเบี้ยว ❷ บน–ล่างหลุดจากตัวรับ", "Lift handle ❶ out of its retainer and turn the locking bar until cams ❷ leave their keepers."),
           ("เปิดบานออกจนสุด และยึดบานไว้ ไม่ปล่อยให้ลมตีบาน", "Swing the door fully open and hold it so the wind cannot slam it."),
           ("การปิด: ปิดบานให้สนิท หมุนมือจับกลับให้ลูกเบี้ยวเข้าตัวรับทั้งบน–ล่าง แล้วกดมือจับลงในตัวล็อก ดึงบานเพื่อตรวจว่าล็อกแล้ว", "To close: shut the door, turn the handle back so both cams enter their keepers, press the handle into its retainer and pull the door to check.")) + '</div></div>' +
     warn(("ห้ามเปิดประตูขณะลมแรงโดยไม่จับบานไว้ บานสูงกว่า 2 ม. และอาจตีกระแทกผู้ใช้", "Do not open a door in strong wind without holding it: the doors are over 2 m tall and can strike you."),
          ("ประตูไม่ใช่ผนังรับแรงสินค้า รัดหรือกั้นสินค้าไม่ให้พิงประตู", "Doors are not load-bearing walls: tie or brace the load so it does not lean on them.")))

page("5. ประตูตู้ (Box doors)", band("5. ประตูตู้", "Box doors") + h3("5.2 ประตูท้ายและประตูหน้า", "Rear and front doors") +
     M.view("tz_rear", [("c", (-905, 2880, 1900), 70), ("c", (905, 2880, 1900), 70)], "ประตูท้าย: บานพับสองฝั่ง (วงประ)", "t2") +
     steps(("ยกมือจับคานล็อกออกจากตัวล็อกมือจับ แล้วหมุนคานล็อกให้ลูกเบี้ยวบน–ล่างหลุดจากตัวรับ เริ่มจากบานที่ปิดทับ", "Lift each locking-bar handle out of its retainer and turn the bar until the top and bottom cams leave their keepers, starting with the overlapping leaf."),
           ("เปิดบานจนสุดและยึดไว้ ไม่ปล่อยให้บานแกว่งขณะขนของ", "Open each leaf fully and hold it; do not let it swing while loading."),
           ("การปิด: ปิดบานแรก หมุนคานล็อกให้ลูกเบี้ยวเข้าตัวรับ กดมือจับลงในตัวล็อก แล้วปิดบานที่สองแบบเดียวกัน ตรวจซีลยางว่าแนบสนิท", "To close: shut the first leaf, turn its bars so the cams engage, press the handles into their retainers, then do the same with the second leaf and check the seal sits tight.")) +
     para("ประตูหน้า (ด้านหัวลาก) ใช้สำหรับเข้าถึงด้านหน้าตู้ เปิดได้เมื่อหางลากจอดและปลดล็อกแล้วเท่านั้น", "The front door (drawbar end) gives access to the front of the box; open it only when the trailer is parked.") +
     remark(("ประตูท้ายใช้คานล็อกแบบเดียวกับประตูข้าง", "The rear doors use the same locking bars as the side doors."),
            ("หล่อลื่นบานพับและกลอนทุกเดือน และทำความสะอาดซีลยางเพื่อกันน้ำรั่ว (หัวข้อ 8)", "Lubricate hinges and bolts monthly and clean the seals to keep water out (section 8).")))

page("5. ประตูตู้ (Box doors)", band("5. ประตูตู้และกล่องเครื่องมือ", "Box doors and tool box") + h3("5.3 กล่องเครื่องมือหน้า", "Front tool box") +
     para("กล่องเครื่องมืออะลูมิเนียมลายกันลื่นทรงคางหมูบนคานลากหน้าตู้ (ฝาลาดเอียงขึ้นหาผนังตู้ ปลายสองข้างเฉียงตามคานลาก) สำหรับเก็บโซ่ สายรัด ลิ่มหนุนล้อ และอุปกรณ์ลากจูง ฝาเปิดขึ้นด้านบน ยึดด้วยสลักล็อกแบบคันโยก 2 ตัว ❷ ด้านหน้ากล่องมีปุ่มแดงวาล์วล็อกเบรก ❶ (Brake lock valve) ดูหัวข้อ 3.3",
          "Trapezoid tread-plate aluminium tool box on the drawbar in front of the body (lid sloping up to the body wall, ends angled along the A-frame) for chains, straps, wheel chocks and towing gear. The lid lifts up and is held by two draw latches ❷. Red Brake lock valve button ❶ is on the front (see 3.3).") +
     M.view("p_toolbox", [("c", (260, -26, 80), 40), ("n", (260, -26, 80), 1, -70, 40), ("n", (640, -16, 110), 2, -30, 100), ("n", (1100, -16, 110), 2, 40, 100)], "❶ ปุ่มวาล์วล็อกเบรก (ป้ายเหลือง) · ❷ สลักล็อกฝา 2 ตัว · ฝาเปิดขึ้น", "s") +
     steps(("ง้างคันโยกสลัก ❷ ทั้งสองตัวออก แล้วยกฝาขึ้น", "Pull out both draw-latch levers ❷ and lift the lid."),
           ("การปิด: ปิดฝาให้สนิท เกี่ยวห่วงสลัก ❷ กับขอบฝา แล้วกดคันโยกลงจนล็อกทั้งสองตัว", "To close: shut the lid, hook both latches ❷ onto the lid and press the levers home.")) +
     warn(("ปิดและล็อกฝากล่องก่อนลากทุกครั้ง ของในกล่องที่หลุดออกมาอาจตกลงถนน", "Close and lock the lid before every tow; loose items could fall onto the road."),
          ("ห้ามนั่งหรือยืนบนกล่องเครื่องมือ", "Do not sit or stand on the tool box.")))

page("5. ประตูตู้ (Box doors)", band("5. ประตูตู้และกล่องเครื่องมือ", "Box doors and tool box") + h3("5.4 ระบบภายในกล่องเครื่องมือ", "Inside the tool box") +
     M.view("p_toolbox_open", [("n", (415, 185, 179), 1, -100, -40), ("n", (415, 92, 150), 2, -60, 90), ("n", (665, 235, 155), 3, -60, -100), ("n", (900, 224, 160), 4, 0, -110), ("n", (800, 229, 40), 5, 60, 90), ("n", (1250, 150, 4), 6, 40, 110)], "เปิดฝา มองจากด้านหน้า", "m") +
     table(["#", "อุปกรณ์ (Item)", "การใช้งาน / ข้อควรรู้ (Use)"], [
         ['<span class="numdot">1</span>', "แบตเตอรี่ 12 V (Amaron GO) ขั้วบวกมีฝาครอบสีแดง" + en("12 V battery, red cover on the + terminal"), "จ่ายไฟให้ระบบในกล่องและเบรกฉุกเฉิน ชาร์จจากรถผ่านสายขดสีเขียว (2.3)" + en("Powers the box and breakaway brakes; charged via the green lead (2.3)")],
         ['<span class="numdot">2</span>', "ตัวรัดแบตเตอรี่ (เหล็กฉากพร้อมสลักเกลียว)" + en("Battery hold-down bar and J-bolt"), "ยึดแบตเตอรี่ไม่ให้ขยับขณะลาก ตรวจความแน่นเป็นประจำ" + en("Keeps the battery still when towing; check it is tight")],
         ['<span class="numdot">3</span>', "กล่องเบรกฉุกเฉิน Break-Away Systems บนผนังหลัง" + en("Break-Away Systems unit on the back wall"), "ปุ่มสวิตช์ไฟในตู้ · ปุ่ม TEST · ไฟสถานะแบตเตอรี่ (3.2)" + en("Interior-lamp switch · TEST button · battery lamps (3.2)")],
         ['<span class="numdot">4</span>', "กล่องควบคุมสีดำ (มีครีบระบายความร้อน)" + en("Black control box with cooling fins"), f"ชุดควบคุมระบบเบรกหางลาก {B} ห้ามเปิดหรือปรับเอง" + en("Trailer brake control module – do not open or adjust")],
         ['<span class="numdot">5</span>', "ชุดสายไฟและขั้วต่อ" + en("Wiring harness and connectors"), "ห้ามดึง ถอด หรือวางของทับ" + en("Do not pull, unplug or load anything on it")],
         ['<span class="numdot">6</span>', "พื้นที่เก็บของด้านขวา" + en("Storage space on the right"), "เก็บลิ่มหนุนล้อ สายรัด และอุปกรณ์ลากจูง" + en("For wheel chocks, straps and towing gear")]], [7, 40, 53], "plist care"))

page("5. ประตูตู้ (Box doors)", band("5. ประตูตู้และกล่องเครื่องมือ", "Box doors and tool box") + h3("5.4 ระบบภายในกล่องเครื่องมือ (ต่อ)", "Inside the tool box (continued)") +
     '<div class="side2 w">' + M.view("p_tb_bat", [("n", (415, 185, 179), 1, -150, -60), ("n", (415, 92, 150), 2, -100, 150), ("n", (665, 235, 155), 3, -40, -150)], "❶ แบตเตอรี่ · ❷ ตัวรัด · ❸ กล่องเบรกฉุกเฉิน") + '<div>' +
     h4("ตรวจก่อนลากทุกครั้ง", "Check before every tow") +
     steps(("ตรวจว่าขั้วแบตเตอรี่แน่น ไม่มีขี้เกลือ และฝาครอบขั้วบวกสีแดงปิดอยู่", "Check the battery terminals are tight and clean and the red + cover is on."),
           ("กดปุ่ม TEST ที่กล่อง ❸ และอ่านไฟสถานะ (3.2)", "Press TEST on unit ❸ and read the lamps (3.2)."),
           ("วางของเฉพาะในพื้นที่ ❻ และยึดไม่ให้ไถลไปกระแทก ❶–❺", "Stow items only in space ❻ and secure them so they cannot hit ❶–❺.")) + '</div></div>' +
     h4("จอดเก็บหางลากนาน", "Long-term parking") +
     bullets(("ต่อสายขดสีเขียวกับรถเป็นระยะ หรือให้ RRS ชาร์จแบตเตอรี่ อย่าปล่อยให้ไฟสถานะขึ้น Recharge!", "Connect the green lead to the car from time to time or have RRS charge the battery; never let the lamp reach Recharge!."),
             ("ตรวจว่าสลักเบรกฉุกเฉินเสียบอยู่ และปุ่มสวิตช์ไฟในตู้ปิด เพื่อไม่ให้แบตเตอรี่หมด", "Make sure the breakaway pin is in and the interior lamps are off so the battery does not drain.")) +
     warn(("ห้ามวางโลหะพาดขั้วแบตเตอรี่หรือทำให้เกิดประกายไฟใกล้แบตเตอรี่ · งานซ่อมระบบไฟและเปลี่ยนแบตเตอรี่ให้ RRS ทำ (ถอดขั้วลบก่อนเสมอ)", "No metal across the terminals, no sparks near the battery · electrical work by RRS only.")) +
     remark(("หน้าที่กล่อง ❹ และขนาดแบตเตอรี่ให้ RRS ระบุ", "Function of box ❹ and battery size to be stated by RRS.")))

# ---------------------------------------------------------------- 6 loading
page("6. การบรรทุก (Loading)", band("6. การบรรทุก", "Loading") +
     M.view("t_load", [("t", (0, -1100, 1250), "หนัก (Heavy)", 0, 0), ("t", (0, 100, 1000), "กลาง", 0, 0), ("t", (0, 1600, 1100), "เบา (Light)", 0, 0), ("a", (0, -4330, 900), (0, -4330, 520))], "การกระจายน้ำหนัก (Load distribution)", "m") +
     table(["ควรทำ (Do)", "ไม่ควรทำ (Don't)"], [
         ["วางของหนักชิดพื้น อยู่หน้าแนวเพลาเล็กน้อย และกึ่งกลางซ้าย–ขวา" + en("Heavy items low, slightly ahead of the axles, centred left–right"), "กองของหนักไว้ท้ายตู้" + en("Pile heavy items at the rear")],
         ["ให้น้ำหนักกดลูกบอลประมาณ 10% ของน้ำหนักรวมหางลาก ไม่เกินค่าของ Ford" + en("Ball download about 10% of the trailer mass, within the Ford limit"), "ให้น้ำหนักกดลูกบอลน้อยหรือติดลบ" + en("Low or negative ball download")],
         ["รัดหรือกั้นสินค้ากับพื้นและโครงตู้" + en("Tie or brace the load to the floor and the box frame"), "ใช้ประตูเป็นที่พิงสินค้า" + en("Lean the load on the doors")],
         ["ชั่งน้ำหนักรวมเมื่อไม่แน่ใจ" + en("Weigh the rig when unsure"), "บรรทุกบนหลังคา หรือเกินป้ายหางลาก" + en("Load the roof or exceed the trailer plate")]], [50, 50], "dodont") +
     warn(("ตรวจสายรัดซ้ำหลังลากระยะสั้นครั้งแรก และทุกครั้งที่หยุดพัก", "Re-check the straps after the first short distance and at every stop.")))

# ---------------------------------------------------------------- 7 driving
page("7. การขับขี่ขณะลากจูง (Driving with the trailer)", band("7. การขับขี่ขณะลากจูง", "Driving with the trailer") +
     bullets(("ขับช้ากว่าปกติ ความเร็วสูงสุดขณะลาก " + B + " กม./ชม. และไม่เกินที่กฎหมายกำหนด", f"Drive slower than usual; max. towing speed {B} km/h and never above the legal limit."),
             ("เผื่อระยะเบรกมากกว่าปกติ และเบรกเบา ๆ ล่วงหน้า", "Allow much longer braking distances and brake early and gently."),
             ("เลี้ยวให้กว้างกว่าปกติ ล้อหางลากจะตัดโค้งด้านใน", "Take corners wider: the trailer wheels cut inside the car's path."),
             ("ลงเขาใช้เกียร์ต่ำ ห้ามแตะเบรกค้างนาน", "Use a low gear downhill; do not ride the brakes."),
             ("ถอยหลัง: จับพวงมาลัยด้านล่าง หมุนไปทางที่ต้องการให้ท้ายหางไป มีผู้ให้สัญญาณ", "Reversing: hold the bottom of the wheel and turn it the way you want the trailer to go, with a helper signalling."),
             ("หยุดพักทุก 1–2 ชม. ตรวจหัวต่อ ล้อ ดุมล้อ (ห้ามร้อนจัด) สายรัด และประตู", "Stop every 1–2 h: check coupling, wheels, hubs (not hot), straps and doors.")) +
     warn(("หางลากส่าย: ถอนคันเร่งช้า ๆ ถือพวงมาลัยตรง ห้ามเบรกกะทันหัน ถ้าใช้ได้ให้สั่งเบรกหางลากด้วยมือเบา ๆ จนหางนิ่ง แล้วจอดตรวจการบรรทุก",
           "If the trailer sways: ease off, hold the wheel straight, never brake hard; if fitted, apply the trailer brakes gently by hand until it settles, then stop and check the load."),
          ("ลมด้านข้างแรงมีผลกับตู้สูงมาก ลดความเร็วเมื่อมีลมแรงหรือถูกรถใหญ่แซง", "The tall box is very sensitive to crosswinds: slow down in strong wind or when passed by large vehicles.")))

# ---------------------------------------------------------------- 8 care
page("8. การดูแลรักษา (Care and maintenance)", band("8. การดูแลรักษา", "Care and maintenance") +
     table(["ระยะ (Interval)", "รายการ (Item)", "ผู้ทำ (By)"], [
         ["ก่อนลากทุกครั้ง" + en("Before every tow"), ["หัวต่อ สลัก โซ่ สายเบรกฉุกเฉิน · วาล์วล็อกเบรกปลดแล้ว" + en("Coupling, pin, chains, breakaway · brake lock valve released"), "ไฟทุกดวง · ลมยางและสภาพยาง" + en("All lamps · tyre pressures"), "ประตูล็อก · ขาตั้งยกขึ้น" + en("Doors locked · jockey up")], "ผู้ใช้" + en("User")],
         ["50 กม. แรก และทุกครั้งที่ถอดล้อ" + en("First 50 km and after wheel removal"), ["ขันน็อตล้อซ้ำตามแรงขัน " + B + " N·m" + en("Re-torque the wheel nuts")], "ผู้ใช้ / RRS"],
         ["ทุกเดือน" + en("Monthly"), ["หล่อลื่นหัวต่อ บานพับ กลอนประตู ขาตั้ง" + en("Lubricate coupling, hinges, door bolts, jockey"), "ทำความสะอาดซีลประตูและรางน้ำหลังคา" + en("Clean door seals and roof gutter"), "ชาร์จหรือตรวจแบตเตอรี่เบรกฉุกเฉิน" + en("Check / charge the breakaway battery")], "ผู้ใช้" + en("User")],
         ["1 เดือน / 1,000 กม. แรก" + en("First 1 month / 1,000 km"), ["น็อตล้อ ลูกปืนล้อ เบรก แหนบ หัวต่อ ไฟ ซีลประตู" + en("Wheel nuts, bearings, brakes, springs, coupling, lamps, seals")], "RRS"],
         ["ทุก 6 เดือน / 10,000 กม." + en("Every 6 months / 10,000 km"), ["รอยร้าวที่คานลาก คานแชสซีส์ หูแหนบ เสามุม" + en("Cracks in drawbar, rails, spring hangers, corner posts"), "โบลต์ยึดหัวต่อ 130 ± 5 N·m · สวิตช์เบรกฉุกเฉิน" + en("Coupling bolts 130 ± 5 N·m · breakaway switch"), "ปรับตั้งเบรก · ความหลวมลูกปืนล้อ · สายไฟ" + en("Brake adjustment · bearing play · wiring")], "RRS"],
         ["ทุก 12 เดือน / 20,000 กม." + en("Every 12 months / 20,000 km"), ["อัดจารบีลูกปืนล้อ เปลี่ยนซีลดุม ตรวจผ้าเบรก สลับยาง" + en("Repack bearings, renew hub seals, check linings, rotate tyres")], "RRS"],
         ["หลังลุยน้ำ ล้าง หรือขนวัสดุกัดกร่อน" + en("After water, washing, corrosive loads"), ["ล้างใต้หาง ตรวจลูกปืนล้อหลังล้อจมน้ำ ห้ามฉีดน้ำแรงดันสูงเข้าดุมล้อและซีล" + en("Rinse underneath; check bearings after immersion; no pressure washer on hubs and seals")], "ผู้ใช้" + en("User")]], [25, 57, 18], "care") +
     remark((f"แรงขันน็อตล้อ {B} N·m · ลมยาง {B} psi · จารบีลูกปืนล้อ ชนิด {B}", "Wheel-nut torque, tyre pressure and bearing grease: values to be stated by RRS.")))

# ---------------------------------------------------------------- 9 troubleshooting
page("9. แก้ปัญหาเบื้องต้น (Troubleshooting)", band("9. แก้ปัญหาเบื้องต้น", "Troubleshooting") +
     para("ตรวจตามตารางก่อนติดต่อ RRS ถ้าทำแล้วไม่หาย ให้หยุดลากและแจ้ง RRS ไม่ถอดซ่อมเอง", "Check the table before calling RRS. If the fault stays, stop towing and contact RRS; do not dismantle parts yourself.") +
     table(["อาการ (Symptom)", "สาเหตุที่พบบ่อย (Likely cause)", "สิ่งที่ทำได้เอง (What you can do)"], [
         ["หางส่ายขณะลาก", "น้ำหนักกดลูกบอลน้อย · ลมยางไม่เท่ากัน · เร็วเกินไป", "ลดความเร็ว จัดของหนักไปข้างหน้า เติมลมยาง"],
         ["ไฟหางลากไม่ติดบางดวง", "ปลั๊กหลวมหรือสกปรก · หลอดขาด · LED กินกระแสต่ำ", "เสียบปลั๊กใหม่ ทำความสะอาดขั้ว แจ้ง RRS ตรวจชุดตัวต้านทาน"],
         ["จอไม่แสดงกล้องหางลากเมื่อถอย", "ปลั๊กหลวม · ไฟถอยหางลากไม่ติด", "เสียบปลั๊กใหม่ ตรวจไฟถอย แจ้ง RRS"],
         ["เบรกหางลากไม่ทำงานหรือดึงข้าง", "ตัวควบคุมเบรกไม่ได้ตั้งค่า · สายหลวม · ผ้าเบรกสึก", "ตรวจการตั้งค่า (3.1) แจ้ง RRS ปรับตั้งเบรก"],
         ["ดุมล้อร้อนจัดหรือมีกลิ่นไหม้", "ลูกปืนขาดจารบี · เบรกติด", "หยุดลาก ปล่อยให้เย็น ห้ามราดน้ำ แจ้ง RRS"],
         ["มีเสียงกุกกักที่หัวต่อ", "หัวต่อไม่ล็อกสุด · ลูกบอลผิดขนาด", "หยุดลาก ตรวจล็อกและขนาดลูกบอล หล่อลื่นหัวต่อ"],
         ["น้ำรั่วเข้าตู้", "ซีลประตูเสื่อมหรือมีเศษติด · รางน้ำตัน", "ทำความสะอาดซีลและรางน้ำ แจ้ง RRS ถ้ายังรั่ว"],
         ["ประตูปิดไม่สนิท", "บานพับหรือกลอนฝืด · จอดบนพื้นเอียง", "หล่อลื่น จอดบนพื้นเรียบแล้วลองใหม่"]], [24, 38, 38]))

# ---------------------------------------------------------------- 10 technical data
page("10. ข้อมูลทางเทคนิค (Technical data)", band("10. ข้อมูลทางเทคนิค", "Technical data") +
     table(["รายการ (Item)", "ค่า (Value)"], [
         ["ความยาวรวม · ตัวตู้ ยาว × กว้าง" + en("Overall length · box L × W"), "~7,256 · 5,700 × 1,806 มม."],
         ["ความสูงภายใน · ความกว้างรวม" + en("Inside height · overall width"), "~2,247 · ~2,394 มม."],
         ["คานแชสซีส์ · คานขวาง · พื้น" + en("Chassis rails · cross members · floor"), "คานคู่ ห่างศูนย์ 1,714 มม. · คานขวาง 9 ตัว ระยะ 600 มม. · พื้นเหล็กลาย"],
         ["ประตู · บานพับ" + en("Doors · hinges"), "ข้างละ 4 บาน · ประตูท้าย · ประตูหน้า · บานพับบานนอก 5 ตัว ระยะ 466 มม."],
         ["เพลา · ช่วงล่าง · ยาง" + en("Axles · suspension · tyres"), f"2 เพลา · {B} · {B}"],
         ["เบรก" + en("Brakes"), f"เบรกไฟฟ้าสั่งจากตัวควบคุมเบรก + ระบบ breakaway · {B}"],
         ["ปลั๊ก · ไฟ" + en("Plug · lamps"), "12 ขาแบน · ไฟบนหลังคา 4 ดวง · LED ≥ 550 mA ต่อวงจร"],
         ["กล้อง" + en("Camera"), "กล้องมองหลัง Ford N1WJ-19H391-A กลางท้ายตู้"],
         ["ชุดลากที่ใช้ได้" + en("Towbar"), "Ford 3.5 ตัน (Ø50) / 4.5 ตัน (Ø70)"],
         ["แรงขันโบลต์ยึดหัวต่อ" + en("Coupling bolt torque"), "130 ± 5 N·m (โบลต์ KEA เกรด 8.8)"]], [40, 60]) +
     remark(("ค่าจากแบบ 3D และเอกสาร RRS · ค่าที่เป็น ____ ให้ RRS ระบุก่อนพิมพ์", "Values from the RRS 3D model and documents · blanks to be filled by RRS before printing.")))

# ---------------------------------------------------------------- back cover
raw('''<div class="back"><img src="logo_white.png"><h2>บริษัท รุ่งเรืองกระบะดั้มพ์ 101</h2>
<p>ที่อยู่ ______________________________________________<br>โทรศัพท์ ____________________ · LINE ____________________<br>อีเมล ____________________ · เว็บไซต์ rungruengdump101.com</p>
<small>คู่มือการใช้งาน หางลากพ่วงตู้ทึบ RRS · Owner Manual – RRS Enclosed Box Trailer · P/N ____________</small></div>''', "nocrop")

A5 = '@page{size:148mm 210mm;margin:0}.page{width:185mm;height:262.5mm}'   # design page at A5 ratio; pdf.js prints it at 80 % = 148 x 210 mm
if __import__("os").environ.get("BLEED"):   # print-shop version: 3 mm bleed (3.75 mm design) round every page, edge colours run into it
    A5 = ('@page{size:154mm 216mm;margin:0}.page{width:192.5mm;height:270mm;border:3.75mm solid transparent;overflow:visible}'
          '.stripe{top:-3.75mm;bottom:-3.75mm;left:-3.75mm;width:17.75mm}.cfoot{bottom:-3.75mm;right:-3.75mm;height:23.75mm;padding-bottom:3.75mm}'
          '.back{inset:-3.75mm;padding-top:65.75mm;border-bottom-width:17.75mm}.tab{right:-3.75mm;width:11.75mm;padding-right:3.75mm}')
save("booklet.html", "RRS Owner Manual – Box Trailer", extra_css=M.CSS + A5 + '.tab{display:none}' + open(HERE / "style.css", encoding="utf-8").read() + '''
.coverfig.tr{top:154mm;left:24mm;right:10mm}.coverfig.tr .mvin img{max-height:66mm}.coverfig.tr svg{width:100%;max-height:60mm}
svg.diagram{width:100%;display:block}.figbox svg.diagram{max-height:60mm}.figbox.s svg.diagram{max-height:52mm}
.two2{display:flex;gap:5mm;align-items:flex-start}.two2>.figbox{flex:0 0 40%}.two2>.mv{flex:0 0 32%}.two2>table{flex:1}
.figbox svg.dwg{max-height:46mm}.figbox.s svg.dwg{max-height:34mm}.figbox.xs svg.dwg{max-height:24mm}
''')
