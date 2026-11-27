"""Relay / fuse map sticker for the cover of the fuse-relay box in the trailer tool box (14.5 x 5.5 cm).

Layout follows the box: relays 1-4 in a row over 11 blade fuses, relay 5 over relay 6 at the right.
Data from the RRS hand sketch (relays 1-6, fuses left to right). python3 make.py && node pdf.js
"""
RELAYS = {1: ("ไฟถอย", "Reverse"), 2: ("ไฟเบรก", "Stop"), 3: ("ไฟเลี้ยวขวา", "Turn RH"), 4: ("ไฟเลี้ยวซ้าย", "Turn LH"),
          5: ("ไฟหรี่", "Tail"), 6: ("เบรกไฟฟ้า", "Electric brake")}
# (amp, colour, label th, label en, span) – a span of 2 = two fuses on one circuit
FUSES = [(25, "clear", "เบรกไฟฟ้า", "Electric brake", 2), (10, "red", "ไฟถอย", "Reverse", 1), (10, "red", "ไฟในตู้", "Interior", 1),
         (10, "red", "ไฟเบรก", "Stop", 1), (30, "green", "แบตเตอรี่ B+", "Battery B+", 2), (10, "red", "เลี้ยวขวา", "Turn RH", 1),
         (10, "red", "สำรอง", "Spare", 1), (10, "red", "ไฟหรี่", "Tail", 1), (10, "red", "เลี้ยวซ้าย", "Turn LH", 1)]
COL = {"clear": ("#F4F6F8", "#8A94A3", "#111"), "red": ("#D7262E", "#9E1A20", "#fff"), "green": ("#1E9E4A", "#13703A", "#fff")}

W, H, M, G = 145, 55, 2.5, 1.2                   # mm
CW = (W - 2 * M - 4 * G) / 5                      # relay column width
TOP, RH = 9.5, 19.5                               # relay row
FY = TOP + RH + 1.6                               # fuse row
FH = H - M - FY
FW = (4 * CW + 3 * G) / 11


def relay(n, x, y, h):
    th, en = RELAYS[n]
    return (f'<div class="rl" style="left:{x}mm;top:{y}mm;width:{CW}mm;height:{h}mm"><b class="n">{n}</b>'
            f'<span class="th">{th}</span><span class="en">{en}</span><i>RELAY</i></div>')


def fuses():
    out, i = [], 0
    for amp, c, th, en, span in FUSES:
        bg, bd, fg = COL[c]
        x0 = M + i * FW
        for k in range(span):
            x = x0 + k * FW
            out.append(f'<div class="fz" style="left:{x + .7}mm;top:{FY}mm;width:{FW - 1.4}mm;background:{bg};border-color:{bd};color:{fg}">'
                       f'{amp}A</div>')
        lw = span * FW
        br = f'<div class="br" style="left:{x0 + 1}mm;width:{lw - 2}mm;top:{FY + 7.6}mm"></div>' if span > 1 else ""
        out.append(br + f'<div class="fl" style="left:{x0}mm;width:{lw}mm;top:{FY + 9.3}mm"><span class="th">{th}</span><span class="en">{en}</span></div>')
        i += span
    return "".join(out)


x5 = M + 4 * (CW + G)
body = (f'<div class="hd"><img src="logo.png"><b>ผังรีเลย์และฟิวส์</b><span>Relay &amp; fuse map · 12 V</span>'
        f'<em>ตัดไฟก่อนเปลี่ยนฟิวส์ · ใช้ขนาดเดิมเท่านั้น</em></div>'
        + "".join(relay(n, M + (n - 1) * (CW + G), TOP, RH) for n in (1, 2, 3, 4))
        + relay(5, x5, TOP, RH) + relay(6, x5, FY, FH) + fuses())
css = f'''@page{{size:{W}mm {H}mm;margin:0}}*{{box-sizing:border-box}}html,body{{margin:0}}
body{{width:{W}mm;height:{H}mm;position:relative;overflow:hidden;background:#fff;font-family:"Noto Sans Thai","Noto Sans",sans-serif;color:#0B2A5B}}
.cut{{position:absolute;inset:.6mm;border:.35mm solid #0B2A5B;border-radius:2.5mm}}
.hd{{position:absolute;left:{M}mm;right:{M}mm;top:{M - .6}mm;height:6mm;display:flex;align-items:center;gap:2mm;border-bottom:.3mm solid #1257C8}}
.hd img{{height:4.2mm}}.hd b{{font-size:9pt}}.hd span{{font-size:6.2pt;color:#1257C8}}.hd em{{margin-left:auto;font-style:normal;font-size:5.8pt;color:#A8262E;font-weight:bold}}
.rl{{position:absolute;background:#2B2F36;border-radius:1.6mm;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.15}}
.rl .n{{position:absolute;left:1.2mm;top:1mm;width:4.6mm;height:4.6mm;border-radius:50%;background:#fff;color:#2B2F36;font-size:8pt;text-align:center;line-height:4.6mm;font-family:"Noto Sans"}}
.rl .th{{font-size:9pt;font-weight:bold;margin-top:1mm}}.rl .en{{font-size:5.6pt;color:#c9d3e3;font-family:"Noto Sans"}}
.rl i{{position:absolute;right:1.2mm;top:1mm;font-style:normal;font-size:4.4pt;color:#8a94a3;font-family:"Noto Sans";letter-spacing:.08em}}
.fz{{position:absolute;height:7mm;border:.3mm solid;border-radius:.8mm .8mm .4mm .4mm;font-family:"Noto Sans";font-weight:bold;font-size:6.4pt;display:flex;align-items:center;justify-content:center}}
.br{{position:absolute;height:.9mm;border:.3mm solid #0B2A5B;border-top:0}}
.fl{{position:absolute;text-align:center;line-height:1.05}}.fl .th{{display:block;font-size:6.3pt;font-weight:bold;white-space:nowrap}}.fl .en{{display:block;font-size:4.4pt;color:#5b6577;font-family:"Noto Sans";white-space:nowrap}}
'''
open("sticker.html", "w", encoding="utf-8").write(f'<!doctype html><html lang="th"><meta charset="utf-8"><style>{css}</style><body><div class="cut"></div>{body}</body></html>')
print("sticker.html", W, "x", H, "mm")
