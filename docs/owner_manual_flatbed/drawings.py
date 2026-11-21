"""Line drawings for the RRS cargo-flatbed owner manual (original RRS artwork, simple SVG).

Sizes follow the RRS flatbed model (docs/FORD_SUPER_DUTY_INSTALL.md 2.5): floor 2,669 x 1,874 mm, main frame 1,962 mm.
"""

INK, NAVY, BLUE, CYAN, FILL, LIGHT = "#2B2F36", "#0B2A5B", "#1257C8", "#00B4F0", "#F3F6FA", "#DCE6F2"
FONT = 'font-family="Noto Sans, Noto Sans Thai"'


def _callout(n, x, y, tx, ty):
    return (f'<line x1="{tx}" y1="{ty}" x2="{x}" y2="{y}" stroke="{NAVY}" stroke-width="1.4"/>'
            f'<circle cx="{x}" cy="{y}" r="3" fill="{NAVY}"/>'
            f'<circle cx="{tx}" cy="{ty}" r="10" fill="{NAVY}"/>'
            f'<text x="{tx}" y="{ty + 4.5}" text-anchor="middle" font-size="12" font-weight="bold" fill="#fff" {FONT}>{n}</text>')


def components():
    """Three-quarter view of the truck with the flatbed, numbered parts 1-8."""
    g = []
    # cab (simplified)
    g.append(f'<path d="M40 150 L40 92 Q42 70 70 66 L128 62 L150 100 L152 150 Z" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    g.append(f'<path d="M72 74 L124 70 L140 100 L72 100 Z" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>')
    # headboard (1)
    g.append(f'<rect x="156" y="62" width="10" height="70" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    for yy in range(70, 130, 10):
        g.append(f'<line x1="156" y1="{yy}" x2="166" y2="{yy}" stroke="{INK}" stroke-width=".8"/>')
    # deck & sides (2 left side, 3 tailgate)
    g.append(f'<path d="M166 108 L420 108 L452 92 L196 92 Z" fill="{LIGHT}" stroke="{INK}" stroke-width="1.6"/>')
    g.append(f'<rect x="166" y="108" width="254" height="30" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    for xx in (230, 295, 360):
        g.append(f'<line x1="{xx}" y1="108" x2="{xx}" y2="138" stroke="{INK}" stroke-width="1"/>')
    g.append(f'<path d="M420 108 L452 92 L452 122 L420 138 Z" fill="{FILL}" stroke="{INK}" stroke-width="2"/>')
    # hinges (4) under side gate, latches (5)
    for xx in (200, 293, 386):
        g.append(f'<rect x="{xx}" y="137" width="14" height="5" fill="{NAVY}"/>')
    for xx in (226, 356):
        g.append(f'<rect x="{xx - 4}" y="112" width="8" height="12" rx="2" fill="{BLUE}"/>')
    # tie hooks (6)
    for xx in (190, 260, 330, 400):
        g.append(f'<path d="M{xx} 138 q0 6 5 6" fill="none" stroke="{INK}" stroke-width="1.5"/>')
    # frame, rear bar (7), mudguard (8), wheels
    g.append(f'<rect x="150" y="142" width="280" height="10" fill="#c9d2de" stroke="{INK}" stroke-width="1.2"/>')
    g.append(f'<rect x="424" y="140" width="34" height="22" fill="#c9d2de" stroke="{INK}" stroke-width="1.5"/>')
    g.append(f'<rect x="428" y="145" width="8" height="5" fill="#E03131"/><rect x="446" y="145" width="8" height="5" fill="#F59F00"/>')
    for cx in (100, 360):
        g.append(f'<circle cx="{cx}" cy="168" r="22" fill="#3a3f47" stroke="{INK}" stroke-width="2"/><circle cx="{cx}" cy="168" r="10" fill="#c9d2de"/>')
    g.append(f'<path d="M330 152 Q360 128 392 152" fill="none" stroke="{INK}" stroke-width="3"/>')
    g.append(f'<line x1="10" y1="190" x2="480" y2="190" stroke="#9aa6b6" stroke-dasharray="6 4"/>')
    calls = [(1, 161, 72, 166, 26), (2, 300, 124, 300, 26), (3, 438, 112, 470, 64), (4, 300, 140, 270, 212),
             (5, 356, 118, 400, 26), (6, 262, 143, 210, 212), (7, 441, 156, 470, 212), (8, 362, 140, 340, 212)]
    for c in calls:
        g.append(_callout(*c))
    return f'<svg class="dwg" viewBox="0 10 490 215" xmlns="http://www.w3.org/2000/svg">{"".join(g)}</svg>'


def top_view(length="2,669", width="1,874", label_len="ความยาวพื้น", label_w="ความกว้างพื้น"):
    """Floor plan with dimension lines; front to the left."""
    x0, y0, w, h = 90, 30, 300, 150
    g = [f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="{LIGHT}" stroke="{INK}" stroke-width="2"/>']
    for i in range(1, 8):
        yy = y0 + i * h / 8
        g.append(f'<line x1="{x0}" y1="{yy:.0f}" x2="{x0 + w}" y2="{yy:.0f}" stroke="#b8c4d4" stroke-width="1"/>')
    g.append(f'<rect x="{x0 - 8}" y="{y0}" width="8" height="{h}" fill="{NAVY}"/>')
    # dims
    g.append(f'<line x1="{x0}" y1="{y0 + h + 22}" x2="{x0 + w}" y2="{y0 + h + 22}" stroke="{NAVY}" stroke-width="1.2" marker-start="url(#a)" marker-end="url(#a)"/>')
    g.append(f'<text x="{x0 + w / 2}" y="{y0 + h + 40}" text-anchor="middle" font-size="13" fill="{NAVY}" {FONT}>{label_len} {length} มม.</text>')
    g.append(f'<line x1="{x0 + w + 22}" y1="{y0}" x2="{x0 + w + 22}" y2="{y0 + h}" stroke="{NAVY}" stroke-width="1.2" marker-start="url(#a)" marker-end="url(#a)"/>')
    g.append(f'<text x="{x0 + w + 32}" y="{y0 + h / 2}" font-size="13" fill="{NAVY}" {FONT} transform="rotate(90 {x0 + w + 32} {y0 + h / 2})" text-anchor="middle">{label_w} {width} มม.</text>')
    g.append(f'<path d="M60 {y0 + h / 2} l-30 0 m0 0 l10 -7 m-10 7 l10 7" stroke="{BLUE}" stroke-width="2" fill="none"/>')
    g.append(f'<text x="45" y="{y0 + h / 2 - 12}" text-anchor="middle" font-size="12" fill="{BLUE}" {FONT}>หน้ารถ</text>')
    g.append(f'<text x="{x0 + w / 2}" y="{y0 - 10}" text-anchor="middle" font-size="12" fill="#5b6577" {FONT}>ด้านขวา (RH)</text>')
    defs = (f'<defs><marker id="a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0 0 L10 5 L0 10 z" fill="{NAVY}"/></marker></defs>')
    return f'<svg class="dwg" viewBox="0 0 470 240" xmlns="http://www.w3.org/2000/svg">{defs}{"".join(g)}</svg>'


def latch(locked=True):
    """Gate latch seen from outside: lever over the hook (locked) or pulled up and turned away (unlocked)."""
    g = [f'<rect x="10" y="10" width="160" height="120" rx="10" fill="#fff" stroke="{INK}" stroke-width="1.5"/>',
         f'<rect x="30" y="30" width="22" height="90" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>',  # corner post
         f'<rect x="52" y="52" width="110" height="42" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>',  # gate edge
         f'<path d="M40 70 q-8 6 0 12" fill="none" stroke="{INK}" stroke-width="3"/>']  # hook on post
    if locked:
        g.append(f'<rect x="38" y="60" width="44" height="9" rx="3" fill="{NAVY}"/>')
        g.append(f'<circle cx="82" cy="64" r="5" fill="{NAVY}"/>')
        g.append(f'<text x="90" y="150" text-anchor="middle" font-size="13" font-weight="bold" fill="{NAVY}" {FONT}>ล็อก (Locked)</text>')
    else:
        g.append(f'<rect x="78" y="30" width="9" height="40" rx="3" fill="{BLUE}"/>')
        g.append(f'<circle cx="82" cy="64" r="5" fill="{BLUE}"/>')
        g.append(f'<path d="M100 40 a18 18 0 0 1 -6 26" fill="none" stroke="{CYAN}" stroke-width="2.5" marker-end="url(#b)"/>')
        g.append(f'<text x="90" y="150" text-anchor="middle" font-size="13" font-weight="bold" fill="{BLUE}" {FONT}>ปลดล็อก (Unlocked)</text>')
    defs = (f'<defs><marker id="b" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto">'
            f'<path d="M0 0 L10 5 L0 10 z" fill="{CYAN}"/></marker></defs>')
    return f'<svg class="dwg small" viewBox="0 0 180 158" xmlns="http://www.w3.org/2000/svg">{defs}{"".join(g)}</svg>'


def gate_open(angle):
    """Side view of the tailgate: closed, 90 degrees (level, on its stays) or 180 degrees (hanging)."""
    g = [f'<rect x="20" y="70" width="150" height="14" fill="{LIGHT}" stroke="{INK}" stroke-width="1.5"/>',  # deck
         f'<text x="95" y="104" text-anchor="middle" font-size="11" fill="#5b6577" {FONT}>พื้นกระบะ</text>',
         f'<circle cx="170" cy="84" r="4" fill="{NAVY}"/>']
    if angle == 90:
        g.append(f'<rect x="170" y="80" width="70" height="8" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>')
        g.append(f'<line x1="160" y1="40" x2="236" y2="80" stroke="{BLUE}" stroke-width="2"/>')
        g.append(f'<line x1="160" y1="40" x2="160" y2="70" stroke="{INK}" stroke-width="3"/>')
        g.append(f'<text x="205" y="58" font-size="11" fill="{BLUE}" {FONT}>โซ่/สลิงรั้ง</text>')
        t = "90° – ฝาท้ายรับของ"
    else:
        g.append(f'<rect x="166" y="84" width="8" height="70" fill="{FILL}" stroke="{INK}" stroke-width="1.5"/>')
        g.append(f'<path d="M200 60 a40 40 0 0 1 -10 70" fill="none" stroke="{CYAN}" stroke-width="2" stroke-dasharray="5 3"/>')
        t = "180° – ฝาท้ายห้อยลง"
    g.append(f'<text x="125" y="176" text-anchor="middle" font-size="13" font-weight="bold" fill="{NAVY}" {FONT}>{t}</text>')
    return f'<svg class="dwg small" viewBox="0 20 260 165" xmlns="http://www.w3.org/2000/svg">{"".join(g)}</svg>'
