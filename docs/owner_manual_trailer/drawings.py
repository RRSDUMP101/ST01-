"""Line drawings for the RRS box-trailer owner manual – original RRS artwork, black line art in the style of the
flatbed manual (dashed circles, numbered dots, cyan arrows). Replaced by renders of the 3D model once a STEP file
of the trailer is available (see README)."""

INK, NAVY, CYAN, FILL, LIGHT, RED, GREEN = "#111", "#0B2A5B", "#00B4F0", "#F3F6FA", "#DCE6F2", "#D9534F", "#1F9D6B"
FONT = 'font-family="Noto Sans, Noto Sans Thai"'


def _svg(body, vb):
    defs = (f'<defs><marker id="ta" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">'
            f'<path d="M0 0 L10 5 L0 10 z" fill="{CYAN}"/></marker></defs>')
    return f'<svg class="dwg" viewBox="{vb}" xmlns="http://www.w3.org/2000/svg">{defs}{body}</svg>'


def _num(n, x, y, r=11):
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="{INK}"/>'
            f'<text x="{x}" y="{y + r * .42:.1f}" text-anchor="middle" font-size="{r * 1.25:.0f}" font-weight="bold" fill="#fff" {FONT}>{n}</text>')


def _t(x, y, s, size=13, anchor="middle", color=NAVY, bold=True):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" {"font-weight=\"bold\"" if bold else ""} fill="{color}" {FONT}>{s}</text>'


def _arrow(d, w=5):
    return f'<path d="{d}" fill="none" stroke="{CYAN}" stroke-width="{w}" stroke-linecap="round" marker-end="url(#ta)"/>'


def _dash(x, y, r):
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="none" stroke="{INK}" stroke-width="2" stroke-dasharray="7 5"/>'


def _zoom(x, y, w, h):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="#fff" stroke="{INK}" stroke-width="2"/>'


# ---------------------------------------------------------------- coupling
def _drawbar(g, x=0, y=0):
    g.append(f'<path d="M{x + 40} {y + 120} L{x + 250} {y + 120} L{x + 420} {y + 112} L{x + 420} {y + 138} L{x + 250} {y + 146} L{x + 40} {y + 146} Z" fill="{FILL}" stroke="{INK}" stroke-width="2.4"/>')


def coupler(state="locked"):
    """Side view of the coupling head on the tow ball; locked / open lever."""
    g = []
    g.append(f'<rect x="20" y="170" width="140" height="26" fill="{LIGHT}" stroke="{INK}" stroke-width="2.4"/>')  # tow bar tongue
    g.append(f'<rect x="96" y="140" width="16" height="32" fill="#fff" stroke="{INK}" stroke-width="2.2"/>')  # ball neck
    g.append(f'<circle cx="104" cy="128" r="22" fill="#fff" stroke="{INK}" stroke-width="2.4"/>')  # ball
    # coupling head
    g.append(f'<path d="M70 118 Q70 92 104 92 L300 92 L300 126 L140 126 Q138 108 104 108 Q86 108 84 126 L70 126 Z" fill="{FILL}" stroke="{INK}" stroke-width="2.4"/>')
    g.append(f'<rect x="300" y="96" width="120" height="26" fill="{FILL}" stroke="{INK}" stroke-width="2.4"/>')
    if state == "locked":
        g.append(f'<path d="M120 92 L230 70 L236 80 L128 100 Z" fill="#fff" stroke="{INK}" stroke-width="2.2"/>')
        g.append(f'<circle cx="250" cy="98" r="6" fill="#fff" stroke="{INK}" stroke-width="2"/><path d="M250 92 L250 70" stroke="{INK}" stroke-width="2"/>')  # safety pin
        g.append(_dash(104, 120, 40))
    else:
        g.append(f'<path d="M120 92 L190 30 L198 38 L130 100 Z" fill="#fff" stroke="{INK}" stroke-width="2.2"/>')
        g.append(_arrow("M215 70 Q215 34 186 22"))
    return _svg("".join(g), "0 10 440 200")


def chains():
    """Top view: safety chains crossed under the coupling, breakaway cable to a fixed point."""
    g = []
    g.append(f'<rect x="10" y="80" width="120" height="70" rx="6" fill="{LIGHT}" stroke="{INK}" stroke-width="2.4"/>')  # car bumper / towbar
    g.append(_t(70, 120, "รถลาก", 13))
    g.append(f'<rect x="130" y="108" width="60" height="16" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    g.append(f'<circle cx="200" cy="116" r="14" fill="#fff" stroke="{INK}" stroke-width="2.4"/>')
    g.append(f'<path d="M200 102 L420 30 L440 30 M200 130 L420 202 L440 202" fill="none" stroke="{INK}" stroke-width="3"/>')  # A-frame
    g.append(f'<path d="M190 104 L440 104 L440 128 L190 128" fill="{FILL}" stroke="{INK}" stroke-width="2.2"/>')
    # chains crossed
    for a, b in (("M300 70", "Q230 150 150 140"), ("M300 162", "Q230 82 150 92")):
        g.append(f'<path d="{a} {b}" fill="none" stroke="{INK}" stroke-width="3" stroke-dasharray="6 4"/>')
    g.append(_num(1, 236, 116))
    # breakaway cable
    g.append(f'<path d="M330 128 Q300 180 140 150" fill="none" stroke="{RED}" stroke-width="2.4"/>')
    g.append(f'<rect x="320" y="128" width="26" height="18" fill="#fff" stroke="{INK}" stroke-width="2"/>')
    g.append(_num(2, 345, 168))
    return _svg("".join(g), "0 10 460 220")


def jockey(down=True):
    """Front jockey wheel: wind down to take the weight, wind up and lock before towing."""
    g = []
    _drawbar(g, 0, 40)
    top, wy = (60, 222) if down else (10, 172)
    g.append(f'<rect x="220" y="{top}" width="26" height="{wy - 14 - top}" fill="#fff" stroke="{INK}" stroke-width="2.4"/>')
    g.append(f'<rect x="212" y="150" width="42" height="22" fill="{LIGHT}" stroke="{INK}" stroke-width="2"/>')  # clamp on the drawbar
    g.append(f'<path d="M233 {top} L233 {top - 18} L272 {top - 18}" fill="none" stroke="{INK}" stroke-width="3"/>')  # handle
    g.append(f'<circle cx="233" cy="{wy}" r="14" fill="#3a3f47" stroke="{INK}" stroke-width="2"/>')
    g.append(f'<line x1="10" y1="238" x2="440" y2="238" stroke="#9aa6b6" stroke-width="2" stroke-dasharray="10 6"/>')
    g.append(_arrow("M300 70 L300 120" if down else "M300 120 L300 70"))
    return _svg("".join(g), "0 -20 450 270")


PIN_XY = {1: (-1, -1), 2: (0, -1.25), 3: (1, -1), 4: (1.25, 0), 5: (1, 1), 6: (0, 1.25), 7: (-1, 1), 8: (-1.25, 0),
          9: (-.55, -.45), 10: (.55, -.45), 11: (.55, .45), 12: (-.55, .45)}


def plug12():
    """12-pin flat trailer plug, face view – pin numbers as printed on the plug (layout is illustrative)."""
    g = [f'<circle cx="150" cy="130" r="108" fill="{FILL}" stroke="{INK}" stroke-width="3"/>',
         f'<rect x="136" y="14" width="28" height="14" fill="#fff" stroke="{INK}" stroke-width="2"/>']
    for n, (x, y) in PIN_XY.items():
        cx, cy = 150 + x * 68, 130 + y * 68
        g.append(f'<rect x="{cx - 9}" y="{cy - 4}" width="18" height="8" rx="2" fill="#fff" stroke="{INK}" stroke-width="2"/>')
        g.append(_t(cx, cy + 24, str(n), 13, color=INK))
    return _svg("".join(g), "30 0 240 260")


def breakaway():
    """Breakaway switch on the drawbar: cable to the car; pulling the pin applies the trailer brakes."""
    g = []
    _drawbar(g, 0, 40)
    g.append(f'<rect x="250" y="112" width="64" height="38" rx="5" fill="#fff" stroke="{INK}" stroke-width="2.4"/>')
    g.append(_t(282, 136, "BA", 13, color=INK))
    g.append(f'<circle cx="250" cy="131" r="5" fill="{INK}"/>')
    g.append(f'<path d="M250 131 Q200 200 60 196" fill="none" stroke="{RED}" stroke-width="2.6"/>')
    g.append(f'<rect x="20" y="180" width="44" height="30" fill="{LIGHT}" stroke="{INK}" stroke-width="2"/>')
    g.append(_t(42, 230, "รถลาก", 12))
    g.append(f'<rect x="330" y="160" width="80" height="44" rx="4" fill="{FILL}" stroke="{INK}" stroke-width="2.2"/>')
    g.append(_t(370, 188, "แบตเตอรี่", 12, color=INK))
    g.append(f'<path d="M314 140 L340 160" stroke="{INK}" stroke-width="2"/>')
    g.append(_num(1, 250, 96)); g.append(_num(2, 120, 222)); g.append(_num(3, 420, 150))
    return _svg("".join(g), "0 30 450 210")


def doors_top():
    """Top view of the box: 4 side doors each side swing outward, rear door; numbers = door positions."""
    g = [f'<rect x="60" y="60" width="570" height="180" fill="{FILL}" stroke="{INK}" stroke-width="3"/>',
         f'<path d="M60 150 L0 150" stroke="{INK}" stroke-width="4"/>', _t(18, 140, "หัวลาก", 12, anchor="start")]
    xs = [60, 197, 345, 492, 630]
    n = 1
    for side, y in (("L", 60), ("R", 240)):
        for i in range(4):
            x0, x1 = xs[i] + 4, xs[i + 1] - 4
            hinge = x0 if i in (0, 2) else x1  # doors open in pairs from the centre posts
            sgn = -1 if side == "L" else 1
            g.append(f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}" stroke="{INK}" stroke-width="5"/>')
            tip = x1 if hinge == x0 else x0
            g.append(f'<path d="M{hinge} {y} L{hinge} {y + sgn * 110}" stroke="{INK}" stroke-width="2.2" stroke-dasharray="6 4"/>')
            g.append(f'<path d="M{tip} {y} A{abs(tip - hinge)} {abs(tip - hinge)} 0 0 {1 if (side == "L") == (hinge == x0) else 0} {hinge} {y + sgn * abs(tip - hinge)}" fill="none" stroke="{CYAN}" stroke-width="2"/>')
            g.append(_num(n, (x0 + x1) / 2, y - sgn * 22))
            n += 1
    g.append(f'<line x1="630" y1="70" x2="630" y2="230" stroke="{INK}" stroke-width="6"/>')
    g.append(_t(660, 155, "ประตูท้าย", 12, anchor="start"))
    return _svg("".join(g), "-10 -70 760 440")


def load_split():
    """Side view sketch: load ahead of the axles gives a positive ball download (~10 %)."""
    g = [f'<rect x="120" y="40" width="440" height="120" fill="{FILL}" stroke="{INK}" stroke-width="2.6"/>',
         f'<path d="M120 150 L20 158" stroke="{INK}" stroke-width="4"/>',
         f'<circle cx="320" cy="180" r="20" fill="#3a3f47"/><circle cx="372" cy="180" r="20" fill="#3a3f47"/>',
         f'<line x1="0" y1="200" x2="600" y2="200" stroke="#9aa6b6" stroke-width="2" stroke-dasharray="10 6"/>',
         f'<rect x="150" y="96" width="140" height="54" fill="#fff" stroke="{INK}" stroke-width="2.2"/>', _t(220, 128, "หนัก (Heavy)", 13, color=INK),
         f'<rect x="300" y="116" width="100" height="34" fill="#fff" stroke="{INK}" stroke-width="2"/>', _t(350, 138, "กลาง", 12, color=INK),
         f'<rect x="410" y="128" width="120" height="22" fill="#fff" stroke="{INK}" stroke-width="2"/>', _t(470, 144, "เบา (Light)", 12, color=INK),
         _arrow("M20 110 L20 150", 6), _t(20, 100, "≈10%", 13),
         f'<line x1="346" y1="30" x2="346" y2="200" stroke="{RED}" stroke-width="1.6" stroke-dasharray="6 4"/>', _t(346, 24, "แนวเพลา (Axles)", 12, color=RED)]
    return _svg("".join(g), "0 0 600 210")


def camera_switch():
    """Camera 1 on the car, camera 2 on the trailer; the trailer reversing-lamp signal selects camera 2."""
    g = [f'<rect x="10" y="60" width="150" height="90" rx="8" fill="{LIGHT}" stroke="{INK}" stroke-width="2.4"/>', _t(85, 110, "รถลาก", 14),
         f'<rect x="230" y="40" width="300" height="130" fill="{FILL}" stroke="{INK}" stroke-width="2.4"/>', _t(380, 112, "หางลาก", 14),
         f'<rect x="130" y="62" width="26" height="16" fill="#fff" stroke="{INK}" stroke-width="2"/>', _num(1, 143, 46),
         f'<rect x="500" y="44" width="26" height="16" fill="#fff" stroke="{INK}" stroke-width="2"/>', _num(2, 513, 28),
         f'<path d="M160 128 L230 128" stroke="{INK}" stroke-width="3"/>', _t(195, 150, "ปลั๊ก", 11, color=INK),
         f'<rect x="40" y="76" width="56" height="34" rx="3" fill="#fff" stroke="{INK}" stroke-width="2"/>', _t(68, 98, "จอ", 12, color=INK)]
    return _svg("".join(g), "0 10 540 170")
