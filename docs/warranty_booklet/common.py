"""Shared layout for the RRS warranty booklets (215 x 240 mm, white-blue theme, Noto Sans + Noto Sans Thai).

Each booklet's build.py: `from common import *`, call set_footer(), add pages with page()/raw(), then save().
"""
import html
import re
H = lambda s: s
pages = []
n = [0]
FOOTER = ["สมุดรับประกันและการบำรุงรักษา"]

# Sections are told apart by name and pictogram (thumb tab on the page edge), the way Toyota / Ford owner and warranty
# books do – not by letters or numbers. Source titles keep "N. " so the tab knows the section; it is not printed.
SECTION_NAMES = {1: "ข้อมูล", 2: "การรับประกัน", 3: "การใช้งานและการบำรุงรักษา", 4: "บันทึก",
                 5: "เครนติดรถ", 6: "หางลากพ่วงจูง", 7: "กระบะพื้นเรียบคาร์โก้"}
_P = {
    1: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    2: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    3: '<path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17l3 3 5.5-5.5a4 4 0 0 0 5.2-5.2l-2.4 2.4-2.6-.4-.4-2.6z"/>',
    4: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    5: '<path d="M3 21h11M6 21v-5h5v5M8.5 16L20 6M20 6v8"/><path d="M18.5 16.5a1.5 1.5 0 0 0 3 0"/>',
    6: '<rect x="7" y="5" width="14" height="10" rx="1"/><path d="M2 15h5M7 15h14"/><circle cx="12" cy="18" r="2"/><circle cx="16.5" cy="18" r="2"/>',
    7: '<path d="M2 14h12M14 14V8h4l3 3v3h-7"/><path d="M2 14V11"/><circle cx="6" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
}


def icon(n, cls="ico"):
    return (f'<svg class="{cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
            f'stroke-linecap="round" stroke-linejoin="round">{_P[n]}</svg>')


def sref(text):
    """§N in body text -> pictogram + section name."""
    return re.sub(r"§([1-7])", lambda m: f'<span class="sref">{icon(int(m.group(1)))}{SECTION_NAMES[int(m.group(1))]}</span>', text)


def set_footer(text):
    FOOTER[0] = text


def page(section, body, cls=""):
    n[0] += 1
    side = "odd" if n[0] % 2 else "even"
    m = re.match(r"([1-7])\. ", section)
    tab = f'<div class="tab">{icon(int(m.group(1)))}</div>' if m else ""
    title = section[m.end():] if m else section
    pages.append(f'''<section class="page {side} {cls}">{tab}<header><img src="logo.png"><span>{title}</span></header>
<main>{sref(body)}</main><footer><span>{FOOTER[0]}</span><b>{n[0]}</b></footer></section>''')
def raw(body, cls):
    n[0] += 1
    pages.append(f'<section class="page {cls}">{sref(body)}</section>')
_OK = ('<svg class="mk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" '
       'stroke-linejoin="round"><path d="M6 12.5l4 4 8-9"/></svg>')
_NO = ('<svg class="mk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">'
       '<path d="M7 7l10 10M17 7L7 17"/></svg>')


def _head(h):
    """'✔ text' / '✘ text' headers become a coloured column with a badge; returns (html, column class)."""
    if h.startswith("✔ "):
        return f'<span class="badge ok">{_OK}</span>{h[2:]}', "ok"
    if h.startswith("✘ "):
        return f'<span class="badge no">{_NO}</span>{h[2:]}', "no"
    return h, ""


def _cell(c):
    """A list becomes a bulleted list: one condition per line, as warranty terms are set."""
    if isinstance(c, (list, tuple)):
        return '<ul class="vl">' + "".join(f"<li>{x}</li>" for x in c) + "</ul>"
    return c


def table(head, rows, widths=None, cls=""):
    cg = "".join(f'<col style="width:{w}%">' for w in widths) if widths else ""
    heads = [_head(h) for h in head]
    kinds = [k for _, k in heads]
    if any(kinds):
        cls = (cls + " verdict").strip()
    th = "".join(f'<th class="{k}">{h}</th>' if k else f"<th>{h}</th>" for h, k in heads)
    tr = "".join("<tr>" + "".join(f'<td class="{kinds[i]}">{_cell(c)}</td>' if i < len(kinds) and kinds[i] else f"<td>{_cell(c)}</td>"
                                  for i, c in enumerate(r)) + "</tr>" for r in rows)
    return f'<table class="{cls}"><colgroup>{cg}</colgroup><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>'
def opener(letter, title, sub):
    return f'<div class="opener"><div class="band"><span class="letter">{icon(int(letter), "ico big") if str(letter).isdigit() else letter}</span><h1>{title}</h1><img src="logo_white.png"></div><p class="sub">{sub}</p></div>'
F = '<span class="fill"></span>'
def field(label, w=""):
    return f'<div class="field {w}"><label>{label}</label><i></i></div>'



CSS = '''
table.scope.tight td{padding:2mm 2.6mm}table.scope.tight ul.vl li{margin-bottom:.5mm}table.inline td{font-size:9.1pt;line-height:1.4}table.inline td{padding:1.7mm 2.6mm}
table.inline ul.vl{padding-left:0;list-style:none}table.inline ul.vl li{display:inline;margin:0}table.inline ul.vl li::before{content:"•";color:#D45A5F;margin:0 1.4mm 0 0}table.inline ul.vl li+li::before{margin-left:2.6mm}table.inline td{padding:2.4mm 2.8mm}
ol.terms,ul.terms{padding-left:5.5mm;margin:0 0 3mm}ol.terms li,ul.terms li{margin-bottom:1.2mm;line-height:1.5}ol.terms li::marker{color:#1257C8;font-weight:bold}
ul.vl{margin:0;padding-left:3.6mm}ul.vl li{margin:0 0 1.3mm;line-height:1.45}ul.vl li:last-child{margin-bottom:0}ul.vl li::marker{color:#7a8394}td.ok ul.vl li::marker{color:#2FA77A}td.no ul.vl li::marker{color:#D45A5F}.intro{line-height:1.6;margin:0 0 4mm;text-align:justify}.cond{font-size:8.6pt;color:#5b6577;font-style:normal}
table.verdict{border-collapse:separate;border-spacing:0;border:.6pt solid #c9d6ea;border-radius:2.5mm;overflow:hidden}table.verdict th{vertical-align:middle}table.verdict th.ok{background:#0E7A55}table.verdict th.no{background:#A8262E}table.verdict tbody tr:nth-child(even) td{background:#F6F8FC}table.verdict td{border-bottom:.5pt solid #dfe6f1}table.verdict tbody tr:last-child td{border-bottom:0}table.verdict td.ok{background:#F1FAF5!important;border-left:2pt solid #2FA77A;color:#1F3B30}table.verdict td.no{background:#FDF3F3!important;border-left:2pt solid #D45A5F;color:#4A2427}table.verdict tbody tr:nth-child(even) td.ok{background:#E6F5ED!important}table.verdict tbody tr:nth-child(even) td.no{background:#FAE8E8!important}.badge{display:inline-flex;align-items:center;justify-content:center;width:5mm;height:5mm;border-radius:50%;background:#fff;margin-right:1.6mm;vertical-align:-1.2mm}.badge .mk{width:3.4mm;height:3.4mm}.badge.ok{color:#0E7A55}.badge.no{color:#A8262E}
.tab{position:absolute;top:112mm;right:0;width:8mm;height:16mm;background:#1257C8;border-radius:2.2mm 0 0 2.2mm;display:flex;align-items:center;justify-content:center}.tab .ico{width:4.6mm;height:4.6mm;color:#fff}.ico.big{width:11mm;height:11mm;color:#fff;display:block}.sref{white-space:nowrap;font-weight:bold;color:#1257C8}.sref .ico{width:1.05em;height:1.05em;vertical-align:-.15em;margin-right:.25em}
figure.cut{overflow:visible}figure.cut img{object-fit:contain}.cap{font-size:8.8pt;color:#0B2A5B;text-align:center;margin:0 0 2mm}.figs .narrow{flex:1}.figs .narrow figure{margin-bottom:1mm}

figure{margin:2mm 0 3mm;position:relative;border-radius:1.5mm;overflow:hidden}figure img{width:100%;height:100%;object-fit:cover;display:block}figcaption{position:absolute;left:0;right:0;bottom:0;background:rgba(11,42,91,.88);color:#fff;font-size:8.8pt;padding:1.2mm 3mm}
.figs{display:flex;gap:5mm}.figs figure{flex:1.25}.figs figure.narrow{flex:1}

.fig{width:100%;height:44mm;object-fit:contain;display:block;margin-bottom:2mm}

.back h2:after,.cardhead h2:after{display:none}.cardhead h2{padding-bottom:0}
.signs.tight{margin-top:3mm!important}.signs.tight .stamp{height:18mm!important}.cardhead+h3{margin-top:2mm}

.lead{font-size:12.5pt;color:#0B2A5B;margin-bottom:6mm}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:5mm;margin-bottom:4mm}.cards div{border:1pt solid #c9d6ea;border-top:2.5pt solid #1257C8;padding:4mm;position:relative}.cards b{position:absolute;right:4mm;top:2mm;font-size:22pt;color:#00B4F0}.cards p{margin:1.5mm 0 0;font-size:10pt}
ol.steps li{padding-top:2.4mm!important;padding-bottom:2.4mm!important}

@page{size:215mm 240mm;margin:0}*{box-sizing:border-box}html,body{margin:0}
body{font-family:"Noto Sans","Noto Sans Thai",sans-serif;color:#2B2F36;font-size:10.5pt;line-height:1.45}
.page{width:215mm;height:240mm;position:relative;overflow:hidden;page-break-after:always;background:#fff;padding:22mm 15mm 16mm}
header{position:absolute;top:8mm;left:15mm;right:15mm;height:9mm;border-bottom:1.2pt solid #1257C8;display:flex;align-items:center;gap:4mm;color:#1257C8;font-weight:bold;font-size:8.5pt}
header img{height:5.6mm}
footer{position:absolute;bottom:7mm;left:15mm;right:15mm;display:flex;justify-content:space-between;font-size:7.5pt;color:#7a8394}footer b{color:#1257C8;font-size:9pt}
h1,h2,h3,h4,th,header,b,strong{font-family:"Noto Sans","Noto Sans Thai",sans-serif}h1,h2,h3{margin:0}h2{color:#0B2A5B;font-size:18pt;margin:0 0 4mm;padding-bottom:1.5mm;position:relative}h3{color:#1257C8;font-size:12pt;margin:5mm 0 2mm}h4{margin:0;color:#0B2A5B;font-size:11.5pt}
p{margin:0 0 2.5mm}ul,ol{margin:0 0 2mm;padding-left:5.5mm}li{margin-bottom:.8mm}
table{width:100%;border-collapse:collapse;margin:1mm 0 4mm;font-size:9.8pt}th{background:#0B2A5B;color:#fff;text-align:left;padding:2.2mm 2.5mm;font-weight:bold}
td{padding:2.3mm 2.5mm;border-bottom:.5pt solid #c9d6ea;vertical-align:top}tbody tr:nth-child(even) td{background:#EAF2FB}
.yr{display:inline-block;border:1.2pt solid #00B4F0;color:#0B2A5B;font-weight:bold;border-radius:2mm;padding:.5mm 2mm;white-space:nowrap}
.note{background:#EAF2FB;border-left:2.5pt solid #1257C8;padding:3mm 4mm;margin:3.5mm 0;font-size:10pt}
.warn{border:1.5pt solid #D9480F;background:#FFF4EC;color:#8a2c05;padding:3mm 4mm;margin-top:5mm;font-size:10.5pt}
.opener{margin:-2mm 0 5mm}.band{background:#0B2A5B;color:#fff;display:flex;align-items:center;gap:5mm;padding:4mm 5mm;border-left:5mm solid #00B4F0}
.band h1{font-size:19pt;flex:1}.band img{height:9mm}.letter{font-size:24pt;font-weight:bold;color:#00B4F0}.sub{color:#1257C8;margin-top:1.5mm}
.cover{position:absolute;inset:0;background:#fff}.stripe{position:absolute;left:0;top:0;bottom:0;width:14mm;background:linear-gradient(#3f40c4,#1257C8 45%,#00B4F0)}
.biglogo{position:absolute;top:32mm;left:50mm;width:129mm}
.ctitle{position:absolute;top:92mm;left:30mm;right:16mm}.ctitle small{color:#1257C8;letter-spacing:.2em;font-weight:bold;font-size:9pt}.ctitle h1{font-size:33pt;line-height:1.2;color:#0B2A5B;margin:2mm 0 3mm}.ctitle p{font-size:13pt;color:#2B2F36}
.badges{position:absolute;top:158mm;left:30mm;right:16mm;display:flex;gap:6mm}.badges div{flex:1;border-top:2.5pt solid #00B4F0;padding-top:2mm}.badges b{font-size:34pt;color:#1257C8;line-height:1}.badges span{font-size:13pt;color:#1257C8;font-weight:bold;margin-left:1mm}.badges em{display:block;font-style:normal;font-size:9pt;margin-top:1mm}
.cfoot{position:absolute;bottom:0;left:14mm;right:0;height:20mm;background:#0B2A5B;color:#fff;display:flex;justify-content:space-around;align-items:center;font-size:10pt}
.cardhead{display:flex;align-items:center;gap:6mm;border-bottom:2pt solid #0B2A5B;padding-bottom:3mm;margin-bottom:2mm}.cardhead img{width:40mm}.cardhead.small img{width:30mm}.cardhead h2{margin:0;font-size:18pt}.cardhead p{margin:0;color:#1257C8;letter-spacing:.12em;font-size:8.5pt}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.5mm 5mm}.field label{font-size:7.8pt;color:#5b6577;display:block}.field i{display:block;height:5.4mm;border-bottom:.7pt solid #1257C8}.w2{grid-column:span 2}.w3{grid-column:span 3}
.ends{display:flex;gap:5mm}.ends div{flex:1;border:1.2pt solid #00B4F0;border-radius:2mm;padding:2mm 3mm;font-size:8.8pt}.ends b{color:#1257C8;font-size:12pt;margin-right:1mm}.ends i{display:block;height:7mm;border-bottom:.7pt solid #1257C8}
.ack{margin:4mm 0 2mm;background:#EAF2FB;padding:2.2mm 3mm}
.signs{display:flex;gap:8mm;margin-top:9mm;font-size:9.5pt;text-align:center;align-items:flex-end}.signs div{flex:1}.signs i{display:block;border-bottom:.7pt solid #2B2F36;height:9mm;margin-bottom:1mm}.signs .stamp{border:.8pt dashed #1257C8;height:22mm;display:flex;align-items:center;justify-content:center;color:#7a8394}
table.form td{height:10.6mm;font-size:9.6pt;vertical-align:middle}table.form td:nth-child(3){text-align:center;font-size:12pt}
table.scope td{font-size:9.4pt;line-height:1.45;padding:3mm 2.8mm}
.hero{display:flex;align-items:center;gap:6mm;background:#0B2A5B;color:#fff;padding:4mm 6mm;border-left:5mm solid #00B4F0;margin-bottom:2mm}.hero b{font-size:30pt;white-space:nowrap;color:#fff}.hero span{font-size:10pt}
ol.steps{list-style:none;padding:0;counter-reset:s}ol.steps li{counter-increment:s;position:relative;padding:1.4mm 0 1.4mm 11mm;border-bottom:.5pt solid #c9d6ea}ol.steps li:before{content:counter(s);position:absolute;left:0;top:1mm;width:7mm;height:7mm;border-radius:50%;background:#00B4F0;color:#fff;font-weight:bold;text-align:center;line-height:7mm}
.contact{display:flex;gap:6mm;align-items:center;border:1.2pt solid #1257C8;padding:4mm;margin-top:6mm}.contact img{width:34mm}
.two{display:flex;gap:8mm}.two>div{flex:1}ul.check{list-style:"☐  ";}
table.log td{height:14.2mm;text-align:center;vertical-align:middle;font-size:8pt}table.log th{font-size:7.4pt;padding:1.2mm 1mm;text-align:center}table.log td:nth-child(2){text-align:left}table.log.tall td{height:14.6mm}
.small{font-size:9pt;color:#5b6577}
.back{position:absolute;inset:0;background:#0B2A5B;color:#fff;text-align:center;padding-top:62mm;border-bottom:14mm solid #00B4F0}.back img{width:95mm}.back h2{color:#fff;margin:9mm 0 5mm;font-size:16pt}.back p{line-height:2.1;font-size:10.5pt}.back small{position:absolute;bottom:10mm;left:0;right:0;color:#9fc3f5}
'''


def save(path, title, extra_css=""):
    open(path, "w", encoding="utf-8").write(f'<!doctype html><html lang="th"><meta charset="utf-8"><title>{title}</title><style>{CSS}{extra_css}</style><body>{"".join(pages)}</body></html>')
    print(n[0], "pages")
