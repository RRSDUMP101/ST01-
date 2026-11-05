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
