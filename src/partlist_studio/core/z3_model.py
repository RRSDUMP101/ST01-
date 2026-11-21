"""A ZW3D file (.Z3 / .Z3ASM) opened as a 3D assembly: every part a box where the file places it, with what is wrong
with the design said in the note.

A .Z3 file holds names, assemblies, placements and boxes, no faces (see z3_reader). So each part is drawn as its box
until a STEP of the same assembly gives the real shapes. The axes of the RRS drawings of the trailer are +Y to the
rear, Z up; the program's are +X to the rear, +Y the right of the vehicle: X = Y(file), Y = -X(file), Z = Z(file).

The box trailer of RRS ("หางลากพื้นเรียบตู้ทึบ", docs/TRAILER_INSTALL.md) gets its 19 steps from the names of its parts;
any other .Z3 gets one step per group, as an imported mesh does.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import assembly3d as a3
from . import z3_reader as zr

Z3_SUFFIXES = (".z3", ".z3asm", ".z3prt")
STALE_BEYOND = 300.0  # mm: a box that reaches this far past all the other parts is stale (ZW3D does not shrink it)
SAME_PLACE = 0.5  # mm / matrix units: two placements this close, of parts of the same own box, are one part twice
PARTNER_TOL = 80.0  # mm: a part and its twin on the other side, mirrored across the middle, agree to this
ASYMMETRY = 5.0  # mm: twins that differ by more are reported
CENTRED = 20.0  # mm: a part whose middle is this close to the middle line needs no twin
TOP_BOX = 20000.0  # mm: an assembly box longer than this is no shape of its own (the top's own box is ~49 m long)
BODY_GROUP_OF_DOOR = "ประตูข้าง"


def is_z3_file(path: str | Path) -> bool:
    return Path(path).suffix.lower() in Z3_SUFFIXES


@dataclass
class Z3Check:
    """What opening the file found: shown in the note of the model, and kept for the tests."""

    duplicates: list[tuple[str, str]] = field(default_factory=list)  # (instance, instance) at one place
    stale: list[str] = field(default_factory=list)  # parts whose box was cut back to the others
    alone: dict[str, int] = field(default_factory=dict)  # base name -> parts with no twin on the other side
    uneven: list[tuple[str, float]] = field(default_factory=list)  # (base name, mm) twins that are not equal
    unused: int = 0  # 3D objects of the file the top assembly does not use
    unused_names: list[str] = field(default_factory=list)
    missing_files: list[str] = field(default_factory=list)
    bodies: int = 0  # assemblies with a shape of their own (door leaves, a box) made parts

    def lines(self) -> list[str]:
        out = []
        for a, b in self.duplicates:
            out.append(f"ชิ้นวางซ้ำที่เดียวกัน: {a} = {b}")
        if self.stale:
            out.append(f"กล่องขอบเขตใหญ่เกินชิ้นจริง (ZW3D ไม่ปรับให้ตรง) – ตัดภาพให้อยู่ในตัวหาง: {', '.join(self.stale)}")
        for name, n in self.alone.items():
            out.append(f"ไม่มีคู่อีกด้าน: {name} {n} ชิ้น")
        for name, d in self.uneven:
            out.append(f"ซ้าย/ขวาไม่เท่ากัน {d:,.0f} มม.: {name}")
        if self.missing_files:
            out.append(f"ไฟล์ที่ชุดประกอบเรียกแต่ไม่อยู่ในโฟลเดอร์: {', '.join(self.missing_files)}")
        if self.unused:
            out.append(f"วัตถุในไฟล์ที่ไม่ได้ใช้ในชุดประกอบ {self.unused} รายการ (ไม่นับในใบรายการ)")
        return out


# --------------------------------------------------------------------------- the box trailer
TRAILER_PHASES = ("เตรียมชิ้นงาน", "งานโครงบนจิ๊ก", "งานตัวถัง", "งานติดตั้ง + ต่อพ่วงกับรถ")
UNSORTED = a3.UNSORTED_GROUP
# (group, step, rule on the name without '_Mirror…'); the first rule that matches wins. The order of the steps is the
# one the RRS factory built the first box trailer in (videos of 3-19 Nov 2026, docs/TRAILER_INSTALL.md section 8)
TRAILER_RULES: list[tuple[str, int, str]] = [
    ("คานแม่", 4, r"^4x5500"),
    ("คานขวาง", 5, r"^(บน p[2489]|คานกลาง.*|คาน1?)$"),
    ("คานตามยาว / รองพื้น", 6, r"^(บน p[13567]|กล่อง 1x1|ตัวประกบบน)$"),
    ("คันลาก", 7, r"^(ล่าง p\d|ตัวประกบล่าง1?|ประกบข้าง|Part006)$"),
    ("ชุดล้อ + บังโคลน", 8, r"^(ล้อ|บังโคลน)"),
    ("พื้นตู้", 9, r"^พื้น"),  # not "พื้น": a group named like a part would read as its twin (tidy_names)
    (BODY_GROUP_OF_DOOR, 10, r"^(ประตูตู้ [12]|เสากลาง)"),
    ("โครงตู้", 11, r"^(ตู้ p[13456]|Part003|Part004)$"),
    ("หลังคา", 12, r"^(ตู้ p2|ประตูตู้2|กันน้ำบนหลังคา|Part005)$"),
    ("บานพับ + หูรับกลอน", 14, r"^(บานพับ|Part002)"),
    ("ประตูหน้า / ท้าย", 16, r"^ประตูตู้(หน้า|ท้าย)$"),
    ("กล่องเก็บของหน้าตู้", 17, r"^(กล่องหน้า|ฝากล่องหน้า|แบบกล่องใหม่)$"),
    ("ไฟ + ป้าย", 18, r"^(ไฟ|ป้าย|ปิดท้าย)"),
    ("อุปกรณ์ของ Ford", 18, r"(?i)^n1wj"),
]
TRAILER_FITS = 0.6  # this share of the parts named by the rules: the model is the box trailer
TRAILER_UNSORTED_STEP = 18


def trailer_sequence() -> list[a3.Step]:
    prep, jig, body, fit = TRAILER_PHASES
    s, items = a3.Step, a3.parse_items
    height = "ทำงานบนที่สูง: ใช้บันไดขั้นมีราว / นั่งร้าน และสายกันตก"
    return [
        # ---- preparing the parts (no part of the 3D model is fitted in these steps)
        s("ตรวจแบบ + ใบตัดชิ้นงาน", "ตรวจแบบ ZW3D ฉบับล่าสุด แบบ 2 มิติ และ Part List ก่อนสั่งตัด – ทุกชิ้นต้องเป็นแบบฉบับเดียวกัน",
          check="ฉบับแบบตรงกันทุกแผ่น · คำเตือนของแบบ (ชิ้นซ้ำ ชิ้นขาดคู่) แก้แล้ว", tools="แบบ 2 มิติ Part List", phase=prep,
          no_parts=True),
        s("ตัด พับ เชื่อมชุดย่อย", "ตัดเลเซอร์ พับ แล้วเชื่อมชุดย่อยแบบลิ้นสอดร่อง (tab-and-slot) เจียรแต่งแนวเชื่อม",
          check="ลิ้นเข้าร่องสุดทุกจุด ไม่มีช่อง · แนวเชื่อมเต็ม ไม่มีรูพรุน · เจียรแนวเชื่อมที่ต้องเรียบ",
          tools="เครื่องเชื่อม MIG หินเจียร", warning="สวมหน้ากากเชื่อม ถุงมือ ผ้าคลุมหน้า ขณะเชื่อม/เจียร",
          phase=prep, no_parts=True),
        s("พ่นสีฝุ่นชิ้นงาน", "ล้างไขมัน แขวนชิ้นงาน พ่นสีฝุ่น แล้วอบตามสเปกสี – ทำก่อนประกอบ (ชิ้นโครง แผ่นเพลท กรอบประตู แผ่นผนังสีขาว)",
          check="สีครบทุกด้านรวมในร่องและรู · ไม่มีเม็ด/ไหล · สีตรงตามแบบของชิ้น",
          warning="ชิ้นที่ต้องเชื่อมเพิ่มหลังพ่นสี: เจียรสีออกก่อนเชื่อม แล้วซ่อมสี", tools="ห้องพ่นสีฝุ่น เตาอบ ตะขอแขวน",
          phase=prep, no_parts=True, items=items("สีฝุ่นดำ (ชิ้นโครง); สีฝุ่นขาว (แผ่นผนัง)")),
        # ---- the frame on the jig
        s("วางคานแม่ 2 เส้นบนจิ๊ก", "ตั้งคานแม่ขนานกันบนจิ๊ก ให้ปลายหน้าอยู่แนวเดียวกัน",
          check="ระยะในระหว่างคาน 1,624 ±1 มม. · ปลายหน้าอยู่แนวเดียวกัน · ความยาวคานตามที่ RRS ยืนยัน",
          tools="จิ๊ก ฉาก ตลับเมตร", phase=jig),
        s("เชื่อมคานขวาง", "เชื่อมคานขวางเข้ากับคานแม่ตามตำแหน่งในภาพ",
          check="คานขวาง บน p4 ห่างกัน 600 ±2 มม. · ทแยงโครงสองแนวเท่ากัน (5,968 ±3 มม.)",
          tools="ตลับเมตร ฉาก แม่เหล็กจับฉาก เครื่องเชื่อม", phase=jig),
        s("คานตามยาว / รองพื้น", "เชื่อมคานตามยาวและแผ่นปิดใต้พื้น", tools="เครื่องเชื่อม ปากกาจับ แม่เหล็กจับฉาก", phase=jig),
        s("ประกอบคันลาก", "เชื่อมคันลาก (A-frame) และแผ่นประกบเข้ากับโครง แล้วเจียรแต่งแนวเชื่อม",
          check="ท่อกลางคันลากอยู่แนวกลาง ±2 มม. · หัวคันลากห่างหน้าตู้ 1,556 มม.",
          warning="ตำแหน่งยึดหัวลากยังไม่มีในแบบ – ใช้ตามแบบหัวลากที่ RRS กำหนด", tools="ตลับเมตร เอ็นแนวกลาง เครื่องเชื่อม หินเจียร",
          phase=jig, items=items("หัวลาก (คอปเปอร์) ให้ตรงกับลูกบอลชุดลาก Ford Ø50 / Ø70 × 1; สลักยึดหัวลาก")),
        s("ชุดเพลา / ล้อ + บังโคลน", "ติดตั้งชุดเพลาและล้อ แล้วติดบังโคลน – ตั้งแชสซีบนขาตั้งรองระหว่างทำงานต่อ",
          check="ล้ออยู่กลางบังโคลน · ตำแหน่งเพลาตามที่ RRS ยืนยัน · แรงขันน็อตล้อตามผู้ผลิตเพลา",
          warning="ตั้งแชสซีบนขาตั้งรองให้มั่นคงก่อนเข้าไปทำงานใต้โครง", tools="แม่แรง ขาตั้งรอง ประแจทอร์ก", phase=jig,
          items=items("ชุดเพลา + ดุม + แหนบ; ล้อ + ยาง; ชุดเบรกหาง (ถ้ามี)")),
        s("ปูพื้น + แผ่นตีนไก่", "ปูแผ่นพื้นและแผ่นตีนไก่บนโครง", tools="เครื่องเชื่อม / สว่าน", phase=jig),
        # ---- the body
        s("เชื่อมกรอบประตู / กรอบผนังบนพื้น", "เชื่อมกรอบประตูข้างและเสากลางวางราบบนพื้นเรียบ แล้วยกตั้งขึ้น",
          check="ทแยงกรอบสองแนวเท่ากัน · กรอบวางแนบพื้นไม่บิด", tools="แม่เหล็กจับฉาก เครื่องเชื่อม MIG ตลับเมตร",
          warning="ยกกรอบตั้งด้วยคนอย่างน้อย 2 คน", phase=body),
        s("ตั้งโครงตู้", "ตั้งเสามุม คานบน/ล่างหัวตู้และท้ายตู้ และฉากหุ้มมุมบนแชสซี",
          check="เสาดิ่ง · ทแยงขอบบนตู้สองแนวเท่ากัน (5,977 ±3 มม.)", tools="ระดับน้ำ ลูกดิ่ง ตลับเมตร เครื่องเชื่อม บันไดขั้นมีราว",
          warning=height, phase=body),
        s("หลังคา", "ติดตั้งรางหลังคา แผ่นหลังคา กันน้ำ และฝาครอบท้ายบน", check="ทดสอบรั่วด้วยน้ำ", warning=height, phase=body),
        s("ติดแผ่นผิวกับกรอบประตู (บนพื้น)", "วางกรอบประตูราบบนพื้น ทำความสะอาดผิวติด แล้ววางแผ่นผิวสีขาวลงบนกรอบและกดให้แนบ",
          check="ผิวติดสะอาด แห้ง ไม่มีฝุ่นสี · แผ่นวางตรงขอบกรอบ · กดแนบทั่วทั้งแผ่น · ทิ้งให้กาว/เทปเซ็ตตามผู้ผลิตก่อนยก",
          warning="วิธีติด (เทปกาวสองหน้า / กาวโครงสร้าง) และเวลาเซ็ต ให้ RRS ยืนยัน", tools="ผ้าสะอาด แปรง ลูกกลิ้งกด",
          phase=body, no_parts=True,
          items=items("แผ่นผิวประตูข้าง พ่นสีขาว × 8; เทปกาวสองหน้า / กาวโครงสร้าง; น้ำยาทำความสะอาด / ไพรเมอร์")),
        s("แขวนประตูข้าง 8 บาน", "แขวนบานประตูข้างด้วยบานพับ ติดหูรับกลอน",
          check="บานพับห่างกัน 466 ±2 มม. · บานพับตัวล่างสูงจากผิวพื้น 190 มม. · เปิด-ปิดคล่อง",
          warning="บานในยังไม่มีบานพับในแบบ – รอ RRS", tools="ประแจ สว่าน ตลับเมตร", phase=body,
          items=items("กลอน / มือจับประตูข้าง; ซีลขอบประตู")),
        s("ติดแผ่นผนังตัวตู้", "ทาไพรเมอร์ / ทำความสะอาดผิวติด ยกแผ่นผนังด้วยรถยกขึ้นวางชิดโครง แล้วจับยึดไว้จนกาวเซ็ต",
          check="แนวแผ่นตรงกับโครง · ช่องรอยต่อระหว่างแผ่นเท่ากัน · จับยึดครบทุกจุดจนกาวเซ็ต",
          warning="ห้ามยืนใต้แผ่นที่ยก · มีคนประคองแผ่นทั้งสองข้าง · " + height,
          tools="รถยก นั่งร้าน / บันไดขั้นมีราว ปากกาจับ แปรง", phase=body, no_parts=True,
          items=items("แผ่นผนังตัวตู้ พ่นสีขาว; เทปกาวสองหน้า / กาวโครงสร้าง; ไพรเมอร์")),
        s("ประตูหน้า + ประตูท้าย", "ติดตั้งประตูหน้าและประตูท้าย", warning="บานพับและกลอนยังไม่มีในแบบ", phase=body,
          items=items("บานพับประตูหน้า / ท้าย; กลอน / มือจับประตูหน้า / ท้าย")),
        s("กล่องเก็บของหน้าตู้", "ติดตั้งกล่องเก็บของหน้าตู้", check="ฝาปิดสนิท", phase=body),
        # ---- fitting, and the trailer on the Ford
        s("ไฟ ป้าย กล้อง + สายไฟ หัวลาก ขาตั้ง โซ่", "ติดไฟ ป้ายทะเบียน กล้องมองหลัง เดินสายไฟถึงปลั๊กหัวหาง "
          "ติดล้อหน้า/ขาตั้ง และโซ่นิรภัย", check="ไฟติดครบทุกวงจร · ภาพกล้องขึ้นจอรถ",
          warning="ขาตั้ง โซ่ ปลั๊ก สายไฟ และไฟระดับล่าง ยังไม่มีในแบบ – ใส่เป็นรายการซื้อสำเร็จ", phase=fit,
          items=items("ล้อหน้า / ขาตั้ง × 1; โซ่นิรภัย × 2; ปลั๊ก 12 ขาแบน AS4177.5 × 1; ชุดสายไฟหาง × 1; "
                      "ไฟท้าย / ไฟเบรก / ไฟเลี้ยว / ไฟถอย ระดับล่าง × 2; แผ่นสะท้อนแสง; ไฟข้าง; ไฟส่องป้าย × 1")),
        s("ต่อพ่วงกับรถ Ford", "ต่อหางกับรถตามเช็กลิสต์ติดตั้ง (ชุดลาก ปลั๊ก 12 ขา น้ำหนักกดลูกบอล เบรกพ่วง)",
          check="ชุดลาก Ford 3.5T/4.5T · LED ≥ 550 mA · ชั่งน้ำหนักกดลูกบอล · GCM ≤ 8,000 กก.",
          ref="1.14 / 4.6.12", phase=fit, no_parts=True),
    ]


def _base(name: str) -> str:
    """'ตู้ p1_Mirror_1_Mirror' → 'ตู้ p1' · the misspellings of the file corrected, so that the rules see the word."""
    return a3.tidy_name(a3.MIRROR.sub("", name).strip())


def trailer_group(name: str) -> tuple[str, int] | None:
    base = _base(name)
    for group, step, rule in TRAILER_RULES:
        if re.search(rule, base):
            return group, step
    return None


# --------------------------------------------------------------------------- reading
def _top(z3: zr.Z3File, path: Path) -> zr.Z3Object | None:
    """The assembly to open: the object named like the file when there is one (a side file such as a mudguard holds
    its part and a drawing, and find_top would take a stray part), else find_top."""
    named = z3.find(path.stem)
    return named if named is not None and named.kind in ("part", "assembly") else zr.find_top(z3)


def _to_program(box: tuple[float, ...]) -> tuple[list[float], list[float]]:
    """A box (xmin, xmax, ymin, ymax, zmin, zmax) of the file → (low corner, sizes) in the program's axes."""
    x0, x1, y0, y1, z0, z1 = box
    lo = [y0, -x1, z0]
    return lo, [y1 - y0, x1 - x0, z1 - z0]


def _others_extent(boxes: np.ndarray) -> np.ndarray:
    """For every box, the extent of all the OTHER boxes: [n, 6] of (min x, max x, min y, max y, min z, max z)."""
    out = np.empty_like(boxes)
    for col, take_min in ((0, True), (1, False), (2, True), (3, False), (4, True), (5, False)):
        v = boxes[:, col]
        order = np.argsort(v) if take_min else np.argsort(-v)
        first, second = order[0], order[1] if len(order) > 1 else order[0]
        out[:, col] = v[first]
        out[first, col] = v[second]
    return out


def model_from_z3(path: str | Path) -> tuple[a3.AssemblyModel, Z3Check]:
    """Open a ZW3D file as an assembly of boxes. Raises zr.Z3Error (message in Thai) for a file it cannot read."""
    path = Path(path)
    z3 = zr.read_z3(path)
    if not z3.ok:
        raise zr.Z3Error(z3.message or "อ่านไฟล์ ZW3D ไม่ได้", z3.status, z3.checks)
    top = _top(z3, path)
    if top is None:
        raise zr.Z3Error(f"ไม่พบชิ้นส่วนหรือชุดประกอบในไฟล์ “{path.name}”", "empty")
    library = zr.Z3Library()
    placed = zr.placed_instances(z3, top, library=library)
    bom = zr.bom(z3, top, library=library)
    check = Z3Check(missing_files=sorted(set(getattr(bom, "missing_files", []) or [])))

    # what is drawn: every part, and every assembly below the top that has a shape of its own (a door leaf)
    shown = []
    for q in placed:
        if q.box is None or (q.kind == "assembly" and (not q.path or q.box[1] - q.box[0] > TOP_BOX
                                                       or q.box[3] - q.box[2] > TOP_BOX)):
            continue
        if q.kind in ("part", "assembly"):
            shown.append(q)
    check.bodies = sum(1 for q in shown if q.kind == "assembly")
    if not shown:
        raise zr.Z3Error(f"ไฟล์ “{path.name}” ไม่มีชิ้นที่มีตำแหน่งและขนาด", "empty")

    # one part twice at one place: the same placement and the same box of its own
    own = {o.name: o.box for o in z3.objects}
    for i, a in enumerate(shown):
        for b in shown[i + 1:]:
            if (np.allclose(a.matrix, b.matrix, atol=SAME_PLACE) and own.get(a.name) is not None
                    and own.get(b.name) is not None and np.allclose(own[a.name], own[b.name], atol=SAME_PLACE)):
                check.duplicates.append((a.instance, b.instance))

    # stale boxes: reaching far past every other part – cut back to the others for the picture. Again until nothing
    # changes: two stale boxes would each keep the other in. Not downwards: the wheels are the lowest part by right.
    boxes = np.array([q.box for q in shown], dtype=float)
    stale: set[int] = set()
    for _round in range(5):  # the extent is taken from the parts not found stale yet
        keep = [k for k in range(len(shown)) if k not in stale]
        if len(keep) < 3:
            break
        sub = _others_extent(boxes[keep])
        whole = np.array([boxes[keep, 0].min(), boxes[keep, 1].max(), boxes[keep, 2].min(), boxes[keep, 3].max(),
                          boxes[keep, 4].min(), boxes[keep, 5].max()])
        changed = False
        for k in range(len(shown)):
            b, e = boxes[k], (sub[keep.index(k)] if k in keep else whole)
            if max(e[0] - b[0], b[1] - e[1], e[2] - b[2], b[3] - e[3], b[5] - e[5]) > 1e-6 + (STALE_BEYOND if k not in stale else 0):
                boxes[k] = [max(b[0], e[0]), min(b[1], e[1]), max(b[2], e[2]), min(b[3], e[3]), b[4], min(b[5], e[5])]
                changed |= k not in stale
                stale.add(k)
        if not changed:
            break
    check.stale = list(dict.fromkeys(_base(shown[k].name) for k in sorted(stale)))

    # twins across the middle (file X): a part with none, and twins that are not equal. The middle is where most
    # parts are centred (a stale or a one-sided part must not move it)
    mid = float(np.median((boxes[:, 0] + boxes[:, 1]) / 2))
    paired = set()
    for k, q in enumerate(shown):
        b = boxes[k]
        if abs((b[0] + b[1]) / 2 - mid) <= CENTRED or k in paired or k in stale or q.kind == "assembly":
            continue  # an assembly's box and a stale box say too little about the part to compare it
        mirrored = np.array([2 * mid - b[1], 2 * mid - b[0], b[2], b[3], b[4], b[5]])
        best, gap = None, None
        for j, r in enumerate(shown):
            if j == k or j in stale or r.kind == "assembly":
                continue
            d = float(np.abs(boxes[j] - mirrored).max())
            if gap is None or d < gap:
                best, gap = j, d
        if best is not None and gap <= PARTNER_TOL:
            paired |= {k, best}
            if gap > ASYMMETRY:
                check.uneven.append((_base(q.name), gap))
        elif best is None or gap > PARTNER_TOL:
            check.alone[_base(q.name)] = check.alone.get(_base(q.name), 0) + 1

    drawing_of = _drawings(z3, top, path, library, shown)

    # parts
    parts: list[a3.Part3D] = []
    for k, q in enumerate(shown):
        lo, size = _to_program(tuple(boxes[k]))
        name = q.name
        p = a3.Part3D(f"z{k + 1}", name, _base(q.path[1]) if len(q.path) > 1 else _base(name), "box",
                      dims=[round(max(v, 1.0), 1) for v in size], pos=[round(v, 1) for v in lo],
                      size="กล่อง " + " × ".join(f"{v:,.0f}" for v in sorted(size, reverse=True)) + " มม.",
                      note="ขนาดจากกล่องขอบเขตในไฟล์ ZW3D (ยังไม่มีรูปทรงจริง)"
                           + (" – กล่องเกินชิ้นจริง ภาพถูกตัดให้อยู่ในตัวหาง" if k in stale else ""))
        if q.kind == "assembly":
            p.note += " · ตัวชุดประกอบ (รูปทรงของชุดเอง ไม่นับรวมกับชิ้นลูก)"
        p.drawing, p.drawing_how = drawing_of(q)
        parts.append(p)
    model = a3.AssemblyModel(top.name, parts, source="file")

    named = [trailer_group(q.name) for q in shown]
    trailer = sum(1 for g in named if g) >= TRAILER_FITS * len(shown)
    if trailer:
        model.steps = trailer_sequence()
        unsorted = 0
        for p, g in zip(parts, named):
            if g is None:
                p.group, p.step = UNSORTED, TRAILER_UNSORTED_STEP
                unsorted += 1
            else:
                p.group, p.step = g
        for n, step in enumerate(model.steps, 1):  # a step no part of this model goes to is a step of work only
            if not step.no_parts and not model.parts_of_step(n):
                step.no_parts = True
        _name_doors(parts, shown)
        a3.tidy_names(model, rear=1.0)
        a3.auto_explode(model)
    else:
        a3.auto_steps(model)
        a3.auto_explode(model)

    # unused objects of the file (3D only; the drawings are used for the part cards)
    used = {q.name for q in placed} | {n for q in placed for n in q.path} | {top.name}
    unused = [o.name for o in z3.objects if o.kind in ("part", "assembly") and o.name not in used]
    check.unused, check.unused_names = len(unused), unused[:20]

    n_parts = sum(1 for q in shown if q.kind == "part")
    warn = check.lines()
    head = [f"เปิดจากไฟล์ ZW3D {path.name}: “{top.name}” {n_parts} ชิ้น"
            + (f" + ตัวชุดประกอบ {check.bodies}" if check.bodies else ""),
            f"คำเตือนของแบบ {len(warn)} ข้อ" if warn else "",
            f"ลำดับหางลากพื้นเรียบตู้ทึบ {len(model.steps)} ขั้น {len(TRAILER_PHASES)} ช่วงงาน ตามงานประกอบจริง (จัดตามชื่อชิ้น)" if trailer else f"{len(model.steps)} กลุ่ม/ขั้น",
            "ทุกชิ้นวาดเป็นกล่องขอบเขต (ไฟล์ .Z3 ไม่มีรูปทรง – รับรูปทรงจริงจาก STEP ได้ภายหลัง)"]
    head = [h for h in head if h]  # the note is shown cut at its second " · ": the warnings come first
    if trailer and any(p.group == UNSORTED for p in parts):
        head.append(f"ยังไม่ได้จัดกลุ่ม {sum(1 for p in parts if p.group == UNSORTED)} ชิ้น – อยู่ที่ขั้น {TRAILER_UNSORTED_STEP}")
    model.note = " · ".join(head + warn)
    return model, check


def _drawings(z3: zr.Z3File, top: zr.Z3Object, path: Path, library: zr.Z3Library, shown: list):
    """The 2D drawing for each part, the nearest that shows it: its own → its mirrored twin's ('_Mirror' copies have
    none of their own) → the drawing of the nearest assembly it is in → the drawing of the whole. Drawings of a part
    kept in another file (a mudguard) are in that file."""
    known: dict[str, tuple[str, str]] = {k: (v[0], "") for k, v in zr.drawings_of(z3).items()}
    for f in sorted({q.file for q in shown if q.file}):
        where = library.locate(path.parent, f)
        if where is None:
            continue
        side = library.read(where)
        if side.ok:
            for k, v in zr.drawings_of(side).items():
                known.setdefault(k, (v[0], f))

    def look(name: str) -> tuple[str, str] | None:
        return known.get(zr._fold(name))

    def drawing_of(q) -> tuple[str, str]:
        def said(hit, how):
            return hit[0], how + (f" · ในไฟล์ {hit[1]}" if hit[1] else "")

        hit = look(q.name)
        if hit:
            return said(hit, "แบบของชิ้นนี้")
        hit = look(a3.MIRROR.sub("", q.name).strip())
        if hit:
            return said(hit, "แบบของชิ้นต้นแบบ – ชิ้นนี้เป็นภาพกลับด้าน")
        for owner in reversed(q.path[1:]):
            hit = look(owner) or look(a3.MIRROR.sub("", owner).strip())
            if hit:
                return said(hit, f"แบบของชุด {owner}")
        hit = look(top.name)
        return said(hit, "แบบรวม") if hit else ("", "")

    return drawing_of


def _name_doors(parts: list[a3.Part3D], shown: list) -> None:
    """The 8 side door leaves differ only by ZW3D's _Mirror_n: named by where they are - side and place from the front."""
    leaves = [(p, q) for p, q in zip(parts, shown) if q.kind == "assembly" and re.match(r"^ประตูตู้ [12]", _base(q.name))]
    for side_sign, side in ((-1, "ซ้าย"), (1, "ขวา")):  # program +Y = right of the vehicle
        row = sorted((p for p, _q in leaves if (p.centre()[1] > 0) == (side_sign > 0)), key=lambda p: p.centre()[0])
        for n, p in enumerate(row, 1):
            p.note = f"{p.note} · ชื่อในไฟล์: {p.name}"
            p.name = f"ประตูข้าง{side} บานที่ {n}"
