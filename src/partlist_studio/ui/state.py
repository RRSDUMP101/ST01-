"""Shared application state and persisted settings."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from PySide6.QtCore import QObject, QSettings, QStandardPaths, Signal

from ..core import access, fileio
from ..core.access import Perm
from ..core.audit import AuditLog
from ..core.users import UserStore
from ..core import stock as stock_mod
from ..core.cad_fix import GAP_TOL
from ..core.catalog import Catalog
from ..core.company_files import ModelBOM
from ..core.dwg_io import DEFAULT_DENSITIES, DrawingData, find_converter
from ..core.laser import CutQueue, FlatLibrary, LaserParams
from ..core.models import PartList
from ..core.movements import Ledger, StockDoc
from ..core.production import Job, RawUse
from ..core.replenish import ReplenishParams
from ..core.stock import RequirementLine, StockItem, StockList, _key
from ..core.xref import CodeXref

MANUAL_SOURCE = "เพิ่มเอง"
MOVED_SOURCE = "รับเข้าในโปรแกรม"  # items first received by a document (FR/RR) that no source had


class Settings:
    def __init__(self):
        self.q = QSettings()

    def get(self, key: str, default: str = "") -> str:
        value = self.q.value(key, default)
        return "" if value is None else str(value)

    def set(self, key: str, value) -> None:
        self.q.setValue(key, value)

    @property
    def densities(self) -> dict[str, float]:
        try:
            data = json.loads(self.get("dwg/densities", ""))
            return {str(k): float(v) for k, v in data.items()} or dict(DEFAULT_DENSITIES)
        except (ValueError, AttributeError):
            return dict(DEFAULT_DENSITIES)

    @densities.setter
    def densities(self, value: dict[str, float]) -> None:
        self.set("dwg/densities", json.dumps(value))

    def converter(self):
        return find_converter(self.get("dwg/converter_path"))

    @property
    def default_thickness(self) -> float:
        """mm for flat patterns whose drawing gives no thickness (0 = none)."""
        try:
            return max(0.0, float(self.get("dwg/default_thickness", "0") or 0))
        except ValueError:
            return 0.0

    @default_thickness.setter
    def default_thickness(self, value: float) -> None:
        self.set("dwg/default_thickness", f"{float(value):g}")

    @property
    def thickness_mode(self) -> str:
        """"drawing" = as written in the drawing, "fixed" = the default thickness for every plate part."""
        return "fixed" if self.get("dwg/thickness_mode") == "fixed" else "drawing"

    @thickness_mode.setter
    def thickness_mode(self, value: str) -> None:
        self.set("dwg/thickness_mode", value)

    @property
    def auto_fix(self) -> bool:
        """Repair the cut lines while importing (gaps, overshoots, lines drawn twice, bend lines, letters)."""
        return self.get("dwg/auto_fix", "1") != "0"

    @auto_fix.setter
    def auto_fix(self, value: bool) -> None:
        self.set("dwg/auto_fix", "1" if value else "0")

    @property
    def gap_tol(self) -> float:
        """mm: loose ends of cut lines closer than this are joined."""
        try:
            return min(5.0, max(0.05, float(self.get("dwg/gap_tol", "") or GAP_TOL)))
        except ValueError:
            return GAP_TOL

    @gap_tol.setter
    def gap_tol(self, value: float) -> None:
        self.set("dwg/gap_tol", f"{float(value):g}")

    @property
    def replenish(self) -> ReplenishParams:
        p = ReplenishParams()
        try:
            data = json.loads(self.get("stock/replenish", "") or "{}")
        except ValueError:
            data = {}
        for k, v in data.items():
            if hasattr(p, k):
                setattr(p, k, float(v) if k != "history_days" else int(v))
        return p

    @replenish.setter
    def replenish(self, p: ReplenishParams) -> None:
        self.set("stock/replenish", json.dumps(p.__dict__))

    @property
    def laser(self) -> LaserParams:
        try:
            return LaserParams.from_dict(json.loads(self.get("laser/params", "") or "{}"))
        except ValueError:
            return LaserParams()

    @laser.setter
    def laser(self, p: LaserParams) -> None:
        self.set("laser/params", json.dumps(p.to_dict(), ensure_ascii=False))

    @property
    def custom_sheets(self) -> list[tuple[float, float, float, str]]:
        """Sheet sizes added by hand for the cutting plan: (width, length, thickness 0 = every thickness, note)."""
        try:
            rows = json.loads(self.get("laser/custom_sheets", "") or "[]")
            return [(float(w), float(h), float(t), str(n)) for w, h, t, n in rows]
        except (ValueError, TypeError):
            return []

    @custom_sheets.setter
    def custom_sheets(self, rows: list) -> None:
        self.set("laser/custom_sheets", json.dumps([list(r) for r in rows], ensure_ascii=False))


_FILL_EXTRA = ("width_mm", "length_mm", "count_code", "category_name", "item_kind")


def _fill_item(item: StockItem, other: StockItem) -> None:
    """What `item` lacks of the master data (material, thickness, plate size, stock-count code) from `other`."""
    if not item.material and other.material:
        item.material = other.material
    if not item.spec and other.spec:
        item.spec = other.spec
    for key in _FILL_EXTRA:
        if key in other.extra and key not in item.extra:
            item.extra[key] = other.extra[key]


class AppState(QObject):
    partlist_changed = Signal()  # rows or job info changed
    partlist_replaced = Signal()  # a different document was opened
    stock_changed = Signal()
    requirements_changed = Signal()
    models_changed = Signal()
    xref_changed = Signal()
    jobs_changed = Signal()
    ledger_changed = Signal()
    laser_changed = Signal()  # flat pattern library or cut programs changed
    catalog_changed = Signal()  # assembly groups / shelf locations set by hand
    actor_changed = Signal()  # someone signed in / out
    message = Signal(str)

    def __init__(self, data_dir: str | Path | None = None):
        super().__init__()
        self.settings = Settings()
        self.partlist = PartList()
        self.stock = StockList()  # merged view of the active stock sources
        self.stock_sources: dict[str, StockList] = {}
        self.active_sources: list[str] = []
        self.models: list[ModelBOM] = []
        self.xref = CodeXref()
        self.ledger = Ledger()
        self.jobs: list[Job] = []
        self.raw_uses: list[RawUse] = []
        self.flats = FlatLibrary()  # คลังรูปคลี่: flat pattern of every part code from the drawings
        self.cut_queue = CutQueue()  # laser cut programs
        self.catalog = Catalog()  # assembly group and shelf location set by hand per code
        self.requirements: list[RequirementLine] = []
        self.part_matches: list = []  # (Part, part_match.PartMatch) of the last material check
        self.drawing_cache: dict[str, DrawingData] = {}
        self.path: str = ""
        self.dirty = False
        self._data_dir = Path(data_dir) if data_dir else None
        stock_mod.XREF_LOOKUP = self.xref_lookup
        stock_mod.XREF_ENTRIES = lambda: self.xref.entries
        self.load_library()
        self.audit = AuditLog(self.data_dir() / "audit")
        self.users_problem = ""
        try:
            self.users = UserStore.load(self.data_dir() / "users.json")
        except (OSError, ValueError, TypeError) as e:  # a broken users file: view only until IT looks at it
            self.users = UserStore(self.data_dir() / "users.json.unreadable")
            self.users_problem = f"อ่านรายชื่อผู้ใช้ไม่ได้ ({type(e).__name__}) – ใช้ได้แบบดูอย่างเดียว"
        self.actor = access.VIEWER if (self.users.active or self.users_problem) else access.OPEN

    # ---- company data kept between sessions (stock sources, model BOMs, code table) ------------
    def data_dir(self) -> Path:
        if self._data_dir is None:
            self._data_dir = Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))
        self._data_dir.mkdir(parents=True, exist_ok=True)
        return self._data_dir

    def image_dir(self) -> Path:
        path = self.data_dir() / "images"
        path.mkdir(exist_ok=True)
        return path

    def xref_lookup(self, code: str) -> list[str]:
        return self.xref.lookup(code)

    def load_library(self) -> None:
        """Read library.json. A file that cannot be read is set aside and the newest copy is read instead; when no
        copy can be read either, nothing is saved (an empty program must never be written over the company data)."""
        file = self.data_dir() / "library.json"
        self.library_problem = ""
        self._library_load_failed = False
        if not file.is_file():
            return
        tries = [file] + fileio.backups(file)
        for i, path in enumerate(tries):
            try:
                self._read_library(json.loads(path.read_text(encoding="utf-8")))
            except (ValueError, TypeError, KeyError, AttributeError, OSError) as e:
                if i == 0:
                    try:
                        bad = fileio.set_aside(file)
                    except OSError:
                        bad = file
                    self.library_problem = f"อ่านข้อมูล {file.name} ไม่ได้ ({type(e).__name__}) – เก็บไฟล์เสียไว้ที่ {bad.name}"
                continue
            if i > 0:
                self.library_problem += f" · ใช้สำเนา {path.name} แทน (ข้อมูลหลังสำเนานี้หายไป – ตรวจยอดอีกครั้ง)"
                self.save_library()
            return
        self._empty_library()
        self._library_load_failed = True
        self.library_problem += " · ไม่มีสำเนาที่อ่านได้ – โปรแกรมจะไม่บันทึกทับจนกว่า IT จะตรวจ"

    def _empty_library(self) -> None:
        self.stock_sources, self.active_sources, self.models = {}, [], []
        self.xref, self.ledger, self.jobs, self.raw_uses = CodeXref(), Ledger(), [], []
        self.flats, self.cut_queue, self.catalog = FlatLibrary(), CutQueue(), Catalog()
        self._merge_stock()

    def _read_library(self, data: dict) -> None:
        if not isinstance(data, dict):
            raise TypeError("library.json is not an object")
        self.stock_sources = {k: StockList.from_dict(v) for k, v in data.get("stock_sources", {}).items()}
        self.active_sources = [n for n in data.get("active_sources", []) if n in self.stock_sources]
        self.models = [ModelBOM.from_dict(m) for m in data.get("models", [])]
        self.xref = CodeXref.from_dict(data.get("xref", {}))
        self.ledger = Ledger.from_dict(data.get("ledger", {}))
        self.jobs = [Job.from_dict(j) for j in data.get("jobs", [])]
        self.raw_uses = [RawUse(**{k: v for k, v in r.items() if k in RawUse.__dataclass_fields__})
                         for r in data.get("raw_uses", [])]
        self.flats = FlatLibrary.from_dict(data.get("flats", {}))
        self.cut_queue = CutQueue.from_dict(data.get("cut_queue", {}))
        self.catalog = Catalog.from_dict(data.get("catalog"))
        self._merge_stock()

    def save_library(self) -> None:
        if getattr(self, "_library_load_failed", False):
            return  # the data could not be read: do not write an empty program over it
        data = {
            "stock_sources": {k: v.to_dict() for k, v in self.stock_sources.items()},
            "active_sources": self.active_sources,
            "models": [m.to_dict() for m in self.models],
            "xref": self.xref.to_dict(),
            "ledger": self.ledger.to_dict(),
            "jobs": [j.to_dict() for j in self.jobs],
            "raw_uses": [r.__dict__ for r in self.raw_uses],
            "flats": self.flats.to_dict(),
            "cut_queue": self.cut_queue.to_dict(),
            "catalog": self.catalog.to_dict(),
        }
        file = self.data_dir() / "library.json"
        if not getattr(self, "_backed_up", False) and file.is_file() and file.stat().st_size:
            try:  # the first save of a session: keep the last good file, and one copy a day
                shutil.copy2(file, file.with_name(file.name + ".bak"))
                fileio.backup_daily(file)
            except OSError:
                pass
            self._backed_up = True
        fileio.atomic_write_text(file, json.dumps(data, ensure_ascii=False))

    def allow_saving_anyway(self) -> None:
        """IT decided to start again from the copy loaded (or empty): saving is allowed again."""
        self._library_load_failed = False

    def _merge_stock(self) -> None:
        """One item per code over the active sources, the first source first. A list without balances (the steel
        register, an item list) gives way to a later source that has the balance of the same code, and what one
        of them lacks (material, thickness, plate size, stock-count code) is filled in from the other."""
        kept: dict[str, tuple[StockItem, bool]] = {}
        order: list[str] = []
        for name in self.active_sources:
            source = self.stock_sources[name]
            for item in source.items:
                key = _key(item.code) or "#" + _key(item.name)
                if key not in kept:
                    kept[key] = (item, source.has_quantities)
                    order.append(key)
                    continue
                first, counted = kept[key]
                if not counted and source.has_quantities:
                    _fill_item(item, first)
                    kept[key] = (item, True)
                else:
                    _fill_item(first, item)
        items = [kept[k][0] for k in order]
        self.stock = StockList(items=items, source=" + ".join(self.active_sources),
                               has_quantities=all(self.stock_sources[n].has_quantities for n in self.active_sources))

    def rebuild_stock(self) -> None:
        self._merge_stock()
        self.save_library()
        self.stock_changed.emit()

    def add_stock_source(self, name: str, stock: StockList, activate: bool = True) -> None:
        self.stock_sources[name] = stock
        if activate and name not in self.active_sources:
            self.active_sources.append(name)
        self.rebuild_stock()

    def remove_stock_source(self, name: str) -> None:
        self.stock_sources.pop(name, None)
        self.active_sources = [n for n in self.active_sources if n != name]
        self.rebuild_stock()

    def set_source_active(self, name: str, active: bool) -> None:
        if active and name not in self.active_sources:
            self.active_sources.append(name)
        elif not active:
            self.active_sources = [n for n in self.active_sources if n != name]
        self.rebuild_stock()

    def add_manual_item(self) -> StockItem:
        source = self.stock_sources.setdefault(MANUAL_SOURCE, StockList(source=MANUAL_SOURCE))
        item = StockItem()
        source.items.append(item)
        if MANUAL_SOURCE not in self.active_sources:
            self.active_sources.append(MANUAL_SOURCE)
        self.rebuild_stock()
        return item

    def remove_items(self, items: list[StockItem]) -> None:
        ids = {id(i) for i in items}
        for source in self.stock_sources.values():
            source.items = [i for i in source.items if id(i) not in ids]
        self.rebuild_stock()

    def set_models(self, models: list[ModelBOM], replace_same_name: bool = True) -> None:
        names = {m.name for m in models}
        self.models = [m for m in self.models if not (replace_same_name and m.name in names)] + models
        self.save_library()
        self.models_changed.emit()

    def set_xref(self, xref: CodeXref) -> None:
        self.xref = xref
        self.save_library()
        self.xref_changed.emit()
        self.stock_changed.emit()

    # ---- Express item list, documents, jobs ------------------------------------------------------
    def express_stock(self) -> StockList | None:
        """The Express item list (STMASR0200 / 4.สินค้า export) with the most RRS codes."""
        express = [s for n, s in self.stock_sources.items() if n.startswith("Express")]
        if not express:
            return None
        return max(express, key=lambda s: sum(1 for i in s.items if i.code.upper().startswith("RRS")))

    # ---- who is using the program ------------------------------------------------------------
    @property
    def signin_on(self) -> bool:
        return self.users.active or bool(self.users_problem)

    def can(self, perm: Perm) -> bool:
        return access.can(self.actor, perm)

    def require(self, perm: Perm) -> None:
        access.require(self.actor, perm)

    def set_actor(self, actor: access.Actor) -> None:
        old = self.actor
        self.actor = actor
        if old.id != actor.id:
            self.log("user.sign_in" if actor.kind == "pc" and actor.id != "viewer" else "user.sign_out", "user",
                     actor.id if actor.id != "viewer" else old.id)
        self.actor_changed.emit()

    def log(self, action: str, obj_type: str = "", obj_id: str = "", before=None, after=None, reason: str = "",
            source: str = "pc", actor: access.Actor | None = None) -> None:
        """One line in the audit log (never fails the work when the disk does)."""
        try:
            self.audit.append(actor or self.actor, action, obj_type, obj_id, before, after, reason, source)
        except OSError:
            pass

    def who(self) -> str:
        return self.actor.name if self.actor.kind != "open" else ""

    def post_doc(self, doc: StockDoc, actor: access.Actor | None = None) -> list[str]:
        """Save a stock document: balances change and the movements are recorded."""
        actor = actor or self.actor
        access.require(actor, Perm.DOC_POST_AJ if doc.doc_type == "AJ" else Perm.DOC_POST)
        new_items = self.stock_sources.setdefault(MOVED_SOURCE, StockList(source=MOVED_SOURCE))
        if doc not in self.ledger.docs:
            if not doc.doc_no:
                doc.doc_no = self.ledger.next_no(doc.doc_type, doc.date)
            self.ledger.docs.append(doc)
        warnings = self.ledger.post(doc, self.stock, new_items)
        if doc.status == "บันทึกแล้ว":
            doc.posted_by = actor.name if actor.kind != "open" else ""
            self.log("doc.post", "doc", doc.doc_no, after={"type": doc.doc_type, "lines": [
                {"code": ln.code, "qty": ln.qty} for ln in doc.lines]}, actor=actor)
        if new_items.items and MOVED_SOURCE not in self.active_sources:
            self.active_sources.append(MOVED_SOURCE)
        if not new_items.items:
            self.stock_sources.pop(MOVED_SOURCE, None)
        self.rebuild_stock()
        self.ledger_changed.emit()
        return warnings

    def cancel_doc(self, doc: StockDoc, reason: str = "") -> None:
        """Cancel a saved document (its stock comes back). One already keyed / numbered in Express needs the right
        to do so and is marked to be cancelled in Express too."""
        in_express = bool(doc.express_no or doc.keyed_at)
        self.require(Perm.DOC_CANCEL_KEYED if in_express else Perm.DOC_CANCEL)
        self.ledger.cancel(doc, self.stock)
        from datetime import datetime

        doc.cancelled_by, doc.cancel_reason = self.who(), reason
        doc.cancelled_at = datetime.now().isoformat(timespec="seconds")
        doc.void_in_express = in_express
        self.log("doc.cancel", "doc", doc.doc_no, after={"express_no": doc.express_no} if in_express else None,
                 reason=reason)
        self.rebuild_stock()
        self.ledger_changed.emit()

    def set_express_no(self, doc: StockDoc, number: str, source: str = "pc") -> bool:
        """The one way an Express number is set or changed (the outbox, the bot, a file, the เบิก / รับ page)."""
        from datetime import datetime

        from ..core import express_out

        self.require(Perm.EXPRESS_NUMBER)
        number = (number or "").strip().upper()
        if doc.status == "ยกเลิก":
            raise ValueError(f"{doc.doc_no} ยกเลิกแล้ว – ใส่เลขที่ Express ไม่ได้")
        if number == doc.express_no:
            return False
        before = doc.express_no
        express_out.apply_express_numbers(self.ledger, {doc.doc_no: number}, allow_clear=True)
        doc.express_no_by, doc.express_no_at = self.who(), datetime.now().isoformat(timespec="seconds")
        self.log("doc.express_no", "doc", doc.doc_no, {"express_no": before}, {"express_no": number}, source=source)
        return True

    def save_jobs(self) -> None:
        self.save_library()
        self.jobs_changed.emit()

    def save_laser(self) -> None:
        self.save_library()
        self.laser_changed.emit()

    def save_catalog(self) -> None:
        self.save_library()
        self.catalog_changed.emit()

    def mark_dirty(self) -> None:
        self.dirty = True
        self.partlist_changed.emit()

    def replace(self, partlist: PartList, path: str = "") -> None:
        self.partlist = partlist
        self.path = path
        self.dirty = False
        self.requirements = []
        self.part_matches = []
        self.drawing_cache.clear()
        self.partlist_replaced.emit()
        self.partlist_changed.emit()
        self.requirements_changed.emit()

    def notify(self, text: str) -> None:
        self.message.emit(text)
