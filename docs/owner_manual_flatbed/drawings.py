"""Line drawings for the RRS cargo-flatbed owner manual – original RRS artwork, simple SVG.

Sizes and part layout follow the RRS flatbed model (docs/FORD_SUPER_DUTY_INSTALL.md 2.5 and 6.2): floor 2,669 x 1,874 mm,
main frame 1,962 mm, side gates hinged at 3 points 900 mm apart, 8 tie-down slots in the floor.
"""

INK, NAVY, BLUE, CYAN, FILL, LIGHT, RED, GREEN = "#2B2F36", "#0B2A5B", "#1257C8", "#00B4F0", "#F3F6FA", "#DCE6F2", "#D9534F", "#1F9D6B"
FONT = 'font-family="Noto Sans, Noto Sans Thai"'


def _svg(body, vb, cls="dwg"):
    defs = (f'<defs><marker id="ar" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
            f'<path d="M0 0 L10 5 L0 10 z" fill="{CYAN}"/></marker>'
            f'<marker id="dm" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0 0 L10 5 L0 10 z" fill="{NAVY}"/></marker></defs>')
    return f'<svg class="{cls}" viewBox="{vb}" xmlns="http://www.w3.org/2000/svg">{defs}{body}</svg>'


def _num(n, x, y, r=9, fill=NAVY):
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}"/>'
            f'<text x="{x}" y="{y + r * .42:.1f}" text-anchor="middle" font-size="{r * 1.2:.0f}" font-weight="bold" fill="#fff" {FONT}>{n}</text>')


def _call(n, x, y, tx, ty):
    return f'<line x1="{tx}" y1="{ty}" x2="{x}" y2="{y}" stroke="{NAVY}" stroke-width="1.3"/><circle cx="{x}" cy="{y}" r="2.6" fill="{NAVY}"/>' + _num(n, tx, ty)


def _txt(x, y, s, size=12, color=NAVY, anchor="middle", bold=True):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" {"font-weight=\"bold\"" if bold else ""} fill="{color}" {FONT}>{s}</text>'


def _zoom(x, y, w, h, body):
    return f'<g><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="#fff" stroke="{INK}" stroke-width="1.4"/>{body}</g>'


def _truck(g, x=0, open_side=False, open_tail=False):
    """Three-quarter side view of the cab and the flatbed."""
    g.append(f'<path d="M{x + 40} 150 L{x + 40} 92 Q{x + 42} 70 {x + 70} 66 L{x + 128} 62 L{x + 150} 100 L{x + 152} 150 Z" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    g.append(f'<path d="M{x + 72} 74 L{x + 124} 70 L{x + 140} 100 L{x + 72} 100 Z" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>')
    g.append(f'<rect x="{x + 156}" y="62" width="10" height="70" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    for yy in range(70, 130, 10):
        g.append(f'<line x1="{x + 156}" y1="{yy}" x2="{x + 166}" y2="{yy}" stroke="{INK}" stroke-width=".8"/>')
    g.append(f'<path d="M{x + 166} 108 L{x + 420} 108 L{x + 452} 92 L{x + 196} 92 Z" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>')
    if open_side:
        g.append(f'<rect x="{x + 166}" y="138" width="254" height="30" fill="{FILL}" stroke="{INK}" stroke-width="2" opacity=".9"/>')
        g.append(f'<path d="M{x + 290} 112 q30 14 0 30" fill="none" stroke="{CYAN}" stroke-width="2.4" marker-end="url(#ar)"/>')
    else:
        g.append(f'<rect x="{x + 166}" y="108" width="254" height="30" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
        for xx in (230, 295, 360):
            g.append(f'<line x1="{x + xx}" y1="108" x2="{x + xx}" y2="138" stroke="{INK}" stroke-width="1"/>')
        for xx in (226, 356):
            g.append(f'<rect x="{x + xx - 4}" y="112" width="8" height="12" rx="2" fill="{BLUE}"/>')
    if open_tail:
        g.append(f'<path d="M{x + 420} 138 L{x + 452} 122 L{x + 480} 136 L{x + 448} 152 Z" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    else:
        g.append(f'<path d="M{x + 420} 108 L{x + 452} 92 L{x + 452} 122 L{x + 420} 138 Z" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    for xx in (200, 293, 386):
        g.append(f'<rect x="{x + xx}" y="137" width="14" height="5" fill="{NAVY}"/>')
    g.append(f'<rect x="{x + 150}" y="142" width="280" height="10" fill="#c9d2de" stroke="{INK}" stroke-width="1.2"/>')
    g.append(f'<rect x="{x + 424}" y="140" width="34" height="22" fill="#c9d2de" stroke="{INK}" stroke-width="1.5"/>')
    g.append(f'<rect x="{x + 428}" y="145" width="8" height="5" fill="#E03131"/><rect x="{x + 446}" y="145" width="8" height="5" fill="#F59F00"/>')
    for cx in (100, 360):
        g.append(f'<circle cx="{x + cx}" cy="168" r="22" fill="#3a3f47" stroke="{INK}" stroke-width="2"/><circle cx="{x + cx}" cy="168" r="10" fill="#c9d2de"/>')
    g.append(f'<path d="M{x + 330} 152 Q{x + 360} 128 {x + 392} 152" fill="none" stroke="{INK}" stroke-width="3"/>')
    g.append(f'<line x1="{x + 10}" y1="190" x2="{x + 490}" y2="190" stroke="#9aa6b6" stroke-dasharray="6 4"/>')


def components():
    g = []
    _truck(g)
    for c in [(1, 161, 72, 166, 26), (2, 300, 124, 300, 26), (3, 438, 112, 470, 64), (4, 300, 140, 270, 212),
              (5, 356, 118, 400, 26), (6, 205, 98, 215, 26), (7, 441, 156, 470, 212), (8, 362, 140, 340, 212), (9, 170, 147, 120, 212)]:
        g.append(_call(*c))
    return _svg("".join(g), "0 10 500 215")


def top_view(length, width="1,874", note=""):
    x0, y0, w, h = 90, 30, 300, 150
    g = [f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="{LIGHT}" stroke="{INK}" stroke-width="2"/>']
    for i in range(1, 8):
        yy = y0 + i * h / 8
        g.append(f'<line x1="{x0}" y1="{yy:.0f}" x2="{x0 + w}" y2="{yy:.0f}" stroke="#b8c4d4" stroke-width="1"/>')
    g.append(f'<rect x="{x0 - 8}" y="{y0}" width="8" height="{h}" fill="{NAVY}"/>')
    g.append(f'<line x1="{x0}" y1="{y0 + h + 20}" x2="{x0 + w}" y2="{y0 + h + 20}" stroke="{NAVY}" stroke-width="1.2" marker-start="url(#dm)" marker-end="url(#dm)"/>')
    g.append(_txt(x0 + w / 2, y0 + h + 38, f"ความยาวพื้น {length} มม.", 13, NAVY, bold=False))
    g.append(f'<line x1="{x0 + w + 20}" y1="{y0}" x2="{x0 + w + 20}" y2="{y0 + h}" stroke="{NAVY}" stroke-width="1.2" marker-start="url(#dm)" marker-end="url(#dm)"/>')
    g.append(f'<text x="{x0 + w + 32}" y="{y0 + h / 2}" font-size="13" fill="{NAVY}" {FONT} transform="rotate(90 {x0 + w + 32} {y0 + h / 2})" text-anchor="middle">ความกว้างพื้น {width} มม.</text>')
    g.append(f'<path d="M62 {y0 + h / 2} l-30 0 m0 0 l10 -7 m-10 7 l10 7" stroke="{BLUE}" stroke-width="2" fill="none"/>')
    g.append(_txt(47, y0 + h / 2 - 12, "หน้ารถ (FR)", 11, BLUE, bold=False))
    g.append(_txt(x0 + w / 2, y0 - 10, "ด้านขวา (RH)", 11, "#5b6577", bold=False))
    g.append(_txt(x0 + w / 2, y0 + h + 56, "ด้านซ้าย (LH)", 11, "#5b6577", bold=False))
    if note:
        g.append(_txt(x0 + w / 2, y0 + h / 2 + 4, note, 14, NAVY))
    return _svg("".join(g), "0 0 470 250")


def latch(state="locked"):
    """Latch on the corner post: locked (lever over the hook), unlocked (lever up, turned away), half (lever not over the hook)."""
    g = [f'<rect x="10" y="10" width="160" height="120" rx="10" fill="#fff" stroke="{INK}" stroke-width="1.5"/>',
         f'<rect x="30" y="30" width="22" height="90" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>',
         f'<rect x="52" y="52" width="110" height="42" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>',
         f'<path d="M40 70 q-8 6 0 12" fill="none" stroke="{INK}" stroke-width="3"/>']
    if state == "locked":
        g += [f'<rect x="38" y="60" width="44" height="9" rx="3" fill="{NAVY}"/>', f'<circle cx="82" cy="64" r="5" fill="{NAVY}"/>',
              _num(1, 150, 30, 8, GREEN), _txt(90, 152, "ล็อก (Locked)", 13, NAVY)]
    elif state == "unlocked":
        g += [f'<rect x="78" y="30" width="9" height="40" rx="3" fill="{BLUE}"/>', f'<circle cx="82" cy="64" r="5" fill="{BLUE}"/>',
              f'<path d="M100 40 a18 18 0 0 1 -6 26" fill="none" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>',
              _txt(90, 152, "ปลดล็อก (Unlocked)", 13, BLUE)]
    else:
        g += [f'<rect x="52" y="48" width="34" height="9" rx="3" fill="{RED}" transform="rotate(-25 82 52)"/>', f'<circle cx="82" cy="52" r="5" fill="{RED}"/>',
              f'<path d="M140 30 l20 20 m0 -20 l-20 20" stroke="{RED}" stroke-width="4"/>', _txt(90, 152, "ล็อกไม่สนิท (Not locked)", 13, RED)]
    if state == "locked":
        g.append(f'<path d="M140 22 l6 8 l12 -14" fill="none" stroke="{GREEN}" stroke-width="4"/>')
    return _svg("".join(g), "0 0 180 160", "dwg small")


def latch_steps(lock=True):
    """Three numbered frames: lift the lever (1), move it over / off the hook (2), press down (3)."""
    g = []
    for i, (ang, col) in enumerate([(0, NAVY), (-70, BLUE), (0 if lock else -70, NAVY if lock else BLUE)]):
        x = 10 + i * 150
        g.append(f'<rect x="{x}" y="10" width="138" height="120" rx="9" fill="#fff" stroke="{INK}" stroke-width="1.3"/>')
        g.append(f'<rect x="{x + 18}" y="26" width="20" height="92" fill="{FILL}" stroke="{INK}" stroke-width="1.3"/>')
        g.append(f'<rect x="{x + 38}" y="50" width="92" height="40" fill="{LIGHT}" stroke="{INK}" stroke-width="1.3"/>')
        g.append(f'<path d="M{x + 27} 67 q-8 6 0 12" fill="none" stroke="{INK}" stroke-width="3"/>')
        if i == 0:
            g.append(f'<rect x="{x + 26}" y="58" width="44" height="9" rx="3" fill="{col}" transform="rotate(-18 {x + 70} 62)"/>')
            g.append(f'<path d="M{x + 82} 50 l0 -18" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>')
        elif i == 1:
            g.append(f'<rect x="{x + 66}" y="26" width="9" height="38" rx="3" fill="{col}"/>')
            d = "M{a} 34 a20 20 0 0 0 -30 4" if lock else "M{a} 34 a20 20 0 0 1 30 4"
            g.append(f'<path d="{d.format(a=x + 90 if lock else x + 80)}" fill="none" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>')
        else:
            if lock:
                g.append(f'<rect x="{x + 26}" y="58" width="44" height="9" rx="3" fill="{col}"/>')
                g.append(f'<path d="M{x + 60} 40 l0 14" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>')
            else:
                g.append(f'<rect x="{x + 66}" y="26" width="9" height="38" rx="3" fill="{col}"/>')
                g.append(f'<path d="M{x + 105} 70 l0 -0" />')
                g.append(f'<path d="M{x + 96} 102 q14 -10 0 -24" fill="none" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>')
        g.append(f'<circle cx="{x + 70}" cy="62" r="4.5" fill="{col}"/>')
        g.append(_num(i + 1, x + 118, 28))
    return _svg("".join(g), "0 0 470 140")


def stay_check(caught=False):
    """Closing the tailgate: the stay (sling) clear of the latch, or caught between gate and post."""
    g = [f'<rect x="10" y="10" width="200" height="130" rx="10" fill="#fff" stroke="{INK}" stroke-width="1.5"/>',
         f'<rect x="150" y="30" width="22" height="96" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>',
         f'<path d="M30 40 L150 40 L150 70 L30 70 Z" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>',
         f'<path d="M30 70 L150 70 L150 100 L30 100 Z" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>']
    if caught:
        g += [f'<path d="M160 120 C140 110 150 90 152 76" fill="none" stroke="{INK}" stroke-width="3"/>',
              f'<path d="M140 62 l8 6 l-8 6 m24 -12 l-8 6 l8 6" stroke="{RED}" stroke-width="3" fill="none"/>',
              f'<circle cx="152" cy="68" r="14" fill="none" stroke="{RED}" stroke-width="2.5"/>', _txt(110, 162, "สลิงถูกหนีบ (Stay caught)", 13, RED)]
    else:
        g += [f'<path d="M190 120 C186 108 186 98 176 92" fill="none" stroke="{INK}" stroke-width="3"/>',
              f'<path d="M184 26 l6 8 l12 -14" fill="none" stroke="{GREEN}" stroke-width="4"/>', _txt(110, 162, "สลิงไม่ถูกหนีบ (Stay clear)", 13, GREEN)]
    return _svg("".join(g), "0 0 220 172", "dwg small")


def lamp_hidden():
    g = []
    _truck(g, 0, open_tail=True)
    g.append(f'<circle cx="441" cy="150" r="26" fill="none" stroke="{RED}" stroke-width="2.5" stroke-dasharray="5 3"/>')
    g.append(_txt(441, 205, "ฝาท้ายที่เปิดบังไฟท้าย", 12, RED))
    return _svg("".join(g), "0 40 500 175")


def gate_open(angle, opened=True):
    g = [f'<rect x="20" y="70" width="150" height="14" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>',
         _txt(95, 104, "พื้นกระบะ", 11, "#5b6577", bold=False), f'<circle cx="170" cy="84" r="4" fill="{NAVY}"/>',
         f'<rect x="160" y="34" width="10" height="36" fill="{FILL}" stroke="{INK}" stroke-width="1.4"/>']
    if not opened:
        g.append(f'<rect x="166" y="22" width="8" height="62" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>')
        g.append(f'<path d="M210 120 a40 40 0 0 0 -30 -60" fill="none" stroke="{CYAN}" stroke-width="2.2" marker-end="url(#ar)"/>')
        t = "ปิด (Close)"
    elif angle == 90:
        g.append(f'<rect x="170" y="80" width="70" height="8" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>')
        g.append(f'<line x1="165" y1="40" x2="236" y2="80" stroke="{BLUE}" stroke-width="2"/>')
        g.append(_txt(214, 56, "สลิงรั้ง", 11, BLUE, bold=False))
        g.append(f'<path d="M180 40 a40 40 0 0 1 36 30" fill="none" stroke="{CYAN}" stroke-width="2.2" marker-end="url(#ar)"/>')
        t = "เปิด 90° (Open)"
    else:
        g.append(f'<rect x="166" y="84" width="8" height="70" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>')
        g.append(f'<path d="M200 60 a40 40 0 0 1 -10 70" fill="none" stroke="{CYAN}" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#ar)"/>')
        t = "เปิด 180° (Open)"
    g.append(_txt(125, 178, t, 13, NAVY))
    return _svg("".join(g), "0 18 260 168", "dwg small")


def side_gate(opened=True):
    g = [f'<rect x="20" y="60" width="300" height="16" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>']
    for xx in (60, 160, 260):
        g.append(f'<rect x="{xx}" y="76" width="18" height="6" fill="{NAVY}"/>')
    if opened:
        g.append(f'<rect x="20" y="82" width="300" height="38" fill="{FILL}" stroke="{INK}" stroke-width="1.8"/>')
        g.append(f'<path d="M170 30 q30 26 0 50" fill="none" stroke="{CYAN}" stroke-width="2.4" marker-end="url(#ar)"/>')
        t = "เปิด (Open)"
    else:
        g.append(f'<rect x="20" y="22" width="300" height="38" fill="{FILL}" stroke="{INK}" stroke-width="1.8"/>')
        g.append(f'<path d="M170 116 q30 -26 0 -50" fill="none" stroke="{CYAN}" stroke-width="2.4" marker-end="url(#ar)"/>')
        t = "ปิด (Close)"
    g.append(f'<circle cx="290" cy="140" r="16" fill="#3a3f47"/><circle cx="290" cy="140" r="7" fill="#c9d2de"/>')
    g.append(_txt(170, 175, t, 13, NAVY))
    return _svg("".join(g), "0 10 340 175", "dwg small")


def stay(apply=True):
    """Tailgate stay: lift the loop off its keeper on the side post (1) and hook it on the tailgate (2) – or the reverse."""
    g = [_zoom(10, 10, 210, 130, f'<rect x="40" y="25" width="22" height="105" fill="{FILL}" stroke="{INK}" stroke-width="1.4"/>'
                                 f'<path d="M62 50 l18 0 l0 10 l-18 0" fill="none" stroke="{INK}" stroke-width="2.5"/>'
                                 f'<path d="M80 56 C120 50 160 80 190 110" fill="none" stroke="{INK}" stroke-width="3" stroke-dasharray="{"0" if not apply else "0"}"/>'
                                 f'<rect x="150" y="104" width="60" height="10" fill="{LIGHT}" stroke="{INK}" stroke-width="1.4"/>'
                                 f'<path d="M190 104 l0 -8 l8 0" fill="none" stroke="{INK}" stroke-width="2.5"/>')]
    if apply:
        g += [f'<path d="M80 40 l0 -16" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>', _num(1, 100, 32),
              f'<path d="M150 70 q30 6 40 26" fill="none" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>', _num(2, 184, 64),
              _txt(115, 162, "ใส่สลิง (Apply)", 13, NAVY)]
    else:
        g += [f'<path d="M190 92 q-20 -30 -60 -26" fill="none" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>', _num(1, 186, 70),
              f'<path d="M80 30 l0 16" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#ar)"/>', _num(2, 100, 32),
              _txt(115, 162, "ถอดสลิง (Remove)", 13, BLUE)]
    return _svg("".join(g), "0 0 230 172", "dwg small")


def adjust():
    """Hook with lock nut and adjusting thread on the corner post."""
    g = [_zoom(10, 10, 300, 150, f'<rect x="40" y="25" width="30" height="125" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>'
                                 f'<rect x="70" y="72" width="120" height="14" fill="#c9d2de" stroke="{INK}" stroke-width="1.3"/>'
                                 + "".join(f'<line x1="{x}" y1="72" x2="{x - 6}" y2="86" stroke="{INK}" stroke-width=".8"/>' for x in range(80, 190, 8)) +
                                 f'<path d="M190 70 q22 9 0 18" fill="none" stroke="{INK}" stroke-width="4"/>'
                                 f'<rect x="98" y="64" width="18" height="30" fill="{NAVY}"/>'
                                 f'<path d="M108 52 a14 14 0 1 1 -2 0" fill="none" stroke="{CYAN}" stroke-width="2.2" marker-end="url(#ar)"/>'
                                 f'<path d="M150 120 l40 0 m-40 0 l8 -6 m-8 6 l8 6 m32 -6 l-8 -6 m8 6 l-8 6" stroke="{BLUE}" stroke-width="2.2" fill="none"/>')]
    g += [_txt(107, 114, "น็อตล็อก", 11, NAVY, bold=False), _txt(170, 140, "ปรับเข้า / ออก", 11, BLUE, bold=False), _txt(212, 60, "ตะขอ", 11, NAVY, bold=False)]
    return _svg("".join(g), "0 0 320 170", "dwg small")


def hinge_bolts(order, title=""):
    """Gate edge with its hinges; each hinge has 2 bolts numbered in tightening order (order = [(a, b), ...] per hinge)."""
    n = len(order)
    w = 470
    g = [f'<rect x="20" y="40" width="{w - 40}" height="34" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>',
         f'<rect x="20" y="74" width="{w - 40}" height="10" fill="#c9d2de" stroke="{INK}" stroke-width="1.2"/>']
    step = (w - 40) / (n + 1)
    for i, (a, b) in enumerate(order):
        cx = 20 + step * (i + 1)
        g.append(f'<rect x="{cx - 30}" y="68" width="60" height="26" rx="3" fill="{FILL}" stroke="{INK}" stroke-width="1.4"/>')
        g.append(f'<rect x="{cx - 8}" y="62" width="16" height="14" fill="{NAVY}" opacity=".85"/>')
        for dx, k in ((-18, a), (18, b)):
            g.append(f'<circle cx="{cx + dx}" cy="86" r="4.5" fill="#fff" stroke="{INK}" stroke-width="1.4"/>')
            g.append(_num(k, cx + dx, 112, 9))
            g.append(f'<line x1="{cx + dx}" y1="91" x2="{cx + dx}" y2="103" stroke="{NAVY}" stroke-width="1"/>')
    if title:
        g.append(_txt(w / 2, 26, title, 12, "#5b6577", bold=False))
    g.append(_txt(36, 60, "หน้า", 10, BLUE, bold=False) if n == 3 else "")
    return _svg("".join(g), f"0 10 {w} 118")


def headboard():
    """Headboard with its fixing bolts: 4 at the floor, 2 per side at the corner posts."""
    g = [f'<rect x="60" y="20" width="350" height="110" fill="{FILL}" stroke="{INK}" stroke-width="2"/>']
    for yy in range(32, 130, 12):
        g.append(f'<line x1="60" y1="{yy}" x2="410" y2="{yy}" stroke="#b8c4d4" stroke-width="1"/>')
    g.append(f'<rect x="40" y="20" width="20" height="130" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>')
    g.append(f'<rect x="410" y="20" width="20" height="130" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>')
    g.append(f'<rect x="20" y="130" width="430" height="20" fill="#c9d2de" stroke="{INK}" stroke-width="1.4"/>')
    pts = [(50, 50, 1), (420, 110, 2), (420, 50, 3), (50, 110, 4), (120, 140, 5), (350, 140, 6), (200, 140, 7), (270, 140, 8)]
    for x, y, k in pts:
        g.append(f'<circle cx="{x}" cy="{y}" r="5" fill="#fff" stroke="{INK}" stroke-width="1.5"/>')
        g.append(_num(k, x + (22 if x < 235 else -22) if y < 130 else x, y if y < 130 else 172, 9))
    return _svg("".join(g), "0 10 470 180")


def tiedown():
    """Floor plan with the 8 tie-down points and a correctly secured load."""
    x0, y0, w, h = 60, 20, 340, 170
    g = [f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="{LIGHT}" stroke="{INK}" stroke-width="2"/>',
         f'<rect x="{x0 - 8}" y="{y0}" width="8" height="{h}" fill="{NAVY}"/>',
         f'<rect x="{x0 + 40}" y="{y0 + 45}" width="140" height="80" fill="#e9d7b8" stroke="{INK}" stroke-width="1.5"/>',
         _txt(x0 + 110, y0 + 90, "สินค้า", 13, INK, bold=False)]
    hooks = [(x0 + 20, y0), (x0 + 120, y0), (x0 + 220, y0), (x0 + 320, y0), (x0 + 20, y0 + h), (x0 + 120, y0 + h), (x0 + 220, y0 + h), (x0 + 320, y0 + h)]
    for i, (x, y) in enumerate(hooks):
        g.append(f'<rect x="{x - 7}" y="{y - 4}" width="14" height="8" rx="2" fill="{BLUE}"/>')
        g.append(_num(i + 1, x, y + (-16 if y == y0 else 16), 8))
    for (x1, y1), (x2, y2) in [((x0 + 20, y0), (x0 + 60, y0 + 45)), ((x0 + 220, y0), (x0 + 160, y0 + 45)),
                               ((x0 + 20, y0 + h), (x0 + 60, y0 + 125)), ((x0 + 220, y0 + h), (x0 + 160, y0 + 125))]:
        g.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{GREEN}" stroke-width="3"/>')
    g.append(_txt(x0 + w / 2, y0 + h + 40, "จุดผูกรัด 1–8 · สายรัดสีเขียว: ดึงเฉียงลงจากมุมสินค้าไปยังจุดผูกรัด", 11, "#5b6577", bold=False))
    g.append(f'<path d="M40 {y0 + h / 2} l-24 0 m0 0 l8 -6 m-8 6 l8 6" stroke="{BLUE}" stroke-width="2" fill="none"/>')
    return _svg("".join(g), "0 0 420 245")


def mudguard():
    """Mudguard with its bracket bolts numbered."""
    g = [f'<path d="M60 150 Q60 40 200 40 Q340 40 340 150" fill="none" stroke="{INK}" stroke-width="10"/>',
         f'<circle cx="200" cy="150" r="70" fill="#3a3f47"/><circle cx="200" cy="150" r="30" fill="#c9d2de"/>',
         f'<rect x="120" y="20" width="16" height="30" fill="{NAVY}"/><rect x="264" y="20" width="16" height="30" fill="{NAVY}"/>',
         f'<rect x="100" y="10" width="200" height="12" fill="#c9d2de" stroke="{INK}" stroke-width="1.3"/>']
    for x, k in ((128, 1), (272, 2), (128, 3), (272, 4)):
        y = 28 if k < 3 else 44
        g.append(f'<circle cx="{x}" cy="{y}" r="4" fill="#fff" stroke="{INK}" stroke-width="1.3"/>')
        lx, ly = x + (-30 if x < 200 else 30), (14 if k < 3 else 58)
        g.append(f'<line x1="{x}" y1="{y}" x2="{lx}" y2="{ly}" stroke="{NAVY}" stroke-width="1"/>')
        g.append(_num(k, lx, ly, 9))
    return _svg("".join(g), "-60 -2 520 225")


# ---------------------------------------------------------------- part details (traced from RRS assembly footage, no people)
def _dash(x, y, r):
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="none" stroke="{NAVY}" stroke-width="2.2" stroke-dasharray="6 4"/>'


def _hexes(x0, y0, w, h, s=9):
    out = []
    dx, dy = s * 1.75, s * 1.5
    row = 0
    y = y0 + s
    while y < y0 + h - s * .6:
        x = x0 + s + (dx / 2 if row % 2 else 0)
        while x < x0 + w - s * .6:
            pts = " ".join(f"{x + s * .78 * __import__('math').cos(a * 3.14159 / 3 + .5236):.1f},{y + s * .78 * __import__('math').sin(a * 3.14159 / 3 + .5236):.1f}" for a in range(6))
            out.append(f'<polygon points="{pts}" fill="#fff" stroke="{INK}" stroke-width=".8"/>')
            x += dx
        y += dy
        row += 1
    return "".join(out)


def details():
    g = []
    # headboard on the front edge of the floor
    g.append(f'<rect x="176" y="22" width="268" height="88" fill="{LIGHT}" stroke="{INK}" stroke-width="2"/>')
    g.append(f'<clipPath id="hb"><rect x="184" y="30" width="252" height="72"/></clipPath><g clip-path="url(#hb)">{_hexes(184, 30, 252, 72, 7)}</g>')
    g.append(f'<rect x="184" y="30" width="252" height="72" fill="none" stroke="{INK}" stroke-width="1.4"/>')
    for xx in (176, 436):
        g.append(f'<rect x="{xx}" y="14" width="8" height="98" fill="{FILL}" stroke="{INK}" stroke-width="1.8"/>')
    # floor (oblique view from the rear-left)
    g.append(f'<path d="M70 172 L330 172 L444 112 L184 112 Z" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    g.append('<clipPath id="fl"><path d="M74 169 L328 169 L438 115 L186 115 Z"/></clipPath><g clip-path="url(#fl)">')
    for r in range(0, 10):
        y = 117 + r * 6
        off = (r % 2) * 7
        for c in range(0, 40):
            x = 72 + c * 14 + off + (172 - y) * 1.9 - 0
            g.append(f'<ellipse cx="{x:.0f}" cy="{y}" rx="2.2" ry="1.2" fill="none" stroke="{INK}" stroke-width=".6"/>')
    g.append('</g>')
    # rear rail and right side rail
    g.append(f'<path d="M70 172 L330 172 L330 194 L70 194 Z" fill="#c9d2de" stroke="{INK}" stroke-width="2"/>')
    g.append(f'<path d="M330 172 L444 112 L444 134 L330 194 Z" fill="#dfe5ee" stroke="{INK}" stroke-width="2"/>')
    # plate hinges on the rear rail and the side rail
    for xx in (118, 270):
        g.append(f'<rect x="{xx}" y="176" width="22" height="14" rx="2" fill="#fff" stroke="{INK}" stroke-width="1.4"/><line x1="{xx}" y1="183" x2="{xx + 22}" y2="183" stroke="{INK}" stroke-width="1"/>')
    for t in (.3, .72):
        x, y = 330 + 114 * t, 183 - 60 * t
        g.append(f'<path d="M{x - 8:.0f} {y + 4:.0f} l14 -7 l0 11 l-14 7 z" fill="#fff" stroke="{INK}" stroke-width="1.3"/>')
    # tail-lamp housings under the rear corners
    for xx in (74, 290):
        g.append(f'<rect x="{xx}" y="196" width="36" height="24" rx="2" fill="#fff" stroke="{INK}" stroke-width="1.6"/>'
                 f'<rect x="{xx + 4}" y="200" width="28" height="16" fill="{LIGHT}" stroke="{INK}" stroke-width="1"/><line x1="{xx + 18}" y1="200" x2="{xx + 18}" y2="216" stroke="{INK}"/>')
    # under-frame and wheel hint
    g.append(f'<path d="M120 194 L120 214 M280 194 L280 214" stroke="{INK}" stroke-width="2"/>')
    # dashed callouts
    spots = [(1, 250, 140, 22), (4, 129, 183, 17), (7, 92, 208, 21), (2, 310, 66, 26)]
    for _, x, y, r in spots:
        g.append(_dash(x, y, r))
    # magnified bubbles along the bottom
    bx = [8, 156, 304, 452]
    for i, (n, x, y, r) in enumerate(spots):
        cx = bx[i] + 70
        g.append(f'<line x1="{x}" y1="{y + r}" x2="{cx}" y2="252" stroke="{INK}" stroke-width="1" stroke-dasharray="4 3"/>')
    g.append(_zoom(8, 252, 140, 118, _hexdots(16, 262, 124, 98)))
    g.append(_zoom(156, 252, 140, 118,
         f'<rect x="164" y="300" width="124" height="34" fill="#c9d2de" stroke="{INK}" stroke-width="1.6"/>'
         f'<rect x="196" y="278" width="60" height="26" rx="3" fill="#fff" stroke="{INK}" stroke-width="1.6"/>'
         f'<rect x="196" y="304" width="60" height="26" rx="3" fill="#fff" stroke="{INK}" stroke-width="1.6"/>'
         f'<rect x="190" y="299" width="72" height="10" rx="5" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>'
         + "".join(f'<circle cx="{xx}" cy="{yy}" r="3.4" fill="#fff" stroke="{INK}" stroke-width="1.3"/>' for xx in (208, 244) for yy in (290, 320))))
    g.append(_zoom(304, 252, 140, 118,
         f'<rect x="322" y="276" width="104" height="70" rx="4" fill="#fff" stroke="{INK}" stroke-width="1.8"/>'
         f'<rect x="332" y="286" width="84" height="50" fill="{LIGHT}" stroke="{INK}" stroke-width="1.3"/>'
         f'<line x1="360" y1="286" x2="360" y2="336" stroke="{INK}"/><line x1="388" y1="286" x2="388" y2="336" stroke="{INK}"/>'
         f'<rect x="314" y="262" width="120" height="12" fill="#c9d2de" stroke="{INK}" stroke-width="1.4"/>'))
    g.append(_zoom(452, 252, 140, 118,
         f'<rect x="462" y="262" width="120" height="98" fill="{LIGHT}" stroke="{INK}" stroke-width="2"/>'
         f'<clipPath id="hz"><rect x="470" y="270" width="104" height="82"/></clipPath><g clip-path="url(#hz)">{_hexes(470, 270, 104, 82, 11)}</g>'
         f'<rect x="470" y="270" width="104" height="82" fill="none" stroke="{INK}" stroke-width="1.4"/>'))
    for i, (n, *_r) in enumerate(spots):
        g.append(_num(n, bx[i] + 14, 266))
    return _svg("".join(g), "0 0 600 376")


def _hexdots(x0, y0, w, h):
    out = [f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="{FILL}" stroke="{INK}" stroke-width="1.6"/>']
    for r in range(7):
        for c in range(9):
            x = x0 + 10 + c * 14 + (7 if r % 2 else 0)
            y = y0 + 10 + r * 13
            if x < x0 + w - 6:
                out.append(f'<ellipse cx="{x}" cy="{y}" rx="4.2" ry="2.4" fill="#fff" stroke="{INK}" stroke-width="1"/>')
    return "".join(out)


# ---------------------------------------------------------------- how the body is made – line icons, no people
def process_icon(k):
    s = []
    if k == 1:   # CAD design
        s += [f'<rect x="20" y="10" width="120" height="74" rx="4" fill="#fff" stroke="{INK}" stroke-width="2"/>',
              f'<rect x="28" y="18" width="104" height="58" fill="{FILL}" stroke="{INK}"/>',
              f'<path d="M44 60 L96 60 L116 46 L64 46 Z M44 60 L44 66 L96 66 L96 60 M96 66 L116 52 L116 46" fill="none" stroke="{BLUE}" stroke-width="1.6"/>',
              f'<path d="M64 46 L64 30 L116 30 L116 46" fill="none" stroke="{BLUE}" stroke-width="1.6"/>',
              f'<path d="M70 84 L90 84 L96 100 L64 100 Z" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>']
    elif k == 2:  # laser cutting
        s += [f'<rect x="14" y="78" width="132" height="10" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>',
              f'<rect x="14" y="14" width="132" height="12" fill="#fff" stroke="{INK}" stroke-width="2"/>',
              f'<path d="M70 26 L90 26 L86 52 L74 52 Z" fill="#fff" stroke="{INK}" stroke-width="1.8"/><path d="M76 52 L80 60 L84 52" fill="{INK}"/>',
              f'<line x1="80" y1="60" x2="80" y2="78" stroke="{RED}" stroke-width="2.4"/>',
              f'<path d="M30 78 L60 78" stroke="{BLUE}" stroke-width="2" stroke-dasharray="4 3"/>'] + \
             [f'<line x1="80" y1="78" x2="{80 + dx}" y2="{78 - dy}" stroke="{RED}" stroke-width="1.2"/>' for dx, dy in ((10, 8), (-9, 9), (14, 2), (-13, 3))]
    elif k == 3:  # press brake bending
        s += [f'<rect x="20" y="10" width="120" height="22" fill="#fff" stroke="{INK}" stroke-width="2"/>',
              f'<path d="M72 32 L88 32 L80 54 Z" fill="{LIGHT}" stroke="{INK}" stroke-width="1.8"/>',
              f'<path d="M20 70 L66 70 L80 58 L94 70 L140 70 L140 96 L20 96 Z" fill="#fff" stroke="{INK}" stroke-width="2"/>',
              f'<path d="M14 50 L80 56 L146 50" fill="none" stroke="{BLUE}" stroke-width="3"/>',
              f'<path d="M80 6 L80 2" stroke="{INK}"/><path d="M60 40 L60 50" stroke="{CYAN}" stroke-width="2" marker-end="url(#ar)"/>']
    elif k == 4:  # part check
        s += [f'<path d="M16 76 L100 76 L100 46 L112 46" fill="none" stroke="{BLUE}" stroke-width="4"/>',
              f'<rect x="20" y="22" width="96" height="12" fill="#fff" stroke="{INK}" stroke-width="1.6"/>'] + \
             [f'<line x1="{x}" y1="22" x2="{x}" y2="{28 if x % 16 else 31}" stroke="{INK}"/>' for x in range(28, 112, 8)] + \
             [f'<circle cx="128" cy="78" r="16" fill="{GREEN}"/><path d="M120 78 l6 6 l11 -12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>']
    elif k == 5:  # robot welding
        s += [f'<rect x="20" y="86" width="40" height="12" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>',
              f'<path d="M40 86 L40 66 L76 30 L110 44" fill="none" stroke="{INK}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>',
              f'<path d="M40 86 L40 66 L76 30 L110 44" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
              f'<circle cx="40" cy="66" r="6" fill="#fff" stroke="{INK}" stroke-width="1.6"/><circle cx="76" cy="30" r="6" fill="#fff" stroke="{INK}" stroke-width="1.6"/>',
              f'<path d="M110 44 L118 70" stroke="{INK}" stroke-width="4"/>',
              f'<rect x="90" y="80" width="56" height="12" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>'] + \
             [f'<line x1="118" y1="78" x2="{118 + dx}" y2="{78 - dy}" stroke="{CYAN}" stroke-width="1.4"/>' for dx, dy in ((10, 6), (-10, 6), (0, 11), (12, -1))]
    elif k == 6:  # weld finishing
        s += [f'<rect x="14" y="70" width="132" height="24" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>',
              f'<path d="M24 70 q8 -5 16 0 q8 -5 16 0 q8 -5 16 0" fill="none" stroke="{INK}" stroke-width="1.4"/>',
              f'<ellipse cx="96" cy="62" rx="18" ry="6" fill="#fff" stroke="{INK}" stroke-width="1.8"/>',
              f'<rect x="88" y="28" width="16" height="30" rx="4" fill="#fff" stroke="{INK}" stroke-width="1.8"/>',
              f'<rect x="102" y="20" width="44" height="14" rx="6" fill="#fff" stroke="{INK}" stroke-width="1.8"/>'] + \
             [f'<line x1="78" y1="68" x2="{78 - dx}" y2="{68 - dy}" stroke="{RED}" stroke-width="1.4"/>' for dx, dy in ((18, 10), (22, 2), (14, 18), (26, -4))]
    elif k == 7:  # powder coating
        s += [f'<line x1="70" y1="4" x2="70" y2="18" stroke="{INK}" stroke-width="1.6"/><path d="M66 18 q4 6 8 0" fill="none" stroke="{INK}" stroke-width="1.6"/>',
              f'<rect x="40" y="24" width="60" height="70" fill="{LIGHT}" stroke="{INK}" stroke-width="2"/>',
              f'<path d="M130 50 L112 56 L112 64 L130 60 Z" fill="#fff" stroke="{INK}" stroke-width="1.8"/><path d="M126 60 L130 82" stroke="{INK}" stroke-width="3"/>'] + \
             [f'<circle cx="{x}" cy="{y}" r="1.4" fill="{BLUE}"/>' for x, y in ((106, 54), (102, 60), (104, 66), (98, 50), (100, 72), (96, 58), (94, 66))]
    else:        # final inspection
        s += [f'<path d="M14 70 L96 70 L120 56 L38 56 Z" fill="{FILL}" stroke="{INK}" stroke-width="1.8"/>',
              f'<rect x="14" y="70" width="82" height="10" fill="#c9d2de" stroke="{INK}" stroke-width="1.6"/>',
              f'<rect x="38" y="30" width="6" height="26" fill="#fff" stroke="{INK}"/><rect x="114" y="22" width="6" height="34" fill="#fff" stroke="{INK}"/>',
              f'<rect x="104" y="12" width="44" height="58" rx="3" fill="#fff" stroke="{INK}" stroke-width="1.8"/>'] + \
             [f'<path d="M112 {y} l4 4 l7 -8" fill="none" stroke="{GREEN}" stroke-width="2.2"/><line x1="128" y1="{y}" x2="142" y2="{y}" stroke="{INK}"/>' for y in (28, 42, 56)]
    return _svg("".join(s), "0 0 160 104", "dwg icon")
