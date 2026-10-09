# RRS Part List Studio

แอปพลิเคชันเดสก์ท็อป **Windows / macOS** สำหรับจัดทำ **Part List (BOM)** จากแบบ 2D ของ **ZWCAD (ZW2D)**
แล้วเชื่อมกับ **สโตร์ / คลังสินค้า / ฝ่ายผลิต** และ **Google Sheets**

![ภาพรวม](docs/screenshots/1_dashboard.png)

## ทำอะไรได้

| | นำเข้า | ส่งออก |
|---|---|---|
| **ZWCAD (ZW2D)** | แบบ `.dwg` / `.dxf` – อ่าน Title Block, ตาราง BOM (ACAD_TABLE หรือเส้น+ข้อความ), รูปคลี่ → น้ำหนัก/ระยะตัด, บล็อกชิ้นส่วนมาตรฐาน · ไฟล์ CSV/TXT/Excel จาก `TABLEEXPORT` / Data Extraction | ตาราง Part List เป็น `.dxf` (และ `.dwg` เมื่อมี ODA File Converter) สำหรับ `INSERT` ลงแบบ · BOM `.csv/.xlsx` หัวตารางอังกฤษสำหรับ Data Link |
| **Google Sheets** | Part List, สต็อกสโตร์ | Part List, สต็อก, ผลตรวจวัตถุดิบ |
| **Excel / CSV** | BOM, สต็อกสโตร์ (Excel/CSV รองรับภาษาไทย UTF-8 และ TIS-620) | Part List ภาษาไทยพร้อมหัวงาน, ผลตรวจวัตถุดิบ, ใบขอซื้อ (ร่าง), ทะเบียนแบบ |

นอกจากนี้: ตรวจวัตถุดิบเทียบสต็อก × จำนวนคัน, อัปเดตสถานะ *พร้อม / ขาด / รอสั่งซื้อ* กลับเข้า Part List,
ทะเบียนแบบพร้อมสถานะ, บันทึกงานเป็นไฟล์ `.rrspl`

รายละเอียดการวิเคราะห์ระบบ DWG ↔ สโตร์ ↔ ผลิต: [docs/DWG_INTEGRATION.md](docs/DWG_INTEGRATION.md)
การออกแบบหน้าจอ: [docs/UI_DESIGN.md](docs/UI_DESIGN.md)

## ติดตั้ง / รัน

### ใช้ตัวที่ build แล้ว
GitHub Actions build ให้อัตโนมัติทุกครั้งที่ push (แท็บ **Actions → test-and-build → Artifacts**):
`RRS-PartListStudio-Windows-x64.zip`, `RRS-PartListStudio-macOS-arm64.zip` (Apple Silicon), `RRS-PartListStudio-macOS-x64.zip` (Intel)
– push แท็ก `v*` เพื่อแนบไฟล์เข้า Release

* **Windows**: แตก zip → เปิด `RRS Part List Studio.exe`
* **macOS**: แตก zip → ลาก `RRS Part List Studio.app` ไป Applications → ครั้งแรกคลิกขวา → *Open*
  (แอปยังไม่ได้ sign กับ Apple)

### รันจากซอร์สโค้ด (ต้องมี Python 3.10+)
* Windows: ดับเบิลคลิก `scripts\run_windows.bat`
* macOS: ดับเบิลคลิก `scripts/run_macos.command`
* หรือ: `pip install -e .` แล้วพิมพ์ `partlist-studio`

### Build เอง
* Windows: `scripts\build_windows.bat` → `dist\RRS Part List Studio\RRS Part List Studio.exe`
* macOS: `scripts/build_macos.sh` → `dist/RRS Part List Studio.app`

### อ่านไฟล์ DWG
DWG เป็นรูปแบบปิด ต้องติดตั้ง **[ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter)** (ฟรี)
แล้วกด *ค้นหาอัตโนมัติ* ในหน้า **ตั้งค่า** – หรือใน ZWCAD ใช้ *Save As → DXF* แล้วนำเข้า DXF ได้เลยโดยไม่ต้องติดตั้งอะไรเพิ่ม

### Google Sheets
1. Google Cloud Console → เปิด *Google Sheets API* และ *Google Drive API*
2. เลือกอย่างใดอย่างหนึ่ง
   * **Service Account** (แนะนำสำหรับเครื่องสำนักงาน): สร้าง key JSON แล้ว **แชร์ Google Sheet ให้อีเมล Service Account** (ผู้แก้ไข)
   * **OAuth Client (Desktop app)**: ดาวน์โหลด JSON – ครั้งแรกจะเปิดเบราว์เซอร์ให้ล็อกอิน
3. หน้า **Google Sheets** ในโปรแกรม → เลือกไฟล์ JSON → วางลิงก์ชีต → *ทดสอบการเชื่อมต่อ*

อย่า commit ไฟล์ credentials เข้า Git (`.gitignore` กันไว้แล้ว)

## ขั้นตอนใช้งาน

1. **ภาพรวม** – กรอก SO, ลูกค้า, รุ่นรถ, แบบงาน, จำนวนคันที่ผลิต
2. **นำเข้าแบบ DWG/DXF** (เลือกหลายไฟล์ หรือ ลากไฟล์มาวาง) → ตรวจรายการที่อ่านได้ ติ๊กเลือก แก้ไข → *เพิ่มเข้า Part List*
3. **Part List** – แก้ไขแถวสีแดง/เหลือง (ไม่มีรหัส/ชื่อ, จำนวน 0, ไม่ระบุวัสดุ, รหัสซ้ำ)
4. **สโตร์ / คลังสินค้า** – นำเข้าไฟล์สต็อกล่าสุดของสโตร์ (หรือดึงจาก Google Sheet) → *ตรวจวัตถุดิบเทียบสต็อก*
   → *อัปเดตสถานะใน Part List* → *ส่งออกใบขอซื้อ (ร่าง)* ให้จัดซื้อ
5. **ส่งต่อ** – ส่ง Part List / ผลตรวจขึ้น Google Sheet, ส่งออก Excel ให้ฝ่ายผลิต, ส่งออกตาราง DXF กลับไปวางในแบบ ZWCAD
6. **บันทึก** (`Ctrl/⌘+S`) เป็นไฟล์ `.rrspl`

ไฟล์ตัวอย่างอยู่ใน `samples/` (สร้างใหม่ได้ด้วย `python tools/make_samples.py`)

## โครงสร้างโปรเจกต์

```
src/partlist_studio/
  core/            ตรรกะทั้งหมด (ไม่ขึ้นกับหน้าจอ ทดสอบได้)
    models.py        Part, PartList, ข้อมูลงาน, ทะเบียนแบบ
    dwg_io.py        DWG→DXF, อ่าน Title Block/BOM/รูปคลี่, ส่งออกตาราง DXF/DWG
    partlist_io.py   นำเข้า/ส่งออกตาราง (ZWCAD TABLEEXPORT, Excel, CSV)
    mapping.py       จับคู่หัวตาราง ไทย/อังกฤษ/จีน → ช่องข้อมูล
    stock.py         สต็อกสโตร์, ตรวจวัตถุดิบ, ใบขอซื้อ
    gsheets.py       Google Sheets (gspread)
    tabular.py       อ่าน/เขียน CSV/TXT/XLSX/XLS
  ui/              หน้าจอ PySide6 (Qt)
tests/             pytest (core + UI แบบ headless)
packaging/         PyInstaller spec + ไอคอน
scripts/           รัน/build บน Windows, macOS
docs/              การออกแบบ UI, การวิเคราะห์ระบบ DWG, ภาพหน้าจอ
```

## พัฒนา

```
pip install -r requirements-dev.txt
QT_QPA_PLATFORM=offscreen python -m pytest      # Linux/CI ไม่มีจอ
python tools/screenshots.py                      # อัปเดตภาพหน้าจอใน docs/
```
