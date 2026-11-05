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
    {CONFIRM ข้อความ}  ask a person before going on (e.g. "is the screen a new empty document?") - by default only on
              the first document of each type in a run
    text      typed as is

The templates shipped are a start from the screens of the company's Express: try them once on each screen (a test run
types into Notepad) and adjust the order of the keys. The same actions can be written as an AutoHotkey v2 script.
"""

from __future__ import annotations

import os
import re
import sys
import time
import unicodedata
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
_NEW_DOC = ("{CONFIRM หน้าต่างด้านหน้าคือหน้าจอเอกสารชนิดนี้ใน Express ของบริษัทที่ถูกต้อง และยังไม่มีใบค้างอยู่?}"
            "{F4}{WAIT 1200}")
_ISSUE = {HEAD: _NEW_DOC + "[แผนก]{ENTER}{WAIT 300}[หมายเหตุ]{ENTER}{ENTER}[วันที่]{ENTER}{F8}{WAIT 600}",
          LINE: "[รหัส]{ENTER}{WAIT 400}{ENTER}[คลัง]{ENTER}[จำนวน]{ENTER}{ENTER}{ENTER}{WAIT 200}",
          END: "{STOP}"}
DEFAULT_TEMPLATES: dict[str, dict[str, str]] = {
    "PD": dict(_ISSUE),
    "OU": dict(_ISSUE),
    "FR": dict(_ISSUE),
    "AJ": dict(_ISSUE),
    "RR": {HEAD: _NEW_DOC + "[ผู้จำหน่าย]{ENTER}{WAIT 500}[อ้างอิง]{ENTER}[แผนก]{ENTER}{ENTER}[วันที่]{ENTER}"
                 "{F8}{WAIT 600}",
           LINE: "[รหัส]{ENTER}{WAIT 400}{ENTER}[คลัง]{ENTER}[จำนวน]{ENTER}{ENTER}[ราคาต่อหน่วย]{ENTER}{ENTER}"
                 "{ENTER}{WAIT 200}",
           END: "{STOP}"},
}
SCREEN_HINTS = {"PD": "4.สินค้า → PD - จ่ายวัตถุดิบเพื่อผลิต", "OU": "4.สินค้า → OU - จ่ายสินค้าใช้ภายใน",
                "RR": "1.ซื้อ → RR - รับสินค้า", "FR": "4.สินค้า → FR - รับสินค้าสำเร็จรูปจากการผลิต",
                "AJ": "4.สินค้า → JU - ปรับปรุงเพิ่ม/ลดสินค้า (จำนวน = ส่วนต่าง +/−)"}
NEW_KEY_HINT = ("ปุ่มเปิดใบใหม่ตั้งต้นเป็น {F4} – ถ้าไม่เปิดใบใหม่ ลอง {F2} (หน้าจอสมุดรายวันของ Express ใช้ F2) · "
                "ห้ามใส่ปุ่มบันทึก ({F10}) จนกว่าจะทดลองแล้ว")
SAVE_KEYS = {"F10", "CTRL+S"}
# characters Express (Thai code page 874) cannot store, and what to type instead
CP874_FIXES = {"\u2212": "-", "\u2013": "-", "\u2014": "-", "\u2018": "'", "\u2019": "'", "\u201c": '"',
               "\u201d": '"', "\u00d7": "x", "\u00a0": " ", "\u2022": "-", "\u2026": "...", "\u00b0": " องศา"}
_TOKEN = re.compile(r"\{([^{}]+)\}|\[([^\[\]]+)\]|([^{\[]+)")


@dataclass
class Action:
    kind: str  # text | key | wait | stop | confirm | doc (a document starts)
    value: str = ""
    times: int = 1
    label: str = ""  # what it is, shown while running
    doc_type: str = ""  # on the doc action


@dataclass
class BotOptions:
    window: str = "Express"  # part of the title of the window to type into ("Notepad" / "Untitled" for a test run)
    delay_ms: int = 60  # between two actions
    paste_thai: bool = False  # Thai text through the clipboard (Ctrl+V) instead of typing it
    templates: dict[str, dict[str, str]] = field(
        default_factory=lambda: {k: dict(v) for k, v in DEFAULT_TEMPLATES.items()})
    warehouse: str = "01"
    department: str = ""
    process: str = ""  # part of the program file name of Express (e.g. "express"), "" = any program
    confirm_first_only: bool = True  # {CONFIRM} only on the first document of each type in a run
    remark_ref: bool = False  # add our document number to หมายเหตุ (to find the document in Express later)


class TemplateError(ValueError):
    pass


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def doc_values(doc: StockDoc, options: BotOptions) -> dict[str, str]:
    from .express_out import express_remark

    return {"department": doc.department or options.department, "remark": express_remark(doc, options.remark_ref),
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
            elif parts[0] == "CONFIRM":
                out.append(("confirm", key.strip()[len("CONFIRM"):].strip() or "ไปต่อได้ไหม?", 1))
            else:
                times = int(parts[1]) if len(parts) == 2 and parts[1].isdigit() else 1
                combo = parts[0].split("+")
                if combo[-1] not in KEYS or any(m_ not in MODIFIERS for m_ in combo[:-1]) or len(parts) > 2:
                    raise TemplateError(f"ไม่รู้จักปุ่ม {{{key}}}")
                out.append(("key", parts[0], times))
    return out


def check_template(doc_type: str, parts: dict[str, str], allow_save: bool = False) -> list[str]:
    """Errors that stop a run: a wrong token; a save key or no {STOP} at the end (unless an admin allowed saving)."""
    errors = []
    parsed = {}
    for section, fields in ((HEAD, DOC_FIELDS), (LINE, LINE_FIELDS), (END, DOC_FIELDS)):
        try:
            parsed[section] = parse(parts.get(section, ""), fields)
        except TemplateError as e:
            errors.append(f"{doc_type} {section}: {e}")
    if not allow_save and not errors:
        if any(k == "key" and v in SAVE_KEYS for toks in parsed.values() for k, v, _t in toks):
            errors.append(f"{doc_type}: มีปุ่มบันทึก ({', '.join(sorted(SAVE_KEYS))}) – ให้คนตรวจแล้วกดบันทึกเอง "
                          "(ผู้ดูแลเปิดให้บันทึกเองได้ในตั้งค่า)")
        if not any(k == "stop" for k, _v, _t in parsed[END]):
            errors.append(f"{doc_type}: ท้ายเอกสารต้องมี {{STOP}} – ให้คนตรวจก่อนบันทึก")
    return errors


def template_warnings(doc_type: str, parts: dict[str, str]) -> list[str]:
    """Not errors, but risky: a save key, no stop at the end, no wait after a key that opens something."""
    out = []
    try:
        sections = {sec: parse(parts.get(sec, ""), DOC_FIELDS if sec != LINE else LINE_FIELDS) for sec in (HEAD, LINE, END)}
    except TemplateError:
        return out
    for sec, toks in sections.items():
        if any(k == "key" and v in SAVE_KEYS for k, v, _t in toks):
            out.append(f"{doc_type}: มีปุ่มบันทึก ({', '.join(sorted(SAVE_KEYS))}) – Express จะบันทึกเองโดยไม่มีคนตรวจ")
        for i, (k, v, _t) in enumerate(toks):
            if k == "key" and v in ("F2", "F4", "F8") and not (i + 1 < len(toks) and toks[i + 1][0] == "wait"):
                out.append(f"{doc_type}: ไม่มี {{WAIT}} หลัง {{{v}}} – Express อาจยังเปิดหน้าจอไม่ทัน")
    if not any(k in ("stop", "confirm") for k, _v, _t in sections[END]):
        out.append(f"{doc_type}: ท้ายเอกสารไม่มี {{STOP}} – โปรแกรมจะไม่หยุดให้ตรวจก่อนบันทึก")
    return out


def fix_text(text: str) -> tuple[str, list[str]]:
    """The text Express can store (Thai code page 874): NFC, known replacements; returns (text, characters left out)."""
    text = unicodedata.normalize("NFC", text)
    text = "".join(" " if ch in "\t\r\n" else CP874_FIXES.get(ch, ch) for ch in text)
    text = "".join(ch for ch in text if ch >= " " and ch != "\x7f")  # a control character would act as a key
    bad = sorted({ch for ch in text if not _cp874(ch)})
    return "".join(ch for ch in text if ch not in bad), bad


def _cp874(ch: str) -> bool:
    try:
        ch.encode("cp874")
        return True
    except UnicodeEncodeError:
        return False


def check_text(docs_actions: list[list[Action]]) -> list[str]:
    """Fix the typed text in place; returns what could not be typed (document, where, characters)."""
    problems = []
    current = ""
    for actions in docs_actions:
        for a in actions:
            if a.kind == "doc":
                current = a.value
            elif a.kind == "text":
                fixed, bad = fix_text(a.value)
                a.value = fixed
                if bad:
                    problems.append(f"{current} {a.label}: ตัด {' '.join(repr(c) for c in bad)} (Express เก็บไม่ได้)")
    return problems


def actions_for(doc: StockDoc, options: BotOptions) -> list[Action]:
    tpl = options.templates.get(doc.doc_type) or DEFAULT_TEMPLATES.get(doc.doc_type)
    if not tpl:
        raise TemplateError(f"ไม่มีแบบการคีย์ของ {doc.doc_type}")
    out = [Action("doc", doc.doc_no, label=f"{doc.doc_no} ({doc.doc_type})", doc_type=doc.doc_type)]

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


def _ahk_str(text: str) -> str:
    """Text inside an AutoHotkey "…" string: ` and " escaped, line breaks and control characters dropped."""
    text = "".join(ch for ch in str(text) if ch >= " " or ch == "\t").replace("\t", " ")
    return text.replace("`", "``").replace('"', '`"').replace(";", "`;")


def _ahk_comment(text: str) -> str:
    return "".join(ch for ch in str(text) if ch >= " ")


def to_ahk(docs_actions: list[list[Action]], options: BotOptions) -> str:
    win = _ahk_str(options.window)
    lines = ["#Requires AutoHotkey v2.0", "; คีย์เข้า Express อัตโนมัติ – สร้างโดย RRS Part List Studio",
             "; เปิดหน้าจอเอกสารใน Express ไว้ก่อน · กด Ctrl+Alt+Q เพื่อหยุด", "SetKeyDelay 30, 20",
             'SetTitleMatchMode 2', "^!q::ExitApp", f'if !WinExist("{win}") {{', f'    MsgBox "ไม่พบหน้าต่าง {win}"',
             "    ExitApp", "}", f'WinActivate "{win}"', f'WinWaitActive "{win}",, 5', ""]
    current = ""
    for actions in docs_actions:
        for a in actions:
            if a.kind == "doc":
                current = a.value
                lines.append(f"; ---- {_ahk_comment(a.label)}")
            elif a.kind == "text":
                lines.append(f'SendText "{_ahk_str(a.value)}"')
            elif a.kind == "key":
                lines.append(f'Send "{_ahk_key(a.value, a.times)}"')
            elif a.kind == "wait":
                lines.append(f"Sleep {a.value}")
            elif a.kind == "stop":
                lines.append(f'MsgBox "{_ahk_str(current)}: ตรวจในหน้าจอ Express แล้วกดบันทึกเอง จากนั้นกด OK เพื่อคีย์ใบถัดไป"')
                lines.append(f'WinActivate "{win}"')
            elif a.kind == "confirm":
                lines.append(f'if MsgBox("{_ahk_str(current)}: {_ahk_str(a.value)}",, "YesNo") = "No"')
                lines.append("    ExitApp")
                lines.append(f'WinActivate "{win}"')
            if a.kind in ("text", "key"):
                lines.append(f"Sleep {max(options.delay_ms, 0)}")
    lines.append('MsgBox "คีย์ครบแล้ว – อย่าลืมใส่เลขที่ Express ในโปรแกรม"')
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Running: an output that types (the Windows keyboard, or a stand-in in the tests)
# --------------------------------------------------------------------------
class Stopped(Exception):
    """The run was stopped: the user, the window lost, the mouse in the top-left corner, a stop key.
    keyed: documents typed up to their {STOP}; partial: the document typed half-way (open, unsaved in Express)."""

    def __init__(self, message: str, keyed: list[str] | None = None, partial: str = ""):
        super().__init__(message)
        self.keyed = list(keyed or [])
        self.partial = partial


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
        should_stop=lambda: False, sleep=time.sleep, confirm=None) -> list[str]:
    """Type the documents; progress(done, total, label); wait_stop(doc_no) is called at {STOP} and returns False to end
    the run; confirm(doc_no, question) at {CONFIRM} (False = end, nothing more typed into that document).
    Returns the document numbers keyed (up to their {STOP} / end); a stop raises Stopped with the same list and the
    document left half-typed."""
    keyed: list[str] = []
    state = {"current": "", "typed": False}

    def stop(message: str):
        partial = state["current"] if state["current"] and state["typed"] and state["current"] not in keyed else ""
        return Stopped(message, keyed, partial)

    def check():
        if should_stop() or out.abort_requested():
            raise stop("หยุดแล้ว")

    def pause(ms: int) -> None:
        left = max(int(ms), 0) / 1000
        while left > 0:  # in slices: a stop is seen during long waits too
            check()
            step = min(left, 0.05)
            sleep(step)
            left -= step

    if not out.activate(options.window):
        raise Stopped(f"ไม่พบหน้าต่างที่ชื่อมี “{options.window}” – เปิด Express (หน้าจอเอกสาร) ไว้ก่อน")
    total = sum(len(a) for a in docs_actions)
    done = 0
    confirmed_types: set[str] = set()
    for actions in docs_actions:
        state["current"], state["typed"] = "", False
        doc_type = ""
        for a in actions:
            check()
            if a.kind in ("text", "key") and not out.still_there(options.window):
                raise stop(f"หน้าต่าง {options.window} ไม่ได้อยู่ด้านหน้า – หยุดเพื่อไม่ให้พิมพ์ผิดที่")
            if a.kind == "doc":
                state["current"], doc_type = a.value, a.doc_type
            elif a.kind == "text":
                out.text(a.value, options.paste_thai and not a.value.isascii())
                state["typed"] = True
            elif a.kind == "key":
                out.key(a.value, a.times)
                state["typed"] = True
            elif a.kind == "wait":
                pause(int(a.value))
            elif a.kind == "confirm":
                if confirm is not None and not (options.confirm_first_only and doc_type in confirmed_types):
                    if not confirm(state["current"], a.value):
                        raise stop(f"{state['current']}: ไม่ได้ยืนยัน – หยุด")
                    confirmed_types.add(doc_type)
                    if not out.activate(options.window):
                        raise stop(f"ไม่พบหน้าต่าง {options.window}")
            elif a.kind == "stop":
                if state["current"] and state["current"] not in keyed:
                    keyed.append(state["current"])
                if wait_stop is not None and not wait_stop(state["current"]):
                    return keyed
                if not out.activate(options.window):
                    raise stop(f"ไม่พบหน้าต่าง {options.window}")
            if a.kind in ("text", "key"):
                pause(options.delay_ms)
            done += 1
            if progress:
                progress(done, total, a.label)
        if state["current"] and state["current"] not in keyed:
            keyed.append(state["current"])
    return keyed


class WindowsKeyboard(Output):
    """SendInput of Windows: keys by virtual-key code, text as Unicode characters (or pasted with Ctrl+V)."""

    VK = {"ENTER": 0x0D, "TAB": 0x09, "ESC": 0x1B, "UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27,
          "HOME": 0x24, "END": 0x23, "DEL": 0x2E, "BACKSPACE": 0x08, "PGUP": 0x21, "PGDN": 0x22, "INS": 0x2D,
          "SPACE": 0x20, "CTRL": 0x11, "ALT": 0x12, "SHIFT": 0x10,
          **{f"F{i}": 0x6F + i for i in range(1, 13)}, **{c: ord(c) for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}}

    BROWSERS = ("chrome.exe", "msedge.exe", "firefox.exe", "explorer.exe", "brave.exe", "opera.exe", "excel.exe",
                "winword.exe", "outlook.exe", "line.exe")  # never typed into, even when the title matches

    def __init__(self, clipboard=None, process: str = ""):
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
        user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.GetAsyncKeyState.argtypes, user32.GetAsyncKeyState.restype = [ctypes.c_int], ctypes.c_short
        user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        self.kernel32 = k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.argtypes, k32.OpenProcess.restype = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE
        k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                   ctypes.POINTER(wintypes.DWORD)]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.process = (process or "").strip().lower()
        self.hwnd = None
        self.target = ""  # "title — program.exe" of the window typed into
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
    def _exe(self, hwnd) -> str:
        """The program file of a window (express.exe …), "" when Windows does not tell."""
        ctypes, wintypes = self.ctypes, self.wintypes
        pid = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == os.getpid():
            return "<this program>"
        h = self.kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(520)
            size = wintypes.DWORD(520)
            if self.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return buf.value.replace("/", "\\").rsplit("\\", 1)[-1].lower()
            return ""
        finally:
            self.kernel32.CloseHandle(h)

    def candidates(self, title: str) -> list[tuple[int, str, str]]:
        """Visible top-level windows whose title has `title` (not this program, browsers, Explorer):
        (hwnd, title, program)."""
        ctypes, wintypes, user32 = self.ctypes, self.wintypes, self.user32
        found = []
        proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def each(hwnd, _lparam):
            if user32.IsWindowVisible(hwnd):
                n = user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if title.lower() in buf.value.lower():
                    found.append((hwnd, buf.value))
            return True

        user32.EnumWindows(proc(each), 0)
        out = []
        for hwnd, text in found:
            exe = self._exe(hwnd)
            if exe == "<this program>" or exe in self.BROWSERS or "part list studio" in text.lower() \
                    or "toexpress" in text.lower():  # the outbox file / AutoHotkey script open in an editor
                continue
            if self.process and self.process not in exe:
                continue
            out.append((hwnd, text, exe))
        return out

    def activate(self, title: str) -> bool:
        found = self.candidates(title)
        if not found:
            return False
        if len(found) > 1 and self.hwnd not in [h for h, _t, _e in found]:
            raise Stopped("พบหลายหน้าต่างที่ชื่อมี “%s”: %s – พิมพ์ชื่อหน้าต่างให้ละเอียดขึ้น หรือใส่ชื่อโปรแกรม"
                          % (title, " · ".join(f"{t} — {e or '?'}" for _h, t, e in found[:5])))
        hwnd = self.hwnd if self.hwnd in [h for h, _t, _e in found] else found[0][0]
        self.hwnd = hwnd
        self.target = next(f"{t} — {e or '?'}" for h, t, e in found if h == hwnd)
        if self.still_there(title):
            return True  # already in front: no key at all (a lone Alt would open the Express menu)
        if self.user32.IsIconic(hwnd):
            self.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        self._send([self._vk(0x87, True)])  # a key-up of F24, which no program uses: Windows then lets us bring
        if not self.user32.SetForegroundWindow(hwnd):  # another window forward
            fg = self.user32.GetForegroundWindow()
            mine = self.kernel32.GetCurrentThreadId()
            theirs = self.user32.GetWindowThreadProcessId(fg, None) if fg else 0
            if theirs and theirs != mine:
                self.user32.AttachThreadInput(mine, theirs, True)
                self.user32.SetForegroundWindow(hwnd)
                self.user32.AttachThreadInput(mine, theirs, False)
        time.sleep(0.4)
        return self.still_there(title)

    def still_there(self, title: str) -> bool:
        fg = self.user32.GetForegroundWindow()
        return bool(fg) and (fg == self.hwnd or self.user32.GetAncestor(fg, 3) == self.hwnd)

    def abort_requested(self) -> bool:
        pt = self.wintypes.POINT()
        self.user32.GetCursorPos(self.ctypes.byref(pt))
        if pt.x <= 2 and pt.y <= 2:  # the mouse pushed into the top-left corner
            return True
        down = lambda vk: bool(self.user32.GetAsyncKeyState(vk) & 0x8000)  # noqa: E731
        return down(0x13) or (down(0x11) and down(0x12) and down(0x51))  # Pause, or Ctrl+Alt+Q

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
        try:
            ansi = (text + "\0").encode("cp874")  # Express is a Thai ANSI program: give it the text in its code page
        except UnicodeEncodeError:
            ansi = None
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
            if ansi is not None:
                for fmt, payload in ((1, ansi), (16, (0x041E).to_bytes(4, "little"))):  # CF_TEXT, CF_LOCALE (Thai)
                    hh = k32.GlobalAlloc(0x0002, len(payload))
                    pp = k32.GlobalLock(hh)
                    ctypes.memmove(pp, payload, len(payload))
                    k32.GlobalUnlock(hh)
                    u.SetClipboardData(fmt, hh)
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


def windows_codepage() -> int | None:
    """The code page of non-Unicode programs (874 = Thai) on Windows, None elsewhere."""
    if not sys.platform.startswith("win"):
        return None
    import ctypes

    try:
        return int(ctypes.windll.kernel32.GetACP())
    except Exception:  # noqa: BLE001
        return None
