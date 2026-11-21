"""คู่มือการใช้งาน (Owner Manual) – กระบะพื้นเรียบคาร์โก้ RRS สำหรับ Ford Ranger Super Duty.

Structure modelled on a carmaker's owner manual for a 3-way-opening cargo bed (warranty, components, safe driving,
dimensions, gates, adjustment, part removal); the wording, values and drawings are RRS's own.
Shares the layout of ../warranty_booklet (common.py). python3 build.py && node pdf.js
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warranty_booklet"))
from common import *  # noqa: E402,F403
from drawings import components, top_view, latch, gate_open  # noqa: E402

set_footer("คู่มือการใช้งาน · กระบะพื้นเรียบคาร์โก้ RRS · Ford Ranger Super Duty")


def h2(th, en):
    return f'<h2>{th} <span class="en">({en})</span></h2>'


def h3(th, en):
    return f'<h3>{th} <span class="en">({en})</span></h3>'


def step(th, en):
    return f'<li>{th}<span class="en-line">{en}</span></li>'


def steps(*items):
    return '<ol class="msteps">' + "".join(step(t, e) for t, e in items) + "</ol>"


def warn(th, en, title="คำเตือน (Warning)"):
    return f'<div class="warn"><b>⚠ {title}</b><br>{th}<span class="en-line">{en}</span></div>'


def caution(th, en):
    return f'<div class="note"><b>ข้อควรระวัง (Caution)</b> {th}<span class="en-line">{en}</span></div>'


def fig(svg, cap=""):
    return f'<div class="figbox">{svg}' + (f'<p class="cap">{cap}</p>' if cap else "") + "</div>"


# 1 cover
raw('''<div class="cover"><div class="stripe"></div>
<img class="biglogo" src="logo.png">
<div class="ctitle"><small>OWNER MANUAL</small><h1>คู่มือการใช้งาน</h1><p>กระบะพื้นเรียบคาร์โก้ RRS เปิด 3 ทาง<br><span style="color:#1257C8">RRS Cargo Flatbed · 3-way opening · Ford Ranger Super Duty</span></p></div>
<div class="coverfig">''' + components() + '''</div>
<div class="cfoot"><span>รหัสคู่มือ (P/N) ____________</span><span>Serial No. กระบะ ____________</span></div></div>''', "nocrop")

# 2 contents
toc = [("ก่อนใช้งาน", "Before use", [("เงื่อนไขการรับประกัน", "Warranty conditions", 3), ("ส่วนประกอบของกระบะ", "Components", 4),
                                     ("เพื่อการขับขี่อย่างปลอดภัย", "For safe driving", 5)]),
       ("1. ขนาดและน้ำหนัก", "Dimensions and weight", [("ขนาดพื้นกระบะ", "Floor dimensions", 7), ("น้ำหนักกระบะ", "Body weight", 7)]),
       ("2. ฝาท้าย", "Tailgate", [("การล็อก / ปลดล็อก", "Locking / unlocking", 8), ("การเปิด / ปิด 90° และ 180°", "Opening / closing 90° and 180°", 9)]),
       ("3. ฝาข้าง", "Side gates", [("การล็อก / ปลดล็อก และการเปิด / ปิด", "Locking, unlocking, opening and closing", 10)]),
       ("4. การปรับตั้งกลอนล็อก", "Adjusting the latch", [("เมื่อกลอนแน่นหรือหลวมเกินไป", "Latch too tight or too loose", 11)]),
       ("5. การบรรทุกและการผูกรัด", "Loading and tie-down", [("การจัดวางและรัดสินค้า", "Placing and securing the load", 12)]),
       ("6. การถอด / ประกอบชิ้นส่วน", "Removing / installing parts", [("ฝาท้าย", "Tailgate", 13), ("ฝาข้างซ้าย / ขวา", "Side gate LH / RH", 14), ("ตะแกรงกันหัว", "Headboard", 14)]),
       ("7. การดูแลรักษา", "Care and maintenance", [("การตรวจประจำวันและตามระยะ", "Daily and periodic checks", 15)])]
rows = ""
for t, e, subs in toc:
    rows += f'<tr class="grp"><td colspan="2"><b>{t}</b> <span class="en">({e})</span></td></tr>'
    for st, se, pg in subs:
        rows += f'<tr><td>{st} <span class="en">({se})</span></td><td class="pg">{pg}</td></tr>'
page("สารบัญ (Contents)", h2("สารบัญ", "Contents") + f'<table class="toc"><colgroup><col style="width:88%"><col style="width:12%"></colgroup><tbody>{rows}</tbody></table>'
     '<div class="note" style="margin-top:2mm">คู่มือเล่มนี้ใช้คู่กับ <b>สมุดรับประกันและการบำรุงรักษา ผลิตภัณฑ์ RRS</b> ซึ่งระบุระยะเวลาและเงื่อนไขการรับประกันโดยละเอียด'
     '<span class="en-line">Use this manual together with the RRS Warranty and Maintenance Booklet, which sets out the warranty periods and terms in full.</span></div>')

# 3 warranty
page("เงื่อนไขการรับประกัน (Warranty conditions)", h2("เงื่อนไขการรับประกัน", "Warranty conditions") + '<ol class="msteps">' +
     step("การรับประกันเริ่มนับจากวันส่งมอบรถให้แก่ลูกค้า ตามที่ระบุในบัตรรับประกัน",
          "The warranty starts on the delivery date shown on the warranty card.") +
     step("RRS รับประกันความบกพร่องอันเกิดจากวัสดุ ฝีมือการผลิต หรือการติดตั้งของ RRS โดยไม่คิดค่าชิ้นส่วนและค่าแรง ตามระยะเวลาดังนี้: โครงสร้างกระบะ 5 ปี · ฝาข้างและฝาท้าย 1 ปี · อุปกรณ์ประกอบ 1 ปี",
          "RRS covers defects in materials, workmanship or RRS installation, parts and labour included: body structure 5 years · side gates and tailgate 1 year · accessories 1 year.") +
     step("การรับประกันไม่ครอบคลุมกรณีดังต่อไปนี้ แม้อยู่ในระยะเวลารับประกัน", "The warranty does not apply in the following cases, even within the warranty period.") + '</ol>'
     '<ul class="terms sub">'
     '<li>ความเสียหายจากการใช้งานผิดวัตถุประสงค์ หรือไม่ปฏิบัติตามคู่มือเล่มนี้<span class="en-line">Damage from misuse or not following this manual.</span></li>'
     '<li>การบรรทุกเกิน 1,500 กก. หรือเกินพิกัดน้ำหนักที่ Ford กำหนด<span class="en-line">Loads over 1,500 kg or over the limits set by Ford.</span></li>'
     '<li>การดัดแปลง หรือการซ่อมโดยผู้ให้บริการที่ RRS ไม่ได้มอบหมาย<span class="en-line">Modification, or repair by a service provider not appointed by RRS.</span></li>'
     '<li>อุบัติเหตุ เหตุสุดวิสัย และภัยธรรมชาติ<span class="en-line">Accidents, force majeure and natural disasters.</span></li>'
     '<li>ความเสียหายของแชสซีส์และชิ้นส่วนเดิมของ Ford (อยู่ในการรับประกันของ Ford)<span class="en-line">Damage to the Ford chassis and original Ford parts (covered by Ford\'s warranty).</span></li></ul>'
     '<ol class="msteps" start="4">' +
     step("RRS ขอสงวนสิทธิ์ในการเปลี่ยนแปลงข้อกำหนดและเงื่อนไข โดยจะแจ้งให้ทราบล่วงหน้า",
          "RRS reserves the right to change these terms and conditions with prior notice.") + '</ol>'
     '<div class="note">รายละเอียดสิ่งที่รับประกันและไม่รับประกัน ดูสมุดรับประกันและการบำรุงรักษา ส่วนกระบะพื้นเรียบคาร์โก้'
     '<span class="en-line">For what is and is not covered, see the Cargo Flatbed section of the Warranty and Maintenance Booklet.</span></div>')

# 4 components
parts = [("1", "ตะแกรงกันหัว", "Headboard"), ("2", "ฝาข้างซ้าย / ขวา", "Side gate LH / RH"), ("3", "ฝาท้าย", "Tailgate"),
         ("4", "บานพับฝาข้าง (ข้างละ 3 จุด)", "Side gate hinges (3 per side)"), ("5", "กลอนล็อกฝาข้าง", "Side gate latch"),
         ("6", "ตะขอผ้าใบ / จุดผูกรัด", "Rope hooks / tie-down points"), ("7", "โรบาร์หลัง · ไฟท้าย · ป้ายทะเบียน", "Rear bar · tail lamps · number plate"),
         ("8", "บังโคลน", "Mudguard")]
page("ส่วนประกอบของกระบะ (Components)", h2("ส่วนประกอบของกระบะ", "Components") + '<p>กระบะพื้นเรียบคาร์โก้ RRS เปิด 3 ทาง (ฝาข้างซ้าย ฝาข้างขวา และฝาท้าย)'
     '<span class="en-line">RRS cargo flatbed with 3-way opening (left side gate, right side gate and tailgate).</span></p>' + fig(components()) +
     table(["#", "ชิ้นส่วน", "Part"], [[f'<span class="num">{n}</span>', t, f'<span class="en">{e}</span>'] for n, t, e in parts], [8, 50, 42], "plist"))

# 5-6 safe driving
page("เพื่อการขับขี่อย่างปลอดภัย (For safe driving)", h2("เพื่อการขับขี่อย่างปลอดภัย", "For safe driving") +
     warn("ปฏิบัติตามข้อควรระวังต่อไปนี้ทุกครั้ง หากไม่ปฏิบัติอาจทำให้เกิดการบาดเจ็บสาหัสหรือเสียชีวิตได้",
          "Always observe the following. Failure to do so may result in serious injury or death.", "คำเตือนในขณะขับขี่ (Warning while driving)") +
     '<ul class="terms">'
     '<li>ห้ามขับรถขณะฝาท้ายหรือฝาข้างเปิดอยู่ ฝาที่เปิดอาจแกว่งกระแทกบุคคลหรือรถคันอื่น<span class="en-line">Do not drive with the tailgate or a side gate open; an open gate may swing and strike people or other vehicles.</span></li>'
     '<li>ห้ามยืนหรือนั่งบนฝาท้ายที่เปิดอยู่ และห้ามให้ผู้ใดโดยสารบนกระบะ<span class="en-line">Do not stand or sit on an open tailgate, and never carry passengers on the bed.</span></li>'
     '<li>ก่อนออกรถ ตรวจว่ากลอนล็อกทุกจุดล็อกสนิท และสินค้าผูกรัดแน่น<span class="en-line">Before driving off, check that every latch is fully locked and the load is tied down.</span></li>'
     '<li>บรรทุกไม่เกิน 1,500 กก. และไม่เกินพิกัดน้ำหนักลงเพลาของ Ford<span class="en-line">Do not load more than 1,500 kg or exceed Ford\'s axle load limits.</span></li>'
     '<li>สินค้าที่ยื่นเลยท้ายกระบะต้องติดธงหรือไฟเตือนตามกฎหมาย<span class="en-line">Mark any load that overhangs the rear with a flag or lamp as required by law.</span></li></ul>')

page("เพื่อการขับขี่อย่างปลอดภัย (For safe driving)", h3("ก่อนเปิด / ปิดฝาท้ายและฝาข้าง", "Before opening or closing a gate") +
     '<ul class="terms">'
     '<li>จอดรถบนพื้นเรียบ ดับเครื่องยนต์ และดึงเบรกมือ<span class="en-line">Park on level ground, stop the engine and apply the parking brake.</span></li>'
     '<li>ตรวจว่าสินค้าไม่พิงฝาอยู่ เพราะฝาอาจเปิดออกแรงและสินค้าตกหล่น<span class="en-line">Make sure no load is resting against the gate; it may swing open hard and the load may fall.</span></li>'
     '<li>ตรวจว่าบริเวณรอบรถมีพื้นที่เพียงพอ และไม่มีบุคคลอยู่ในรัศมีการเปิดฝา<span class="en-line">Check that there is room around the vehicle and nobody within the swing of the gate.</span></li>'
     '<li>ระวังนิ้วมือถูกหนีบระหว่างฝากับเสามุม ขณะเปิดและปิดฝา<span class="en-line">Keep fingers clear of the gap between gate and corner post when opening and closing.</span></li>'
     '<li>จับฝาไว้ขณะปลดกลอนตัวสุดท้าย และค่อย ๆ ลดฝาลง อย่าปล่อยให้ฝาตกกระแทก<span class="en-line">Hold the gate while releasing the last latch and lower it gently; never let it drop.</span></li></ul>' +
     h3("ขณะบรรทุก", "While loading") +
     '<ul class="terms">'
     '<li>อย่าวางหรือโยนสินค้าหนักลงบนฝาท้ายที่เปิดอยู่<span class="en-line">Do not place or drop heavy loads on the open tailgate.</span></li>'
     '<li>ฝาท้ายแบบเปิด 90° รับน้ำหนักได้ไม่เกิน ____ กก. กระจายทั่วฝา<span class="en-line">An open tailgate at 90° carries no more than ____ kg spread across the gate.</span></li>'
     '<li>ห้ามใช้ฝาข้างเป็นจุดผูกรัดสินค้า ใช้ตะขอผ้าใบหรือจุดผูกรัดของโครงเท่านั้น<span class="en-line">Do not tie loads to the side gates; use the rope hooks or frame tie-down points only.</span></li></ul>')

# 7 dimensions & weight
page("ขนาดและน้ำหนัก (Dimensions and weight)", h2("1. ขนาดและน้ำหนัก", "Dimensions and weight") + h3("1.1 ขนาดพื้นกระบะ", "Floor dimensions") +
     fig(top_view(), "กระบะพื้นเรียบคาร์โก้ Single Cab (มองจากด้านบน) · RRS cargo flatbed, Single Cab (top view)") +
     table(["รุ่นเก๋ง (Cab)", "ความยาวพื้น (Floor length)", "ความกว้างพื้น (Floor width)", "ความยาวรวม (Overall length)"], [
      ["Single Cab", "2,669 มม.", "1,874 มม.", "2,801 มม."],
      ["Super Cab", "≤ 2,190 มม.", "1,874 มม.", "______ มม."],
      ["Double Cab", "≤ 1,890 มม.", "1,874 มม.", "______ มม."]], [25, 25, 25, 25]) +
     h3("1.2 น้ำหนักกระบะ", "Body weight") +
     table(["รุ่นเก๋ง (Cab)", "น้ำหนักกระบะ (Body weight)", "น้ำหนักบรรทุกสูงสุด (Max. payload)"], [
      ["Single Cab", "______ กก.", "1,500 กก."], ["Super Cab", "______ กก.", "1,500 กก."], ["Double Cab", "______ กก.", "1,500 กก."]], [34, 33, 33]) +
     '<p class="small">น้ำหนักบรรทุกที่ใช้ได้จริงของรถแต่ละคัน ดูบัตรรับประกัน · ขนาดจากแบบของ RRS อาจคลาดเคลื่อนตามรุ่นการผลิต<br>'
     'Actual payload of each vehicle: see the warranty card · Dimensions from RRS drawings, may vary by production batch.</p>')

# 8 tailgate lock
page("ฝาท้าย (Tailgate)", h2("2. ฝาท้าย", "Tailgate") + '<p>ฝาท้ายล็อก ปลดล็อก และเปิด / ปิดได้ตามขั้นตอนต่อไปนี้<span class="en-line">The tailgate is locked, unlocked, opened and closed as follows.</span></p>' +
     h3("2.1 การล็อก / ปลดล็อกฝาท้าย", "Locking / unlocking the tailgate") +
     '<div class="two">' + fig(latch(True)) + fig(latch(False)) + '</div>' +
     h3("2.1.1 การล็อก", "Locking") +
     steps(("ยกฝาท้ายขึ้นจนชิดเสามุมทั้งสองข้าง", "Raise the tailgate until it rests against both corner posts."),
           ("ดึงคันกลอนขึ้น แล้วกดลงให้ครอบตะขอที่เสามุม ทั้งด้านซ้ายและขวา", "Lift the latch lever and press it down over the hook on the corner post, left and right."),
           ("ตรวจว่าคันกลอนแนบสนิทและฝาไม่โยก", "Check that both levers sit flat and the gate does not rattle.")) +
     h3("2.1.2 การปลดล็อก", "Unlocking") +
     steps(("จับฝาท้ายไว้ด้วยมือข้างหนึ่ง", "Hold the tailgate with one hand."),
           ("ดึงคันกลอนขึ้นและหมุนออกจากตะขอ ทั้งด้านซ้ายและขวา", "Lift each latch lever and turn it off the hook, left and right.")) +
     caution("ปลดกลอนทีละข้าง และจับฝาไว้ตลอด เพื่อไม่ให้ฝาตกกระแทก", "Release one side at a time and keep hold of the gate so it does not drop."))

# 9 tailgate open/close
page("ฝาท้าย (Tailgate)", h3("2.2 การเปิด / ปิดฝาท้าย", "Opening / closing the tailgate") +
     '<div class="two">' + fig(gate_open(90)) + fig(gate_open(180)) + '</div>' +
     h3("2.2.1 เปิด / ปิดแบบ 90° (ฝาท้ายรับของ)", "Open / close at 90° (tailgate as a shelf)") +
     steps(("ปลดล็อกตามข้อ 2.1.2 แล้วค่อย ๆ ลดฝาลงจนโซ่หรือสลิงรั้งตึงทั้งสองข้าง", "Unlock as in 2.1.2 and lower the gate until both stays are taut."),
           ("การปิด: ยกฝาขึ้นจนชิดเสามุม แล้วล็อกตามข้อ 2.1.1", "To close: raise the gate against the corner posts and lock as in 2.1.1.")) +
     h3("2.2.2 เปิด / ปิดแบบ 180° (ฝาท้ายห้อยลง)", "Open / close at 180° (tailgate hanging)") +
     steps(("เปิดฝาแบบ 90° ก่อน จากนั้นถอดโซ่หรือสลิงรั้งออกจากหูยึดทั้งสองข้าง", "Open to 90° first, then unhook both stays."),
           ("ค่อย ๆ ลดฝาลงจนห้อยแนบท้ายกระบะ", "Lower the gate gently until it hangs against the rear of the body."),
           ("การปิด: ยกฝาขึ้นแบบ 90° คล้องโซ่หรือสลิงกลับเข้าหูยึด แล้วปิดและล็อก", "To close: raise to 90°, refit the stays, then close and lock.")) +
     warn("ห้ามขับรถขณะฝาท้ายเปิดแบบ 180° ฝาอาจกระแทกพื้นหรือป้ายทะเบียนถูกบัง", "Do not drive with the tailgate at 180°; it may strike the road and covers the number plate.") +
     '<p class="small">สำหรับรุ่นที่มีโซ่หรือสลิงรั้งฝาท้าย · For bodies fitted with tailgate stays.</p>')

# 10 side gates
page("ฝาข้าง (Side gates)", h2("3. ฝาข้าง", "Side gates") + '<p>ฝาข้างซ้ายและขวายึดกับพื้นกระบะด้วยบานพับข้างละ 3 จุด และล็อกกับเสามุมด้านหน้าและด้านหลัง'
     '<span class="en-line">Each side gate is hinged to the floor at 3 points and latched to the front and rear corner posts.</span></p>' +
     h3("3.1 การล็อก / ปลดล็อกฝาข้าง", "Locking / unlocking the side gate") +
     steps(("การล็อก: ยกฝาข้างขึ้นชิดเสามุม ดึงคันกลอนขึ้นแล้วกดลงครอบตะขอ ทั้งด้านหน้าและด้านหลัง", "Locking: raise the gate against the posts, lift each latch lever and press it down over the hook, front and rear."),
           ("การปลดล็อก: จับฝาข้างไว้ ดึงคันกลอนขึ้นและหมุนออกจากตะขอ ทั้งด้านหน้าและด้านหลัง", "Unlocking: hold the gate, lift each latch lever and turn it off the hook, front and rear.")) +
     h3("3.2 การเปิด / ปิดฝาข้าง", "Opening / closing the side gate") +
     steps(("ปลดล็อกฝาท้ายก่อน หากต้องการเปิดฝาข้างด้านหลังสุด", "Unlock the tailgate first if the rear latch of the side gate is behind it."),
           ("ปลดล็อกฝาข้าง แล้วค่อย ๆ ลดฝาลงจนห้อยข้างกระบะ", "Unlock the side gate and lower it gently until it hangs beside the body."),
           ("การปิด: ยกฝาข้างขึ้น ล็อกตามข้อ 3.1 แล้วจึงปิดและล็อกฝาท้าย", "To close: raise the side gate, lock it as in 3.1, then close and lock the tailgate.")) +
     caution("ฝาข้างมีน้ำหนักมาก ควรเปิดและปิดโดยจับที่ขอบบนของฝา และยืนพ้นรัศมีการเปิด", "The side gate is heavy: hold it by the top edge and stand clear of its swing.") +
     warn("ห้ามขับรถขณะฝาข้างเปิดหรือห้อยอยู่", "Never drive with a side gate open or hanging."))

# 11 latch adjust
page("การปรับตั้งกลอนล็อก (Adjusting the latch)", h2("4. การปรับตั้งกลอนล็อก", "Adjusting the latch") +
     '<p>เมื่อล็อกแล้วรู้สึกว่าคันกลอนแน่นเกินไปหรือหลวมเกินไป ปรับตั้งได้ที่น็อตปรับของตะขอ'
     '<span class="en-line">If a latch feels too tight or too loose when locked, adjust it at the hook\'s adjusting nut.</span></p>' +
     fig(latch(True), "ตำแหน่งตะขอและน็อตปรับที่เสามุม · Hook and adjusting nut on the corner post") +
     steps(("ปลดล็อกคันกลอนที่ต้องการปรับ", "Unlock the latch to be adjusted."),
           ("คลายน็อตล็อกของตะขอด้วยประแจเบอร์ ____", "Loosen the hook's lock nut with a ____ mm spanner."),
           ("แน่นเกินไป: หมุนตะขอทวนเข็มนาฬิกา · หลวมเกินไป: หมุนตามเข็มนาฬิกา ครั้งละครึ่งรอบ", "Too tight: turn the hook counter-clockwise · Too loose: turn it clockwise, half a turn at a time."),
           ("ลองล็อก จนคันกลอนกดลงได้ด้วยแรงมือพอดีและฝาไม่โยก แล้วขันน็อตล็อกให้แน่น", "Try the latch until it closes with firm hand pressure and the gate does not rattle, then tighten the lock nut.")) +
     caution("ถ้าปรับแล้วยังล็อกไม่สนิท หรือตะขอคด ให้หยุดใช้งานและติดต่อ RRS", "If the latch still does not lock fully, or the hook is bent, stop using the gate and contact RRS."))

# 12 loading
page("การบรรทุกและการผูกรัด (Loading and tie-down)", h2("5. การบรรทุกและการผูกรัด", "Loading and tie-down") +
     table(["ควรทำ (Do)", "ไม่ควรทำ (Don't)"], [
      ["กระจายน้ำหนักทั่วพื้น ให้ของหนักอยู่ด้านหน้าและกลางกระบะ<br><span class=\"en\">Spread the load, heavy items forward and centred.</span>",
       "กองของหนักไว้จุดเดียว หรือไว้ท้ายสุดของกระบะ<br><span class=\"en\">Pile heavy items in one spot or at the very rear.</span>"],
      ["รัดสินค้ากับตะขอผ้าใบและจุดผูกรัดของโครง<br><span class=\"en\">Tie the load to the rope hooks and frame tie-down points.</span>",
       "รัดสินค้ากับฝาข้าง ฝาท้าย หรือตะแกรงกันหัว<br><span class=\"en\">Tie the load to the side gates, tailgate or headboard.</span>"],
      ["วางสินค้าลงพื้นอย่างนุ่มนวล ใช้ไม้รองเมื่อใช้รถยก<br><span class=\"en\">Set loads down gently; use timber when using a forklift.</span>",
       "ทิ้งหรือกระแทกสินค้าลงพื้นกระบะ<br><span class=\"en\">Drop or bang loads onto the floor.</span>"],
      ["ตรวจความแน่นของสายรัดหลังขับไปไม่กี่กิโลเมตร<br><span class=\"en\">Re-check the straps after the first few kilometres.</span>",
       "ต่อเสริมฝาข้างให้สูงขึ้นเพื่อบรรทุกเพิ่ม<br><span class=\"en\">Extend the side gates upward to carry more.</span>"]], [50, 50], "dodont") +
     warn("น้ำหนักบรรทุกบนกระบะต้องไม่เกิน 1,500 กก. และน้ำหนักรถรวมต้องไม่เกิน GVM 4,500 กก. ของ Ford",
          "The load on the body must not exceed 1,500 kg and the gross vehicle mass must not exceed Ford's 4,500 kg GVM."))

# 13 remove tailgate
page("การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", h2("6. การถอด / ประกอบชิ้นส่วน", "Removing / installing parts") +
     warn("การถอดและประกอบฝาต้องใช้ผู้ปฏิบัติงานอย่างน้อย 2 คน ฝามีน้ำหนักมาก อาจตกทับทำให้บาดเจ็บได้",
          "Removing and installing a gate needs at least 2 people; gates are heavy and can cause injury if dropped.") +
     h3("6.1 การถอด / ประกอบฝาท้าย", "Removing / installing the tailgate") +
     steps(("เปิดฝาท้ายแบบ 90° แล้วถอดโซ่หรือสลิงรั้งออกทั้งสองข้าง", "Open the tailgate to 90° and unhook both stays."),
           ("ถอดสลักบานพับฝาท้าย (ถอดปิ๊นล็อกก่อน) ขณะผู้ช่วยจับฝาไว้", "Remove the tailgate hinge pins (take out the retaining clips first) while a helper holds the gate."),
           ("ยกฝาออกจากบานพับ และวางบนพื้นเรียบที่มีวัสดุรอง", "Lift the gate off the hinges and lay it on a padded, level surface."),
           ("การประกอบ: ทำย้อนลำดับ ทาจารบีที่สลักบานพับก่อนใส่ และใส่ปิ๊นล็อกทุกตัว", "To install: reverse the steps, grease the hinge pins first and refit every retaining clip.")) +
     '<p class="small">จำนวนและขนาดสลักบานพับ ____ · Number and size of hinge pins ____</p>')

# 14 side gate + headboard
page("การถอด / ประกอบชิ้นส่วน (Removing / installing parts)", h3("6.2 การถอด / ประกอบฝาข้างซ้าย / ขวา", "Removing / installing the side gate LH / RH") +
     steps(("เปิดฝาท้าย แล้วปลดล็อกและลดฝาข้างลง", "Open the tailgate, then unlock and lower the side gate."),
           ("ถอดสลักบานพับทั้ง 3 จุด โดยเริ่มจากจุดกลาง ขณะผู้ช่วยจับฝาไว้", "Remove all 3 hinge pins, starting with the middle one, while a helper holds the gate."),
           ("ยกฝาออก และวางบนพื้นเรียบที่มีวัสดุรอง", "Lift the gate away and lay it on a padded, level surface."),
           ("การประกอบ: ทำย้อนลำดับ ทาจารบีที่สลักบานพับ และตรวจว่าฝาล็อกได้สนิททั้งหน้าและหลัง", "To install: reverse the steps, grease the pins and check the gate locks fully front and rear.")) +
     h3("6.3 การถอด / ประกอบตะแกรงกันหัว", "Removing / installing the headboard") +
     steps(("เปิดฝาข้างทั้งสองข้าง", "Open both side gates."),
           ("ถอดสลักและน็อตยึดตะแกรงกันหัวกับเสามุมหน้าและพื้นกระบะ จำนวน ____ ตัว", "Remove the ____ bolts that fix the headboard to the front corner posts and the floor."),
           ("ยกตะแกรงออกโดยระวังไม่ให้กระแทกกระจกหลังเก๋ง", "Lift the headboard away, taking care not to strike the cab rear window."),
           ("การประกอบ: ทำย้อนลำดับ ขันน็อตตามแรงขัน ____ Nm และตรวจว่าตะแกรงไม่แตะเก๋ง", "To install: reverse the steps, tighten to ____ Nm and check the headboard does not touch the cab.")) +
     caution("ห้ามขับรถโดยไม่มีตะแกรงกันหัว เมื่อบรรทุกสินค้าที่อาจเลื่อนไปข้างหน้า", "Do not drive without the headboard when carrying loads that could slide forward."))

# 15 care
page("การดูแลรักษา (Care and maintenance)", h2("7. การดูแลรักษา", "Care and maintenance") +
     table(["ระยะ (Interval)", "รายการ (Item)", "ผู้ทำ (By)"], [
      ["ก่อนใช้งานทุกวัน<br><span class=\"en\">Every day</span>", ["กลอนล็อกทุกจุดล็อกสนิท<span class=\"en-line\">All latches lock fully</span>", "ไฟท้ายทำงาน<span class=\"en-line\">Tail lamps work</span>", "สายรัดสินค้าแน่น<span class=\"en-line\">Load straps are tight</span>"], "ผู้ใช้รถ<br><span class=\"en\">Driver</span>"],
      ["ทุกเดือน<br><span class=\"en\">Monthly</span>", ["หล่อลื่นบานพับ กลอนล็อก และสลัก<span class=\"en-line\">Lubricate hinges, latches and pins</span>", "ตรวจรอยร้าวที่ตะแกรงกันหัวและเสามุม<span class=\"en-line\">Check headboard and posts for cracks</span>"], "ผู้ใช้รถ<br><span class=\"en\">Driver</span>"],
      ["1 เดือน / 1,000 กม. แรก<br><span class=\"en\">First month / 1,000 km</span>", ["ตรวจแรงขันสลักแท่นยึดกับแชสซีส์<span class=\"en-line\">Check mounting bolt torque</span>"], "RRS"],
      ["ทุก 6 เดือน / 10,000 กม.<br><span class=\"en\">Every 6 months / 10,000 km</span>", ["แรงขันสลักแท่นยึด · รอยร้าวโครง · สายไฟ<span class=\"en-line\">Mounting torque · frame cracks · wiring</span>"], "RRS"],
      ["หลังล้างรถหรือบรรทุกวัสดุกัดกร่อน<br><span class=\"en\">After washing or corrosive loads</span>", ["ล้างคราบออกและหล่อลื่นบานพับซ้ำ<span class=\"en-line\">Rinse off and re-lubricate the hinges</span>"], "ผู้ใช้รถ<br><span class=\"en\">Driver</span>"]], [28, 54, 18], "care") +
     '<div class="note">บันทึกการเข้ารับบริการในสมุดรับประกันและการบำรุงรักษา เพื่อคงสิทธิ์การรับประกัน'
     '<span class="en-line">Record each service in the Warranty and Maintenance Booklet to keep the warranty valid.</span></div>')

# 16 back cover
raw('''<div class="back"><img src="logo_white.png"><h2>บริษัท รุ่งเรืองกระบะดั้มพ์ 101</h2>
<p>ที่อยู่ ______________________________________________<br>โทรศัพท์ ____________________ · LINE ____________________<br>อีเมล ____________________ · เว็บไซต์ rungruengdump101.com</p>
<small>คู่มือการใช้งาน กระบะพื้นเรียบคาร์โก้ RRS · Owner Manual – RRS Cargo Flatbed</small></div>''', "nocrop")

save("booklet.html", "RRS Owner Manual – Cargo Flatbed", extra_css='''
.en{color:#5b6577;font-weight:normal;font-size:.82em}.en-line{display:block;color:#5b6577;font-size:.86em;margin-top:.4mm}
h2 .en{font-size:.6em}h3 .en{font-size:.78em}
ol.msteps{padding-left:6mm;margin:0 0 3mm}ol.msteps li{margin-bottom:1.8mm;line-height:1.45}ol.msteps li::marker{color:#1257C8;font-weight:bold}
ul.terms.sub{margin-left:6mm}
.figbox{margin:1mm 0 3mm;text-align:center}.figbox svg.dwg{width:100%;max-height:60mm}.figbox svg.dwg.small{max-height:46mm}.two .figbox{flex:1}
.coverfig{position:absolute;top:140mm;left:30mm;right:16mm}.coverfig svg{width:100%;max-height:72mm}
.cover .ctitle h1{font-size:34pt}
table.toc td{padding:.95mm 2.5mm;font-size:9.4pt}table.toc tr.grp td{background:#EAF2FB!important;color:#0B2A5B;padding-top:1.6mm}table.toc td.pg{text-align:right;color:#1257C8;font-weight:bold}
table.plist td{padding:1.6mm 2.5mm}.num{display:inline-flex;width:6mm;height:6mm;border-radius:50%;background:#0B2A5B;color:#fff;font-weight:bold;align-items:center;justify-content:center;font-size:9pt}
table.dodont th:first-child{background:#1F9D6B}table.dodont th:last-child{background:#D9534F}table.dodont td{line-height:1.5}
table.care td{vertical-align:top}
''')
