"""การ์ดรายละเอียดชิ้นส่วน: แตะชิ้นในภาพ 3 มิติ → หัวข้อ · รูป (โมเดล 3 มิติหมุนได้ / รูปจริง) · สเปก · ปุ่มดำเนินการ · ปิด."""

from __future__ import annotations

import base64
from dataclasses import replace

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QPoint, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QButtonGroup,
    QCheckBox,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QScrollArea,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from ..core import assembly3d as a3
from . import theme
from .assembly_view import Assembly3DView
from .widgets import FlowLayout, button

PHOTO_SIDE = 900  # px: the longer side of a photo kept in the model
MEDIA_HEIGHT = 190
STYLE = f"""
#PartPopup {{ background: {theme.CARD}; border: 1px solid #8FA3BD; border-radius: 12px; }}
#PopupTitle {{ font-size: 15px; font-weight: 700; color: {theme.NAVY_DEEP}; }}
#PopupSub {{ color: {theme.MUTED}; }}
#PopupKey {{ color: {theme.MUTED}; }}
#PopupMedia {{ background: #EEF2F7; border: 1px solid {theme.BORDER}; border-radius: 8px; }}
#PopupWarn {{ color: #B4411B; font-weight: 600; }}
QPushButton#PopupClose {{ border: none; font-size: 18px; color: {theme.MUTED}; padding: 0; }}
QPushButton#PopupClose:hover {{ color: {theme.NAVY_DEEP}; background: #E6EBF2; border-radius: 16px; }}
QPushButton#PopupTab {{ padding: 3px 12px; border-radius: 6px; }}
QPushButton#PopupTab:checked {{ background: {theme.NAVY}; color: white; border-color: {theme.NAVY}; }}
"""


def encode_photo(path: str) -> str:
    """A picture file → JPEG no bigger than PHOTO_SIDE, as base64 text for the model file. '' when it cannot be read."""
    image = QImage(path)
    if image.isNull():
        return ""
    if max(image.width(), image.height()) > PHOTO_SIDE:
        image = image.scaled(PHOTO_SIDE, PHOTO_SIDE, Qt.KeepAspectRatio, Qt.SmoothTransformation)
    data = QByteArray()
    buffer = QBuffer(data)
    buffer.open(QIODevice.WriteOnly)
    image.convertToFormat(QImage.Format_RGB888).save(buffer, "JPG", 82)
    return base64.b64encode(bytes(data)).decode("ascii")


def decode_photo(text: str) -> QPixmap:
    pixmap = QPixmap()
    if text:
        try:
            pixmap.loadFromData(base64.b64decode(text))
        except ValueError:  # not base64: a model file edited by hand
            return QPixmap()
    return pixmap


class PartPopup(QFrame):
    """A card over the 3D picture for the part that was tapped. It changes nothing by itself: the page listens."""

    saved = Signal(str, str, str, bool)  # part id, Part No., note, also for every part of the same name
    go_step = Signal(int)
    zoom = Signal(str)  # part id
    attach_photo = Signal(str)  # part id
    remove_photo = Signal(str)
    closed = Signal()

    WIDTH = 380
    MAX_HEIGHT = 660

    def __init__(self, parent: QWidget):
        super().__init__(parent)
        self.setObjectName("PartPopup")
        self.setStyleSheet(STYLE)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.part_id = ""
        self._step = 0
        self._at = QPoint(0, 0)
        self._opened = ("", "")  # Part No. and note as the card got them: only what was changed is saved
        # The card may lie over the point that was tapped. For the length of a double click it lets the mouse
        # through, so that the second click still reaches the picture (double click = zoom to the part).
        self._solid = QTimer(self)
        self._solid.setSingleShot(True)
        self._solid.timeout.connect(lambda: self.setAttribute(Qt.WA_TransparentForMouseEvents, False))
        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 10, 14, 12)
        lay.setSpacing(8)

        # ---- title + close
        head = QHBoxLayout()
        titles = QVBoxLayout()
        titles.setSpacing(0)
        self.title = QLabel()
        self.title.setObjectName("PopupTitle")
        self.title.setWordWrap(True)
        self.subtitle = QLabel()
        self.subtitle.setObjectName("PopupSub")
        self.subtitle.setWordWrap(True)
        titles.addWidget(self.title)
        titles.addWidget(self.subtitle)
        head.addLayout(titles, 1)
        self.close_btn = QPushButton("✕")
        self.close_btn.setObjectName("PopupClose")
        self.close_btn.setFixedSize(QSize(32, 32))  # big enough for a finger
        self.close_btn.setToolTip("ปิด (Esc)")
        self.close_btn.clicked.connect(self.dismiss)
        head.addWidget(self.close_btn, 0, Qt.AlignTop)
        lay.addLayout(head)

        # ---- media: the part alone in 3D (turns and zooms) / a photo of the real part
        tabs = QHBoxLayout()
        tabs.setSpacing(6)
        self.media_tabs = QButtonGroup(self)
        self.tab_3d = self._tab("โมเดล 3 มิติ", 0)
        self.tab_photo = self._tab("รูปจริง", 1)
        tabs.addWidget(self.tab_3d)
        tabs.addWidget(self.tab_photo)
        tabs.addStretch(1)
        lay.addLayout(tabs)
        self.media = QStackedWidget()
        self.media.setObjectName("PopupMedia")
        self.media.setFixedHeight(MEDIA_HEIGHT)
        self.mini = Assembly3DView()
        self.mini.setMinimumSize(QSize(120, 100))
        self.mini.show_labels = False
        self.mini.setToolTip("ลาก = หมุน · ล้อเมาส์ = ซูม · ดับเบิลคลิก = พอดีกรอบ")
        self.photo = QLabel()
        self.photo.setAlignment(Qt.AlignCenter)
        self.photo.setWordWrap(True)
        self.media.addWidget(self.mini)
        self.media.addWidget(self.photo)
        lay.addWidget(self.media)

        # ---- content: what to do with it, and its data
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.body = QWidget()
        body = QVBoxLayout(self.body)
        body.setContentsMargins(0, 0, 4, 0)
        body.setSpacing(6)
        self.description = QLabel()
        self.description.setWordWrap(True)
        body.addWidget(self.description)
        self.form = QFormLayout()
        self.form.setContentsMargins(0, 0, 0, 0)
        self.form.setVerticalSpacing(3)
        self.form.setLabelAlignment(Qt.AlignLeft | Qt.AlignTop)
        body.addLayout(self.form)
        edit = QFormLayout()
        edit.setContentsMargins(0, 4, 0, 0)
        self.part_no = QLineEdit()
        self.part_no.setPlaceholderText("เช่น RRS-T-027-L")
        self.note = QLineEdit()
        self.note.setPlaceholderText("สิ่งที่ช่างต้องรู้เกี่ยวกับชิ้นนี้")
        edit.addRow(self._key("Part No."), self.part_no)
        edit.addRow(self._key("หมายเหตุ"), self.note)
        body.addLayout(edit)
        self.all_same = QCheckBox()
        self.all_same.setChecked(True)
        body.addWidget(self.all_same)
        body.addStretch(1)
        self.scroll.setWidget(self.body)
        lay.addWidget(self.scroll, 1)

        # ---- actions
        row_box = QWidget()
        row = FlowLayout(row_box, h_spacing=6)
        self.save_btn = button("บันทึก", "primary", "บันทึก Part No. และหมายเหตุของชิ้นนี้")
        self.save_btn.clicked.connect(self._save)
        self.step_btn = button("ไปขั้นประกอบ", tooltip="แสดงขั้นที่ประกอบชิ้นนี้ พร้อมสาธิต")
        self.step_btn.clicked.connect(lambda: self.go_step.emit(self._step))
        self.zoom_btn = button("ซูมที่ชิ้น", tooltip="ซูมภาพใหญ่เข้าที่ชิ้นนี้")
        self.zoom_btn.clicked.connect(lambda: self.zoom.emit(self.part_id))
        self.photo_btn = button("แนบรูปจริง…", tooltip="รูปถ่ายชิ้นส่วน / วัสดุจริง – เก็บไว้ในไฟล์คู่มือประกอบ (.rrsasm)")
        self.photo_btn.clicked.connect(lambda: self.attach_photo.emit(self.part_id))
        self.remove_btn = button("ลบรูป", tooltip="เอารูปจริงของชิ้นนี้ออก")
        self.remove_btn.clicked.connect(lambda: self.remove_photo.emit(self.part_id))
        self.cancel_btn = button("ยกเลิก", tooltip="ปิดโดยไม่บันทึก")
        self.cancel_btn.clicked.connect(self.dismiss)
        for b in (self.save_btn, self.step_btn, self.zoom_btn, self.photo_btn, self.remove_btn, self.cancel_btn):
            row.addWidget(b)
        lay.addWidget(row_box)
        self.hide()

    # ---- parts of the card ----------------------------------------------------
    def _tab(self, text: str, index: int) -> QPushButton:
        b = QPushButton(text)
        b.setObjectName("PopupTab")
        b.setCheckable(True)
        b.clicked.connect(lambda: self.media.setCurrentIndex(index))
        self.media_tabs.addButton(b, index)
        return b

    @staticmethod
    def _key(text: str) -> QLabel:
        label = QLabel(text)
        label.setObjectName("PopupKey")
        return label

    # ---- show -------------------------------------------------------------------
    def show_part(self, model: a3.AssemblyModel, part: a3.Part3D, job=None, at: QPoint | None = None,
                  media: int | None = None, keep_edits: bool = False) -> None:
        """Fill the card for `part` and put it beside the point `at` of the picture (kept inside the picture).
        With `keep_edits` (the same part shown again, e.g. after its photo changed) what was typed stays."""
        typed = (self.part_no.text(), self.note.text(), self.all_same.isChecked()) if keep_edits else None
        info = a3.part_details(model, part, job)
        self.part_id, self._step = part.id, info["step"]
        self.title.setText(info["title"])
        self.subtitle.setText(info["subtitle"])
        self.description.setText(info["description"])
        self.description.setVisible(bool(info["description"]))
        while self.form.rowCount():
            self.form.removeRow(0)
        for key, value in info["rows"]:
            text = QLabel(value)
            text.setWordWrap(True)
            text.setTextInteractionFlags(Qt.TextSelectableByMouse)
            if key == "คำเตือน":
                text.setObjectName("PopupWarn")
            self.form.addRow(self._key(key), text)
        self._opened = (part.part_no, part.note)
        self.part_no.setText(part.part_no)
        self.note.setText(part.note)
        self.all_same.setText(f"ใช้ที่แก้กับชิ้นชื่อเดียวกันทั้ง {info['count']} ชิ้น")
        self.all_same.setToolTip("ช่องที่แก้ในการ์ดนี้ถูกบันทึกให้ทุกชิ้นที่ชื่อและขนาดเดียวกัน – ช่องที่ไม่ได้แก้ของชิ้นอื่นคงเดิม")
        self.all_same.setVisible(info["count"] > 1)
        self.all_same.setChecked(True)
        if typed:
            self.part_no.setText(typed[0])
            self.note.setText(typed[1])
            self.all_same.setChecked(typed[2])
        self.step_btn.setText(f"ไปขั้นที่ {self._step}" if self._step else "ไปขั้นประกอบ")
        self.step_btn.setEnabled(bool(self._step))

        alone = replace(part, explode=[0.0, 0.0, 0.0], step=0)
        self.mini.set_model(a3.AssemblyModel(part.name, [alone], source="file"))
        self.mini.set_step(None, animate=False)
        pixmap = decode_photo(info["photo"])
        if pixmap.isNull():
            self.photo.setPixmap(QPixmap())
            self.photo.setText("ยังไม่มีรูปจริงของชิ้นนี้\nกด “แนบรูปจริง…” เพื่อใส่รูปถ่ายชิ้นส่วนหรือวัสดุ")
        else:
            self.photo.setText("")
            self.photo.setPixmap(pixmap.scaled(self.WIDTH - 40, MEDIA_HEIGHT - 8, Qt.KeepAspectRatio, Qt.SmoothTransformation))
        self.remove_btn.setVisible(not pixmap.isNull())
        self.photo_btn.setText("เปลี่ยนรูปจริง…" if not pixmap.isNull() else "แนบรูปจริง…")
        index = media if media is not None else (1 if not pixmap.isNull() else 0)  # a real photo first when there is one
        self.media.setCurrentIndex(index)
        self.media_tabs.button(index).setChecked(True)
        if at is not None:
            self._at = QPoint(at)
        self.place()
        if self.isHidden():  # newly opened by a tap: see _solid
            self.setAttribute(Qt.WA_TransparentForMouseEvents, True)
            self._solid.start(QApplication.doubleClickInterval())
        self.show()
        self.raise_()
        self.setFocus(Qt.OtherFocusReason)  # Esc closes the card; other keys still go on to the picture
        self.mini.fit(None, 0.78)

    def place(self) -> None:
        """Beside the tapped point, on the side that has room, inside the part of the picture that is on the screen
        (the page may be scrolled). Where there is no room beside the point, at the edge farther from it."""
        view = self.parentWidget()
        box = view.visibleRegion().boundingRect()
        if box.width() < 200 or box.height() < 200:  # not shown yet
            box = view.rect()
        width = min(self.WIDTH, box.width() - 16)
        self.setFixedWidth(width)
        self.body.adjustSize()
        fixed = sum(w.sizeHint().height() for w in (self.title, self.subtitle, self.tab_3d)) + MEDIA_HEIGHT + 150
        height = max(260, min(fixed + self.body.sizeHint().height(), box.height() - 16, self.MAX_HEIGHT))
        self.resize(width, height)
        x = self._at.x() + 22
        if x + width > box.right() - 8:
            x = self._at.x() - 22 - width
        if x < box.left() + 8:
            x = box.left() + 8 if self._at.x() > box.center().x() else box.right() - width - 8
        y = min(max(box.top() + 8, self._at.y() - 70), max(box.top() + 8, box.bottom() - height - 8))
        self.move(x, y)

    def has_photo(self) -> bool:
        return self.remove_btn.isVisibleTo(self)

    # ---- actions ------------------------------------------------------------------
    def changed(self) -> tuple[bool, bool]:
        """Was the Part No. / the note changed in the card?"""
        return self.part_no.text().strip() != self._opened[0].strip(), self.note.text().strip() != self._opened[1].strip()

    def _save(self) -> None:
        self.saved.emit(self.part_id, self.part_no.text().strip(), self.note.text().strip(),
                        self.all_same.isVisibleTo(self) and self.all_same.isChecked())
        self.put_away()

    def put_away(self) -> None:
        """Hide the card; the keys go to the picture again."""
        had_focus = self.hasFocus() or self.isAncestorOf(QApplication.focusWidget() or self.parentWidget())
        self._solid.stop()
        self.setAttribute(Qt.WA_TransparentForMouseEvents, False)
        self.hide()
        if had_focus:
            self.parentWidget().setFocus(Qt.OtherFocusReason)

    def dismiss(self) -> None:
        if not self.isHidden():
            self.put_away()
            self.closed.emit()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key_Escape:
            self.dismiss()
        else:
            super().keyPressEvent(event)

    # a tap on the card is not a tap on the picture under it
    def mousePressEvent(self, event) -> None:  # noqa: N802
        event.accept()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        event.accept()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        event.accept()

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        event.accept()

    def wheelEvent(self, event) -> None:  # noqa: N802
        event.accept()
