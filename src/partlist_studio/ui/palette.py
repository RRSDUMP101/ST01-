"""ค้นหาคำสั่ง (Ctrl+K) - type a few letters to reach any page, tab or menu command, Enter runs it."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QDialog, QLabel, QLineEdit, QListWidget, QListWidgetItem, QVBoxLayout


@dataclass
class Command:
    title: str
    where: str  # หน้า / แท็บ / เมนู ไฟล์ › นำเข้า
    run: Callable[[], object] = field(repr=False)
    shortcut: str = ""
    detail: str = ""  # what it does (the tooltip of its button): searched, shown when pointed at

    @property
    def text(self) -> str:
        return f"{self.title}  {self.where}  {self.detail}".lower()


def rank(commands: list[Command], query: str) -> list[Command]:
    """The commands every word of the query is in, the ones whose title starts with it first."""
    words = query.lower().split()
    if not words:
        return list(commands)
    hits = [c for c in commands if all(w in c.text for w in words)]
    return sorted(hits, key=lambda c: (not c.title.lower().startswith(words[0]), words[0] not in c.title.lower(),
                                       len(c.title)))


class CommandPalette(QDialog):
    def __init__(self, commands: list[Command], parent=None):
        super().__init__(parent, Qt.FramelessWindowHint | Qt.Dialog)
        self.setObjectName("Palette")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.commands = commands
        self.chosen: Command | None = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 12, 12, 10)
        lay.setSpacing(8)
        self.input = QLineEdit()
        self.input.setObjectName("PaletteInput")
        self.input.setPlaceholderText("ค้นหาหน้า แท็บ หรือคำสั่ง… เช่น นำเข้า, Min, ใบเบิก, เลเซอร์, QR")
        self.input.setClearButtonEnabled(True)
        lay.addWidget(self.input)
        self.list = QListWidget()
        self.list.setObjectName("PaletteList")
        self.list.setUniformItemSizes(True)
        lay.addWidget(self.list, 1)
        self.hint = QLabel("↑ ↓ เลือก · Enter ทำ · Esc ปิด")
        self.hint.setObjectName("Hint")
        lay.addWidget(self.hint)
        self.input.textChanged.connect(self._filter)
        self.input.returnPressed.connect(self._run_current)
        self.list.itemActivated.connect(lambda _item: self._run_current())
        self.resize(680, 440)
        if parent is not None:
            top = parent.window()
            g = top.geometry()
            self.move(g.x() + (g.width() - self.width()) // 2, g.y() + 70)
        self._filter("")

    def _filter(self, text: str) -> None:
        self.list.clear()
        for cmd in rank(self.commands, text)[:80]:
            label = f"{cmd.title}    ·  {cmd.where}" + (f"    [{cmd.shortcut}]" if cmd.shortcut else "")
            item = QListWidgetItem(label)
            item.setData(Qt.UserRole, cmd)
            item.setToolTip(cmd.detail or cmd.where)
            self.list.addItem(item)
        if self.list.count():
            self.list.setCurrentRow(0)
        self.hint.setText(f"พบ {self.list.count()} คำสั่ง · ↑ ↓ เลือก · Enter ทำ · Esc ปิด" if text
                          else "↑ ↓ เลือก · Enter ทำ · Esc ปิด")

    def keyPressEvent(self, event):  # noqa: N802 - the arrows move in the list while typing
        if event.key() in (Qt.Key_Down, Qt.Key_Up, Qt.Key_PageDown, Qt.Key_PageUp):
            row = self.list.currentRow()
            step = {Qt.Key_Down: 1, Qt.Key_Up: -1, Qt.Key_PageDown: 8, Qt.Key_PageUp: -8}[event.key()]
            if self.list.count():
                self.list.setCurrentRow(max(0, min(self.list.count() - 1, row + step)))
            return
        super().keyPressEvent(event)

    def _run_current(self) -> None:
        item = self.list.currentItem()
        if item is None:
            return
        self.chosen = item.data(Qt.UserRole)
        self.accept()
