"""Google Sheets import/export (via gspread).

Two ways to sign in:
  * service  - a Service Account JSON key. Share the spreadsheet with the
               service account e-mail (Editor). Good for a shared office PC.
  * oauth    - an OAuth "Desktop app" client JSON. The browser opens once to
               sign in with the user's Google account; the token is cached.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file"]

_KEY_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")


class SheetsError(Exception):
    pass


def spreadsheet_key(url_or_key: str) -> str:
    text = (url_or_key or "").strip()
    match = _KEY_RE.search(text)
    if match:
        return match.group(1)
    if re.fullmatch(r"[a-zA-Z0-9-_]{20,}", text):
        return text
    raise SheetsError("ลิงก์ Google Sheet ไม่ถูกต้อง (ต้องเป็น https://docs.google.com/spreadsheets/d/...)")


def service_account_email(credentials_path: str) -> str:
    try:
        data = json.loads(Path(credentials_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return data.get("client_email", "")


def detect_mode(credentials_path: str) -> str:
    try:
        data = json.loads(Path(credentials_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SheetsError(f"อ่านไฟล์ credentials ไม่ได้: {exc}") from exc
    if data.get("type") == "service_account":
        return "service"
    if "installed" in data or "web" in data:
        return "oauth"
    raise SheetsError("ไฟล์ credentials ไม่ใช่ Service Account หรือ OAuth Client (Desktop app)")


class SheetsClient:
    def __init__(self, credentials_path: str, token_path: str | None = None, client=None):
        self.credentials_path = credentials_path
        self.token_path = token_path
        self._client = client  # injected in tests

    def client(self):
        if self._client is None:
            import gspread

            if not self.credentials_path:
                raise SheetsError("ยังไม่ได้เลือกไฟล์ credentials ของ Google (หน้า Google Sheets)")
            mode = detect_mode(self.credentials_path)
            try:
                if mode == "service":
                    self._client = gspread.service_account(filename=self.credentials_path, scopes=SCOPES)
                else:
                    self._client = gspread.oauth(scopes=SCOPES, credentials_filename=self.credentials_path,
                                                 authorized_user_filename=self.token_path)
            except Exception as exc:  # noqa: BLE001 - surface any auth problem to the user
                raise SheetsError(f"เชื่อมต่อ Google ไม่สำเร็จ: {exc}") from exc
        return self._client

    def _spreadsheet(self, url_or_key: str):
        try:
            return self.client().open_by_key(spreadsheet_key(url_or_key))
        except SheetsError:
            raise
        except Exception as exc:  # noqa: BLE001
            hint = ""
            email = service_account_email(self.credentials_path) if self.credentials_path else ""
            if email:
                hint = f"\nตรวจว่าแชร์ชีตให้ {email} (สิทธิ์ผู้แก้ไข) แล้ว"
            raise SheetsError(f"เปิด Google Sheet ไม่ได้: {exc}{hint}") from exc

    def worksheet_titles(self, url_or_key: str) -> list[str]:
        return [ws.title for ws in self._spreadsheet(url_or_key).worksheets()]

    def read_rows(self, url_or_key: str, worksheet: str) -> list[list]:
        sheet = self._spreadsheet(url_or_key)
        try:
            ws = sheet.worksheet(worksheet) if worksheet else sheet.sheet1
        except Exception as exc:  # noqa: BLE001
            raise SheetsError(f"ไม่พบแท็บ '{worksheet}' ใน Google Sheet") from exc
        return [row for row in ws.get_all_values() if any(str(c).strip() for c in row)]

    def write_rows(self, url_or_key: str, worksheet: str, rows: list[list]) -> str:
        """Replace the content of a tab (created when missing). Returns the sheet URL."""
        sheet = self._spreadsheet(url_or_key)
        width = max((len(r) for r in rows), default=1)
        try:
            ws = sheet.worksheet(worksheet)
        except Exception:  # noqa: BLE001 - gspread.WorksheetNotFound
            ws = sheet.add_worksheet(title=worksheet, rows=max(len(rows) + 20, 100), cols=max(width, 10))
        ws.clear()
        ws.update(values=[[_cell(v) for v in r] for r in rows], range_name="A1", value_input_option="USER_ENTERED")
        try:
            ws.format("1:1", {"textFormat": {"bold": True}, "backgroundColor": {"red": 0.86, "green": 0.91, "blue": 0.97}})
            ws.freeze(rows=1)
        except Exception:  # noqa: BLE001 - formatting is cosmetic
            pass
        return sheet.url


def _cell(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value
