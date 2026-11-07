"""คีย์เข้า Express อัตโนมัติ: templates of the Express screens → keys and text, AutoHotkey, the run and its stops."""

import pytest

from partlist_studio.core import express_bot as bot
from partlist_studio.core.movements import DocLine, StockDoc


def _doc():
    return StockDoc("PD", "PD6911-0001", "2026-07-08", job="SO6700001", remark="ช่างรองโตโยต้าระยอง", department="SET",
                    lines=[DocLine("9900001", "แผ่นยางรองขาเครน", 6, "ชน", "01", 65),
                           DocLine("STORE-67-0253", "ข้อต่องอ90", 1.5, "ตว", "ST05")])


class Fake(bot.Output):
    def __init__(self, present=True, lose_after=None):
        self.typed, self.present, self.lose_after = [], present, lose_after

    def activate(self, title):
        return self.present

    def still_there(self, title):
        return self.lose_after is None or len(self.typed) < self.lose_after

    def text(self, text, paste=False):
        self.typed.append(("paste " if paste else "") + text)

    def key(self, name, times=1):
        self.typed.append("{" + name + (f" {times}" if times > 1 else "") + "}")


def test_template_to_actions():
    assert bot.parse("{F4}{WAIT 800}[แผนก]{TAB 2}x{CTRL+S}{STOP}", bot.DOC_FIELDS) == [
        ("key", "F4", 1), ("wait", "800", 1), ("field", "department", 1), ("key", "TAB", 2), ("text", "x", 1),
        ("key", "CTRL+S", 1), ("stop", "", 1)]
    for bad in ("[ราคา]", "{F13}", "{WAIT x}", "{HYPER+A}"):
        with pytest.raises(bot.TemplateError):
            bot.parse(bad, bot.DOC_FIELDS)
    opts = bot.BotOptions(delay_ms=0)
    acts = bot.actions_for(_doc(), opts)
    texts = [a.value for a in acts if a.kind == "text"]
    assert texts == ["SET", "SO6700001 ช่างรองโตโยต้าระยอง", "08/07/69", "9900001", "01", "6",
                     "STORE-67-0253", "ST05", "1.5"]  # คลัง as on each line, PD price left to Express
    assert acts[0].kind == "doc" and acts[-1].kind == "stop"
    assert all(not bot.check_template(t, p) for t, p in bot.DEFAULT_TEMPLATES.items())
    rr = StockDoc("RR", "RR1", "2026-03-18", vendor="อ-092", ref="PO6900012",
                  lines=[DocLine("STORE-67-0850", "สายถัก", 10, "มน", "ST05", 600)])
    texts = [a.value for a in bot.actions_for(rr, opts) if a.kind == "text"]
    assert texts[:2] == ["อ-092", "PO6900012"] and "600" in texts


def test_autohotkey_script():
    opts = bot.BotOptions(delay_ms=20)
    script = bot.to_ahk([bot.actions_for(_doc(), opts)], opts)
    assert script.startswith("#Requires AutoHotkey v2.0")
    assert 'WinActivate "Express"' in script and 'Send "{F4}"' in script and 'SendText "แผ่นยางรองขาเครน"' not in script
    assert 'SendText "SO6700001 ช่างรองโตโยต้าระยอง"' in script and "MsgBox" in script and "^!q::ExitApp" in script
    assert bot._ahk_key("CTRL+S", 1) == "^{s}"
    assert bot._ahk_key("TAB", 3) == "{Tab 3}"


def test_run_types_stops_and_guards():
    opts = bot.BotOptions(delay_ms=0)
    acts = [bot.actions_for(_doc(), opts), bot.actions_for(StockDoc("OU", "OU1", lines=[DocLine("A", "a", 1)]), opts)]
    out, stops = Fake(), []
    keyed = bot.run(acts, opts, out, wait_stop=lambda no: stops.append(no) or True, sleep=lambda s: None)
    assert keyed == ["PD6911-0001", "OU1"] and stops == keyed and out.typed[0] == "{F4}"
    keyed = bot.run(acts, opts, Fake(), wait_stop=lambda no: False, sleep=lambda s: None)
    assert keyed == ["PD6911-0001"]  # Cancel at the first stop
    with pytest.raises(bot.Stopped, match="ไม่พบหน้าต่าง"):
        bot.run(acts, opts, Fake(present=False), sleep=lambda s: None)
    out = Fake(lose_after=3)
    with pytest.raises(bot.Stopped, match="ไม่ได้อยู่ด้านหน้า"):
        bot.run(acts, opts, out, sleep=lambda s: None)
    assert len(out.typed) == 3  # nothing typed after the window was lost
    opts.paste_thai = True
    out = Fake()
    bot.run(acts[:1], opts, out, wait_stop=lambda no: True, sleep=lambda s: None)
    assert "paste SO6700001 ช่างรองโตโยต้าระยอง" in out.typed and "9900001" in out.typed


def test_confirm_partial_and_text_checks():
    opts = bot.BotOptions(delay_ms=0)
    acts = [bot.actions_for(_doc(), opts), bot.actions_for(StockDoc("PD", "PD2", lines=[DocLine("A", "a", 1)]), opts)]
    asked = []
    keyed = bot.run(acts, opts, Fake(), wait_stop=lambda no: True, confirm=lambda no, q: asked.append(no) or True,
                    sleep=lambda s: None)
    assert keyed == ["PD6911-0001", "PD2"] and asked == ["PD6911-0001"]  # only the first PD asks
    out = Fake()
    with pytest.raises(bot.Stopped) as e:  # "no" at the check before the new-document key: nothing was pressed
        bot.run(acts, opts, out, confirm=lambda no, q: False, sleep=lambda s: None)
    assert e.value.keyed == [] and e.value.partial == "" and out.typed == []
    calls = {"n": 0}

    def stop_soon():
        calls["n"] += 1
        return calls["n"] > 12

    with pytest.raises(bot.Stopped) as e:  # stopped while typing the first document
        bot.run(acts, opts, Fake(), should_stop=stop_soon, confirm=lambda no, q: True, sleep=lambda s: None)
    assert e.value.partial == "PD6911-0001" and e.value.keyed == []
    slept = []
    calls["n"] = 0
    with pytest.raises(bot.Stopped):  # a long {WAIT} is cut short by a stop
        bot.run(acts, opts, Fake(), should_stop=lambda: len(slept) > 3, sleep=slept.append)
    assert len(slept) <= 5
    text, bad = bot.fix_text("ยาว 1−2 × 3 “ok” 😀")
    assert text == "ยาว 1-2 x 3 \"ok\" " and bad == ["😀"]
    a = [[bot.Action("doc", "D1"), bot.Action("text", "x😀", label="หัวเอกสาร หมายเหตุ")]]
    assert bot.check_text(a) and a[0][1].value == "x"
    warn = bot.template_warnings("PD", {bot.HEAD: "{F4}[แผนก]{F10}", bot.LINE: "", bot.END: ""})
    assert any("บันทึก" in w for w in warn) and any("WAIT" in w for w in warn) and any("STOP" in w for w in warn)
    assert bot.template_warnings("PD", bot.DEFAULT_TEMPLATES["PD"]) == []
    save = {bot.HEAD: "{F4}{WAIT 500}[แผนก]", bot.LINE: "[รหัส]", bot.END: "{F10}{STOP}"}
    assert any("บันทึก" in e for e in bot.check_template("PD", save))  # refused unless an admin allows saving
    assert bot.check_template("PD", save, allow_save=True) == []
    assert any("STOP" in e for e in bot.check_template("PD", {bot.HEAD: "", bot.LINE: "", bot.END: ""}))
    assert bot.fix_text("A\tB\x1bC\x7f")[0] == "A BC"  # control characters never reach Express as keys


def test_ahk_escapes_document_text():
    opts = bot.BotOptions(delay_ms=0)
    doc = StockDoc("OU", "OU1", remark='ช่าง "A" `x`;\nMsgBox "pwn"', lines=[DocLine("A", "a", 1)])
    script = bot.to_ahk([bot.actions_for(doc, opts)], opts)
    line = next(x for x in script.splitlines() if x.startswith("SendText") and "ช่าง" in x)
    assert line == 'SendText "ช่าง `"A`" ``x```;MsgBox `"pwn`""'
    assert 'if MsgBox("OU1: หน้าต่างด้านหน้าคือหน้าจอเอกสาร' in script


def test_the_express_screen_from_the_window_title():
    """Express writes the screen in its title (Express Accounting - PD - จ่ายวัตถุดิบเพื่อผลิต - [...]): a run stops before
    typing when another screen is open; AJ of this program is JU in Express; no screen in the title = not checked."""
    pd = "Express Accounting - PD - จ่ายวัตถุดิบเพื่อผลิต      - [PD - จ่ายวัตถุดิบเพื่อผลิต   ]"
    assert bot.screen_of(pd) == "PD" and bot.screen_of("Express Accounting - JU - ปรับปรุงเพิ่ม/ลดสินค้า") == "JU"
    assert bot.screen_of("Untitled - Notepad") == "" and bot.screen_of("Express Accounting") == ""
    assert not bot.screen_problem("PD", pd) and not bot.screen_problem("AJ", "Express Accounting - JU - x")
    assert not bot.screen_problem("PD", "Untitled - Notepad")
    assert "เป็นหน้าจอ OU แต่ใบนี้เป็น PD" in bot.screen_problem("PD", "Express Accounting - OU - จ่ายสินค้าใช้ภายใน")

    class Titled(Fake):
        def __init__(self, title):
            super().__init__()
            self.shown = title

        def title(self):
            return self.shown

    opts = bot.BotOptions(delay_ms=0)
    out = Titled("Express Accounting - OU - จ่ายสินค้าใช้ภายใน")
    with pytest.raises(bot.Stopped) as e:
        bot.run([bot.actions_for(_doc(), opts)], opts, out, sleep=lambda s: None)
    assert "หน้าจอ OU" in str(e.value) and out.typed == [] and not e.value.partial  # nothing typed
    out = Titled(pd)
    assert bot.run([bot.actions_for(_doc(), opts)], opts, out, sleep=lambda s: None) == ["PD6911-0001"]
    opts.check_screen = False
    assert bot.run([bot.actions_for(_doc(), opts)], opts, Titled("Express Accounting - OU - x"), sleep=lambda s: None)


def test_codes_checked_before_a_run():
    """Before a run: a แผนก that is not an Express code (Express opens its look-up list and every key after goes astray),
    a คลัง not in Express, a line without a code or a quantity, a code with stray spaces, a remark too long."""
    opts = bot.BotOptions(departments=["ST01", "08", "ACC", "SET"], warehouses=["01", "ST05"])
    assert bot.doc_problems(_doc(), opts) == []
    doc = _doc()
    doc.department = "สโตร์ตั้ม"
    doc.lines[1].warehouse = "02"
    doc.lines.append(DocLine(" RRS-T-002 ", "หน้าเฟรมบน T", 0, "ชน"))
    doc.lines.append(DocLine("", "ไม่มีรหัส", 1, "ชน"))
    got = "\n".join(bot.doc_problems(doc, opts))
    assert "แผนก “สโตร์ตั้ม” ไม่มีในรหัสแผนก" in got and "คลัง “02”" in got and "ช่องว่าง" in got
    assert "จำนวน 0" in got and "ไม่มีรหัสสินค้า" in got
    doc = _doc()
    doc.department = "สโตร์ ตั้มแอน"
    assert "ดูเหมือนชื่อ" in bot.doc_problems(doc, bot.BotOptions())[0]  # no list given: a name is still caught
    doc.department, doc.remark = "SET", "ก" * 80
    assert "หมายเหตุยาว" in bot.doc_problems(doc, bot.BotOptions())[0]


def test_step_by_step_waits_before_every_field_and_key():
    """ทดลองทีละขั้น: the run waits before every field / key (to see where the cursor is in Express); "doc" = the rest
    of the document without stopping; False = stop, with the document half typed."""
    opts = bot.BotOptions(delay_ms=0, step=True, confirm_first_only=True)
    asked = []

    def step(doc_no, where, what):
        asked.append((where, what))
        return "doc" if len(asked) == 3 else True

    out = Fake()
    assert bot.run([bot.actions_for(_doc(), opts)], opts, out, sleep=lambda s: None, step=step,
                   confirm=lambda d, q: True) == ["PD6911-0001"]
    assert asked[:3] == [("หัวเอกสาร", "กด F4"), ("หัวเอกสาร แผนก", "พิมพ์ “SET”"), ("หัวเอกสาร", "กด Enter")]
    assert len(asked) == 3 and out.typed[:2] == ["{F4}", "SET"]
    with pytest.raises(bot.Stopped) as e:
        bot.run([bot.actions_for(_doc(), opts)], opts, Fake(), sleep=lambda s: None, step=lambda *a: len(asked) < 0,
                confirm=lambda d, q: True)
    assert "ทีละขั้น" in str(e.value)
    assert bot.describe(bot.Action("key", "ENTER", 2)) == "กด Enter 2 ครั้ง"
    assert bot.describe(bot.Action("wait", "400")) == "รอ 0.4 วินาที"
