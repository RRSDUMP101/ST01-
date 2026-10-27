# RRS Part List Studio

แอปพลิเคชันเดสก์ท็อป **Windows / macOS** สำหรับจัดทำ **Part List (BOM)** จากแบบ 2D ของ **ZWCAD (ZW2D)**
แล้วเชื่อมกับ **สโตร์ / คลังสินค้า / ฝ่ายผลิต** และ **Google Sheets**

![ภาพรวม](docs/screenshots/1_dashboard.png)

## ทำอะไรได้

| | นำเข้า | ส่งออก |
|---|---|---|
| **ZWCAD (ZW2D)** | แบบ `.dwg` / `.dxf` – อ่าน Title Block, ตาราง BOM (ACAD_TABLE หรือเส้น+ข้อความ), รูปคลี่ → น้ำหนัก/ระยะตัด, **รหัส/ชื่อ/ความหนา/จำนวนรายชิ้น** จากป้ายที่รูปคลี่ (`RRS-T-001` / `เฟรมบน` / `t3` / `16 ชิ้น`) พร้อมปรับความหนา (ตามแบบ / กำหนดเอง), **ซ้าย/ขวา** จากตำแหน่งที่วาง (คู่ในแนวนอน: ฝั่งซ้าย = L, ฝั่งขวา = R), บล็อกชิ้นส่วนมาตรฐาน · ไฟล์ CSV/TXT/Excel จาก `TABLEEXPORT` / Data Extraction | ตาราง Part List เป็น `.dxf` (และ `.dwg` เมื่อมี ODA File Converter) สำหรับ `INSERT` ลงแบบ · BOM `.csv/.xlsx` หัวตารางอังกฤษสำหรับ Data Link |
| **Google Sheets** | Part List, สต็อกสโตร์ | Part List, สต็อก, ผลตรวจวัตถุดิบ |
| **Excel / CSV** | BOM, สต็อกสโตร์ (Excel/CSV รองรับภาษาไทย UTF-8 และ TIS-620) | Part List ภาษาไทยพร้อมหัวงาน, ผลตรวจวัตถุดิบ, ใบขอซื้อ (ร่าง), ทะเบียนแบบ |

| **Express** | ทะเบียนสินค้า/ยอดคงเหลือ (Excel/CSV), รายงานแบบข้อความ (.txt) | ร่าง PD จ่ายวัตถุดิบเพื่อผลิต, ร่างใบขอซื้อ, สินค้าใหม่สำหรับเปิดรหัส |
| **ไฟล์ของบริษัท** | 7. Parts List All Model (แบบกระบะ + รูป, สต๊อกเหล็ก, อะไหล่กระบะ), 10. นับสต๊อค (.xls) | ไฟล์รูปแบบเดียวกัน (พร้อมรูป), ใบจ่ายเหล็ก |

นอกจากนี้: คลังแบบกระบะมาตรฐานพร้อมรูป, หลายแหล่งสต็อกพร้อมกัน, **สต็อกเหล็ก** (ไฟล์ทะเบียนเหล็ก: หนา กว้าง ยาว กก./แผ่น + ยอดจาก Express / คิวเลเซอร์ใช้ / เหลือหลังตัด), **ตารางเทียบรหัส** (Express ↔ รหัสนับสต็อก),
ตรวจวัตถุดิบเทียบสต็อก × จำนวนคัน (เหล็กแผ่นคิดเป็นจำนวนแผ่น) – **รหัสในแบบไม่ตรงกับสต็อกก็จับคู่ให้อัตโนมัติ**:
อ่านรหัสทีละหลัก (`RRS-T-039` = Toyota ชิ้น 039 → `RRS-A-039-NO1-PR`, A = ทุกยี่ห้อ) แล้วจากชื่อชิ้นส่วน
(เลขชิ้นส่วน รุ่น ความสูงคอก ความยาว ซ้าย/ขวา – รวมข้างจากตำแหน่งที่วางในแบบ) และตรวจให้ทันทีเมื่อนำเข้าไฟล์สต็อก, อัปเดตสถานะ *พร้อม / ขาด / รอสั่งซื้อ* กลับเข้า Part List,
เทียบยอด Express ↔ Google Sheet, ทะเบียนแบบพร้อมสถานะ, บันทึกงานเป็นไฟล์ `.rrspl`

ระบบงานผลิต / สโตร์ ([docs/PRODUCTION_SYSTEM.md](docs/PRODUCTION_SYSTEM.md)):
1. **เลือกรุ่นย่อย** (รุ่นรถ / คอก 84-80-60-40 / ความยาว) ตอนสร้าง Part List หรืองานผลิตจากแบบกระบะ → ได้รหัส Express ทันที
2. **ควบคุมการตั้งรหัส** – ตรวจรหัส Express ที่ผิดรูปแบบ, ตั้งรหัสใหม่ตามกฎเดียวกัน กันรหัสซ้ำ
3. **ใบเบิก/รับ** PD · OU · FR · RR · AJ จากแบบ × จำนวนคัน พร้อม **ประวัติการเคลื่อนไหว** (บัตรสินค้า) และร่างสำหรับคีย์ Express
4. **งานผลิต (SO)** – ติดตามรายชิ้น รอตัด → รอพับ → รอเหยียบปิด → รอเชื่อม → เสร็จ · **ความพร้อมประกอบ** ต่อกลุ่ม ·
   **ใบงาน QR** (A6) · ใบจัดชุด · สแกนใบงานด้วยเครื่องสแกน USB
5. **ตัดเหล็ก / เลเซอร์** จากรูปคลี่ใน DWG – คลังรูปคลี่ตามรหัส → ตัดตามงานผลิตที่เปิดอยู่ → ตรวจก่อนตัด →
   โปรแกรมตัด LC… → ไฟล์ DXF สำหรับเครื่องเลเซอร์ + ใบสั่งตัด → คิวเลเซอร์ → บันทึกตัดเสร็จ ([docs/LASER_CUTTING.md](docs/LASER_CUTTING.md))
6. **Min / Max จากยอดใช้จริง** + เตือนสั่งซื้อ / ใบขอซื้อตามจุดสั่งซื้อ
7. **เทียบ Rev.** แบบ / Part List – เพิ่ม ตัด จำนวน ขนาด วัสดุ รูปคลี่
8. **ชิ้นส่วนพร้อมประกอบ แยก 10 กลุ่มประกอบ** – สต็อก 6 ช่องต่อรหัส (พร้อม · จอง · ใช้ได้ · ระหว่างผลิต · จะได้ · ขาด),
   ตำแหน่งเก็บ, ป้าย QR ชั้นวาง
9. **ตรวจและแก้แบบก่อนส่งตัด** – ต่อมุมที่ต่อไม่สนิท ตัดเส้นเกิน ลบเส้นซ้ำ แยกเส้นพับ ลบตัวเลข `90` ที่ลืมลบ อัตโนมัติ ·
   ใส่ **Mark** (รหัส, เส้นพับ) · **Nest** (ระยะห่างตามความหนา, หมุนชิ้นที่วาดเอียง) · **Gap / micro-joint** ([docs/PRE_CUT_CHECK.md](docs/PRE_CUT_CHECK.md))

รายละเอียดการวิเคราะห์ระบบ DWG ↔ สโตร์ ↔ ผลิต: [docs/DWG_INTEGRATION.md](docs/DWG_INTEGRATION.md)
การเชื่อม Express / Google Sheet / ไฟล์ Excel ของบริษัท: [docs/EXPRESS_INTEGRATION.md](docs/EXPRESS_INTEGRATION.md)
การออกแบบหน้าจอ: [docs/UI_DESIGN.md](docs/UI_DESIGN.md)
ปรับเมนูให้เป็นเส้นทางงานเดียว 6 ขั้น + ปุ่มขั้นต่อไป: [docs/UI_FLOW_REDESIGN.md](docs/UI_FLOW_REDESIGN.md)
ระบบสต็อกชิ้นส่วนรอประกอบ + การผลิตถึงประกอบ (กลุ่มประกอบ, ใบงาน QR, ความพร้อมประกอบ – ระยะ 1 ทำแล้ว): [docs/STOCK_PRODUCTION_DESIGN.md](docs/STOCK_PRODUCTION_DESIGN.md)
จากแบบ DWG สู่เครื่องตัดเลเซอร์: [docs/LASER_CUTTING.md](docs/LASER_CUTTING.md)
ตรวจและแก้แบบก่อนส่งตัด · Mark · Nest · Gap: [docs/PRE_CUT_CHECK.md](docs/PRE_CUT_CHECK.md)

## ติดตั้ง / รัน

### ติดตั้งบน Windows (แนะนำ)
1. เปิด GitHub → แท็บ **Actions** → รายการ **test-and-build** ล่าสุด (เครื่องหมาย ✓ สีเขียว)
2. ส่วน **Artifacts** ด้านล่าง → ดาวน์โหลด **`RRS-PartListStudio-Windows-Setup`** แล้วแตกไฟล์ zip
3. ดับเบิลคลิก **`RRS-PartListStudio-Setup-0.1.0.exe`** → Next → Install
   (ไม่ต้องใช้สิทธิ์ Administrator · ถ้า Windows SmartScreen เตือน ให้กด *More info → Run anyway* เพราะโปรแกรมยังไม่ได้ลงลายเซ็นดิจิทัล)
4. เปิดโปรแกรมจากไอคอน **RRS Part List Studio** บนเดสก์ท็อปหรือเมนู Start

ตัวติดตั้งมี **ตัวแปลง DWG (LibreDWG dwg2dxf)** ในตัว จึงเปิดไฟล์ `.dwg` ได้ทันที
(ถ้าติดตั้ง ODA File Converter ไว้ด้วย โปรแกรมจะเลือกใช้ ODA ก่อน) · ดับเบิลคลิกไฟล์งาน `.rrspl` จะเปิดในโปรแกรมให้อัตโนมัติ

แบบไม่ต้องติดตั้ง:
* **`RRS-PartListStudio-Windows-Portable`** – ไฟล์ .exe ไฟล์เดียว ดับเบิลคลิกได้เลย (เปิดครั้งแรกช้ากว่าปกติเล็กน้อย)
* `RRS-PartListStudio-Windows-x64` – โฟลเดอร์โปรแกรม: **คลิกขวาที่ zip → Extract All ก่อน** แล้วเปิด `RRS Part List Studio.exe`
  (ถ้าเปิดจากใน zip โดยตรงจะขึ้น *Failed to load Python DLL … python312.dll*)

### ติดตั้งบน macOS (macOS 11 Big Sur ขึ้นไป)
ทุกครั้งที่ push จะสร้างเฉพาะตัว Windows – ตัว macOS สร้างเมื่อสั่งเอง:
GitHub → **Actions** → **test-and-build** → **Run workflow** → ติ๊ก *Build the macOS apps too* → **Run workflow**

1. GitHub → **Actions** → **test-and-build** ที่สั่งสร้าง macOS → **Artifacts** → ดาวน์โหลดให้ตรงกับเครื่อง
   * **`RRS-PartListStudio-macOS-arm64-dmg`** – Mac ชิป Apple (M1/M2/M3/M4…)
   * **`RRS-PartListStudio-macOS-x64-dmg`** – Mac ชิป Intel
   (ดูชิปได้ที่เมนู  → About This Mac)
2. แตก zip → ดับเบิลคลิกไฟล์ `.dmg` → **ลากไอคอน RRS Part List Studio ไปวางที่ Applications**
   (ใน `.dmg` มีไฟล์ *วิธีเปิดครั้งแรก (อ่านก่อน).txt* ภาษาไทย)
3. เปิดครั้งแรก: แอปยังไม่ได้ลงทะเบียนนักพัฒนากับ Apple macOS จึงจะเตือน ให้ทำอย่างใดอย่างหนึ่ง
   * คลิกขวาที่แอปใน Applications → **Open** → **Open**
   * หรือ macOS 15 ขึ้นไป: เปิดแล้วกด Done → **System Settings → Privacy & Security** → เลื่อนลง กด **Open Anyway**
   * ถ้าขึ้นว่า "is damaged": เปิด Terminal แล้วพิมพ์ `xattr -cr "/Applications/RRS Part List Studio.app"`
4. ครั้งต่อไปเปิดจาก Launchpad หรือ Applications ได้ตามปกติ

ตัว macOS มี **ตัวแปลง DWG (LibreDWG dwg2dxf)** ในตัวเหมือน Windows จึงเปิดไฟล์ `.dwg` ได้ทันที
(แบบไม่ต้องติดตั้ง: ดาวน์โหลด `RRS-PartListStudio-macOS-arm64` / `-x64` เป็น zip ที่มี `.app` อยู่ข้างใน)

push แท็ก `v*` (เช่น `v0.1.0`) เพื่อแนบไฟล์ติดตั้ง Windows เข้า GitHub Release (ตัว macOS ใช้ Run workflow ตามด้านบน)

### รันจากซอร์สโค้ด (ต้องมี Python 3.10+)
* Windows: ดับเบิลคลิก `scripts\run_windows.bat`
* macOS: ดับเบิลคลิก `scripts/run_macos.command`
* หรือ: `pip install -e .` แล้วพิมพ์ `partlist-studio`

### Build เอง
* Windows: `scripts\build_windows.bat` → `dist\RRS Part List Studio\RRS Part List Studio.exe`
* macOS: `scripts/build_macos.sh` → `dist/RRS Part List Studio.app` (สร้างตัวแปลง DWG ให้ด้วย ใช้เวลาครั้งแรกไม่กี่นาที)
  ใช้ Python 3.12 · ติดตั้ง PySide6 6.7.3 / numpy ที่สร้างสำหรับ macOS 11 (`scripts/macos_deps.sh`) แล้วตรวจด้วย
  `tools/macho_min_os.py` ว่าทุกไฟล์ในแอปเปิดได้บน macOS 11 – รุ่นใหม่ของ PySide6 เปิดได้เฉพาะ macOS รุ่นใหม่มาก

### อ่านไฟล์ DWG
DWG เป็นรูปแบบปิด ต้องแปลงเป็น DXF ก่อนอ่าน: ตัวติดตั้ง Windows และ macOS มี LibreDWG ในตัวแล้ว ·
ใช้ **[ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter)** (ฟรี, แม่นยำกว่า) ได้ โดยกด *ค้นหาอัตโนมัติ* ในหน้า **ตั้งค่า** ·
หรือใน ZWCAD ใช้ *Save As → DXF* แล้วนำเข้า DXF โดยตรง
LibreDWG เป็นซอฟต์แวร์ GPLv3 (ไฟล์สัญญาอนุญาตอยู่ในโฟลเดอร์ `libredwg` ของโปรแกรม)

### Google Sheets
1. Google Cloud Console → เปิด *Google Sheets API* และ *Google Drive API*
2. เลือกอย่างใดอย่างหนึ่ง
   * **Service Account** (แนะนำสำหรับเครื่องสำนักงาน): สร้าง key JSON แล้ว **แชร์ Google Sheet ให้อีเมล Service Account** (ผู้แก้ไข)
   * **OAuth Client (Desktop app)**: ดาวน์โหลด JSON – ครั้งแรกจะเปิดเบราว์เซอร์ให้ล็อกอิน
3. หน้า **Google Sheets** ในโปรแกรม → เลือกไฟล์ JSON → วางลิงก์ชีต → *ทดสอบการเชื่อมต่อ*

อย่า commit ไฟล์ credentials เข้า Git (`.gitignore` กันไว้แล้ว)

## ขั้นตอนใช้งาน

0. ครั้งแรก: นำเข้า **7. Parts List All Model** (หน้า แบบกระบะ), **10. นับสต๊อค** (หน้า สโตร์) และไฟล์จาก **Express**
   แล้วสร้าง **ตารางเทียบรหัส** (หน้า Express) – ข้อมูลถูกเก็บไว้ในเครื่อง ใช้ต่อได้ทุกงาน
   · นำเข้า *รายงานรายละเอียดสินค้า (STMASR0200)* แล้วกด **ใช้รหัส Express กับแบบกระบะ** / **Parts List All Model (รหัส Express)**
1. **ภาพรวม** – กรอก SO, ลูกค้า, รุ่นรถ, แบบงาน, จำนวนคันที่ผลิต · หรือเลือก **แบบกระบะ** → สร้าง Part List จากแบบ
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
    steel.py         สต็อกเหล็ก: แผ่น/เส้น/ท่อ ขนาด น้ำหนัก ยอด คิวเลเซอร์ใช้ เหลือหลังตัด
    sides.py         ซ้าย/ขวา จากตำแหน่งที่วางในแบบ (คู่ในแนวนอน: ฝั่งซ้าย = L, ฝั่งขวา = R)
    partlist_io.py   นำเข้า/ส่งออกตาราง (ZWCAD TABLEEXPORT, Excel, CSV)
    mapping.py       จับคู่หัวตาราง ไทย/อังกฤษ/จีน → ช่องข้อมูล
    stock.py         สต็อกสโตร์, ตรวจวัตถุดิบ, ใบขอซื้อ
    express.py       Express: รายงานข้อความ/รายละเอียดสินค้า (STMASR0200), ร่าง PD/สินค้าใหม่, เทียบยอด, ตรวจรหัส
    express_codes.py ให้แบบกระบะใช้รหัสเต็มใน Express (ชื่อ + รุ่น + ความสูงคอก + ซ้าย/ขวา), เลือกรุ่นย่อย
    code_rules.py    กฎรหัสสินค้า: ตรวจรหัส Express ที่ผิดรูปแบบ, ตั้งรหัสใหม่
    movements.py     ใบเบิก/รับ (PD OU FR RR AJ) และประวัติการเคลื่อนไหวสินค้า
    production.py    งานผลิต (SO): สถานะรายชิ้นตามขั้นตอน, เอกสารของงาน, วัตถุดิบต่อชิ้น
    nesting.py       วางแผนตัดแผ่นเหล็กจากรูปคลี่ (MaxRects), Excel + DXF
    laser.py         ตัดเลเซอร์: คลังรูปคลี่, สิ่งที่ต้องตัดจากงานผลิต, ตรวจก่อนตัด, โปรแกรมตัด/คิว, ไฟล์ DXF สำหรับเครื่อง
    catalog.py       ประเภทสินค้า, 10 กลุ่มประกอบ, สต็อก 6 ช่อง, ความพร้อมประกอบ, ใบจัดชุด, ใบงาน, ป้ายชั้นวาง
    qr.py            ข้อความใน QR ของใบงาน/ป้ายชั้นวาง และการอ่านกลับ
    replenish.py     Min / Max จากยอดใช้จริง, เตือนสั่งซื้อ
    revision.py      เทียบ Rev. แบบ / Part List
    item_form.py     ฟอร์มทะเบียนสินค้า Express (Excel/Google Sheet พร้อมสูตร)
    partlist_express.py  Parts List All Model (รหัส Express) – ทุกแบบ + รูป + ฟอร์มเปิดรหัสใหม่
    company_files.py ไฟล์ Excel ของบริษัท (แบบกระบะ+รูป, นับสต๊อค, สต๊อกเหล็ก, อะไหล่กระบะ)
    xref.py          ตารางเทียบรหัสระหว่างระบบ
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
