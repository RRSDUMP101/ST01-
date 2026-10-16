"""The one work path of the program, from the drawing to the store, shown the same way on every page:

    1 แบบ 2D → 2 Part List → 3 งานผลิต → 4 ตัดเลเซอร์ → 5 สโตร์ / ประกอบ → 6 เบิก / รับ

Each step shows what is waiting in it, and the program picks the ONE next thing to do (ขั้นต่อไป) from the
data, so nobody has to know which of the pages comes next.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..core.laser import CUT_STEP, planned_pieces
from ..core.production import CLOSED


@dataclass
class Step:
    key: str  # page
    num: int
    title: str
    metric: str  # what is in the step now
    waiting: int = 0  # things to do in this step (0 = nothing waits)


@dataclass
class NextAction:
    key: str  # page to open
    text: str  # what to do, for the button
    tab: int = -1  # tab of the page (-1 = as it is)
    action: str = ""  # '' = only open the page · 'import_drawings' / 'new_job'


STEP_PAGES = ["drawings", "parts", "production", "nesting", "stock", "movements"]
STEP_TITLES = ["แบบ 2D", "Part List", "งานผลิต", "ตัดเลเซอร์", "สโตร์ / ประกอบ", "เบิก / รับ"]


def _open_jobs(state):
    return [j for j in state.jobs if j.status not in CLOSED]


def pieces_to_plan(state) -> int:
    """Pieces of the open jobs still before ตัด and in no cut program."""
    planned = planned_pieces(state.cut_queue.programs)
    left = 0
    for job in _open_jobs(state):
        for i, p in enumerate(job.parts):
            wait = p.waiting().get(CUT_STEP, 0)
            if wait:
                left += max(0.0, wait - planned.get(f"job|{job.job_no}|{i}", 0))
    return int(left)


def _to_receive(state) -> int:
    return sum(1 for j in _open_jobs(state) for p in j.parts if p.to_make > 0 and p.finished >= p.to_make
               and p.received < p.to_make)


def workflow_steps(state) -> list[Step]:
    pl = state.partlist
    jobs = _open_jobs(state)
    to_plan = pieces_to_plan(state)
    progs = state.cut_queue.open_programs()
    receive = _to_receive(state)
    drafts = sum(1 for d in state.ledger.docs if d.status == "ร่าง")
    no_material = sum(1 for p in pl.parts if not p.material)
    metrics = [
        (f"{len(pl.drawings)} แบบ", 0),
        (f"{len(pl.parts)} รายการ" + (f" · ไม่มีวัสดุ {no_material}" if no_material else ""), no_material),
        (f"เปิดอยู่ {len(jobs)} งาน", 0),
        (f"รอวาง {to_plan} ชิ้น · คิว {len(progs)}", to_plan + len(progs)),
        (f"รอรับเข้า {receive}", receive),
        (f"ร่าง {drafts} ใบ", drafts),
    ]
    return [Step(key, i + 1, title, m, w) for i, (key, title, (m, w)) in enumerate(zip(STEP_PAGES, STEP_TITLES, metrics))]


def next_action(state) -> NextAction:
    """The one next thing to do, in the order of the work."""
    pl = state.partlist
    jobs = _open_jobs(state)
    if not pl.parts and not jobs:
        return NextAction("drawings", "นำเข้าแบบ DWG", action="import_drawings")
    if pl.parts and not jobs:
        return NextAction("production", "เปิดงานผลิตจาก Part List", action="new_job")
    to_plan = pieces_to_plan(state)
    if to_plan:
        return NextAction("nesting", f"วางแผนตัดเลเซอร์ {to_plan} ชิ้น", tab=0)
    progs = state.cut_queue.open_programs()
    if progs:
        return NextAction("nesting", f"ตัดและบันทึกผล {len(progs)} โปรแกรม", tab=2)
    waiting = sum(1 for j in jobs for p in j.parts if p.to_make > 0 and p.finished < p.to_make)
    if waiting:
        return NextAction("production", f"บันทึกงานพับ/เชื่อม {waiting} รายการ", tab=0)
    receive = _to_receive(state)
    if receive:
        return NextAction("production", f"รับชิ้นงานเสร็จเข้าสโตร์ {receive} รายการ", tab=0)
    drafts = sum(1 for d in state.ledger.docs if d.status == "ร่าง")
    if drafts:
        return NextAction("movements", f"ตรวจและบันทึกเอกสารร่าง {drafts} ใบ", tab=0)
    if jobs:
        return NextAction("production", "ดูความพร้อมประกอบ", tab=1)
    return NextAction("drawings", "นำเข้าแบบงานใหม่", action="import_drawings")
