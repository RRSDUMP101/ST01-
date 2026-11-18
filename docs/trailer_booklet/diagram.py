"""Side and rear views of the RRS box trailer, drawn as SVG from the positions in the ZW3D file
"หางลาก ford พื้นเรียบ[.Z3" (top assembly "รวมหางลาก ford").

CAD axes: x across (+ = right side), y along (- = towing end), z up. The floor is at z 700, the ground at z -217
(tyre 225/70 R15 ~ 700 mm on the wheel centre z 133). Axle positions are taken from the fender (y -1324 .. 584):
the CAD boxes of the wheel part are not tight, so the wheels are drawn about where the fender says.
"""

NAVY, BLUE, LINE, FILL, GLASS = "#0B2A5B", "#1257C8", "#2B2F36", "#F3F6FA", "#DCE6F2"
FONT = 'font-family="IBM Plex Sans Thai" font-weight="bold"'

Y0, ZTOP = -4450, 3150  # left edge of the side view in CAD y, top in CAD z


def S(y, z):
    return y - Y0, ZTOP - z


def rect(y0, y1, z0, z1, fill=FILL, stroke=LINE, sw=14, rx=0, extra=""):
    x, t = S(y0, z1)
    return (f'<rect x="{x:.0f}" y="{t:.0f}" width="{y1 - y0:.0f}" height="{z1 - z0:.0f}" rx="{rx}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>')


def wheel(y, zc=133, r=350):
    x, t = S(y, zc)
    return (f'<circle cx="{x}" cy="{t}" r="{r}" fill="#3a3f47" stroke="{LINE}" stroke-width="14"/>'
            f'<circle cx="{x}" cy="{t}" r="{r * .55:.0f}" fill="#c9d2de" stroke="{LINE}" stroke-width="10"/>'
            f'<circle cx="{x}" cy="{t}" r="{r * .14:.0f}" fill="{LINE}"/>')


def label(text, at, to, anchor="middle", size=150):
    """Text at `at` (svg coords), leader to `to` (CAD y, z)."""
    tx, ty = S(*to)
    ax, ay = at
    ly = ay + (25 if ay < ty else -size * .95)
    return (f'<line x1="{ax}" y1="{ly}" x2="{tx}" y2="{ty}" stroke="{NAVY}" stroke-width="9"/>'
            f'<circle cx="{tx}" cy="{ty}" r="26" fill="{NAVY}" stroke="#fff" stroke-width="8"/>'
            f'<text x="{ax}" y="{ay}" text-anchor="{anchor}" font-size="{size}" fill="{NAVY}" {FONT}>{text}</text>')


def side_view():
    g = []
    gx0, gy = S(-4450, -217)
    g.append(f'<line x1="{gx0}" y1="{gy}" x2="{gx0 + 7500}" y2="{gy}" stroke="#9aa6b6" stroke-width="12" stroke-dasharray="60 40"/>')
    # drawbar (A-frame, seen from the side) and coupling head
    g.append(rect(-4300, -2640, 440, 545, fill="#d5dde8"))
    g.append(rect(-4420, -4240, 420, 575, fill="#9aa6b6", rx=30))
    # jockey stand position is not in the file: none drawn
    # chassis rails under the floor
    g.append(rect(-2645, 2839, 490, 700, fill="#d5dde8"))
    # front tool box on the drawbar
    g.append(rect(-3350, -2850, 545, 870, fill="#e9eef5"))
    g.append(rect(-3300, -2900, 830, 860, fill="#c9d2de", sw=8))
    # box body: frame, side doors, posts, roof
    g.append(rect(-2850, 2850, 700, 3003, fill=FILL, sw=18))
    for d0, d1 in ((-2750, -1415), (-1395, -10), (10, 1395), (1415, 2750)):
        g.append(rect(d0 + 15, d1 - 15, 770, 2930, fill="#fff", sw=10))
        for zz in (1250, 2050):  # stiffener lines on the door skin
            x0, t = S(d0 + 60, zz)
            g.append(f'<line x1="{x0}" y1="{t}" x2="{x0 + (d1 - d0) - 120}" y2="{t}" stroke="#c3ccd8" stroke-width="8"/>')
        for zz in (1000, 1800, 2600):  # hinges on the leading edge
            g.append(rect(d0 + 20, d0 + 70, zz, zz + 110, fill="#9aa6b6", sw=6))
        g.append(rect(d1 - 150, d1 - 60, 1650, 1950, fill=NAVY, sw=0, rx=12))  # lock handle
    g.append(rect(-2850, -2750, 700, 3003, fill="#d5dde8", sw=10))
    g.append(rect(2750, 2850, 700, 3003, fill="#d5dde8", sw=10))
    g.append(rect(-2850, 2850, 2950, 3003, fill="#d5dde8", sw=10))
    g.append(rect(-2850, 2856, 3003, 3033, fill="#9aa6b6", sw=8))  # roof gutter
    g.append(rect(-2850, 2850, 700, 752, fill="#d5dde8", sw=10))
    # rear marker lights on the rear corner, rear closing beam and plate
    g.append(rect(2850, 2890, 2905, 2990, fill="#E03131", sw=4))
    g.append(rect(2669, 2853, 451, 700, fill="#d5dde8", sw=10))
    # fender over both axles, then the wheels
    for yw in (-820, 80):
        g.append(wheel(yw))
    x0, t = S(-1324, 743)
    g.append(f'<path d="M{x0} {t + 160} Q{x0 + 60} {t} {x0 + 300} {t} L{x0 + 1608} {t} Q{x0 + 1848} {t} {x0 + 1908} {t + 160}" '
             f'fill="none" stroke="{LINE}" stroke-width="40" stroke-linecap="round"/>')
    # labels above
    L = [
        ("หัวต่อพ่วง", (300, -200), (-4330, 575), "middle"),
        ("กล่องเครื่องมือหน้า", (1300, -380), (-3100, 860), "middle"),
        ("รางน้ำหลังคา", (2900, -200), (-1000, 3033), "middle"),
        ("ประตูข้าง (ข้างละ 4 บาน)", (4700, -380), (700, 2400), "middle"),
        ("เสามุม / โครงตู้", (6900, -200), (2800, 2600), "middle"),
        # below
        ("คานลาก", (500, 3700), (-3800, 440), "middle"),
        ("คานแชสซีส์", (1900, 3880), (-2000, 490), "middle"),
        ("ล้อและเพลา (2 เพลา)", (3500, 3700), (-820, 133), "middle"),
        ("บังโคลน", (4600, 3880), (500, 700), "middle"),
        ("บานพับ · มือจับล็อก", (5900, 3700), (1335, 1800), "middle"),
        ("ไฟท้าย / ป้ายทะเบียน", (6950, 3880), (2760, 560), "middle"),
    ]
    for t_, at, to, an in L:
        g.append(label(t_, at, to, an))
    return (f'<svg class="diagram" viewBox="-150 -580 7800 4520" xmlns="http://www.w3.org/2000/svg">{"".join(g)}</svg>')


def rear_view():
    """Rear view, x across: same z scale. Light positions from the CAD (amber inner, red outer)."""
    X0 = -1400

    def R(x, z):
        return x - X0, ZTOP - z

    def rr(x0, x1, z0, z1, fill=FILL, sw=14, rx=0):
        a, t = R(x0, z1)
        return f'<rect x="{a:.0f}" y="{t:.0f}" width="{x1 - x0:.0f}" height="{z1 - z0:.0f}" rx="{rx}" fill="{fill}" stroke="{LINE}" stroke-width="{sw}"/>'

    g = []
    a, t = R(-1400, -217)
    g.append(f'<line x1="{a}" y1="{t}" x2="{a + 2800}" y2="{t}" stroke="#9aa6b6" stroke-width="12" stroke-dasharray="60 40"/>')
    for s in (-1, 1):  # wheels seen from behind
        x0, x1 = (930, 1160) if s > 0 else (-1160, -930)
        g.append(rr(x0, x1, -217, 483, fill="#3a3f47", rx=40))
        f0, f1 = (900, 1250) if s > 0 else (-1250, -900)
        g.append(rr(f0, f1, 600, 700, fill="#9aa6b6", sw=8))
    g.append(rr(-900, 900, 490, 700, fill="#d5dde8"))
    g.append(rr(-908, 908, 700, 3003, fill=FILL, sw=18))
    g.append(rr(-860, 860, 760, 2940, fill="#fff", sw=10))  # rear door
    a, t = R(0, 2940)
    g.append(f'<line x1="{a}" y1="{t}" x2="{a}" y2="{t + 2180}" stroke="#c3ccd8" stroke-width="10"/>')
    g.append(rr(-120, -40, 1500, 1900, fill=NAVY, sw=0, rx=12))
    g.append(rr(40, 120, 1500, 1900, fill=NAVY, sw=0, rx=12))
    g.append(rr(-920, 920, 3003, 3033, fill="#9aa6b6", sw=8))
    for x0, x1, c in ((-803, -704, "#E03131"), (-664, -569, "#F59F00"), (586, 681, "#F59F00"), (708, 803, "#E03131")):
        g.append(rr(x0, x1, 2905, 2990, fill=c, sw=4))
    g.append(rr(-901, 904, 451, 700, fill="#d5dde8", sw=10))
    g.append(rr(-245, 250, 470, 680, fill="#fff", sw=10))
    for x0, x1 in ((-880, -700), (700, 880)):  # tail lamps on the closing beam (positions not in the file)
        g.append(rr(x0, x1, 520, 640, fill="#E03131", sw=6, rx=10))

    def lab(text, at, to):
        tx, ty = R(*to)
        ax, ay = at
        ly = ay + (30 if ay < ty else -190)
        return (f'<line x1="{ax}" y1="{ly}" x2="{tx}" y2="{ty}" stroke="{NAVY}" stroke-width="12"/>'
                f'<circle cx="{tx}" cy="{ty}" r="34" fill="{NAVY}" stroke="#fff" stroke-width="10"/>'
                f'<text x="{ax}" y="{ay}" text-anchor="middle" font-size="200" fill="{NAVY}" {FONT}>{text}</text>')

    g.append(lab("ไฟหรี่หลังคา", (650, -220), (-750, 2950)))
    g.append(lab("ประตูท้าย", (2200, -220), (300, 2300)))
    g.append(lab("ไฟท้าย", (450, 3750), (-790, 580)))
    g.append(lab("ป้ายทะเบียน", (1950, 3750), (0, 470)))
    return f'<svg class="diagram rear" viewBox="-200 -500 3200 4350" xmlns="http://www.w3.org/2000/svg">{"".join(g)}</svg>'
