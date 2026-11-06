"""คีย์เข้า Express อัตโนมัติ - the dialog: which documents, the keys of each Express screen, a test run, the run."""

from __future__ import annotations

import json
import sys
import threading
from datetime import datetime

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import (QCheckBox, QDialog, QFileDialog, QFormLayout, QHBoxLayout, QInputDialog, QLabel,
                               QLineEdit, QListWidget, QListWidgetItem, QMessageBox, QPlainTextEdit, QProgressBar,
                               QSpinBox, QSplitter, QTabWidget, QVBoxLayout, QWidget)

from ..core import express_bot as bot
from ..core import express_out
from ..core.access import AccessDenied, Perm
from .widgets import button, fit_to_screen

SETTINGS_KEY = "express/bot"
HELP = ("<b>[ช่อง]</b> ค่าของเอกสาร: " + ", ".join(f"[{k}]" for k in bot.DOC_FIELDS)
        + " · ของบรรทัด: " + ", ".join(f"[{k}]" for k in bot.LINE_FIELDS)
        + "<br><b>{ปุ่ม}</b> {ENTER} {TAB} {ESC} {DOWN} {F4} {F8} {F10} {CTRL+S} {TAB 3} (กด 3 ครั้ง) · "
          "<b>{WAIT 500}</b> รอ 0.5 วินาที · <b>{STOP}</b> หยุดให้คนตรวจและกดบันทึกเอง · "
          "<b>{CONFIRM ข้อความ}</b> ถามก่อนไปต่อ (ใบแรกของแต่ละชนิด)<br>" + bot.NEW_KEY_HINT)


def load_options(settings, warehouse: str = "01", department: str = "") -> bot.BotOptions:
    opts = bot.BotOptions(warehouse=warehouse or "01", department=department)
    try:
        data = json.loads(settings.get(SETTINGS_KEY, "") or "{}")
    except ValueError:
        data = {}
    opts.window = data.get("window", opts.window) or "Express"
    opts.delay_ms = int(data.get("delay_ms", opts.delay_ms))
    opts.paste_thai = bool(data.get("paste_thai", opts.paste_thai))
    opts.process = str(data.get("process", opts.process) or "")
    opts.confirm_first_only = bool(data.get("confirm_first_only", opts.confirm_first_only))
    opts.remark_ref = bool(data.get("remark_ref", opts.remark_ref))
    for t, parts in (data.get("templates") or {}).items():
        if t in opts.templates and isinstance(parts, dict):
            opts.templates[t].update({k: v for k, v in parts.items() if k in (bot.HEAD, bot.LINE, bot.END)})
    return opts


def save_options(settings, opts: bot.BotOptions) -> None:
    settings.set(SETTINGS_KEY, json.dumps({"window": opts.window, "delay_ms": opts.delay_ms,
                                           "paste_thai": opts.paste_thai, "process": opts.process,
                                           "confirm_first_only": opts.confirm_first_only,
                                           "remark_ref": opts.remark_ref, "templates": opts.templates},
                                          ensure_ascii=False))


class _Worker(QObject):
    progress = Signal(int, int, str)
    stop_reached = Signal(str)
    confirm_asked = Signal(str, str)
    finished = Signal(list, str, str)  # keyed, error, the document left half-typed

    def __init__(self, actions, options, out):
        super().__init__()
        self.actions, self.options, self.out = actions, options, out
        self.cancel = False
        self._event = threading.Event()
        self._go_on = True

    def answer(self, go_on: bool) -> None:
        self._go_on = go_on
        self._event.set()

    def _wait_stop(self, label: str) -> bool:
        self._event.clear()
        self.stop_reached.emit(label)
        self._event.wait()
        return self._go_on and not self.cancel

    def _confirm(self, doc_no: str, question: str) -> bool:
        self._event.clear()
        self.confirm_asked.emit(doc_no, question)
        self._event.wait()
        return self._go_on and not self.cancel

    def run(self) -> None:
        keyed, error, partial = [], "", ""
        try:
            keyed = bot.run(self.actions, self.options, self.out, lambda d, t, label: self.progress.emit(d, t, label),
                            self._wait_stop, lambda: self.cancel, confirm=self._confirm)
        except bot.Stopped as e:
            error, keyed, partial = str(e), e.keyed, e.partial
        except Exception as e:  # noqa: BLE001 - shown in the dialog
            error = f"{type(e).__name__}: {e}"
        self.finished.emit(keyed, error, partial)


class ExpressBotDialog(QDialog):
    def __init__(self, state, docs, parent=None, output_factory=None, practice=False):
        super().__init__(parent)
        self.practice = practice  # ตัวอย่างสำหรับฝึก: types into Notepad, nothing of the program changes
        self.setWindowTitle("ฝึกคีย์เข้า Express (ตัวอย่าง)" if practice else "คีย์เข้า Express อัตโนมัติ")
        self.setObjectName("ExpressBotDialog")
        fit_to_screen(self, 1180, 820)
        self.state = state
        self.docs = docs
        s = state.settings
        self.options = load_options(s, s.get("express/warehouse", "01"), s.get("express/department", ""))
        self.output_factory = output_factory or self._windows_output
        self.worker = None
        lay = QVBoxLayout(self)
        if practice:
            self.options.window = "Notepad"
            banner = QLabel("<b>โหมดฝึก</b> – เอกสารตัวอย่าง 4 ใบ (PD, OU, RR, JU) พิมพ์ลง <b>Notepad</b> ให้ดูว่าโปรแกรมกดอะไรบ้าง · "
                            "ไม่มีอะไรเปลี่ยนในโปรแกรมหรือใน Express · กด <b>เปิด Notepad</b> แล้ว <b>เริ่มคีย์</b>")
            banner.setWordWrap(True)
            banner.setStyleSheet("background:#FFF4CE;border:1px solid #E0B84C;border-radius:6px;padding:8px")
            lay.addWidget(banner)
        steps = QLabel(
            "<b>① เปิดหน้าจอ</b> ใน Express (เช่น 4.สินค้า → PD) ค้างไว้ &nbsp;→&nbsp; "
            "<b>② ติ๊กใบ</b> ที่จะคีย์ทางซ้าย (ชนิดเดียวกับหน้าจอที่เปิด) &nbsp;→&nbsp; "
            "<b>③ กด เริ่มคีย์</b> – นับถอยหลัง 3 วิ ปล่อยเมาส์/แป้น โปรแกรมพิมพ์ให้ &nbsp;→&nbsp; "
            "<b>④ ตรวจในหน้าจอ</b> แล้วกดบันทึกใน Express เอง → กด <b>บันทึกใน Express แล้ว</b> → ใส่เลขที่ที่ Express ออกให้"
            "<br><span style='color:#6B7A90'>ครั้งแรก: ลองกับ Notepad ก่อน แล้วลองใบเดียวกับ Express – ถ้าเคอร์เซอร์ไปผิดช่อง "
            "แก้ลำดับการกดทางขวา (ผู้ดูแล) · หยุดทันที: เมาส์มุมซ้ายบนสุด / Pause / Ctrl+Alt+Q · "
            "โปรแกรมไม่เขียนไฟล์ข้อมูลของ Express – Express ตรวจทุกช่องเหมือนคนคีย์</span>")
        steps.setWordWrap(True)
        lay.addWidget(steps)
        split = QSplitter(Qt.Horizontal)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(QLabel("<b>เอกสารที่จะคีย์</b> (เรียงตามวันที่)"))
        self.doc_list = QListWidget()
        for d in docs:
            keyed = (f" · หยุดกลางคัน {d.key_partial[:16].replace('T', ' ')} – ตรวจใน Express" if d.key_partial else
                     f" · คีย์แล้ว {d.keyed_at[:16].replace('T', ' ')} รอเลขที่" if d.keyed_at else "")
            it = QListWidgetItem(f"{d.doc_no} · {d.doc_type} · {express_out.thai_date(d.date)} · {len(d.lines)} รายการ"
                                 f"{keyed}\n{express_out.screen_note(d)[:70]}")
            it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
            it.setCheckState(Qt.Unchecked if d.keyed_at or d.key_partial else Qt.Checked)
            it.setData(Qt.UserRole, d.doc_no)
            self.doc_list.addItem(it)
        self.doc_list.itemChanged.connect(lambda *_: self._preview())
        self.doc_list.currentRowChanged.connect(self._doc_changed)
        ll.addWidget(self.doc_list, 1)
        form = QFormLayout()
        self.window_edit = QLineEdit(self.options.window)
        self.window_edit.setToolTip("ส่วนหนึ่งของชื่อหน้าต่าง Express (แถบบนสุด) – ทดลองก่อนได้: เปิด Notepad แล้วใส่ Notepad")
        form.addRow("พิมพ์ลงหน้าต่างที่ชื่อมี", self.window_edit)
        self.process_edit = QLineEdit(self.options.process)
        self.process_edit.setPlaceholderText("เช่น express (ว่าง = โปรแกรมใดก็ได้)")
        self.process_edit.setToolTip("ส่วนหนึ่งของชื่อไฟล์โปรแกรม Express (ดูใน Task Manager) – กันพิมพ์ลงหน้าต่างอื่นที่ชื่อคล้ายกัน")
        form.addRow("ชื่อโปรแกรม", self.process_edit)
        self.delay = QSpinBox()
        self.delay.setRange(0, 2000)
        self.delay.setSuffix(" มิลลิวินาที")
        self.delay.setValue(self.options.delay_ms)
        form.addRow("เว้นระหว่างปุ่ม", self.delay)
        self.paste = QCheckBox("พิมพ์ภาษาไทยด้วยการวาง (Ctrl+V)")
        self.paste.setToolTip("ใช้เมื่อพิมพ์ไทยลง Express แล้วเป็นตัวอ่านไม่ออก")
        self.paste.setChecked(self.options.paste_thai)
        form.addRow("", self.paste)
        self.confirm_first = QCheckBox("ถามยืนยัน ({CONFIRM}) เฉพาะใบแรกของแต่ละชนิด")
        self.confirm_first.setChecked(self.options.confirm_first_only)
        form.addRow("", self.confirm_first)
        self.remark_ref = QCheckBox("ใส่เลขที่ในโปรแกรมท้ายหมายเหตุ (#PD6911-0001)")
        self.remark_ref.setToolTip("ช่วยหาใบนี้ใน Express ภายหลัง (อ่านข้อมูล Express)")
        self.remark_ref.setChecked(self.options.remark_ref)
        self.remark_ref.toggled.connect(lambda *_: self._preview())
        form.addRow("", self.remark_ref)
        ll.addLayout(form)
        split.addWidget(left)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(QLabel("<b>ลำดับการกดของแต่ละหน้าจอ Express</b> – แก้ให้ตรงกับหน้าจอจริงครั้งเดียว แล้วโปรแกรมจำไว้"))
        self.tpl_tabs = QTabWidget()
        self.tpl_edits: dict[str, dict[str, QPlainTextEdit]] = {}
        for t, parts in self.options.templates.items():
            w = QWidget()
            wl = QVBoxLayout(w)
            hint = QLabel(f"หน้าจอ: <b>{bot.SCREEN_HINTS.get(t, t)}</b>")
            wl.addWidget(hint)
            edits = {}
            for sec, label in ((bot.HEAD, "หัวเอกสาร (ครั้งเดียว)"), (bot.LINE, "แต่ละบรรทัดสินค้า"),
                               (bot.END, "ท้ายเอกสาร")):
                wl.addWidget(QLabel(label))
                e = QPlainTextEdit(parts.get(sec, ""))
                e.setMaximumHeight(70 if sec != bot.END else 40)
                e.textChanged.connect(self._preview)
                wl.addWidget(e)
                edits[sec] = e
            reset = button("คืนค่าเริ่มต้นของหน้าจอนี้")
            reset.clicked.connect(lambda _=False, t=t: self._reset(t))
            wl.addWidget(reset, 0, Qt.AlignLeft)
            if not state.can(Perm.EXPRESS_CONFIG):  # templates decide what is pressed in Express: IT only
                for e in edits.values():
                    e.setReadOnly(True)
                reset.setEnabled(False)
            self.tpl_edits[t] = edits
            self.tpl_tabs.addTab(w, t)
        rl.addWidget(self.tpl_tabs)
        if not state.can(Perm.EXPRESS_CONFIG):
            lock = QLabel("แก้ลำดับการกด / หน้าต่าง / ชื่อโปรแกรม ได้เฉพาะ ผู้ดูแล / IT")
            lock.setObjectName("Hint")
            rl.addWidget(lock)
        help_label = QLabel(HELP)
        help_label.setWordWrap(True)
        help_label.setObjectName("Hint")
        rl.addWidget(help_label)
        rl.addWidget(QLabel("<b>สิ่งที่จะพิมพ์</b> (ใบที่เลือก)"))
        self.preview = QPlainTextEdit()
        self.preview.setReadOnly(True)
        rl.addWidget(self.preview, 1)
        split.addWidget(right)
        split.setSizes([380, 780])
        lay.addWidget(split, 1)
        self.status = QLabel("")
        self.status.setWordWrap(True)
        lay.addWidget(self.status)
        self.bar = QProgressBar()
        self.bar.setVisible(False)
        lay.addWidget(self.bar)
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumHeight(90)
        self.log.setPlaceholderText("บันทึกการคีย์ของรอบนี้")
        lay.addWidget(self.log)
        row = QHBoxLayout()
        self.notepad_btn = button("เปิด Notepad ลองก่อน", tooltip="เปิด Notepad แล้วตั้งให้พิมพ์ลง Notepad – ดูว่าโปรแกรมกดอะไร")
        self.notepad_btn.clicked.connect(self.open_notepad)
        row.addWidget(self.notepad_btn)
        self.ahk_btn = button("ส่งออก AutoHotkey…", tooltip="สคริปต์ AutoHotkey v2 ของการกดเดียวกัน (ดู/รันเองได้)")
        self.ahk_btn.clicked.connect(self.export_ahk)
        row.addWidget(self.ahk_btn)
        copy = button("คัดลอกบันทึก")
        copy.clicked.connect(lambda: QGuiApplication.clipboard().setText(self.log.toPlainText()))
        row.addWidget(copy)
        row.addStretch(1)
        self.stop_btn = button("หยุด")
        self.stop_btn.clicked.connect(self.stop)
        self.stop_btn.setEnabled(False)
        row.addWidget(self.stop_btn)
        close = button("ปิด")
        close.clicked.connect(self.close)
        row.addWidget(close)
        self.run_btn = button("เริ่มคีย์เข้า Express", "primary", "พิมพ์ใบที่ติ๊กลงหน้าต่าง Express ทีละใบ (หยุดก่อนบันทึกทุกใบ)")
        self.run_btn.clicked.connect(self.start)
        row.addWidget(self.run_btn)
        lay.addLayout(row)
        if not sys.platform.startswith("win") and output_factory is None:
            self.run_btn.setEnabled(False)
            self.status.setText("คีย์อัตโนมัติใช้ได้บน Windows ที่ติดตั้ง Express – เครื่องนี้ส่งออก AutoHotkey หรือดูลำดับได้")
        if not state.can(Perm.EXPRESS_CONFIG):
            for w in (self.window_edit, self.process_edit, self.delay):
                w.setEnabled(False)
        if self.doc_list.count():
            self.doc_list.setCurrentRow(0)
        self._preview()

    def open_notepad(self) -> None:
        """A safe place to try the keys: Notepad, and the bot types into it."""
        self.window_edit.setEnabled(True)
        self.window_edit.setText("Notepad")
        self.process_edit.setText("")
        if sys.platform.startswith("win"):
            import subprocess

            try:
                subprocess.Popen(["notepad.exe"])  # noqa: S603,S607 - Windows' own editor
            except OSError as e:
                self.status.setText(f"เปิด Notepad ไม่ได้: {e}")
                return
            self.status.setText("เปิด Notepad แล้ว – กด เริ่มคีย์ แล้วดูตัวอักษรที่โปรแกรมพิมพ์ลง Notepad")
        else:
            self.status.setText("ตั้งให้พิมพ์ลงหน้าต่าง Notepad แล้ว (เครื่องนี้ไม่ใช่ Windows – ใช้ส่งออก AutoHotkey ดูลำดับได้)")

    # ---- options ------------------------------------------------------------------------------------
    def _read_options(self) -> bot.BotOptions:
        o = self.options
        o.window = self.window_edit.text().strip() or "Express"
        o.process = self.process_edit.text().strip()
        o.delay_ms = self.delay.value()
        o.paste_thai = self.paste.isChecked()
        o.confirm_first_only = self.confirm_first.isChecked()
        o.remark_ref = self.remark_ref.isChecked()
        for t, edits in self.tpl_edits.items():
            o.templates[t] = {sec: e.toPlainText().strip() for sec, e in edits.items()}
        return o

    def _reset(self, t: str) -> None:
        for sec, e in self.tpl_edits[t].items():
            e.setPlainText(bot.DEFAULT_TEMPLATES[t][sec])

    def checked_docs(self):
        nos = {self.doc_list.item(i).data(Qt.UserRole) for i in range(self.doc_list.count())
               if self.doc_list.item(i).checkState() == Qt.Checked}
        return [d for d in self.docs if d.doc_no in nos]

    def _actions(self, docs):
        opts = self._read_options()
        allow = self.state.settings.get("express/bot_allow_save", "0") == "1"
        errors = [e for t in sorted({d.doc_type for d in docs})
                  for e in bot.check_template(t, opts.templates[t], allow)]
        if errors:
            raise bot.TemplateError("\n".join(errors))
        return [bot.actions_for(d, opts) for d in docs]

    def _doc_changed(self, row: int) -> None:
        if 0 <= row < len(self.docs) and self.docs[row].doc_type in self.tpl_edits:
            self.tpl_tabs.setCurrentIndex(list(self.tpl_edits).index(self.docs[row].doc_type))
        self._preview()

    def _preview(self) -> None:
        row = self.doc_list.currentRow()
        doc = self.docs[row] if 0 <= row < len(self.docs) else None
        if doc is None:
            self.preview.setPlainText("")
            return
        try:
            actions = self._actions([doc])[0]
        except bot.TemplateError as e:
            self.preview.setPlainText(f"แก้แบบการกดก่อน:\n{e}")
            return
        text = [f"⚠ {w}" for w in bot.template_warnings(doc.doc_type, self._read_options().templates[doc.doc_type])]
        text += [f"⚠ {p}" for p in bot.check_text([actions])]
        for a in actions:
            if a.kind == "doc":
                text.append(f"=== {a.label}")
            elif a.kind == "text":
                text.append(f"พิมพ์  “{a.value}”   ({a.label})")
            elif a.kind == "key":
                text.append(f"กด    {a.value}" + (f" × {a.times}" if a.times > 1 else ""))
            elif a.kind == "wait":
                text.append(f"รอ    {a.value} ms")
            elif a.kind == "stop":
                text.append("หยุด  – ตรวจในหน้าจอ แล้วกดบันทึกเอง")
            elif a.kind == "confirm":
                text.append(f"ถาม  “{a.value}”")
        self.preview.setPlainText("\n".join(text))

    # ---- AutoHotkey ----------------------------------------------------------------------------------
    def export_ahk(self) -> None:
        docs = self.checked_docs()
        if not docs:
            self.status.setText("ติ๊กเอกสารก่อน")
            return
        try:
            actions = self._actions(docs)
        except bot.TemplateError as e:
            QMessageBox.warning(self, "แบบการกดไม่ถูกต้อง", str(e))
            return
        path, _ = QFileDialog.getSaveFileName(self, "สคริปต์ AutoHotkey", "ToExpress.ahk", "AutoHotkey (*.ahk)")
        if not path:
            return
        with open(path, "w", encoding="utf-8-sig", newline="\r\n") as fh:
            fh.write(bot.to_ahk(actions, self._read_options()))
        save_options(self.state.settings, self.options)
        self.status.setText(f"บันทึก {path} แล้ว – ดับเบิลคลิกเพื่อรันด้วย AutoHotkey v2 (เปิดหน้าจอ Express ไว้ก่อน)")

    # ---- running ------------------------------------------------------------------------------------
    def _windows_output(self):
        return bot.WindowsKeyboard(process=self.options.process)

    def _log(self, text: str) -> None:
        self.log.appendPlainText(f"{datetime.now():%H:%M:%S} {text}")

    def start(self) -> None:
        docs = self.checked_docs()
        if not docs:
            self.status.setText("ติ๊กเอกสารที่จะคีย์ก่อน")
            return
        try:
            actions = self._actions(docs)
            out = self.output_factory()
        except (bot.TemplateError, OSError) as e:
            QMessageBox.warning(self, "เริ่มคีย์ไม่ได้", str(e))
            return
        warnings = [w for t in sorted({d.doc_type for d in docs})
                    for w in bot.template_warnings(t, self.options.templates[t])]
        warnings += bot.check_text(actions)
        cp = bot.windows_codepage()
        if cp is not None and cp != 874 and not self.options.paste_thai:
            warnings.append(f"Windows ตั้งภาษาสำหรับโปรแกรมที่ไม่ใช่ Unicode เป็น code page {cp} (ไม่ใช่ไทย 874) – "
                            "ภาษาไทยใน Express อาจเพี้ยน: ติ๊ก พิมพ์ภาษาไทยด้วยการวาง หรือให้ IT ตั้งเป็นไทย")
        if warnings and QMessageBox.question(self, "ตรวจก่อนคีย์", "\n".join(warnings[:12]) + "\n\nคีย์ต่อไหม?") \
                != QMessageBox.Yes:
            return
        again = [d for d in docs if d.keyed_at or d.key_partial or d.express_no] if not self.practice else []
        if again:
            reason, ok = QInputDialog.getText(
                self, "คีย์ซ้ำ", "ใบนี้คีย์เข้า Express ไปแล้ว: " + ", ".join(d.doc_no for d in again)
                + "\nตรวจใน Express ก่อนว่าไม่มีใบซ้ำ\nเหตุผลที่คีย์อีกครั้ง (จำเป็น):")
            if not ok or not reason.strip():
                return
            for d in again:
                self.state.log("doc.rekey", "doc", d.doc_no, before={"keyed_at": d.keyed_at, "express_no": d.express_no},
                               reason=reason.strip())
        types = sorted({d.doc_type for d in docs})
        if len(types) > 1:
            self.status.setText("หลายชนิดเอกสาร: โปรแกรมหยุดทุกใบ – ระหว่างนั้นเปิดหน้าจอของใบถัดไปใน Express ได้")
        if not self.practice:
            save_options(self.state.settings, self.options)
        self._by_no = {d.doc_no: d for d in docs}
        self.worker = _Worker(actions, self.options, out)
        self.worker.progress.connect(self._progress)
        self.worker.stop_reached.connect(self._stop_reached)
        self.worker.confirm_asked.connect(self._confirm_asked)
        self.worker.finished.connect(self._finished)
        self.bar.setVisible(True)
        self.bar.setRange(0, sum(len(a) for a in actions))
        self.run_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self._log(f"เริ่ม {len(docs)} ใบ: " + ", ".join(d.doc_no for d in docs) + f" → หน้าต่าง “{self.options.window}”")
        if not self.practice:
            self.state.log("bot.run_start", "bot_run", "", after={"docs": [d.doc_no for d in docs],
                                                                 "window": self.options.window,
                                                                 "process": self.options.process})
        self._countdown, self._started = self.countdown_s, False
        self._tick()

    countdown_s = 3

    def _tick(self) -> None:
        if self.worker is None or self.worker.cancel:
            return
        if self._countdown > 0:
            self.status.setText(f"เริ่มใน {self._countdown}… ปล่อยเมาส์และแป้นพิมพ์ · หยุด: เมาส์มุมซ้ายบน / Pause / Ctrl+Alt+Q")
            self._countdown -= 1
            QTimer.singleShot(1000, self._tick)
            return
        self._started = True
        threading.Thread(target=self.worker.run, daemon=True, name="express-bot").start()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt
        if self.worker is not None:
            event.ignore()  # a run goes on typing even when the window is gone: stop it first
            self.status.setText("กำลังคีย์อยู่ – กด หยุด ก่อนปิด")
            return
        super().closeEvent(event)

    def reject(self) -> None:
        if self.worker is not None:
            self.status.setText("กำลังคีย์อยู่ – กด หยุด ก่อนปิด")
            return
        super().reject()

    def stop(self) -> None:
        if self.worker is not None:
            self.worker.cancel = True
            self.worker.answer(False)
            if not self._started:  # stopped during the countdown: nothing was typed
                self._finished([], "หยุดก่อนเริ่มพิมพ์", "")

    def _progress(self, done: int, total: int, label: str) -> None:
        self.bar.setValue(done)
        self.status.setText(f"กำลังคีย์… {label}")

    def _stop_reached(self, doc_no: str) -> None:
        doc = self._by_no.get(doc_no)
        label = f"{doc_no} ({doc.doc_type} {doc.type_name})" if doc is not None else doc_no
        self._log(f"หยุดรอบันทึก {label}")
        answer = self.ask_saved(label)
        now = datetime.now().isoformat(timespec="seconds")
        if self.practice:  # an example: nothing is kept
            if answer == "saved":
                no, ok = QInputDialog.getText(self, "เลขที่ Express (ฝึก)", f"{label}: ตอนใช้จริง ใส่เลขที่ที่ Express ออกให้ "
                                                                        "ตรงนี้ (เช่น PD0000526) – ตอนฝึกไม่เก็บ")
                self._log(f"ฝึก: {doc_no} ได้เลขที่ {no.strip() or '-'} (ไม่เก็บ)")
            self.worker.answer(answer != "stop")
            return
        if doc is not None and answer == "saved":
            doc.keyed_at, doc.key_partial, doc.keyed_by = now, "", self.state.who()
            self.state.log("doc.keyed", "doc", doc.doc_no, source="bot")
            prompt = f"{label}: เลขที่ที่ Express ออกให้ (เว้นว่างได้ – ใส่ภายหลังในหน้า Express)"
            while True:
                no, ok = QInputDialog.getText(self, "เลขที่ Express", prompt)
                no = no.strip().upper()
                warn = express_out.check_express_no(doc, no, self.state.ledger) if ok and no else []
                if not warn or QMessageBox.question(self, "ตรวจเลขที่ Express", "\n".join(warn)
                                                    + "\n\nใช้เลขที่นี้ไหม?") == QMessageBox.Yes:
                    break
            if ok and no:
                try:
                    self.state.set_express_no(doc, no, source="bot")
                    self._log(f"ได้เลขที่ {doc.doc_no} → {no}")
                except (AccessDenied, ValueError) as e:
                    self._log(f"ใส่เลขที่ไม่ได้ {doc.doc_no}: {e}")
        elif doc is not None:  # typed but not saved: it is open in Express, someone must close it there
            doc.key_partial = now
            self.state.log("doc.key_partial", "doc", doc.doc_no, source="bot")
            self._log(f"ไม่ได้บันทึก {doc.doc_no} – ปิดใบนั้นใน Express โดยไม่บันทึก")
        self.state.save_library()
        self.worker.answer(answer != "stop")

    def ask_saved(self, label: str) -> str:
        """At {STOP}: 'saved' (the person saved it in Express), 'skip' (not saved, go on) or 'stop'."""
        box = QMessageBox(self)
        box.setWindowTitle("ตรวจและบันทึกใน Express")
        box.setText(f"{label}: คีย์ครบแล้ว\nตรวจในหน้าจอ Express แล้วกดบันทึกใน Express เอง")
        saved = box.addButton("บันทึกใน Express แล้ว", QMessageBox.AcceptRole)
        skip = box.addButton("ไม่บันทึก – ข้ามใบนี้", QMessageBox.RejectRole)
        box.addButton("หยุด", QMessageBox.DestructiveRole)
        box.setDefaultButton(saved)
        box.exec()
        return "saved" if box.clickedButton() is saved else "skip" if box.clickedButton() is skip else "stop"

    def _confirm_asked(self, doc_no: str, question: str) -> None:
        ok = QMessageBox.question(self, "ยืนยันก่อนคีย์ต่อ", f"{doc_no}: {question}") == QMessageBox.Yes
        self._log(f"ยืนยัน {doc_no}: {'ใช่' if ok else 'ไม่ – หยุด'}")
        self.worker.answer(ok)

    def _finished(self, keyed: list, error: str, partial: str = "") -> None:
        if self.worker is None:
            return
        if self.practice:
            self._log(f"ฝึกเสร็จ: พิมพ์ {len(keyed)} ใบ" + (f" · {error}" if error else "")
                      + " – ใช้จริง: เปิดหน้าจอ Express แล้วกด คีย์เข้า Express อัตโนมัติ ในหน้า Express")
            self.run_btn.setEnabled(True)
            self.stop_btn.setEnabled(False)
            self.bar.setVisible(False)
            self.worker = None
            self.status.setText(f"ฝึกเสร็จ – พิมพ์ {len(keyed)} ใบ" + (f" · {error}" if error else ""))
            return
        now = datetime.now().isoformat(timespec="seconds")
        half = self._by_no.get(partial) if partial else None
        if half is not None:
            half.key_partial = now
            self._log(f"หยุดกลางคัน {partial}: {error}")
            QMessageBox.warning(self, "หยุดกลางคัน",
                                f"ใบ {partial} พิมพ์ไปบางส่วนแล้ว และยังเปิดอยู่ใน Express (ยังไม่บันทึก)\n"
                                "ใน Express: ยกเลิก/ปิดใบนั้นโดยไม่บันทึก ก่อนคีย์ใหม่ – ใบนี้จะไม่ถูกติ๊กในรอบถัดไป")
        self._log(f"สรุป: คีย์ {len(keyed)} ใบ" + (f" · {error}" if error else ""))
        target = getattr(getattr(self.worker, "out", None), "target", "")
        self.state.log("bot.run_end", "bot_run", "", after={"keyed": keyed, "partial": partial, "window": target},
                       reason=error)
        self.state.save_library()
        self.state.ledger_changed.emit()
        self.run_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.bar.setVisible(False)
        self.worker = None
        text = f"คีย์แล้ว {len(keyed)} ใบ" + (f" · {error}" if error else "")
        self.status.setText(text)
        self.state.notify(text)
