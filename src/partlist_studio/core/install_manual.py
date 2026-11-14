"""คู่มือติดตั้ง (Installation Instruction) – Ford Ranger Super Duty.

ตัวเลขและข้อกำหนดทั้งหมดในไฟล์นี้สรุปจาก *Ford Ranger Super Duty Body and Equipment Mounting Manual*
(BEMM, E455418, ฉบับ 03/2026). ทุกกฎอ้างอิงหัวข้อของ BEMM (`ref`) เพื่อให้ตรวจย้อนกลับได้ – BEMM เป็นเอกสารมีชีวิต
ต้องตรวจฉบับล่าสุดก่อนเริ่มงานทุกครั้ง (BEMM 1.1.1).

โมดูลนี้ไม่ใช้ Qt:
* ข้อมูลรถ (`CABS`, `VEHICLE`) และผลิตภัณฑ์ของ RRS (`PRODUCTS`)
* `InstallJob` – ข้อมูลงานติดตั้ง 1 คัน
* `check(job)` – ตรวจงานเทียบ BEMM ได้รายการ `Finding` (ผ่าน / ตรวจเพิ่ม / ไม่ผ่าน / ข้อมูล)
* `procedure(job)` – ขั้นตอนติดตั้งตามชนิดงาน พร้อมคำเตือน แรงขัน ค่าที่ต้องวัด
* `render_html(job)` – ใบขั้นตอนติดตั้งพร้อมผลตรวจและช่องเซ็น สำหรับพิมพ์ / PDF
"""

from __future__ import annotations

import html
import json
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime
from pathlib import Path

BEMM_DOC = "Ford Ranger Super Duty BEMM E455418 (03/2026)"

PASS, WARN, FAIL, INFO = "ผ่าน", "ตรวจเพิ่ม", "ไม่ผ่าน", "ข้อมูล"
FINDING_STATES = [FAIL, WARN, PASS, INFO]


# --------------------------------------------------------------------------- vehicle data (BEMM)
@dataclass(frozen=True)
class CabSpec:
    key: str
    name: str
    frame_behind_cab: int  # 1.11.1 A – frame length behind back of cab (top of rails, no towbar)
    body_front_to_rear_axle: int  # 1.11.1 D – front outside of body to rear axle centre line
    max_body_width: int  # 1.11.1 J / 1.10.5 – standard mirrors
    max_load_length: int  # 1.10.7 A – recommended max main load area length (without the 28 mm gap)
    second_row: tuple[int, int] | None  # 1.13.1 – kg on front / rear axle per 2nd-row passenger
    seats_front: int = 2
    seats_rear: int = 0
    pad_height_mro: int = 850  # 5.1.4 – mounting pad height from ground at MRO (kerb)


CABS: dict[str, CabSpec] = {
    "single": CabSpec("single", "Single Cab (ตอนเดียว)", 2286, 1265, 1960, 2670, None, 2, 0, 850),
    "super": CabSpec("super", "Super Cab (แคป)", 1816, 795, 1990, 2190, (24, 51), 2, 2, 845),
    "double": CabSpec("double", "Double Cab (4 ประตู)", 1518, 497, 2010, 1890, (21, 54), 2, 3, 840),
}


class VEHICLE:  # values common to all cab styles
    wheelbase = 3270  # 1.11.2 E
    track = 1710
    width_no_mirrors = 2032
    width_mirrors = 2197
    overall_length = 5470
    frame_rear_overhang = 1020
    max_overhang_ratio = 0.50  # 1.11.1 E – rear overhang ≤ 50 % of the wheelbase
    max_body_height = 2400  # 1.11.1 C – external body height over the top of the frame
    cab_gap_min = 28  # 1.11.1 F / 1.11.3
    cab_top_gap_min = 30  # 1.11.1 H
    fgawr, rgawr, gvm, gcm = 1900, 2800, 4500, 8000  # 1.13.3 – 3.0L V6 AWD
    front_row_per_person = (40, 35)  # 1.13.1 – kg on front / rear axle
    pad_height_gvm = 740  # 5.1.4 – mounting pad height from ground at GVM @ RGAWR
    max_frame_hole = 16.5  # 5.6 – mm
    max_vertical_holes = 2
    wheel_nut_torque = 204  # 2.2 – Nm, M14x1.5 Step-Loc, star pattern
    engine = "3.0L Powerstroke V6 Diesel 154 kW / 600 Nm"


# 1.13.2 – recommended centre of gravity of the ADDED mass (body + cargo, without seated passengers).
# A = min distance behind the front axle, B = max distance behind the front axle,
# C = max height of the CG (above the top of the frame – see figure E459559),
# D = max lateral offset from the vehicle centre line.
# NOTE: the labels of C and D come from a figure; confirm them against page 32 of the BEMM.
CG_LIMITS = {  # added mass up to → (A min, B max, C max, D max)
    800: (1965, 3255, 630, 130),
    10_000: (1965, 3350, 530, 65),  # "GVM @ RGAWR"
}

# 1.12 – tightening torque Nm (max, min) for ISO 898 bolts
TORQUE = {
    "M6": {"8.8": (11.5, 8.5), "10.9": (15, 11)},
    "M8": {"8.8": (28, 20), "10.9": (35, 25)},
    "M10": {"8.8": (55, 41), "10.9": (70, 50)},
    "M12": {"8.8": (92, 68), "10.9": (125, 95)},
    "M14": {"8.8": (153, 113), "10.9": (200, 150)},
    "M16": {"8.8": (230, 170), "10.9": (310, 230)},
}
BOLT_SIZES = list(TORQUE)
BOLT_GRADES = ["8.8", "10.9"]

# 4.x – blunt-cut wires and signals for the converter (signal, wire colour, max current, where)
WIRES = [
    ("12V B+ ตลอดเวลา (PAAT)", "เขียว/ขาว GN/WH", "10 A", "หลังแผงข้างเท้า เสา A ซ้าย", "4.2.3"),
    ("สัญญาณกุญแจ Run/Start", "ขาว/เขียว WH/GN", "10 A (ร่วม)", "เสา A ซ้าย + ห้องเครื่องขวา", "4.2.5"),
    ("ไฟเบรก (Stop) เพิ่ม", "เหลือง/เทา YE/GY", "1.75 A", "หลังแผงข้างเท้า เสา A", "4.6.9"),
    ("ไฟหรี่ (Position)", "น้ำเงิน/เทา BU/GY", "4.7 A", "เสา A ซ้าย", "4.6.10"),
    ("ไฟกระบะ/ทับ (Loadbox)", "ขาว/เขียว WH/GN", "1.6 A (2 ข้างรวม)", "สองข้างแชสซี", "4.6.11"),
    ("ไฟสูง (สั่งรีเลย์ไฟสปอร์ตไลท์)", "เทา/น้ำตาล GY/BN", "6 A", "ข้างเท้าผู้โดยสาร", "4.6.7"),
    ("ไฟในห้องโดยสาร", "เทา/ม่วง GY/VT", "3.5 A", "เสา A ซ้าย", "4.6.14"),
    ("เบรกพ่วง (Trailer brake – สัญญาณพัลส์)", "เหลือง/เทา YE/GY", "2.1 A", "เสา A ซ้าย", "4.6.12"),
    ("12V แผงหน้าปัด (ขั้ว USB)", "เหลือง/ม่วง YE/VT", "5 A", "ใต้แผงปิด IP", "4.5.1"),
    ("CHMSL ของหลังคา/ตู้", "BCM C5 pin 13", "2.5 A", "BCM", "4.6.14 / 4.6.16"),
    ("สัญญาณความเร็ว (สี่เหลี่ยม 1.3808 Hz/กม./ชม.)", "BCM J5 pin 41 (สายเพิ่มเอง 0.5 มม.²)", "-", "BCM", "4.4.1"),
]


# --------------------------------------------------------------------------- RRS products (from the deck)
@dataclass(frozen=True)
class Product:
    key: str
    name: str
    kind: str  # 'tray' (mounted on the frame) · 'box' (closed body on a sub-frame) · 'trailer' (towed)
    length: int  # mm – load floor / body / trailer deck
    width: int
    height: int  # mm – body height above the top of the frame (tray: headboard)
    note: str = ""


PRODUCTS: dict[str, Product] = {
    "flat_tray": Product("flat_tray", "กระบะพื้นเรียบ 1.96 × 2.60 ม. (มีโครงกันหัว + ฝาข้าง)", "tray", 2600, 1960, 1000,
                         "แบบ RRS: ด้านหน้า/หลัง/ข้าง/บน กว้าง 1960 ยาว 2600"),
    "box_body": Product("box_body", "ตู้ทึบ / ตู้แห้ง (Dry Van) เปิดข้าง-หลัง", "box", 2600, 1960, 1900,
                        "ภาพตัวอย่างในสไลด์เป็นรถบรรทุก – ขนาดสำหรับ Ranger Super Duty ต้องออกแบบใหม่ตามกรอบ BEMM"),
    "trailer_5m": Product("trailer_5m", "หางลาก ถาดยาว 5.0 ม. กว้างใน 1.8 ม. (2 เพลา)", "trailer", 5000, 1800, 2300,
                          "ยาวรวม 6500 (คานลาก 1500) · กว้างนอก 2443.77 · สูงบรรทุก 2300 / รวม 3000"),
}
TRAILER_OUTER_WIDTH = 2444


# --------------------------------------------------------------------------- the job
@dataclass
class InstallJob:
    job_no: str = ""
    customer: str = ""
    vin: str = ""
    cab: str = "single"
    product: str = "flat_tray"
    # body geometry (mm)
    body_length: int = 2600
    body_width: int = 1960
    body_height: int = 1000  # above the top of the frame
    cab_gap: int = 28  # back of cab ↔ body
    cab_top_gap: int = 30  # top of cab ↔ body (only when the body is higher than the cab)
    # masses (kg) – the added mass = body + payload; CG measured from the front axle centre line
    body_mass: float = 350
    payload: float = 1000
    cg_x: int = 2400  # behind the front axle
    cg_z: int = 450  # above the top of the frame
    cg_y: int = 0  # lateral offset from the centre line
    kerb_front: float = 0  # weighed axle loads of the bare cab-chassis (0 = not weighed)
    kerb_rear: float = 0
    passengers: int = 2
    # mounting
    bolt_size: str = "M14"
    bolt_grade: str = "10.9"
    all_mounts_used: bool = True
    rigid_subframe: bool = False  # an exceptionally rigid sub-frame (box, tank) → flexible front mounts
    frame_holes: int = 0  # extra holes drilled into the frame
    frame_hole_dia: float = 0
    holes_in_vertical_line: int = 0
    welded_frame: bool = False
    # lighting & sensors
    lamp_low: int = 600  # rear combination lamp, ground → lower edge
    lamp_high: int = 900  # ground → upper edge
    lamp_from_edge: int = 150  # outer edge of vehicle → lamp
    plate_height: int = 900  # rear plate, ground → top
    parking_sensors: bool = True
    sensor_x: int = 200  # sensor surface → lowest rearmost point of tray
    sensor_y: int = 250  # sensor midpoint → outermost rear point of tray
    sensor_z: int = 260  # sensor midpoint → lowest rearmost point of tray
    tub_removed: bool = True  # the factory tub / tail lamps removed (rear camera, filler, vents)
    aux_battery: bool = False
    # towing
    tow_hitch: str = ""  # '3.5T' (Ø50 ball) · '4.5T' (Ø70 ball) · '' none
    trailer_tare: float = 900
    trailer_load: float = 2000
    towball_load: float = 300
    towball_limit: float = 450  # from the Owner Guide of the vehicle (BEMM 1.14 refers to it)
    trailer_led_ma: int = 600  # lowest current of a trailer lamp circuit
    # checklist: step id → {"done": bool, "value": str, "by": str, "at": str}
    record: dict = field(default_factory=dict)

    @property
    def cab_spec(self) -> CabSpec:
        return CABS.get(self.cab, CABS["single"])

    @property
    def product_spec(self) -> Product:
        return PRODUCTS.get(self.product, PRODUCTS["flat_tray"])

    @property
    def added_mass(self) -> float:
        return float(self.body_mass) + float(self.payload)

    def apply_product(self) -> None:
        """The dimensions of the chosen RRS product as the starting values."""
        p = self.product_spec
        self.body_length, self.body_width, self.body_height = p.length, p.width, p.height
        self.rigid_subframe = p.kind == "box"
        if p.kind == "trailer" and not self.tow_hitch:
            self.tow_hitch = "4.5T"

    # ---- file
    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> InstallJob:
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in names})

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps({"format": "rrs-install/1", "job": self.to_dict()}, ensure_ascii=False,
                                         indent=1), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> InstallJob:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data.get("job", data))


# --------------------------------------------------------------------------- checks
@dataclass
class Finding:
    rule: str
    topic: str
    status: str
    text: str
    ref: str = ""
    value: str = ""
    limit: str = ""


def rear_overhang(job: InstallJob) -> int:
    """Body overhang behind the rear axle centre line (mm). BEMM 1.11.1 D is measured with the body at the
    minimum cab gap; a bigger gap moves the body back by the difference."""
    c = job.cab_spec
    return int(job.body_length - c.body_front_to_rear_axle + max(0, job.cab_gap - VEHICLE.cab_gap_min))


def cg_limits(added_mass: float) -> tuple[int, int, int, int]:
    for limit in sorted(CG_LIMITS):
        if added_mass <= limit:
            return CG_LIMITS[limit]
    return CG_LIMITS[max(CG_LIMITS)]


def axle_loads(job: InstallJob) -> tuple[float, float]:
    """Front and rear axle loads at the given load (kerb weighed + passengers + added mass at its CG)."""
    wb = VEHICLE.wheelbase
    front = job.kerb_front + job.added_mass * (wb - job.cg_x) / wb
    rear = job.kerb_rear + job.added_mass * job.cg_x / wb
    c = job.cab_spec
    n_front = min(job.passengers, c.seats_front)
    n_rear = max(0, job.passengers - n_front) if c.second_row else 0
    front += n_front * VEHICLE.front_row_per_person[0]
    rear += n_front * VEHICLE.front_row_per_person[1]
    if c.second_row:
        front += n_rear * c.second_row[0]
        rear += n_rear * c.second_row[1]
    return round(front, 1), round(rear, 1)


def torque_for(size: str, grade: str) -> tuple[float, float] | None:
    return TORQUE.get(size, {}).get(grade)


def _range(out: list[Finding], rule, topic, value, lo=None, hi=None, unit="มม.", ref="", what="", fail=True):
    ok = (lo is None or value >= lo) and (hi is None or value <= hi)
    limit = " – ".join(x for x in (f"≥ {lo:g}" if lo is not None else "", f"≤ {hi:g}" if hi is not None else "") if x)
    out.append(Finding(rule, topic, PASS if ok else (FAIL if fail else WARN), what, ref, f"{value:g} {unit}",
                       f"{limit} {unit}"))


def check(job: InstallJob) -> list[Finding]:
    c, p, v = job.cab_spec, job.product_spec, VEHICLE
    out: list[Finding] = []
    out.append(Finding("doc", "เอกสาร", INFO, f"ตรวจตาม {BEMM_DOC} – ตรวจฉบับออนไลน์ล่าสุดก่อนเริ่มงาน", "1.1.1"))

    if p.kind in ("tray", "box"):
        # ---- dimensions
        _range(out, "width", "ขนาดตัวถัง", job.body_width, hi=c.max_body_width, ref="1.11.1 J",
               what=f"ความกว้างตัวถังสูงสุดสำหรับ {c.name} (กระจกมาตรฐาน) – กว้างกว่านี้ต้องใช้กระจกยื่น (ECE R46)")
        _range(out, "length", "ขนาดตัวถัง", job.body_length, hi=c.max_load_length, ref="1.10.7 A",
               what=f"ความยาวพื้นบรรทุกที่แนะนำสูงสุดสำหรับ {c.name} (ไม่รวมช่องห่าง 28 มม.)")
        oh, oh_max = rear_overhang(job), int(v.wheelbase * v.max_overhang_ratio)
        _range(out, "overhang", "ขนาดตัวถัง", oh, hi=oh_max, ref="1.11.1 E",
               what="ยื่นหลังเพลาหลัง ≤ 50 % ของฐานล้อ (เกินนี้ต้องติดต่อ Ford) – ห้ามต่อแชสซีรถที่มี ESP")
        _range(out, "height", "ขนาดตัวถัง", job.body_height, hi=v.max_body_height, ref="1.11.1 C",
               what="ความสูงตัวถังเหนือหลังแชสซี")
        _range(out, "cab_gap", "ขนาดตัวถัง", job.cab_gap, lo=v.cab_gap_min, ref="1.11.3",
               what="ช่องห่างหลังเก๋ง ↔ ตัวถัง/โครงกันหัว (กันเก๋งเสียหายขณะแชสซีบิด)")
        if p.kind == "box":
            _range(out, "cab_top_gap", "ขนาดตัวถัง", job.cab_top_gap, lo=v.cab_top_gap_min, ref="1.11.1 H",
                   what="ช่องห่างหลังคาเก๋ง ↔ ตัวถังที่ยื่นคลุม")
        out.append(Finding("overall_height", "ขนาดตัวถัง", INFO,
                           f"ความสูงรวมโดยประมาณ (รถเปล่า) = แท่นยึด {c.pad_height_mro} + ตัวถัง {job.body_height} "
                           f"= {c.pad_height_mro + job.body_height} มม. – ตรวจกฎหมายความสูงรถ", "5.1.4"))

        # ---- mass & centre of gravity
        a_min, b_max, c_max, d_max = cg_limits(job.added_mass)
        _range(out, "cg_x", "น้ำหนัก & จุด CG", job.cg_x, lo=a_min, hi=b_max, ref="1.13.2 A/B",
               what=f"CG ตามแนวยาวของมวลที่เพิ่ม {job.added_mass:g} กก. วัดจากศูนย์เพลาหน้า")
        _range(out, "cg_z", "น้ำหนัก & จุด CG", job.cg_z, hi=c_max, ref="1.13.2 C",
               what="ความสูง CG ของมวลที่เพิ่ม (ยืนยันนิยามกับรูป E459559 หน้า 32)")
        _range(out, "cg_y", "น้ำหนัก & จุด CG", abs(job.cg_y), hi=d_max, ref="1.13.2 D",
               what="CG เยื้องข้างจากแนวกึ่งกลางรถ – หลีกเลี่ยงการบรรทุกข้างเดียว")
        if job.kerb_front and job.kerb_rear:
            front, rear = axle_loads(job)
            _range(out, "fgawr", "น้ำหนัก & จุด CG", front, hi=v.fgawr, unit="กก.", ref="1.13.3",
                   what="น้ำหนักลงเพลาหน้า (รถเปล่าที่ชั่ง + ผู้โดยสาร + มวลที่เพิ่ม)")
            _range(out, "rgawr", "น้ำหนัก & จุด CG", rear, hi=v.rgawr, unit="กก.", ref="1.13.3",
                   what="น้ำหนักลงเพลาหลัง")
            _range(out, "gvm", "น้ำหนัก & จุด CG", front + rear, hi=v.gvm, unit="กก.", ref="1.13.3",
                   what="น้ำหนักรวมรถ (GVM)")
            if front < 0.25 * (front + rear):
                out.append(Finding("front_light", "น้ำหนัก & จุด CG", WARN,
                                   "น้ำหนักเพลาหน้าน้อยกว่า 25 % ของน้ำหนักรวม (เกณฑ์ภายใน RRS) – ท้ายยื่นมากทำให้เพลาหน้าเบา "
                                   "การบังคับเลี้ยว/เบรกแย่ลง", "1.11.1"))
        else:
            out.append(Finding("weigh", "น้ำหนัก & จุด CG", WARN,
                               "ยังไม่ได้ชั่งน้ำหนักเพลาหน้า/หลังของรถเปล่า – ชั่งก่อนและหลังติดตั้งเพื่อยืนยัน GVM 4,500 / "
                               "เพลาหน้า 1,900 / เพลาหลัง 2,800 กก.", "1.13.3"))

        # ---- mounting
        grade_ok = job.bolt_grade == "10.9" and BOLT_SIZES.index(job.bolt_size) >= BOLT_SIZES.index("M12")
        out.append(Finding("bolts", "การยึด", PASS if grade_ok else FAIL,
                           "สลักยึดแท่นแชสซีขั้นต่ำ M12 เกรด 10.9 + น็อตล็อก (แนะนำ M14)", "5.1.4 / 5.6.5",
                           f"{job.bolt_size} {job.bolt_grade}", "≥ M12 10.9"))
        if grade_ok and job.bolt_size == "M12":
            out.append(Finding("bolts_m14", "การยึด", INFO, "แนะนำ M14 เกรด 10.9 เพื่อการยึดที่แข็งแรงกว่า", "5.1.4"))
        t = torque_for(job.bolt_size, job.bolt_grade)
        if t:
            out.append(Finding("torque", "การยึด", INFO, f"แรงขัน {job.bolt_size} เกรด {job.bolt_grade}: {t[1]:g}–{t[0]:g} Nm "
                               "(ตารางแนะนำ – ผู้ติดตั้งรับผิดชอบค่าที่เหมาะกับรอยต่อ)", "1.12"))
        out.append(Finding("all_mounts", "การยึด", PASS if job.all_mounts_used else FAIL,
                           "ต้องใช้จุดยึดบนแชสซีที่ให้มาครบทุกจุด แท่นยึดตัวถังต้องแนบเต็มหน้าแท่น", "5.1.4"))
        if job.rigid_subframe or p.kind == "box":
            out.append(Finding("flex_mounts", "การยึด", WARN,
                               "ซับเฟรมแข็งมาก (ตู้): แท่นคู่หน้าต้องเป็นแบบยืดหยุ่น ~1 kN/มม. จำกัดระยะ ±12 มม. "
                               "สลักแบบ captive – แท่นอื่นทั้งหมดยึดแข็ง", "5.1.4"))
        if job.frame_holes:
            _range(out, "hole_dia", "การยึด", job.frame_hole_dia, hi=v.max_frame_hole, ref="5.6 / 5.6.4",
                   what="รูเจาะเพิ่มบนแชสซีโตสุด 16.5 มม. – เจาะด้วยดอกสว่าน ห้ามใช้แก๊ส ห้ามคว้านรูเดิม")
            _range(out, "hole_line", "การยึด", job.holes_in_vertical_line, hi=v.max_vertical_holes, unit="รู",
                   ref="5.6", what="จำนวนรูในแนวดิ่งเดียวกันบนผนังแชสซี")
        if job.welded_frame:
            out.append(Finding("weld", "การยึด", WARN,
                               "ห้ามเชื่อมแชสซี ยกเว้นท่อเสริมระหว่างผนังตามข้อ 5.6.4 – คลุมแหนบกันสะเก็ดเชื่อม", "5.6 / 2.1"))

        # ---- lighting
        _range(out, "lamp_low", "ไฟส่องสว่าง", job.lamp_low, lo=500, ref="4.6.3 A", what="ไฟท้ายรวม: พื้น → ขอบล่างโคม")
        _range(out, "lamp_high", "ไฟส่องสว่าง", job.lamp_high, hi=1200, ref="4.6.3 B", what="ไฟท้ายรวม: พื้น → ขอบบนโคม")
        _range(out, "lamp_edge", "ไฟส่องสว่าง", job.lamp_from_edge, hi=400, ref="4.6.3 G",
               what="ขอบนอกตัวรถ → โคมไฟเบรก/ไฟท้าย/ไฟเลี้ยว")
        _range(out, "plate", "ไฟส่องสว่าง", job.plate_height, hi=1300, ref="1.10.8",
               what="ป้ายทะเบียนหลัง: ทุกส่วนสูงจากพื้นไม่เกิน")
        if job.tub_removed:
            out.append(Finding("camera", "ไฟส่องสว่าง", WARN,
                               "ถอดกระบะ/ไฟท้ายเดิม: กล้องถอยจะใช้งานไม่ได้ – ให้ศูนย์ Ford ตั้งค่ารถใหม่เพื่อไม่ให้ขึ้นเตือน; "
                               "ห้ามต่อไฟท้ายใหม่เข้าวงจรไฟท้ายเดิมโดยตรง ใช้สายเบรก/ไฟหรี่ที่เตรียมไว้", "4.5.2 / 4.6.1"))

        # ---- parking sensors
        if job.parking_sensors:
            _range(out, "sensor_x", "เซนเซอร์ถอย", job.sensor_x, hi=225, ref="4.3.1 X",
                   what="ผิวเซนเซอร์ → จุดต่ำสุด-ท้ายสุดของถาด (เกิน = เตือนหลอก)")
            _range(out, "sensor_y", "เซนเซอร์ถอย", job.sensor_y, hi=290, ref="4.3.1 Y",
                   what="กึ่งกลางเซนเซอร์ → จุดนอกสุดด้านท้ายของถาด")
            _range(out, "sensor_z", "เซนเซอร์ถอย", job.sensor_z, lo=240, ref="4.3.1 Z",
                   what="กึ่งกลางเซนเซอร์ → จุดต่ำสุด-ท้ายสุดของถาด")

        if job.tub_removed:
            out.append(Finding("filler", "เชื้อเพลิง & DEF", WARN,
                               "ติดตั้งคอเติมน้ำมัน/DEF ใหม่: มุมปากเติม ≥ 30°, ลาดลงต่อเนื่อง ≥ 2°, ไม่ตกท้องช้าง/หักพับ, "
                               "ห่างตัวถัง ≥ 9 มม., ขายึดนำไฟฟ้า หนา ≥ 2 มม. กว้าง ≥ 180 มม. ต่อกราวด์", "3.2.1 / 3.3.2"))
            out.append(Finding("vents", "เชื้อเพลิง & DEF", WARN,
                               "ปลายท่อหายใจถังน้ำมันและเฟืองท้ายต้องสูงจากพื้น ≥ 850 มม. ขณะบรรทุกเต็ม (ทำคอห่าน/ฝา jiggle)",
                               "3.3.3 / 3.3.4"))

    if p.kind == "trailer" or job.tow_hitch:
        _towing(job, out)
    if job.aux_battery:
        out.append(Finding("aux_batt", "ไฟฟ้า", WARN,
                           "แบตเตอรี่สำรองต่อผ่าน DC/DC charger, กราวด์โหลดที่จุดกราวด์ตัวรถ/แท็บ BMS ห้ามต่อขั้วลบแบตโดยตรง, "
                           "ขั้ว M6 ขัน 9 Nm, ตัดแบตหลักที่ 12.7 V", "4.2.1"))
    return out


def _towing(job: InstallJob, out: list[Finding]) -> None:
    v = VEHICLE
    if not job.tow_hitch:
        out.append(Finding("hitch", "ลากจูง", FAIL, "หางลากต้องใช้ชุดลากของ Ford (3.5T ลูกบอล Ø50 หรือ 4.5T ลูกบอล Ø70)", "1.14.1"))
        return
    capacity = 4500 if job.tow_hitch == "4.5T" else 3500
    atm = job.trailer_tare + job.trailer_load
    _range(out, "atm", "ลากจูง", atm, hi=capacity, unit="กก.", ref="1.14",
           what=f"น้ำหนักรวมหางลาก (เปล่า + บรรทุก) ไม่เกินพิกัดชุดลาก {job.tow_hitch}")
    if job.kerb_front and job.kerb_rear:
        front, rear = axle_loads(job)
        _range(out, "gcm", "ลากจูง", front + rear + atm, hi=v.gcm, unit="กก.", ref="1.13.3",
               what="น้ำหนักรวมรถ + หางลาก (GCM)")
    else:
        out.append(Finding("gcm", "ลากจูง", WARN, f"ยืนยัน GCM ≤ {v.gcm:,} กก. ด้วยการชั่งรถลากจริง "
                           f"(รถ 4,500 + หาง {atm:,.0f} = {4500 + atm:,.0f} กก. ที่ GVM เต็ม)", "1.13.3"))
    _range(out, "towball", "ลากจูง", job.towball_load, hi=job.towball_limit, unit="กก.", ref="1.14.2",
           what="น้ำหนักกดลูกบอล (ค่าจำกัดจาก Owner Guide ของรถ – กรอกให้ตรงคู่มือ)")
    out.append(Finding("ball", "ลากจูง", INFO, "ห้ามใส่ลูกบอล Ø50/3.5T ในชุดลาก Ø70/4.5T · ห้ามตัด เจาะ เชื่อม ชุดลาก", "1.14.2"))
    _range(out, "led", "ลากจูง", job.trailer_led_ma, lo=550, unit="mA", ref="4.6.12",
           what="ไฟ LED หางลาก: กระแสต่อวงจร ≥ 550 mA (ต่ำกว่านี้ใส่ชุดตัวต้านทาน 120 Ω 2 W ฝั่งหางลาก)", fail=False)
    if job.product_spec.kind == "trailer" and TRAILER_OUTER_WIDTH > v.width_no_mirrors:
        out.append(Finding("mirrors", "ลากจูง", WARN,
                           f"หางลากกว้าง {TRAILER_OUTER_WIDTH} มม. > ตัวรถ {v.width_no_mirrors} มม.: อาจต้องใช้กระจกยื่นสำหรับลาก "
                           "(ECE R46 / ADR 14) – ส่วนต่อกระจกอาจบังกล้อง 360°", "1.10.5 / 4.5.2"))
    out.append(Finding("brake_ctrl", "ลากจูง", INFO, "สายเบรกพ่วงเป็นสัญญาณพัลส์ ไม่ใช่ไฟ DC – ตัวควบคุมเบรกต้องรองรับ", "2.3.2"))


def summary(findings: list[Finding]) -> dict[str, int]:
    counts = {s: 0 for s in FINDING_STATES}
    for f in findings:
        counts[f.status] = counts.get(f.status, 0) + 1
    return counts


# --------------------------------------------------------------------------- procedure
@dataclass(frozen=True)
class Measure:
    label: str
    unit: str
    lo: float | None = None
    hi: float | None = None

    def judge(self, text: str) -> str:
        try:
            x = float(str(text).replace(",", "").strip())
        except ValueError:
            return ""
        return PASS if (self.lo is None or x >= self.lo) and (self.hi is None or x <= self.hi) else FAIL


@dataclass(frozen=True)
class Step:
    id: str
    phase: str
    title: str
    detail: str
    ref: str = ""
    warning: str = ""
    torque: str = ""
    measure: Measure | None = None
    kinds: tuple[str, ...] = ("tray", "box", "trailer")
    when: str = ""  # '' always · name of a bool field of InstallJob that must be True


PHASES = ["1. รับรถ & ตรวจรับ", "2. เตรียมรถ", "3. ติดตั้งโครง/ตัวถัง", "4. ระบบเชื้อเพลิง & DEF",
          "5. ไฟฟ้า & ไฟส่องสว่าง", "6. ลากจูง", "7. ทดสอบ & ส่งมอบ"]
_BODY = ("tray", "box")

STEPS: list[Step] = [
    Step("rcv_doc", PHASES[0], "ตรวจ BEMM ฉบับล่าสุด", "เทียบฉบับที่ใช้กับฉบับออนไลน์ของ Ford ก่อนเริ่มงาน", "1.1.1"),
    Step("rcv_vin", PHASES[0], "บันทึก VIN / รุ่นเก๋ง / อุปกรณ์จากโรงงาน",
         "เช็ก ESP, เซนเซอร์ถอย, กล้อง 360°, ชุดลาก, สวิตช์ Upfitter, ถังลม/สนอร์เกิล", "1.5"),
    Step("rcv_batt", PHASES[0], "วัดแรงดันแบตเตอรี่ตอนรับรถ (OCV)", "ก่อนวัดให้คายประจุผิว: "
         "เปิดไฟหน้า 5 วินาที ปิดโหลดทั้งหมด รอ 10 นาที", "4.2.1", measure=Measure("OCV", "V", lo=12.75)),
    Step("rcv_transport", PHASES[0], "คงโหมด Transport ไว้ระหว่างดัดแปลง",
         "ออกจาก Transport mode ก่อนเวลาเพิ่มความเสี่ยงหัวฉีดเสียเร็ว", "1.9 / 3.3",
         warning="อย่าออกจาก Transport mode จนกว่าจะส่งมอบ"),
    Step("prep_batt", PHASES[1], "ถอดสายแบตเตอรี่ (ถ้าจอดเกิน 4 วัน หรือก่อนเจาะ/เชื่อม)",
         "ถอดสายลบที่จุดกราวด์ตัวรถ/ตัวถัง (A) – ห้ามยุ่งรอยต่อ BMS (C)", "4.2.1",
         warning="ถ้าถอดเรดาร์/กล้อง ต้องต่อกลับก่อนต่อแบตเตอรี่ มิฉะนั้นจะขึ้นรหัสเสีย"),
    Step("prep_protect", PHASES[1], "ปิดคลุมแหนบ ท่อเบรก สายไฟ ก่อนงานเจาะ/เจียร/เชื่อม",
         "ห้ามให้ลวดเชื่อม/คีมเชื่อมแตะแหนบ · กันเศษโลหะเข้าตัวดึงเข็มขัด", "2.1 / 5.4.1"),
    Step("prep_tub", PHASES[1], "ถอดกระบะเดิม (ถ้ามี) – เก็บชิ้นส่วนให้สะอาดแห้ง ประกอบกลับคันเดิม",
         "ระวังคอเติมน้ำมัน/DEF, ท่อหายใจ, สายไฟท้าย, กล้อง/เซนเซอร์", "1.9 / 3.2.1", when="tub_removed",
         kinds=_BODY),
    Step("prep_def_line", PHASES[1], "ตรวจแนวท่อ DEF ใต้รางแชสซีก่อนใส่ยูโบลต์/ขายึด",
         "ขยับท่อในคลิปเพื่อเว้นระยะ – ห้ามหนีบท่อ DEF", "3.2.1", kinds=_BODY),
    Step("mount_check", PHASES[2], "ตรวจระยะติดตั้งตามผลตรวจ BEMM",
         "ความกว้าง ความยาว ระยะยื่นหลัง ความสูง ช่องห่างหลังเก๋ง ≥ 28 มม.", "1.11.1", kinds=_BODY,
         measure=Measure("ช่องห่างหลังเก๋ง", "มม.", lo=28)),
    Step("mount_subframe", PHASES[2], "วางคานตามยาว/ซับเฟรมบนแท่นยึดแชสซี",
         "คานตามยาวอยู่เหนือรางแชสซีตรง ๆ, ด้านหน้าต้องผ่อนแรง (relief) หรือเว้นระยะจากหลังแชสซี, "
         "รองรับความต่างระดับแท่นโดยไม่มี pre-load, คานขวางทุกคู่แท่น", "5.1.4 / 5.6.5", kinds=_BODY),
    Step("mount_flex", PHASES[2], "แท่นคู่หน้าแบบยืดหยุ่น (ซับเฟรมแข็ง/ตู้)",
         "~1 kN/มม. ที่แต่ละแท่น จำกัดระยะ ±12 มม. ทุกทิศ สลัก captive · แท่นอื่นยึดแข็ง", "5.1.4",
         kinds=_BODY, when="rigid_subframe"),
    Step("mount_bolt", PHASES[2], "ยึดทุกแท่นด้วยสลัก M12–M14 เกรด 10.9 + น็อตล็อก + แหวนหนา Ø50×5",
         "ใช้จุดยึดครบทุกจุด · ผิวสัมผัสห้ามเป็นสีฝุ่น ใช้ผิวชุบแข็ง · แหวนต้องไม่ยุบที่แรงขันจริง", "5.1.4",
         torque="M12 10.9: 95–125 Nm · M14 10.9: 150–200 Nm", kinds=_BODY),
    Step("mount_holes", PHASES[2], "เจาะแชสซี (ถ้าจำเป็น)",
         "รูโตสุด 16.5 มม., ไม่เกิน 2 รูในแนวดิ่ง, ห้ามคว้านรูเดิม/รู datum, ห้ามเจาะใกล้จุดเปลี่ยนหน้าตัด, "
         "ลบคม 1×45°, ล้างเศษ ทากันสนิม", "5.6", kinds=_BODY, measure=Measure("ขนาดรูใหญ่สุด", "มม.", hi=16.5)),
    Step("mount_seal", PHASES[2], "ทาสีขอบตัด/รูเจาะ ซีลทุกจุดยึดทะลุพื้น/ผนัง กันกัลวานิก",
         "ต่างโลหะต้องคั่นฉนวน", "5.5", kinds=_BODY),
    Step("fuel_filler", PHASES[3], "ติดตั้งคอเติมน้ำมัน (RB3Z-9034-B) บนตัวถัง",
         "มุมปากเติม ≥ 30°, ลาด ≥ 2°, สูงกว่า ICV ≥ 250 มม., ห่างตัวถัง ≥ 9 มม., ขายึด ≥ 2 มม. กว้าง ≥ 180 มม., "
         "ใช้จุดยึด 3 จุด, ต่อกราวด์", "3.3.2", kinds=_BODY, when="tub_removed",
         measure=Measure("ความสูงเหนือ ICV", "มม.", lo=250)),
    Step("def_filler", PHASES[3], "ติดตั้งคอเติม DEF (ชุดย้าย MB3Z-5K289-A ถ้าต้องตัดท่อ)",
         "มุม ≥ 30°, ระยะตกรวม ≥ 180 มม., ลาด ≥ 2° ตลอดสาย, ห่างตัวถัง ≥ 9 มม., ไม่ยื่นนอกตัวถัง", "3.2.1",
         torque="สกรูคอเติม DEF 3 ตัว: 5.4 Nm", kinds=_BODY, when="tub_removed",
         measure=Measure("ระยะตกท่อ DEF", "มม.", lo=180)),
    Step("vents", PHASES[3], "เดินท่อหายใจถังน้ำมัน + เฟืองท้าย", "ปลายท่อสูงจากพื้น ≥ 850 มม. ขณะบรรทุกเต็ม "
         "(สูงกว่าแท่นยึดหลัง ≥ 100 มม.), ไม่เสียดสีตลอดช่วงยุบ-ยืดช่วงล่าง", "3.3.3 / 3.3.4", kinds=_BODY,
         when="tub_removed", measure=Measure("ความสูงปลายท่อ", "มม.", lo=850)),
    Step("elec_route", PHASES[4], "เดินสายไฟผ่านยางกันน้ำที่เตรียมไว้", "สายเพิ่มผ่านปุ่มยางโตสุด 8 มม., ซีลด้วยซิลิโคน "
         "ห้ามใช้เทป, ห้ามเดินร่วมสาย ABS, ห้ามตัดต่อสาย (ถ้าจำเป็นใช้ crimp splice หดกันน้ำ)", "4.1"),
    Step("elec_lamps", PHASES[4], "ติดตั้งไฟท้ายรวม / ไฟป้าย / ไฟตัดหมอก",
         "ไฟท้าย: ขอบล่าง ≥ 500 ขอบบน ≤ 1200 ห่างขอบนอก ≤ 400 มม. · ไฟป้ายตามรูป 4.6.5 · ป้ายสูง ≤ 1300 มม. · "
         "ไฟท้ายเพิ่มรับไฟผ่านโมดูลลากจูง", "4.6.3–4.6.6", kinds=_BODY,
         measure=Measure("ขอบล่างไฟท้าย", "มม.", lo=500, hi=1200)),
    Step("elec_signals", PHASES[4], "ต่อสัญญาณเบรก/ไฟหรี่จากสายปลายตัดที่เตรียมไว้", "ใช้สาย YE/GY (เบรก) และ BU/GY (ไฟหรี่) "
         "ที่เสา A ซ้าย – ห้ามต่อไฟท้ายใหม่เข้าวงจรไฟเบรก+ไฟหรี่ร่วม (PWM) ของไฟท้ายเดิม", "4.6.1 / 4.6.9 / 4.6.10",
         kinds=_BODY),
    Step("elec_sensors", PHASES[4], "ย้าย/ตรวจเซนเซอร์ถอยและกล้อง", "ติดตั้งตำแหน่ง X/Y/Z เดิม ตามลำดับเดิม · "
         "ระยะถาด X ≤ 225, Y ≤ 290, Z ≥ 240 มม. · ห้ามย้ายแท่น DAT bar · ห้ามบังมุมกล้อง", "4.3 / 4.5.2", kinds=_BODY,
         when="parking_sensors", measure=Measure("ระยะ X ถาด", "มม.", hi=225)),
    Step("elec_aux", PHASES[4], "แบตเตอรี่สำรอง / โหลดเพิ่ม", "DC/DC charger · กราวด์ที่จุดกราวด์/แท็บ BMS เท่านั้น · "
         "ขั้ว M6 ที่แบต/PDB 9 Nm · ขั้วต่อเพิ่มที่แบตใช้หางปลา 90° ชี้ลง", "4.2.1", torque="M6: 9 Nm", when="aux_battery"),
    Step("tow_hitch", PHASES[5], "ตรวจชุดลากและลูกบอลให้ตรงพิกัด", "3.5T = R1WZ-17D826-A + ลูกบอล Ø50 · "
         "4.5T = RB3Z-17D826-A + ลูกบอล Ø70 · ห้ามดัดแปลงชุดลาก", "1.14", kinds=("trailer",)),
    Step("tow_wiring", PHASES[5], "ต่อปลั๊กหางลาก 12 ขาแบน (AS4177.5)", "ใช้ชุดสายลากของ Ford + ตั้งค่า FDRS ที่ศูนย์ · "
         "ไฟ LED ≥ 550 mA ต่อวงจร หรือใส่ชุดตัวต้านทาน 120 Ω 2 W ฝั่งหางลาก", "4.6.12", kinds=("trailer",),
         measure=Measure("กระแสวงจรไฟ LED ต่ำสุด", "mA", lo=550)),
    Step("tow_ball", PHASES[5], "ชั่งน้ำหนักกดลูกบอลและน้ำหนักรวมหางลาก", "ต้องอยู่ในช่วงของ Owner Guide · "
         "น้ำหนักรวม ≤ พิกัดชุดลาก · GCM ≤ 8,000 กก.", "1.14 / 1.13.3", kinds=("trailer",),
         measure=Measure("น้ำหนักกดลูกบอล", "กก.", lo=0)),
    Step("tow_brake", PHASES[5], "ตรวจเบรกหางลากกับสัญญาณพัลส์", "ตัวควบคุมเบรกต้องรองรับสัญญาณพัลส์ของรถ", "2.3.2",
         kinds=("trailer",)),
    Step("fin_torque", PHASES[6], "ตรวจแรงขันซ้ำทุกจุดยึด + ล้อ", "ล้อขันแบบดาว 204 Nm บนพื้น · ขันซ้ำภายใน 160 กม.",
         "1.12 / 2.2", torque="น็อตล้อ M14×1.5: 204 Nm"),
    Step("fin_weigh", PHASES[6], "ชั่งน้ำหนักรถหลังติดตั้ง (เพลาหน้า/หลัง)", "GVM ≤ 4,500 · หน้า ≤ 1,900 · หลัง ≤ 2,800 กก.",
         "1.13.3", kinds=_BODY, measure=Measure("น้ำหนักรวม", "กก.", hi=4500)),
    Step("fin_lamps", PHASES[6], "ตั้งไฟหน้า + ทดสอบไฟทุกดวง", "พื้นราบ น้ำหนักแบบหน้าก้มที่สุด ตั้งตามมุมที่หล่อบนโคม (1 % = 10 มม./1 ม.)",
         "4.6.2"),
    Step("fin_brake", PHASES[6], "ทดสอบเบรก + เบรกมือ + ไฟเตือน", "ห้ามดัดแปลง ABS/ESP/EBB · ท่อเบรกไม่บิด ไม่เสียดสีทุกมุมเลี้ยว",
         "2.3"),
    Step("fin_scan", PHASES[6], "สแกนรหัสเสีย (DTC) + ทดสอบระบบช่วยขับขี่", "ADAS/กล้อง/เซนเซอร์/ล็อก – รถที่มวลหรือรูปทรงเปลี่ยนมาก "
         "ให้ศูนย์ Ford ตรวจศูนย์เรดาร์/กล้อง", "4.7 / 4.8 / 4.11"),
    Step("fin_batt", PHASES[6], "วัดแรงดันแบตเตอรี่ก่อนส่งมอบ (CCV)", "ต่อแบตกลับแล้ววัดขณะไม่มีโหลด", "4.2.1",
         measure=Measure("CCV", "V", lo=12.50)),
    Step("fin_docs", PHASES[6], "บันทึกการดัดแปลงลงคู่มือเจ้าของรถ + ป้ายพิกัดบรรทุก", "ระบุน้ำหนักบรรทุก/ข้อจำกัด · "
         "ห้ามย้ายหรือปิดป้ายเตือนเดิม", "1.3.1 / 1.3.7"),
]


def procedure(job: InstallJob) -> list[Step]:
    kind = job.product_spec.kind
    out = []
    for s in STEPS:
        if kind not in s.kinds:
            continue
        if s.when and not getattr(job, s.when, False):
            continue
        out.append(s)
    return out


def step_state(job: InstallJob, step: Step) -> str:
    rec = job.record.get(step.id, {})
    if step.measure and rec.get("value", "") != "":
        judged = step.measure.judge(rec["value"])
        if judged == FAIL:
            return FAIL
    return PASS if rec.get("done") else ""


def mark(job: InstallJob, step_id: str, done: bool | None = None, value: str | None = None, by: str = "") -> dict:
    rec = job.record.setdefault(step_id, {"done": False, "value": "", "by": "", "at": ""})
    if done is not None:
        rec["done"] = bool(done)
    if value is not None:
        rec["value"] = str(value)
    rec["by"] = by or rec.get("by", "")
    rec["at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    return rec


def progress(job: InstallJob) -> tuple[int, int]:
    steps = procedure(job)
    return sum(1 for s in steps if job.record.get(s.id, {}).get("done")), len(steps)


# --------------------------------------------------------------------------- printable instruction
_CSS = """body{font-family:'Sarabun','TH Sarabun New','Noto Sans Thai',sans-serif;font-size:10.5pt;color:#1E2A3A}
h1{font-size:16pt;color:#1F4E79;margin:0}h2{font-size:12pt;color:#1F4E79;border-bottom:2px solid #1F4E79;margin:14px 0 6px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #B8C2CF;padding:3px 5px;vertical-align:top}
th{background:#E8EEF6;text-align:left}.s-ผ่าน{color:#2E9D5B;font-weight:bold}.s-ไม่ผ่าน{color:#D64545;font-weight:bold}
.s-ตรวจเพิ่ม{color:#E08A1E;font-weight:bold}.s-ข้อมูล{color:#6B7A90}.warn{color:#D64545}.muted{color:#6B7A90}"""


def render_html(job: InstallJob, findings: list[Finding] | None = None) -> str:
    e = html.escape
    findings = findings if findings is not None else check(job)
    c, p = job.cab_spec, job.product_spec
    counts = summary(findings)
    rows = "".join(
        f"<tr><td>{e(f.topic)}</td><td>{e(f.text)}</td><td>{e(f.value)}</td><td>{e(f.limit)}</td>"
        f"<td class='s-{e(f.status)}'>{e(f.status)}</td><td>{e(f.ref)}</td></tr>" for f in findings)
    steps_html, phase = [], ""
    for n, s in enumerate(procedure(job), 1):
        if s.phase != phase:
            phase = s.phase
            steps_html.append(f"<tr><th colspan='5'>{e(phase)}</th></tr>")
        rec = job.record.get(s.id, {})
        extra = "".join(x for x in (
            f"<br><span class='warn'>⚠ {e(s.warning)}</span>" if s.warning else "",
            f"<br><b>แรงขัน:</b> {e(s.torque)}" if s.torque else ""))
        meas = ""
        if s.measure:
            lim = " ".join(x for x in (f"≥ {s.measure.lo:g}" if s.measure.lo is not None else "",
                                       f"≤ {s.measure.hi:g}" if s.measure.hi is not None else "") if x)
            meas = f"{e(s.measure.label)} ({lim} {e(s.measure.unit)}): <b>{e(rec.get('value', '')) or '______'}</b>"
        box = "☑" if rec.get("done") else "☐"
        who = e(" ".join(x for x in (rec.get("by", ""), rec.get("at", "")) if x)) if rec.get("done") else ""
        steps_html.append(f"<tr><td>{n}</td><td><b>{e(s.title)}</b><br>{e(s.detail)}{extra}</td><td>{meas}</td>"
                          f"<td>{e(s.ref)}</td><td style='font-size:13pt;text-align:center'>{box}<br>"
                          f"<span class='muted' style='font-size:8pt'>{who}</span></td></tr>")
    done, total = progress(job)
    return f"""<html><head><meta charset="utf-8"><title>คู่มือติดตั้ง {e(job.job_no)}</title><style>{_CSS}</style></head><body>
<h1>ใบขั้นตอนติดตั้ง – Ford Ranger Super Duty</h1>
<p class="muted">RRS · อ้างอิง {e(BEMM_DOC)} · พิมพ์ {datetime.now():%d/%m/%Y %H:%M}</p>
<table width="100%"><tr><th width="15%">เลขที่งาน</th><td>{e(job.job_no)}</td><th>ลูกค้า</th><td>{e(job.customer)}</td></tr>
<tr><th>VIN</th><td>{e(job.vin)}</td><th>รุ่นเก๋ง</th><td>{e(c.name)}</td></tr>
<tr><th>ผลิตภัณฑ์</th><td colspan="3">{e(p.name)}</td></tr>
<tr><th>ขนาดตัวถัง</th><td>ยาว {job.body_length} × กว้าง {job.body_width} × สูง {job.body_height} มม.</td>
<th>มวลที่เพิ่ม</th><td>{job.added_mass:,.0f} กก. (ตัวถัง {job.body_mass:,.0f} + บรรทุก {job.payload:,.0f})</td></tr></table>
<h2>ผลตรวจตาม BEMM – ไม่ผ่าน {counts[FAIL]} · ตรวจเพิ่ม {counts[WARN]} · ผ่าน {counts[PASS]}</h2>
<table width="100%"><tr><th width="13%">หัวข้อ</th><th width="45%">ข้อกำหนด</th><th width="12%">ค่าจริง</th><th width="12%">เกณฑ์</th><th width="8%">ผล</th><th width="10%">BEMM</th></tr>{rows}</table>
<h2>ขั้นตอนติดตั้ง ({done}/{total})</h2>
<table width="100%"><tr><th width="4%">#</th><th width="56%">ขั้นตอน</th><th width="20%">ค่าที่วัด</th><th width="10%">BEMM</th><th width="10%">เสร็จ</th></tr>{''.join(steps_html)}</table>
<h2>ลงนาม</h2>
<table width="100%"><tr><td style="height:48px">ช่างติดตั้ง<br><br>.................................. วันที่ ........</td>
<td>หัวหน้างาน / QC<br><br>.................................. วันที่ ........</td>
<td>ผู้รับรถ<br><br>.................................. วันที่ ........</td></tr></table>
<p class="muted">เอกสารนี้สรุปข้อกำหนดจาก BEMM เพื่อใช้ในโรงงาน – ไม่แทนที่คู่มือ Ford, Workshop Manual และกฎหมายท้องถิ่น</p>
</body></html>"""
