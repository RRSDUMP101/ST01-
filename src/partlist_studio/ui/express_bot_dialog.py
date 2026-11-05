"""คีย์เข้า Express อัตโนมัติ - the dialog: which documents, the keys of each Express screen, a test run, the run."""

from __future__ import annotations

import json
import sys
import threading
from datetime import datetime

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtWidgets import (QCheckBox, QDialog, QFileDialog, QFormLayout, QHBoxLayout, QInputDialog, QLabel,
                               QLineEdit, QListWidget, QListWidgetItem, QMessageBox, QPlainTextEdit, QProgressBar,
                               QSpinBox, QSplitter, QTabWidget, QVBoxLayout, QWidget)

from ..core import express_bot as bot
from ..core import express_out
from .widgets import button, fit_to_screen

SETTINGS_KEY = "express/bot"
HELP = ("<b>[ช่อง]</b> ค่าของเอกสาร: " + ", ".join(f"[{k}]" for k in bot.DOC_FIELDS)
        + " · ของบรรทัด: " + ", ".join(f"[{k}]" for k in bot.LINE_FIELDS)
        + "<br><b>{ปุ่ม}</b> {ENTER} {TAB} {ESC} {DOWN} {F4} {F8} {F10} {CTRL+S} {TAB 3} (กด 3 ครั้ง) · "
          "<b>{WAIT 500}</b> รอ 0.5 วินาที · <b>{STOP}</b> หยุดให้คนตรวจและกดบันทึกเอง")


def load_options(settings, warehouse: str = "01", department: str = "") -> bot.BotOptions:
    opts = bot.BotOptions(warehouse=warehouse or "01", department=department)
    try:
        data = json.loads(settings.get(SETTINGS_KEY, "") or "{}")
    except ValueError:
        data = {}
    opts.window = data.get("window", opts.window) or "Express"
    opts.delay_ms = int(data.get("delay_ms", opts.delay_ms))
    opts.paste_thai = bool(data.get("paste_thai", opts.paste_thai))
    for t, parts in (data.get("templates") or {}).items():
        if t in opts.templates and isinstance(parts, dict):
            opts.templates[t].update({k: v for k, v in parts.items() if k in (bot.HEAD, bot.LINE, bot.END)})
    return opts


def save_options(settings, opts: bot.BotOptions) -> None:
    settings.set(SETTINGS_KEY, json.dumps({"window": opts.window, "delay_ms": opts.delay_ms,
                                           "paste_thai": opts.paste_thai, "templates": opts.templates},
                                          ensure_ascii=False))


class _Worker(QObject):
    progress = Signal(int, int, str)
    stop_reached = Signal(str)
    finished = Signal(list, str)

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

    def run(self) -> None:
        keyed, error = [], ""
        try:
            keyed = bot.run(self.actions, self.options, self.out, lambda d, t, label: self.progress.emit(d, t, label),
                            self._wait_stop, lambda: self.cancel)
        except bot.Stopped as e:
            error = str(e)
        except Exception as e:  # noqa: BLE001 - shown in the dialog
            error = f"{type(e).__name__}: {e}"
        self.finished.emit(keyed, error)


class ExpressBotDialog(QDialog):
    def __init__(self, state, docs, parent=None, output_factory=None):
        super().__init__(parent)
        self.setWindowTitle("คีย์เข้า Express อัตโนมัติ")
        fit_to_screen(self, 1180, 820)
        self.state = state
        self.docs = docs
        s = state.settings
        self.options = load_options(s, s.get("express/warehouse", "01"), s.get("express/department", ""))
        self.output_factory = output_factory or self._windows_output
        self.worker = None
        lay = QVBoxLayout(self)
        intro = QLabel("โปรแกรมพิมพ์เอกสารเข้าหน้าจอ Express ให้เหมือนคนคีย์ (ไม่ใช้ API ไม่เขียนไฟล์ข้อมูลของ Express) – "
                       "Express ตรวจทุกช่อง ออกเลขที่ คิดต้นทุน และลงบัญชีเหมือนคีย์เอง · <b>เปิดหน้าจอเอกสารชนิดนั้นใน "
                       "Express ไว้ก่อน</b> · ทุกใบหยุดก่อนบันทึก ({STOP}) ให้ตรวจแล้วกดบันทึกเอง แล้วกรอกเลขที่ Express · "
                       "หยุดทันที: เลื่อนเมาส์ไปมุมซ้ายบนสุดของจอ หรือสลับไปหน้าต่างอื่น")
        intro.setWordWrap(True)
        lay.addWidget(intro)
        split = QSplitter(Qt.Horizontal)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(QLabel("<b>เอกสารที่จะคีย์</b> (เรียงตามวันที่)"))
        self.doc_list = QListWidget()
        for d in docs:
            keyed = f" · คีย์แล้ว {d.keyed_at[:16].replace('T', ' ')} รอเลขที่" if d.keyed_at else ""
            it = QListWidgetItem(f"{d.doc_no} · {d.doc_type} · {express_out.thai_date(d.date)} · {len(d.lines)} รายการ"
                                 f"{keyed}\n{express_out.screen_note(d)[:70]}")
            it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
            it.setCheckState(Qt.Unchecked if d.keyed_at else Qt.Checked)
            it.setData(Qt.UserRole, d.doc_no)
            self.doc_list.addItem(it)
        self.doc_list.itemChanged.connect(lambda *_: self._preview())
        self.doc_list.currentRowChanged.connect(self._doc_changed)
        ll.addWidget(self.doc_list, 1)
        form = QFormLayout()
        self.window_edit = QLineEdit(self.options.window)
        self.window_edit.setToolTip("ส่วนหนึ่งของชื่อหน้าต่าง Express (แถบบนสุด) – ทดลองก่อนได้: เปิด Notepad แล้วใส่ Notepad")
        form.addRow("พิมพ์ลงหน้าต่างที่ชื่อมี", self.window_edit)
        self.delay = QSpinBox()
        self.delay.setRange(0, 2000)
        self.delay.setSuffix(" มิลลิวินาที")
        self.delay.setValue(self.options.delay_ms)
        form.addRow("เว้นระหว่างปุ่ม", self.delay)
        self.paste = QCheckBox("พิมพ์ภาษาไทยด้วยการวาง (Ctrl+V)")
        self.paste.setToolTip("ใช้เมื่อพิมพ์ไทยลง Express แล้วเป็นตัวอ่านไม่ออก")
        self.paste.setChecked(self.options.paste_thai)
        form.addRow("", self.paste)
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
            self.tpl_edits[t] = edits
            self.tpl_tabs.addTab(w, t)
        rl.addWidget(self.tpl_tabs)
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
        row = QHBoxLayout()
        self.ahk_btn = button("ส่งออก AutoHotkey…", tooltip="สคริปต์ AutoHotkey v2 ของการกดเดียวกัน (ดู/รันเองได้)")
        self.ahk_btn.clicked.connect(self.export_ahk)
        row.addWidget(self.ahk_btn)
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
        if self.doc_list.count():
            self.doc_list.setCurrentRow(0)
        self._preview()

    # ---- options ------------------------------------------------------------------------------------
    def _read_options(self) -> bot.BotOptions:
        o = self.options
        o.window = self.window_edit.text().strip() or "Express"
        o.delay_ms = self.delay.value()
        o.paste_thai = self.paste.isChecked()
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
        errors = [e for t in sorted({d.doc_type for d in docs}) for e in bot.check_template(t, opts.templates[t])]
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
        text = []
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
        return bot.WindowsKeyboard()

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
        types = sorted({d.doc_type for d in docs})
        if len(types) > 1:
            self.status.setText("หลายชนิดเอกสาร: โปรแกรมหยุดทุกใบ – ระหว่างนั้นเปิดหน้าจอของใบถัดไปใน Express ได้")
        save_options(self.state.settings, self.options)
        self._by_no = {d.doc_no: d for d in docs}
        self.worker = _Worker(actions, self.options, out)
        self.worker.progress.connect(self._progress)
        self.worker.stop_reached.connect(self._stop_reached)
        self.worker.finished.connect(self._finished)
        self.bar.setVisible(True)
        self.bar.setRange(0, sum(len(a) for a in actions))
        self.run_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        threading.Thread(target=self.worker.run, daemon=True, name="express-bot").start()

    def stop(self) -> None:
        if self.worker is not None:
            self.worker.cancel = True
            self.worker.answer(False)

    def _progress(self, done: int, total: int, label: str) -> None:
        self.bar.setValue(done)
        self.status.setText(f"กำลังคีย์… {label}")

    def _stop_reached(self, doc_no: str) -> None:
        doc = self._by_no.get(doc_no)
        label = f"{doc_no} ({doc.doc_type} {doc.type_name})" if doc is not None else doc_no
        if doc is not None:
            doc.keyed_at = datetime.now().isoformat(timespec="seconds")
        no, ok = QInputDialog.getText(
            self, "ตรวจและบันทึกใน Express",
            f"{label}: คีย์ครบแล้ว – ตรวจในหน้าจอ Express แล้วกดบันทึก\n"
            "ใส่เลขที่ที่ Express ออกให้ (เว้นว่างได้) แล้วกด OK เพื่อคีย์ใบถัดไป · Cancel = หยุด")
        if ok and no.strip() and doc is not None:
            express_out.apply_express_numbers(self.state.ledger, {doc.doc_no: no.strip()})
        self.state.save_library()
        self.worker.answer(ok)

    def _finished(self, keyed: list, error: str) -> None:
        for no in keyed:
            doc = self._by_no.get(no)
            if doc is not None and not doc.keyed_at:
                doc.keyed_at = datetime.now().isoformat(timespec="seconds")
        self.state.save_library()
        self.state.ledger_changed.emit()
        self.run_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.bar.setVisible(False)
        self.worker = None
        text = f"คีย์แล้ว {len(keyed)} ใบ" + (f" · {error}" if error else "")
        self.status.setText(text)
        self.state.notify(text)
