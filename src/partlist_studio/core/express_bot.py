"""คีย์เข้า Express อัตโนมัติ: the program types the documents into the Express screens itself, the way the store does
(no API, no writing into Express's data files - Express checks every field, gives the document number, costs the
stock and posts it as when a person keys it in). This is what the "RPA" tools for Express do.

A screen is described by a template, editable on the PC (Express page → คีย์เข้า Express อัตโนมัติ):

    {F4}{WAIT 1000}[แผนก]{ENTER}[หมายเหตุ]{ENTER}{F8}        head: once per document
    [รหัส]{ENTER}{WAIT 300}[คลัง]{ENTER}[จำนวน]{ENTER}{DOWN}  line: once per line
    {STOP}                                                    end: {STOP} = leave it for a person to check and save

    [field]   the value of the document / the line (Thai names below)
    {KEY}     a key: ENTER TAB ESC UP DOWN LEFT RIGHT HOME END DEL BACKSPACE PGUP PGDN F1 … F12, with CTRL+ / ALT+ /
              SHIFT+ (e.g. {CTRL+S}); {KEY n} = n times
    {WAIT ms} wait (Express opens a screen or fills the name of an item)
    {STOP}    stop here (the document stays open on the screen, not saved)
    text      typed as is

The templates shipped are a start from the screens of the company's Express: try them once on each screen (a test run
types into Notepad) and adjust the order of the keys. The same actions can be written as an AutoHotkey v2 script.
"""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass, field

from .express import thai_date
from .movements import StockDoc

HEAD, LINE, END = "head", "line", "end"
DOC_FIELDS = {"แผนก": "department", "หมายเหตุ": "remark", "วันที่": "date", "งาน": "job", "ผู้จำหน่าย": "vendor",
              "อ้างอิง": "ref", "เลขที่ในโปรแกรม": "doc_no"}
LINE_FIELDS = {"No.": "no", "รหัส": "code", "รายละเอียด": "name", "คลัง": "warehouse", "จำนวน": "qty", "หน่วย": "unit",
               "ราคาต่อหน่วย": "unit_cost", "หมายเหตุบรรทัด": "remark"}
KEYS = {"ENTER", "TAB", "ESC", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "DEL", "BACKSPACE", "PGUP", "PGDN",
        "INS", "SPACE"} | {f"F{i}" for i in range(1, 13)} | set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
MODIFIERS = ("CTRL", "ALT", "SHIFT")

# A start from the Express screens (PD / OU: สำหรับแผนก, หมายเหตุ, เลขที่เอกสาร, วันที่ then the grid of รายการสินค้า
# <F8>: รหัส, รายละเอียด (filled by Express), คลัง, จำนวน, หน่วย (filled), ราคาต่อหน่วย (Express costs the stock)).
_ISSUE = {HEAD: "{F4}{WAIT 1200}[แผนก]{ENTER}{WAIT 300}[หมายเหตุ]{ENTER}{ENTER}[วันที่]{ENTER}{F8}{WAIT 600}",
          LINE: "[รหัส]{ENTER}{WAIT 400}{ENTER}[คลัง]{ENTER}[จำนวน]{ENTER}{ENTER}{ENTER}{WAIT 200}",
          END: "{STOP}"}
DEFAULT_TEMPLATES: dict[str, dict[str, str]] = {
    "PD": dict(_ISSUE),
    "OU": dict(_ISSUE),
    "FR": dict(_ISSUE),
    "AJ": dict(_ISSUE),
    "RR": {HEAD: "{F4}{WAIT 1200}[ผู้จำหน่าย]{ENTER}{WAIT 500}[อ้างอิง]{ENTER}[แผนก]{ENTER}{ENTER}[วันที่]{ENTER}"
                 "{F8}{WAIT 600}",
           LINE: "[รหัส]{ENTER}{WAIT 400}{ENTER}[คลัง]{ENTER}[จำนวน]{ENTER}{ENTER}[ราคาต่อหน่วย]{ENTER}{ENTER}"
                 "{ENTER}{WAIT 200}",
           END: "{STOP}"},
}
SCREEN_HINTS = {"PD": "4.สินค้า → PD - จ่ายวัตถุดิบเพื่อผลิต", "OU": "4.สินค้า → OU - จ่ายสินค้าใช้ภายใน",
                "RR": "1.ซื้อ → RR - รับสินค้า", "FR": "4.สินค้า → FR - รับสินค้าสำเร็จรูปจากการผลิต",
                "AJ": "4.สินค้า → JU - ปรับปรุงเพิ่ม/ลดสินค้า (จำนวน = ส่วนต่าง +/−)"}
_TOKEN = re.compile(r"\{([^{}]+)\}|\[([^\[\]]+)\]|([^{\[]+)")


@dataclass
class Action:
    kind: str  # text | key | wait | stop | doc (a document starts)
    value: str = ""
    times: int = 1
    label: str = ""  # what it is, shown while running


@dataclass
class BotOptions:
    window: str = "Express"  # part of the title of the window to type into ("Notepad" / "Untitled" for a test run)
    delay_ms: int = 60  # between two actions
    paste_thai: bool = False  # Thai text through the clipboard (Ctrl+V) instead of typing it
    templates: dict[str, dict[str, str]] = field(
        default_factory=lambda: {k: dict(v) for k, v in DEFAULT_TEMPLATES.items()})
    warehouse: str = "01"
    department: str = ""


class TemplateError(ValueError):
    pass


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def doc_values(doc: StockDoc, options: BotOptions) -> dict[str, str]:
    from .express_out import express_remark

    return {"department": doc.department or options.department, "remark": express_remark(doc),
            "date": thai_date(doc.date), "job": doc.job, "vendor": doc.vendor, "ref": doc.ref, "doc_no": doc.doc_no}


def line_values(doc: StockDoc, i: int, options: BotOptions) -> dict[str, str]:
    from .express_out import warehouse_of
    from .express_out import Options

    ln = doc.lines[i]
    return {"no": str(i + 1), "code": ln.code, "name": ln.name,
            "warehouse": warehouse_of(ln.warehouse, Options(warehouse=options.warehouse)),
            "qty": _num(float(ln.qty)), "unit": ln.unit, "unit_cost": _num(float(ln.unit_cost)), "remark": ln.remark}


def parse(template: str, fields: dict[str, str]) -> list[tuple[str, str, int]]:
    """'{F4}{WAIT 800}[แผนก]{ENTER}' -> [(key, F4, 1), (wait, 800, 1), (field, department, 1), (key, ENTER, 1)]."""
    out = []
    for m in _TOKEN.finditer(template.replace("\r", "").replace("\n", "")):
        key, name, text = m.group(1), m.group(2), m.group(3)
        if text is not None:
            out.append(("text", text, 1))
        elif name is not None:
            name = name.strip()
            if name not in fields:
                raise TemplateError(f"ไม่รู้จักช่อง [{name}] – ใช้ได้: " + ", ".join(f"[{k}]" for k in fields))
            out.append(("field", fields[name], 1))
        else:
            word = key.strip().upper()
            parts = word.split()
            if parts[0] == "WAIT":
                if len(parts) != 2 or not parts[1].isdigit():
                    raise TemplateError(f"{{{key}}}: ใช้ {{WAIT 500}} (มิลลิวินาที)")
                out.append(("wait", parts[1], 1))
            elif parts[0] == "STOP":
                out.append(("stop", "", 1))
            else:
                times = int(parts[1]) if len(parts) == 2 and parts[1].isdigit() else 1
                combo = parts[0].split("+")
                if combo[-1] not in KEYS or any(m_ not in MODIFIERS for m_ in combo[:-1]) or len(parts) > 2:
                    raise TemplateError(f"ไม่รู้จักปุ่ม {{{key}}}")
                out.append(("key", parts[0], times))
    return out


def check_template(doc_type: str, parts: dict[str, str]) -> list[str]:
    errors = []
    for section, fields in ((HEAD, DOC_FIELDS), (LINE, LINE_FIELDS), (END, DOC_FIELDS)):
        try:
            parse(parts.get(section, ""), fields)
        except TemplateError as e:
            errors.append(f"{doc_type} {section}: {e}")
    return errors


def actions_for(doc: StockDoc, options: BotOptions) -> list[Action]:
    tpl = options.templates.get(doc.doc_type) or DEFAULT_TEMPLATES.get(doc.doc_type)
    if not tpl:
        raise TemplateError(f"ไม่มีแบบการคีย์ของ {doc.doc_type}")
    out = [Action("doc", doc.doc_no, label=f"{doc.doc_no} ({doc.doc_type})")]

    names = {v: k for k, v in {**DOC_FIELDS, **LINE_FIELDS}.items()}

    def emit(parsed, values, where):
        for kind, value, times in parsed:
            if kind == "field":
                text = values.get(value, "")
                if text:
                    out.append(Action("text", text, label=f"{where} {names.get(value, value)}"))
            else:
                out.append(Action(kind, value, times, where))

    emit(parse(tpl.get(HEAD, ""), DOC_FIELDS), doc_values(doc, options), "หัวเอกสาร")
    line_tpl = parse(tpl.get(LINE, ""), LINE_FIELDS)
    for i in range(len(doc.lines)):
        emit(line_tpl, line_values(doc, i, options), f"บรรทัด {i + 1}")
    emit(parse(tpl.get(END, ""), DOC_FIELDS), doc_values(doc, options), "ท้ายเอกสาร")
    return out


# --------------------------------------------------------------------------
# AutoHotkey v2: the same actions as a script (to look at, or to run without this program)
# --------------------------------------------------------------------------
_AHK_KEYS = {"ENTER": "Enter", "TAB": "Tab", "ESC": "Esc", "UP": "Up", "DOWN": "Down", "LEFT": "Left", "RIGHT": "Right",
             "HOME": "Home", "END": "End", "DEL": "Delete", "BACKSPACE": "Backspace", "PGUP": "PgUp", "PGDN": "PgDn",
             "INS": "Insert", "SPACE": "Space"}
_AHK_MODS = {"CTRL": "^", "ALT": "!", "SHIFT": "+"}


def _ahk_key(name: str, times: int) -> str:
    combo = name.split("+")
    base = _AHK_KEYS.get(combo[-1], combo[-1].lower() if len(combo[-1]) == 1 else combo[-1])
    return "".join(_AHK_MODS[m] for m in combo[:-1]) + "{" + base + (f" {times}" if times > 1 else "") + "}"


def to_ahk(docs_actions: list[list[Action]], options: BotOptions) -> str:
    win = options.window.replace('"', "")
    lines = ["#Requires AutoHotkey v2.0", "; คีย์เข้า Express อัตโนมัติ – สร้างโดย RRS Part List Studio",
             "; เปิดหน้าจอเอกสารใน Express ไว้ก่อน · กด Ctrl+Alt+Q เพื่อหยุด", "SetKeyDelay 30, 20",
             'SetTitleMatchMode 2', "^!q::ExitApp", f'if !WinExist("{win}") {{', f'    MsgBox "ไม่พบหน้าต่าง {win}"',
             "    ExitApp", "}", f'WinActivate "{win}"', f'WinWaitActive "{win}",, 5', ""]
    for actions in docs_actions:
        for a in actions:
            if a.kind == "doc":
                lines.append(f"; ---- {a.label}")
            elif a.kind == "text":
                text = a.value.replace("`", "``").replace('"', '`"')
                lines.append(f'SendText "{text}"')
            elif a.kind == "key":
                lines.append(f'Send "{_ahk_key(a.value, a.times)}"')
            elif a.kind == "wait":
                lines.append(f"Sleep {a.value}")
            elif a.kind == "stop":
                lines.append(f'MsgBox "{a.label}: ตรวจในหน้าจอ Express แล้วกดบันทึกเอง จากนั้นกด OK เพื่อคีย์ใบถัดไป"')
            if a.kind in ("text", "key"):
                lines.append(f"Sleep {max(options.delay_ms, 0)}")
    lines.append('MsgBox "คีย์ครบแล้ว – อย่าลืมใส่เลขที่ Express ในโปรแกรม"')
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Running: an output that types (the Windows keyboard, or a stand-in in the tests)
# --------------------------------------------------------------------------
class Stopped(Exception):
    """The run was stopped: the user, the window lost, the mouse in the top-left corner."""


class Output:
    def activate(self, title: str) -> bool:
        raise NotImplementedError

    def still_there(self, title: str) -> bool:
        return True

    def text(self, text: str, paste: bool = False) -> None:
        raise NotImplementedError

    def key(self, name: str, times: int = 1) -> None:
        raise NotImplementedError

    def abort_requested(self) -> bool:
        return False


def run(docs_actions: list[list[Action]], options: BotOptions, out: Output, progress=None, wait_stop=None,
        should_stop=lambda: False, sleep=time.sleep) -> list[str]:
    """Type the documents; progress(done, total, label); wait_stop(label) is called at {STOP} and returns False to end
    the run. Returns the document numbers keyed (up to their {STOP} / end)."""
    if not out.activate(options.window):
        raise Stopped(f"ไม่พบหน้าต่างที่ชื่อมี “{options.window}” – เปิด Express (หน้าจอเอกสาร) ไว้ก่อน")
    total = sum(len(a) for a in docs_actions)
    done, keyed = 0, []
    for actions in docs_actions:
        current = ""
        for a in actions:
            if should_stop() or out.abort_requested():
                raise Stopped("หยุดแล้ว")
            if a.kind in ("text", "key") and not out.still_there(options.window):
                raise Stopped(f"หน้าต่าง {options.window} ไม่ได้อยู่ด้านหน้า – หยุดเพื่อไม่ให้พิมพ์ผิดที่")
            if a.kind == "doc":
                current = a.value
            elif a.kind == "text":
                out.text(a.value, options.paste_thai and not a.value.isascii())
            elif a.kind == "key":
                out.key(a.value, a.times)
            elif a.kind == "wait":
                sleep(int(a.value) / 1000)
            elif a.kind == "stop":
                if current and current not in keyed:
                    keyed.append(current)
                if wait_stop is not None and not wait_stop(current):
                    return keyed
                if not out.activate(options.window):
                    raise Stopped(f"ไม่พบหน้าต่าง {options.window}")
            if a.kind in ("text", "key"):
                sleep(max(options.delay_ms, 0) / 1000)
            done += 1
            if progress:
                progress(done, total, a.label)
        if current and current not in keyed:
            keyed.append(current)
    return keyed


class WindowsKeyboard(Output):
    """SendInput of Windows: keys by virtual-key code, text as Unicode characters (or pasted with Ctrl+V)."""

    VK = {"ENTER": 0x0D, "TAB": 0x09, "ESC": 0x1B, "UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27,
          "HOME": 0x24, "END": 0x23, "DEL": 0x2E, "BACKSPACE": 0x08, "PGUP": 0x21, "PGDN": 0x22, "INS": 0x2D,
          "SPACE": 0x20, "CTRL": 0x11, "ALT": 0x12, "SHIFT": 0x10,
          **{f"F{i}": 0x6F + i for i in range(1, 13)}, **{c: ord(c) for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}}

    def __init__(self, clipboard=None):
        if not sys.platform.startswith("win"):
            raise OSError("คีย์อัตโนมัติใช้ได้บน Windows (เครื่องที่ติดตั้ง Express)")
        import ctypes
        from ctypes import wintypes

        self.ctypes, self.wintypes = ctypes, wintypes
        self.user32 = user32 = ctypes.WinDLL("user32", use_last_error=True)
        HWND = wintypes.HWND
        user32.GetForegroundWindow.restype = HWND
        user32.GetAncestor.argtypes, user32.GetAncestor.restype = [HWND, wintypes.UINT], HWND
        user32.SetForegroundWindow.argtypes = [HWND]
        user32.IsWindowVisible.argtypes = [HWND]
        user32.IsIconic.argtypes = [HWND]
        user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
        user32.GetWindowTextLengthW.argtypes = [HWND]
        user32.GetWindowTextW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
        self.hwnd = None
        self.clipboard = clipboard  # set_text(str) for paste_thai (default: the Windows clipboard, any thread)

        ulong_ptr = ctypes.c_size_t

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("dwExtraInfo", ulong_ptr)]

        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                        ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ulong_ptr)]

        class _U(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]

        class INPUT(ctypes.Structure):
            _anonymous_ = ("u",)
            _fields_ = [("type", wintypes.DWORD), ("u", _U)]

        self.KEYBDINPUT, self.INPUT = KEYBDINPUT, INPUT

    # ---- windows ----------------------------------------------------------------------------------
    def _find(self, title: str):
        ctypes, wintypes, user32 = self.ctypes, self.wintypes, self.user32
        found = []
        proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def each(hwnd, _lparam):
            if user32.IsWindowVisible(hwnd):
                n = user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if title.lower() in buf.value.lower() and "part list studio" not in buf.value.lower():
                    found.append(hwnd)
            return True

        user32.EnumWindows(proc(each), 0)
        return found[0] if found else None

    def activate(self, title: str) -> bool:
        hwnd = self._find(title)
        if not hwnd:
            return False
        self.hwnd = hwnd
        if self.user32.IsIconic(hwnd):
            self.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        self.key("ALT")  # Windows lets a program bring another window forward after a key press
        self.user32.SetForegroundWindow(hwnd)
        time.sleep(0.4)
        return self.still_there(title)

    def still_there(self, title: str) -> bool:
        fg = self.user32.GetForegroundWindow()
        return bool(fg) and (fg == self.hwnd or self.user32.GetAncestor(fg, 3) == self.hwnd)

    def abort_requested(self) -> bool:
        pt = self.wintypes.POINT()
        self.user32.GetCursorPos(self.ctypes.byref(pt))
        return pt.x <= 2 and pt.y <= 2  # the mouse pushed into the top-left corner

    # ---- input ------------------------------------------------------------------------------------
    def _send(self, items) -> None:
        arr = (self.INPUT * len(items))(*items)
        self.user32.SendInput(len(items), arr, self.ctypes.sizeof(self.INPUT))

    def _vk(self, vk: int, up: bool):
        return self.INPUT(type=1, ki=self.KEYBDINPUT(wVk=vk, wScan=0, dwFlags=0x0002 if up else 0, time=0,
                                                     dwExtraInfo=0))

    def key(self, name: str, times: int = 1) -> None:
        combo = name.upper().split("+")
        mods, base = [self.VK[m] for m in combo[:-1]], self.VK[combo[-1]]
        for _ in range(max(times, 1)):
            self._send([self._vk(m, False) for m in mods] + [self._vk(base, False), self._vk(base, True)]
                       + [self._vk(m, True) for m in reversed(mods)])
            time.sleep(0.015)

    def _set_clipboard(self, text: str) -> None:
        """The Windows clipboard (from this thread, not Qt's): CF_UNICODETEXT - Windows gives Express the Thai text."""
        ctypes, wintypes = self.ctypes, self.wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GlobalAlloc.argtypes, k32.GlobalAlloc.restype = [wintypes.UINT, ctypes.c_size_t], wintypes.HGLOBAL
        k32.GlobalLock.argtypes, k32.GlobalLock.restype = [wintypes.HGLOBAL], ctypes.c_void_p
        k32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
        u = self.user32
        u.OpenClipboard.argtypes = [wintypes.HWND]
        u.SetClipboardData.argtypes, u.SetClipboardData.restype = [wintypes.UINT, wintypes.HANDLE], wintypes.HANDLE
        data = (text + "\0").encode("utf-16-le")
        for _ in range(10):
            if u.OpenClipboard(None):
                break
            time.sleep(0.05)
        else:
            raise Stopped("ใช้คลิปบอร์ดไม่ได้ – โปรแกรมอื่นเปิดค้างอยู่")
        try:
            u.EmptyClipboard()
            h = k32.GlobalAlloc(0x0002, len(data))  # GMEM_MOVEABLE
            ptr = k32.GlobalLock(h)
            ctypes.memmove(ptr, data, len(data))
            k32.GlobalUnlock(h)
            u.SetClipboardData(13, h)  # CF_UNICODETEXT, the clipboard owns it now
        finally:
            u.CloseClipboard()

    def text(self, text: str, paste: bool = False) -> None:
        if paste:
            (self.clipboard or self._set_clipboard)(text)
            time.sleep(0.05)
            self.key("CTRL+V")
            return
        for ch in text:
            code = ord(ch)
            down = self.KEYBDINPUT(wVk=0, wScan=code, dwFlags=0x0004, time=0, dwExtraInfo=0)  # KEYEVENTF_UNICODE
            up = self.KEYBDINPUT(wVk=0, wScan=code, dwFlags=0x0004 | 0x0002, time=0, dwExtraInfo=0)
            self._send([self.INPUT(type=1, ki=down), self.INPUT(type=1, ki=up)])
            time.sleep(0.004)
