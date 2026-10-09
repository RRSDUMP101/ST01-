"""Colours, fonts and the Qt style sheet of the app."""

from __future__ import annotations

import platform

from PySide6.QtGui import QColor, QFont, QFontDatabase

NAVY = "#1F4E79"
NAVY_DARK = "#16324F"
NAVY_DEEP = "#0F2238"
ACCENT = "#F28C28"
BG = "#F4F6FA"
CARD = "#FFFFFF"
BORDER = "#DDE3EC"
TEXT = "#1E2A3A"
MUTED = "#6B7A90"

STATUS_COLORS = {
    "พร้อม": "#2E9D5B",
    "พอ": "#2E9D5B",
    "รอตรวจ": "#8A96A8",
    "ขาด": "#D64545",
    "รอสั่งซื้อ": "#E08A1E",
    "ต่ำกว่า Min": "#E08A1E",
    "ไม่พบในสต็อก": "#7B5BD6",
}

ERROR_BG = QColor("#FDECEC")
WARN_BG = QColor("#FFF6E5")


def status_color(status: str) -> QColor:
    return QColor(STATUS_COLORS.get(status, MUTED))


def app_font() -> QFont:
    """A font that renders Thai well on each OS."""
    preferred = {
        "Windows": ["Leelawadee UI", "Tahoma", "Segoe UI"],
        "Darwin": ["Thonburi", "Sukhumvit Set", "Helvetica Neue"],
    }.get(platform.system(), ["Noto Sans Thai", "Noto Sans", "DejaVu Sans"])
    families = set(QFontDatabase.families())
    font = QFont()
    for family in preferred:
        if family in families:
            font = QFont(family)
            break
    font.setPointSize(10 if platform.system() == "Windows" else 12 if platform.system() == "Darwin" else 10)
    return font


STYLE_SHEET = f"""
QWidget {{ color: {TEXT}; }}
QMainWindow, QDialog, #Content {{ background: {BG}; }}

#Sidebar {{ background: {NAVY_DEEP}; }}
#Brand {{ color: white; font-size: 17px; font-weight: 700; padding: 18px 16px 2px 18px; }}
#BrandSub {{ color: #8FA7C4; font-size: 11px; padding: 0 16px 14px 18px; }}
#NavList {{ background: transparent; border: none; outline: none; color: #C9D6E6; }}
#NavList::item {{ padding: 11px 14px; margin: 2px 10px; border-radius: 8px; }}
#NavList::item:hover {{ background: {NAVY_DARK}; color: white; }}
#NavList::item:selected {{ background: {NAVY}; color: white; font-weight: 600; }}
#SidebarFoot {{ color: #6F87A5; font-size: 11px; padding: 12px 18px; }}

#PageTitle {{ font-size: 20px; font-weight: 700; color: {NAVY_DEEP}; }}
#PageSub {{ color: {MUTED}; }}

#Card {{ background: {CARD}; border: 1px solid {BORDER}; border-radius: 10px; }}
#CardTitle {{ font-weight: 700; color: {NAVY}; font-size: 13px; }}
#KpiValue {{ font-size: 24px; font-weight: 700; color: {NAVY_DEEP}; }}
#KpiLabel {{ color: {MUTED}; }}
#Hint {{ color: {MUTED}; }}
#StatusChip {{ border-radius: 9px; padding: 2px 10px; color: white; font-weight: 600; }}

QPushButton {{
    background: white; border: 1px solid {BORDER}; border-radius: 7px; padding: 7px 14px;
}}
QPushButton:hover {{ border-color: {NAVY}; color: {NAVY}; }}
QPushButton:pressed {{ background: #E9EEF6; }}
QPushButton:disabled {{ color: #A9B3C1; border-color: #E6EAF0; }}
QPushButton[kind="primary"] {{ background: {NAVY}; color: white; border: 1px solid {NAVY}; font-weight: 600; }}
QPushButton[kind="primary"]:hover {{ background: {NAVY_DARK}; color: white; }}
QPushButton[kind="accent"] {{ background: {ACCENT}; color: white; border: 1px solid {ACCENT}; font-weight: 600; }}
QPushButton[kind="accent"]:hover {{ background: #D9771A; color: white; }}
QToolButton {{ border: none; padding: 4px; }}

QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox, QPlainTextEdit {{
    background: white; border: 1px solid {BORDER}; border-radius: 6px; padding: 5px 8px;
}}
QComboBox::drop-down {{ border: none; width: 22px; }}
QAbstractSpinBox {{ padding-right: 8px; }}
QLineEdit:focus, QComboBox:focus, QSpinBox:focus, QPlainTextEdit:focus {{ border-color: {NAVY}; }}

QTableView, QTreeWidget, QListWidget#Plain {{
    background: white; border: 1px solid {BORDER}; border-radius: 8px;
    gridline-color: #EEF1F6; selection-background-color: #D6E4F5; selection-color: {TEXT};
    alternate-background-color: #F9FBFD;
}}
QHeaderView::section {{
    background: #EEF2F8; color: {NAVY_DEEP}; font-weight: 600; border: none;
    border-right: 1px solid {BORDER}; border-bottom: 1px solid {BORDER}; padding: 6px;
}}
QTabWidget::pane {{ border: 1px solid {BORDER}; border-radius: 8px; background: white; top: -1px; }}
QTabBar::tab {{ padding: 7px 16px; color: {MUTED}; border: none; }}
QTabBar::tab:selected {{ color: {NAVY}; border-bottom: 2px solid {NAVY}; font-weight: 600; }}
QStatusBar {{ background: white; border-top: 1px solid {BORDER}; color: {MUTED}; }}
QGroupBox {{ border: 1px solid {BORDER}; border-radius: 8px; margin-top: 14px; padding: 12px 10px 10px 10px;
             background: white; font-weight: 600; color: {NAVY}; }}
QGroupBox::title {{ subcontrol-origin: margin; left: 12px; padding: 0 4px; }}
QSplitter::handle {{ background: transparent; }}
"""
