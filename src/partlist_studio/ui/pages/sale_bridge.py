"""Local SO handoff queue; network transfer runs in the separate bridge worker."""

from __future__ import annotations

from datetime import datetime

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QDoubleSpinBox, QFormLayout, QLabel, QLineEdit, QListWidget,
                               QListWidgetItem, QPlainTextEdit, QScrollArea, QSplitter, QVBoxLayout, QWidget)

from ...core.sale_bridge import bind_partlist, job_work_blockers
from ..widgets import PageHeader, button, fill, table


def text_label(text=""):
    label = QLabel(text)
    label.setTextFormat(Qt.PlainText)
    label.setWordWrap(True)
    return label


class SaleBridgePage(QWidget):
    def __init__(self, state, actions, parent=None):
        super().__init__(parent)
        self.state, self.actions = state, actions
        self._form_key = None
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        pane = QWidget()
        scroll.setWidget(pane)
        outer.addWidget(scroll)
        layout = QVBoxLayout(pane)
        layout.setContentsMargins(28, 24, 28, 16)
        layout.setSpacing(12)
        header = PageHeader("Sale Office → งานผลิต", "รับ SO ครั้งเดียว · ผูก Part List และส่งสถานะกลับ · ตรวจร่างก่อนปล่อยผลิต")
        refresh = header.add_action(button("อ่านคิวล่าสุด"))
        refresh.clicked.connect(state.refresh_bridge_jobs)
        retry = header.add_action(button("ลองส่งรายการที่ล้มเหลวใหม่"))
        retry.clicked.connect(self._retry_failed)
        open_production = header.add_action(button("เปิดงานผลิต"))
        open_production.clicked.connect(lambda: actions.go("production"))
        layout.addWidget(header)
        self.connection = text_label()
        self.connection.setObjectName("Hint")
        layout.addWidget(self.connection)
        self.queue = text_label()
        layout.addWidget(self.queue)
        split = QSplitter(Qt.Horizontal)
        self.jobs = QListWidget()
        self.jobs.setObjectName("Plain")
        self.jobs.setWordWrap(True)
        self.jobs.currentItemChanged.connect(self._show_job)
        split.addWidget(self.jobs)
        right = QWidget()
        body = QVBoxLayout(right)
        self.source = text_label("ยังไม่มี SO ในคิว ตัวเชื่อมต้องรับข้อมูลจาก Sale Office ก่อน")
        body.addWidget(self.source)
        self.source_items = table(["รายการจาก SO", "จำนวน", "หน่วย", "รหัสสินค้า"], [370, 80, 80, 140])
        self.source_items.setMaximumHeight(160)
        body.addWidget(self.source_items)
        self.gates = text_label()
        body.addWidget(self.gates)
        self.partlist_label = text_label()
        body.addWidget(self.partlist_label)
        form = QFormLayout()
        self.sets = QDoubleSpinBox()
        self.sets.setRange(0, 99999)
        self.sets.setDecimals(0)
        self.sets.setSpecialValueText("ระบุจำนวนชุด")
        self.bom_revision = QLineEdit()
        self.drawing_revision = QLineEdit()
        self.reviewer = QLineEdit()
        self.evidence = QPlainTextEdit()
        self.evidence.setMaximumHeight(88)
        self.evidence.setPlaceholderText("อ้างอิงเอกสาร/หลักฐานที่ตรวจแล้ว ห้ามใช้ชื่อไฟล์แทนการตรวจแบบ")
        form.addRow("จำนวนชุดที่ใช้ BOM นี้", self.sets)
        form.addRow("BOM Revision", self.bom_revision)
        form.addRow("Drawing Revision", self.drawing_revision)
        form.addRow("ผู้เตรียมข้อมูล", self.reviewer)
        form.addRow("หลักฐานประกอบ", self.evidence)
        body.addLayout(form)
        self.submit = button("ผูก Part List และส่งตรวจ", "primary")
        self.submit.setMinimumHeight(44)
        self.submit.clicked.connect(self._bind)
        body.addWidget(self.submit)
        body.addWidget(text_label("การผูกแบบเป็นข้อมูลรอตรวจ ผู้มีสิทธิ์ใน Sale Office ต้องอนุมัติ Revision "
                                  "และตรวจเงื่อนไขเงิน วัตถุดิบ ผู้รับผิดชอบ และกำหนดงานก่อนเริ่มผลิต"))
        body.addStretch(1)
        split.addWidget(right)
        split.setSizes([300, 900])
        layout.addWidget(split, 1)
        self.errors = table(["เวลา", "ประเภท", "สิ่งที่ต้องแก้ไข"], [150, 160, 600])
        self.errors.setMaximumHeight(145)
        layout.addWidget(self.errors)
        state.bridge_changed.connect(self.refresh)
        state.partlist_changed.connect(self._show_job)
        self.refresh()

    def _retry_failed(self):
        try:
            count = self.state.bridge_store.retry_failed()
        except Exception:
            self.actions.error("ยังลองใหม่ไม่ได้", "ตรวจสิทธิ์ไฟล์คิวแล้วอ่านคิวล่าสุดอีกครั้ง")
            return
        self.state.refresh_bridge_jobs()
        self.state.notify(f"เข้าคิวลองใหม่ {count} รายการ · รายการขัดแย้งต้องแก้ที่ต้นทางก่อน")

    def _job(self):
        selected = self.jobs.currentItem()
        key = selected.data(Qt.UserRole) if selected else None
        return next((j for j in self.state.jobs if j.bridge and j.bridge.get("key") == key), None)

    def refresh(self):
        selected = self.jobs.currentItem()
        key = selected.data(Qt.UserRole) if selected else None
        try:
            summary = self.state.bridge_store.sync_summary()
            issues = self.state.bridge_store.issues()
        except Exception:
            self.connection.setText("อ่านสถานะตัวเชื่อมไม่ได้ กรุณาตรวจสิทธิ์ไฟล์และเปิดโปรแกรมใหม่")
            return
        last = summary.get("lastSuccess") or "ยังไม่มีผลซิงก์สำเร็จ"
        configured = "ตั้งค่าตัวเชื่อมแล้ว" if summary.get("configured") else "ยังไม่พบการตั้งค่าตัวเชื่อม"
        self.connection.setText(f"{configured} · ซิงก์สำเร็จล่าสุด: {last}"
                                + (" · " + str(summary["lastError"]) if summary.get("lastError") else ""))
        self.queue.setText(f"รอส่ง {summary.get('pending', 0)} · ส่งไม่สำเร็จ {summary.get('dead', 0)}"
                           f" · ข้อมูลขัดแย้ง {summary.get('conflict', 0)} · หน้านี้อ่านคิวในเครื่อง")
        fill(self.errors, [[datetime.fromtimestamp(i["createdAt"]).astimezone().strftime("%d/%m/%Y %H:%M")
                            if isinstance(i.get("createdAt"), (int, float)) else i.get("createdAt", ""),
                            i.get("code", ""), i.get("detail", "")] for i in issues])
        self.jobs.blockSignals(True)
        self.jobs.clear()
        for job in (j for j in self.state.jobs if j.bridge):
            workspace = "ในประเทศ" if job.bridge.get("workspace") == "domestic" else "ส่งออก"
            order_number = job.bridge.get("payload", {}).get("orderNumber", job.job_no)
            row = QListWidgetItem(f"{order_number}\n{workspace} · {job.customer}\n{job.status}")
            row.setToolTip(f"รหัสงานผลิต {job.job_no}")
            row.setData(Qt.UserRole, job.bridge["key"])
            self.jobs.addItem(row)
            if job.bridge["key"] == key:
                self.jobs.setCurrentItem(row)
        if self.jobs.currentRow() < 0 and self.jobs.count():
            self.jobs.setCurrentRow(0)
        self.jobs.blockSignals(False)
        self._show_job()

    def _show_job(self, *_args):
        job = self._job()
        self.submit.setEnabled(bool(job and self.state.partlist.parts))
        info = self.state.partlist.info
        self.partlist_label.setText(f"Part List ที่เปิดอยู่: {info.drawing_no or 'ยังไม่ระบุเลขแบบ'}"
                                    f" · {len(self.state.partlist.parts)} รายการ · Revision {info.revision or 'ยังไม่ระบุ'}")
        if job is None:
            self.source.setText("ยังไม่มี SO ในคิว ตัวเชื่อมต้องรับข้อมูลจาก Sale Office ก่อน")
            self.gates.clear()
            self.source_items.setRowCount(0)
            return
        payload = job.bridge.get("payload", {})
        self.source.setText(f"SO {payload.get('orderNumber', job.job_no)} · ลูกค้า {payload.get('customerName', '')}"
                            f"\nรถ {payload.get('vehicle', '') or 'ยังไม่ระบุ'} · ผู้รับผิดชอบ {payload.get('owner') or 'ยังไม่กำหนด'}"
                            f" · กำหนด {payload.get('due') or 'ยังไม่กำหนด'}"
                            f"\nSO ID {job.bridge.get('orderId', '')} · ฉบับข้อมูล {job.bridge.get('commandVersion', '')}")
        fill(self.source_items, [[i.get("description", ""), i.get("qty", ""), i.get("unit", ""),
                                  i.get("productId", "")] for i in payload.get("items", [])])
        blockers = job_work_blockers(job)
        self.gates.setText("รอ: " + " · ".join(blockers) if blockers else "ผ่านเงื่อนไขเริ่มผลิตตามข้อมูลล่าสุด")
        if self._form_key != job.bridge["key"]:
            self._form_key = job.bridge["key"]
            self.sets.setValue(job.sets if job.parts else 0)
            self.bom_revision.setText(job.bridge.get("bomRevision") or "")
            self.drawing_revision.setText(job.bridge.get("drawingRevision") or "")
            self.reviewer.setText(job.bridge.get("revisionReviewer") or "")
            self.evidence.setPlainText(job.bridge.get("revisionEvidence") or "")

    def _bind(self):
        job = self._job()
        if job is None:
            return
        try:
            mapped = bind_partlist(job, self.state.partlist, self.sets.value(), self.bom_revision.text().strip(),
                                   self.drawing_revision.text().strip(), self.reviewer.text().strip(),
                                   self.evidence.toPlainText().strip())
            self.state.bridge_store.save_job(mapped)
        except ValueError as exc:
            self.actions.error("ยังผูก Part List ไม่ได้", str(exc))
            return
        except Exception:
            self.actions.error("บันทึกไม่สำเร็จ", "ข้อมูลอาจเปลี่ยนจาก Sale Office แล้ว อ่านคิวล่าสุดและตรวจข้อมูลอีกครั้ง")
            self.state.refresh_bridge_jobs()
            return
        self.state.refresh_bridge_jobs()
        self.state.notify("ผูก Part List แล้ว · เข้าคิวส่งกลับ Sale Office เพื่อให้ผู้มีสิทธิ์ตรวจ")
