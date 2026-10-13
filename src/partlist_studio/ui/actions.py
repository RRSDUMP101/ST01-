"""User actions shared by several pages: importing drawings/tables, exports, file handling."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtWidgets import QFileDialog, QMessageBox, QWidget

from ..core import dwg_io
from ..core.models import FILE_SUFFIX, PartList
from ..core.partlist_io import export_parts, prepare_import
from ..core.tabular import write_table
from .dialogs import ColumnMappingDialog, DrawingImportDialog
from .state import AppState
from .widgets import run_async

DRAWING_FILTER = "แบบ 2D ZWCAD (*.dwg *.dxf);;DWG (*.dwg);;DXF (*.dxf)"
TABLE_FILTER = "ตาราง (*.csv *.txt *.xlsx *.xls);;CSV (*.csv);;Excel (*.xlsx *.xls);;Text (*.txt)"
PROJECT_FILTER = f"Part List Studio (*{FILE_SUFFIX})"


class Actions:
    def __init__(self, state: AppState, window: QWidget):
        self.state = state
        self.window = window

    # ---- helpers -----------------------------------------------------------
    def _dir(self) -> str:
        return self.state.settings.get("last_dir", str(Path.home()))

    def _remember(self, path: str) -> None:
        self.state.settings.set("last_dir", str(Path(path).parent))

    def go(self, page: str) -> None:
        self.window.go(page)

    def error(self, title: str, text: str) -> None:
        QMessageBox.warning(self.window, title, text)

    def save_path(self, caption: str, name: str, filters: str) -> str:
        path, _ = QFileDialog.getSaveFileName(self.window, caption, str(Path(self._dir()) / name), filters)
        if path:
            self._remember(path)
        return path

    def default_name(self, suffix: str, tail: str = "PartList") -> str:
        info = self.state.partlist.info
        stem = "_".join(x for x in (info.so_no, info.drawing_no) if x) or "RRS"
        return f"{stem}_{tail}{suffix}"

    # ---- import ------------------------------------------------------------
    def import_drawings(self, paths: list[str] | None = None) -> None:
        if paths is None:
            paths, _ = QFileDialog.getOpenFileNames(self.window, "เลือกแบบ 2D จาก ZWCAD", self._dir(), DRAWING_FILTER)
        if not paths:
            return
        self._remember(paths[0])
        settings = self.state.settings
        converter = settings.converter()
        cut_layer = settings.get("dwg/cut_layer")
        if any(p.lower().endswith(".dwg") for p in paths) and converter is None:
            self.error("ยังไม่พบโปรแกรมแปลง DWG",
                       "ไฟล์ .dwg ต้องแปลงเป็น DXF ก่อนอ่าน\n\n"
                       "• ติดตั้ง ODA File Converter (ฟรี) แล้วกด 'ค้นหาอัตโนมัติ' ในหน้า ตั้งค่า\n"
                       "• หรือใน ZWCAD ใช้ Save As → DXF แล้วนำเข้าไฟล์ .dxf แทน")
            paths = [p for p in paths if p.lower().endswith(".dxf")]
            if not paths:
                return

        def work():
            results, errors = [], []
            for p in paths:
                try:
                    results.append(dwg_io.read_drawing(p, converter, cut_layer))
                except Exception as exc:  # noqa: BLE001 - collect per file
                    errors.append(f"{Path(p).name}: {exc}")
            return results, errors

        run_async(work, self._drawings_read, lambda e: self.error("อ่านแบบไม่สำเร็จ", e))

    def _drawings_read(self, result) -> None:
        drawings, errors = result
        if errors:
            self.error("บางไฟล์อ่านไม่ได้", "\n".join(errors))
        if not drawings:
            return
        dialog = DrawingImportDialog(drawings, self.state.settings.densities, self.window)
        if not dialog.exec():
            return
        pl = self.state.partlist
        added = 0
        for data, parts in dialog.selected_parts():
            self.state.drawing_cache[data.source_path or data.path] = data
            record = dwg_io.drawing_record(data, len(parts))
            pl.drawings = [d for d in pl.drawings if d.path != record.path] + [record]
            pl.parts.extend(parts)
            added += len(parts)
            if dialog.update_info.isChecked():
                self._fill_info_from_title(data)
        pl.renumber()
        self.state.mark_dirty()
        self.state.notify(f"เพิ่ม {added} รายการจากแบบ {len(drawings)} ไฟล์")

    def _fill_info_from_title(self, data) -> None:
        info, tb = self.state.partlist.info, data.title_block
        for field_name, key in (("drawing_no", "drawing_no"), ("revision", "revision"), ("customer", "customer"),
                                ("vehicle_model", "vehicle_model"), ("so_no", "so_no")):
            if not getattr(info, field_name) and tb.get(key):
                setattr(info, field_name, tb[key])

    def import_table(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self.window, "เลือกไฟล์ตาราง BOM จาก ZWCAD / Excel", self._dir(),
                                              TABLE_FILTER)
        if not path:
            return
        self._remember(path)
        try:
            table = prepare_import(path)
        except Exception as exc:  # noqa: BLE001
            self.error("เปิดไฟล์ไม่ได้", str(exc))
            return
        self.import_rows(table, Path(path).name)

    def import_rows(self, table, source_name: str) -> None:
        if not table.rows:
            self.error("ไม่มีข้อมูล", "ไม่พบข้อมูลในตาราง")
            return
        dialog = ColumnMappingDialog(table, source_name, self.window)
        if not dialog.exec():
            return
        parts = table.to_parts()
        if self.state.partlist.parts:
            box = QMessageBox(QMessageBox.Question, "นำเข้า Part List",
                              f"พบ {len(parts)} รายการ ต้องการทำอย่างไรกับรายการเดิม {len(self.state.partlist.parts)} รายการ?",
                              parent=self.window)
            add = box.addButton("เพิ่มต่อท้าย", QMessageBox.AcceptRole)
            replace = box.addButton("แทนที่ทั้งหมด", QMessageBox.DestructiveRole)
            box.addButton("ยกเลิก", QMessageBox.RejectRole)
            box.exec()
            if box.clickedButton() == replace:
                self.state.partlist.parts = parts
            elif box.clickedButton() == add:
                self.state.partlist.parts.extend(parts)
            else:
                return
        else:
            self.state.partlist.parts = parts
        if not any(p.item_no for p in parts):
            self.state.partlist.renumber()
        self.state.mark_dirty()
        self.state.notify(f"นำเข้า {len(parts)} รายการจาก {source_name}")

    # ---- export ------------------------------------------------------------
    def export_cad_dxf(self) -> None:
        path = self.save_path("ส่งออกตาราง Part List สำหรับ ZWCAD", self.default_name(".dxf"), "DXF (*.dxf)")
        if path:
            dwg_io.export_dxf_table(self.state.partlist, path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว – เปิดใน ZWCAD หรือใช้ INSERT วางลงในแบบ")

    def export_cad_dwg(self) -> None:
        converter = self.state.settings.converter()
        if converter is None or converter.kind != "oda":
            self.error("ต้องใช้ ODA File Converter", "การบันทึกเป็น DWG ต้องติดตั้ง ODA File Converter (หน้า ตั้งค่า)\n"
                                                      "หรือเลือกส่งออกเป็น DXF ซึ่ง ZWCAD เปิดได้โดยตรง")
            return
        path = self.save_path("ส่งออกตาราง Part List เป็น DWG", self.default_name(".dwg"), "DWG (*.dwg)")
        if not path:
            return
        tmp = Path(path).with_suffix(".tmp.dxf")

        def work():
            dwg_io.export_dxf_table(self.state.partlist, tmp)
            try:
                return dwg_io.export_dxf_to_dwg(tmp, path, converter)
            finally:
                tmp.unlink(missing_ok=True)

        run_async(work, lambda p: self.state.notify(f"บันทึก {Path(p).name} แล้ว"),
                  lambda e: self.error("บันทึก DWG ไม่สำเร็จ", e))

    def export_cad_table(self) -> None:
        path = self.save_path("ส่งออก BOM (CSV/Excel) สำหรับ ZWCAD", self.default_name(".csv", "BOM"),
                              "CSV (*.csv);;Excel (*.xlsx)")
        if path:
            export_parts(self.state.partlist, path, style="cad")
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def export_excel_report(self) -> None:
        path = self.save_path("ส่งออก Part List (Excel)", self.default_name(".xlsx"), "Excel (*.xlsx)")
        if path:
            export_parts(self.state.partlist, path, style="thai")
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def export_company_bom(self) -> None:
        from ..core.company_files import export_models, models_from_partlist

        path = self.save_path("Part List รูปแบบบริษัท", self.default_name(".xlsx", "PartsList"), "Excel (*.xlsx)")
        if path:
            export_models([models_from_partlist(self.state.partlist)], path)
            self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    def export_drawing_register(self) -> None:
        path = self.save_path("ส่งออกทะเบียนแบบ", self.default_name(".xlsx", "Drawings"), "Excel (*.xlsx);;CSV (*.csv)")
        if not path:
            return
        header = ["ไฟล์", "เลขที่แบบ", "ชื่อแบบ", "Rev.", "วัสดุ", "ความหนา", "จำนวนรายการ", "วันที่นำเข้า", "สถานะ", "ตำแหน่งไฟล์"]
        rows = [[d.file_name, d.drawing_no, d.title, d.revision, d.material, d.thickness, d.part_count, d.imported,
                 d.status, d.path] for d in self.state.partlist.drawings]
        write_table(path, header, rows, sheet_title="Drawings")
        self.state.notify(f"บันทึก {Path(path).name} แล้ว")

    # ---- project file ----------------------------------------------------
    def confirm_discard(self) -> bool:
        if not self.state.dirty:
            return True
        answer = QMessageBox.question(self.window, "ยังไม่ได้บันทึก", "บันทึกการเปลี่ยนแปลงก่อนหรือไม่?",
                                      QMessageBox.Save | QMessageBox.Discard | QMessageBox.Cancel)
        if answer == QMessageBox.Save:
            return self.save()
        return answer == QMessageBox.Discard

    def new(self) -> None:
        if self.confirm_discard():
            self.state.replace(PartList())

    def open(self, path: str = "") -> None:
        if not self.confirm_discard():
            return
        if not path:
            path, _ = QFileDialog.getOpenFileName(self.window, "เปิด Part List", self._dir(), PROJECT_FILTER)
        if not path:
            return
        try:
            self.state.replace(PartList.load(path), path)
        except Exception as exc:  # noqa: BLE001
            self.error("เปิดไฟล์ไม่ได้", str(exc))
            return
        self._remember(path)
        self.state.notify(f"เปิด {Path(path).name}")

    def save(self, save_as: bool = False) -> bool:
        path = self.state.path
        if save_as or not path:
            path = self.save_path("บันทึก Part List", self.default_name(FILE_SUFFIX), PROJECT_FILTER)
            if not path:
                return False
            if not path.endswith(FILE_SUFFIX):
                path += FILE_SUFFIX
        self.state.partlist.save(path)
        self.state.path = path
        self.state.dirty = False
        self.state.partlist_changed.emit()
        self.state.notify(f"บันทึก {Path(path).name} แล้ว")
        return True
