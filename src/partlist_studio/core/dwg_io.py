"""2D drawings from ZWCAD (ZW2D): DWG/DXF import and DXF/DWG table export.

DWG is a closed binary format, so a .dwg is first converted to DXF with an
external converter (ODA File Converter - free for Windows/macOS/Linux - or
LibreDWG's dwg2dxf). DXF files are read directly with ezdxf.

From a drawing we extract what the store / warehouse / production flow needs:
  * title block attributes  -> drawing no., part name, material, thickness, qty, rev.
  * BOM table (ACAD_TABLE or TEXT grid) -> rows of the Part List
  * closed profiles (flat patterns)     -> net area, cutting length, weight per piece
  * standard-part blocks (bolts, hinges) -> purchased items to check against stock
"""

from __future__ import annotations

import bisect
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from glob import glob
from pathlib import Path

from .mapping import CAD_HEADERS, match_header, normalize
from .models import COLUMN_KEYS, COLUMN_LABELS, Part, PartList, to_number
from .partlist_io import TableImport, prepare_rows

DRAWING_SUFFIXES = {".dwg", ".dxf"}

# kg/dm3 (= g/cm3). Matched against the material text by prefix/substring.
DEFAULT_DENSITIES: dict[str, float] = {
    "SUS": 7.93,
    "STAINLESS": 7.93,
    "AL": 2.70,
    "A50": 2.68,
    "A60": 2.70,
    "CU": 8.96,
    "BRASS": 8.50,
    "SS400": 7.85,
    "SPHC": 7.85,
    "SPCC": 7.85,
    "SGCC": 7.85,
    "ST": 7.85,
}
STEEL_DENSITY = 7.85

# Layers that never hold cutting profiles.
IGNORE_LAYER_RE = re.compile(r"dim|text|title|frame|border|center|hidden|hatch|defpoints|note|ขอบ|กรอบ|ตาราง",
                             re.IGNORECASE)
NON_CUT_LINETYPES = {"CENTER", "CENTER2", "CENTERX2", "HIDDEN", "HIDDEN2", "DASHED", "PHANTOM", "DASHDOT", "DOT"}

# Title-block attribute tags -> Part / drawing fields (besides the generic header aliases).
TITLE_TAGS: dict[str, list[str]] = {
    "drawing_no": ["dwg no", "dwgno", "drawing no", "drawingno", "drg no", "dwg", "เลขที่แบบ", "เลขแบบ"],
    "part_no": ["part no", "partno", "part number", "code", "รหัสชิ้นส่วน", "รหัส"],
    "name": ["title", "name", "part name", "partname", "description", "ชื่อชิ้นงาน", "ชื่อชิ้นส่วน", "ชื่อแบบ"],
    "material": ["material", "mat", "วัสดุ"],
    "thickness": ["thk", "thickness", "t", "ความหนา"],
    "qty": ["qty", "quantity", "จำนวน"],
    "revision": ["rev", "revision", "แก้ไขครั้งที่"],
    "customer": ["customer", "client", "ลูกค้า"],
    "vehicle_model": ["model", "vehicle", "รุ่นรถ", "รุ่น"],
    "so_no": ["so", "so no", "order no", "job no"],
    "scale": ["scale", "มาตราส่วน"],
    "drawn_by": ["drawn", "drawn by", "designer", "ผู้เขียนแบบ", "ผู้ออกแบบ"],
}
_TITLE_LOOKUP = {normalize(alias): key for key, aliases in TITLE_TAGS.items() for alias in aliases}

# "MATERIAL : SS400", "THK. 3.2", "วัสดุ: SUS304" written as plain text.
_KEY_VALUE_RE = re.compile(r"^\s*([A-Za-z\u0E00-\u0E7F][\w\u0E00-\u0E7F .]*?)\s*[:=]\s*(.+?)\s*$")

_EMPTY_VALUES = {"-", "--", "---", "n/a", "N/A", "NA"}

_UNIT_TO_MM = {1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0, 14: 100.0}


class DrawingError(Exception):
    pass


# --------------------------------------------------------------------------
# DWG -> DXF conversion
# --------------------------------------------------------------------------
@dataclass
class Converter:
    kind: str  # "oda" | "libredwg"
    exe: str

    @property
    def label(self) -> str:
        return {"oda": "ODA File Converter", "libredwg": "LibreDWG dwg2dxf"}[self.kind] + f" ({self.exe})"


def _oda_candidates() -> list[str]:
    system = platform.system()
    if system == "Windows":
        roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", "")]
        found = []
        for root in filter(None, roots):
            found += sorted(glob(os.path.join(root, "ODA", "ODAFileConverter*", "ODAFileConverter.exe")), reverse=True)
        return found
    if system == "Darwin":
        return ["/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter"]
    return ["/usr/bin/ODAFileConverter", "/usr/local/bin/ODAFileConverter"]


def find_converter(custom_path: str = "") -> Converter | None:
    """Locate a DWG->DXF converter. custom_path (from Settings) wins."""
    if custom_path:
        if Path(custom_path).is_file():
            kind = "libredwg" if "dwg2dxf" in Path(custom_path).name.lower() else "oda"
            return Converter(kind, custom_path)
        return None
    for exe in _oda_candidates():
        if Path(exe).is_file():
            return Converter("oda", exe)
    for exe in _bundled_candidates():
        if exe.is_file():
            return Converter("libredwg", str(exe))
    for name in ("ODAFileConverter", "dwg2dxf"):
        exe = shutil.which(name)
        if exe:
            return Converter("oda" if name.startswith("ODA") else "libredwg", exe)
    return None


def _bundled_candidates() -> list[Path]:
    """dwg2dxf shipped inside the Windows installer (folder 'libredwg' next to the program)."""
    name = "dwg2dxf.exe" if platform.system() == "Windows" else "dwg2dxf"
    roots = [Path(sys.executable).resolve().parent]
    if getattr(sys, "_MEIPASS", None):
        roots.insert(0, Path(sys._MEIPASS))
    return [root / "libredwg" / name for root in roots]


def _run(cmd: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    kwargs = {}
    if platform.system() == "Windows":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kwargs)


def convert_dwg_to_dxf(dwg_path: str | Path, converter: Converter, out_dir: str | Path | None = None) -> Path:
    dwg_path = Path(dwg_path)
    out_dir = Path(out_dir or tempfile.mkdtemp(prefix="partlist_dwg_"))
    out_dir.mkdir(parents=True, exist_ok=True)
    if converter.kind == "libredwg":
        if platform.system() != "Windows" and not os.access(converter.exe, os.X_OK):
            os.chmod(converter.exe, 0o755)  # execute bit can get lost when copied into an app bundle
        target = out_dir / (dwg_path.stem + ".dxf")
        result = _run([converter.exe, "-y", "-o", str(target), str(dwg_path)])
    else:
        # ODAFileConverter <in dir> <out dir> <version> <type> <recurse> <audit> <filter>
        in_dir = Path(tempfile.mkdtemp(prefix="partlist_dwg_in_"))
        shutil.copy2(dwg_path, in_dir / dwg_path.name)
        cmd = [converter.exe, str(in_dir), str(out_dir), "ACAD2018", "DXF", "0", "1", dwg_path.name]
        if platform.system() == "Linux" and not os.environ.get("DISPLAY") and shutil.which("xvfb-run"):
            cmd = ["xvfb-run", "-a"] + cmd
        result = _run(cmd)
        shutil.rmtree(in_dir, ignore_errors=True)
        target = out_dir / (dwg_path.stem + ".dxf")
    if not target.is_file():
        detail = (result.stderr or result.stdout or "").strip()[-400:]
        raise DrawingError(f"แปลงไฟล์ DWG ไม่สำเร็จ: {dwg_path.name}\n{detail}")
    return target


def export_dxf_to_dwg(dxf_path: str | Path, dwg_path: str | Path, converter: Converter) -> Path:
    """DXF -> DWG (ODA File Converter only)."""
    if converter.kind != "oda":
        raise DrawingError("การบันทึกเป็น DWG ต้องใช้ ODA File Converter")
    dxf_path, dwg_path = Path(dxf_path), Path(dwg_path)
    in_dir = Path(tempfile.mkdtemp(prefix="partlist_dxf_in_"))
    out_dir = Path(tempfile.mkdtemp(prefix="partlist_dxf_out_"))
    shutil.copy2(dxf_path, in_dir / dxf_path.name)
    _run([converter.exe, str(in_dir), str(out_dir), "ACAD2018", "DWG", "0", "1", dxf_path.name])
    produced = out_dir / (dxf_path.stem + ".dwg")
    if not produced.is_file():
        raise DrawingError("บันทึกเป็น DWG ไม่สำเร็จ")
    shutil.move(str(produced), dwg_path)
    shutil.rmtree(in_dir, ignore_errors=True)
    shutil.rmtree(out_dir, ignore_errors=True)
    return dwg_path


# --------------------------------------------------------------------------
# Extracted data
# --------------------------------------------------------------------------
@dataclass
class TextItem:
    text: str
    x: float  # approximate centre, mm
    y: float
    height: float
    layer: str = ""
    width: float = 0  # estimated

    @property
    def left(self) -> float:
        return self.x - self.width / 2

    @property
    def right(self) -> float:
        return self.x + self.width / 2


def _text_width(text: str, height: float) -> float:
    # Thai vowels and tone marks above/below the line take no width.
    return sum(1 for ch in text if not unicodedata.category(ch).startswith("M")) * height * 0.7


@dataclass
class Profile:
    points: list[tuple[float, float]]
    area: float  # mm2, gross (outer loop)
    perimeter: float  # mm
    layer: str = ""
    holes: list[int] = field(default_factory=list)  # indexes of hole profiles
    parent: int | None = None
    is_container: bool = False  # drawing frame / table border - not a part
    label: str = ""  # text written inside the outline (part name / number)
    net_area: float = 0
    cut_length: float = 0

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        return min(xs), min(ys), max(xs), max(ys)

    @property
    def size(self) -> tuple[float, float]:
        x0, y0, x1, y1 = self.bbox
        return x1 - x0, y1 - y0

    @property
    def is_outer(self) -> bool:
        return self.parent is None and not self.is_container


@dataclass
class DrawingData:
    path: str
    source_path: str = ""  # original .dwg when converted
    units_to_mm: float = 1.0
    title_block: dict[str, str] = field(default_factory=dict)
    attributes: list[tuple[str, str, str]] = field(default_factory=list)  # (block, tag, value)
    bom: TableImport | None = None
    bom_source: str = ""  # "table" | "text"
    profiles: list[Profile] = field(default_factory=list)
    blocks: Counter = field(default_factory=Counter)
    texts: list[TextItem] = field(default_factory=list)
    preview: list[list[tuple[float, float]]] = field(default_factory=list)
    layers: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def file_name(self) -> str:
        return Path(self.source_path or self.path).name

    @property
    def outer_profiles(self) -> list[Profile]:
        return [p for p in self.profiles if p.is_outer]

    @property
    def thickness(self) -> float:
        return parse_thickness(self.title_block.get("thickness", "")) or parse_thickness(
            self.title_block.get("material", ""))


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------
def read_drawing(path: str | Path, converter: Converter | None = None, cut_layer: str = "") -> DrawingData:
    """Read a DWG (via converter) or DXF file and extract Part List information."""
    import ezdxf

    path = Path(path)
    source = ""
    if path.suffix.lower() == ".dwg":
        if converter is None:
            raise DrawingError("ยังไม่พบโปรแกรมแปลง DWG (ODA File Converter)\n"
                               "ติดตั้งแล้วระบุตำแหน่งในหน้า 'ตั้งค่า' หรือบันทึกแบบจาก ZWCAD เป็น DXF")
        source = str(path)
        path = convert_dwg_to_dxf(path, converter)
    try:
        doc = _open_dxf(path)
    except OSError as exc:
        raise DrawingError(f"เปิดไฟล์ไม่ได้: {exc}") from exc
    except ezdxf.DXFStructureError as exc:
        raise DrawingError(f"โครงสร้างไฟล์ DXF เสียหาย: {exc}") from exc

    scale = _UNIT_TO_MM.get(doc.header.get("$INSUNITS", 4), 1.0)
    data = DrawingData(path=str(path), source_path=source, units_to_mm=scale)
    data.layers = sorted(layer.dxf.name for layer in doc.layers)
    msp = doc.modelspace()

    texts: list[TextItem] = []
    tables: list[list[list[str]]] = []
    edge_entities = []
    closed_paths = []

    for entity in msp:
        _collect(entity, data, texts, tables, edge_entities, closed_paths, depth=0, cut_layer=cut_layer)
    # Paper space usually holds the frame + title block.
    for layout in doc.layouts:
        if layout.name.lower() == "model":
            continue
        for entity in layout:
            if entity.dxftype() in ("INSERT", "TEXT", "MTEXT", "ACAD_TABLE"):
                _collect(entity, data, texts, tables, [], [], depth=0, cut_layer=cut_layer)

    data.texts = texts
    _title_from_texts(data, texts)
    _find_bom(data, tables, texts)
    data.profiles = _build_profiles(edge_entities, closed_paths, scale)
    _classify_profiles(data)
    if not data.bom and not data.outer_profiles and not data.title_block:
        data.warnings.append("ไม่พบ Title Block, ตาราง BOM หรือรูปคลี่ชิ้นงานในไฟล์นี้")
    return data


def _open_dxf(path: Path):
    import ezdxf
    from ezdxf import recover

    try:
        return ezdxf.readfile(path)
    except ezdxf.DXFStructureError:
        pass
    try:
        return recover.readfile(path)[0]
    except ezdxf.DXFStructureError:
        repaired = repair_wrapped_values(path)
        if repaired is None:
            raise
        return recover.readfile(repaired)[0]


def repair_wrapped_values(path: Path) -> Path | None:
    """Re-join values that a converter wrapped onto a new line.

    LibreDWG's dwg2dxf breaks long MTEXT strings (common with Thai text in ZWCAD) in the
    middle of a value, so the next line is not a group code. Such a line belongs to the value
    before it. Returns the repaired copy, or None when nothing needed fixing.
    """
    raw = Path(path).read_bytes()
    lines = raw.split(b"\n")
    out: list[bytes] = []
    fixed = 0
    expect_code = True
    for line in lines:
        if expect_code:
            if line.strip().lstrip(b"-").isdigit() or not line.strip():
                out.append(line)
                expect_code = False
            else:  # continuation of the previous value
                out[-1] = out[-1].rstrip(b"\r") + line
                fixed += 1
        else:
            out.append(line)
            expect_code = True
    if not fixed:
        return None
    target = Path(path).with_name(Path(path).stem + "_repaired.dxf")
    target.write_bytes(b"\n".join(out))
    return target


def _collect(entity, data: DrawingData, texts, tables, edge_entities, closed_paths, depth: int, cut_layer: str):
    from ezdxf import path as ezpath

    kind = entity.dxftype()
    layer = entity.dxf.get("layer", "0")
    if kind in ("TEXT", "MTEXT", "ATTRIB"):
        item = _text_item(entity, data.units_to_mm)
        if item:
            texts.append(item)
        return
    if kind == "ACAD_TABLE":
        try:
            from ezdxf.entities.acad_table import read_acad_table_content

            tables.append([[_clean_text(c) for c in row] for row in read_acad_table_content(entity)])
        except Exception as exc:  # noqa: BLE001 - malformed tables are common, keep going
            data.warnings.append(f"อ่านตาราง ACAD_TABLE ไม่ได้: {exc}")
        return
    if kind == "INSERT":
        name = entity.dxf.name
        attribs = list(entity.attribs)
        for attrib in attribs:
            tag, value = attrib.dxf.tag, _clean_text(attrib.dxf.text)
            if value in _EMPTY_VALUES:
                value = ""
            data.attributes.append((name, tag, value))
            key = _TITLE_LOOKUP.get(normalize(tag))
            if key and value and key not in data.title_block:
                data.title_block[key] = value
            item = _text_item(attrib, data.units_to_mm)
            if item:
                texts.append(item)
        if not name.startswith("*") and not attribs and depth == 0:
            data.blocks[name] += 1
        if depth < 2:
            try:
                for sub in entity.virtual_entities():
                    if sub.dxftype() != "ATTDEF":
                        _collect(sub, data, texts, tables, edge_entities, closed_paths, depth + 1, cut_layer)
            except Exception:  # noqa: BLE001 - non-uniform scaling etc.
                pass
        return
    if kind not in ("LINE", "ARC", "CIRCLE", "LWPOLYLINE", "POLYLINE", "SPLINE", "ELLIPSE"):
        return
    try:
        p = ezpath.make_path(entity)
    except Exception:  # noqa: BLE001
        return
    if len(data.preview) < 20000:
        pts = [(v.x * data.units_to_mm, v.y * data.units_to_mm) for v in p.flattening(0.5)]
        if len(pts) >= 2:
            data.preview.append(pts)
    # Geometry inside blocks (bolts, hinges, title frames) is shown but is not a cutting profile,
    # unless the user named the cutting layer explicitly.
    if (depth > 0 and not cut_layer) or not _is_cut_entity(entity, layer, cut_layer):
        return
    if _is_closed(entity, p):
        closed_paths.append((p, layer))
    elif kind in ("LINE", "ARC", "LWPOLYLINE", "POLYLINE", "SPLINE", "ELLIPSE"):
        edge_entities.append(entity)


def _is_cut_entity(entity, layer: str, cut_layer: str) -> bool:
    if cut_layer:
        return layer.lower() == cut_layer.lower()
    if IGNORE_LAYER_RE.search(layer):
        return False
    linetype = entity.dxf.get("linetype", "BYLAYER").upper()
    if linetype == "BYLAYER" and entity.doc and layer in entity.doc.layers:
        linetype = entity.doc.layers.get(layer).dxf.get("linetype", "CONTINUOUS").upper()
    return linetype not in NON_CUT_LINETYPES


def _is_closed(entity, p) -> bool:
    kind = entity.dxftype()
    if kind == "CIRCLE":
        return True
    if kind in ("LWPOLYLINE", "POLYLINE"):
        return bool(entity.closed) or (len(p) > 0 and p.start.isclose(p.end, abs_tol=1e-6))
    if kind == "ELLIPSE":
        return math.isclose(abs(entity.dxf.end_param - entity.dxf.start_param), math.tau, abs_tol=1e-6)
    if kind == "SPLINE":
        return bool(entity.closed) or (len(p) > 0 and p.start.isclose(p.end, abs_tol=1e-6))
    return False


def _clean_text(text) -> str:
    text = "" if text is None else str(text)
    text = text.replace("%%c", "Ø").replace("%%C", "Ø").replace("%%d", "°").replace("%%p", "±")
    text = re.sub(r"\\[A-Za-z][^;\\]*;|\\P|[{}]", " ", text)  # MTEXT inline codes
    return re.sub(r"\s+", " ", text).strip()


def _text_item(entity, scale: float) -> TextItem | None:
    kind = entity.dxftype()
    if kind == "MTEXT":
        text = _clean_text(entity.plain_text())
        height = entity.dxf.get("char_height", 2.5)
        x, y = entity.dxf.insert.x, entity.dxf.insert.y
        attach = entity.dxf.get("attachment_point", 1)
        halign = (attach - 1) % 3  # 0 left, 1 centre, 2 right
        valign = (attach - 1) // 3  # 0 top, 1 middle, 2 bottom
        y += {0: -height / 2, 1: 0, 2: height / 2}[valign]
    else:
        text = _clean_text(entity.dxf.get("text", ""))
        height = entity.dxf.get("height", 2.5)
        h = entity.dxf.get("halign", 0)
        v = entity.dxf.get("valign", 0)
        if (h or v) and entity.dxf.hasattr("align_point"):
            x, y = entity.dxf.align_point.x, entity.dxf.align_point.y
        else:
            x, y = entity.dxf.insert.x, entity.dxf.insert.y
        halign = {0: 0, 1: 1, 2: 2, 4: 1}.get(h, 0)
        if v in (0, 1):
            y += height / 2
        elif v == 3:
            y -= height / 2
    if not text:
        return None
    width = _text_width(text, height)
    x += {0: width / 2, 1: 0, 2: -width / 2}[halign]
    return TextItem(text, x * scale, y * scale, height * scale, entity.dxf.get("layer", "0"), width * scale)


def _title_from_texts(data: DrawingData, texts: list[TextItem]) -> None:
    """'MATERIAL : SS400' style notes. A key written with different values in one drawing
    (e.g. 'Thickness=3.00' and 'Thickness=4.00' next to each flat pattern exported from a
    sheet-metal program) describes single parts, not the whole drawing, so it is skipped."""
    found: dict[str, set[str]] = {}
    for item in texts:
        match = _KEY_VALUE_RE.match(item.text)
        if not match:
            continue
        key, value = _TITLE_LOOKUP.get(normalize(match.group(1))), match.group(2)
        if not key or value in _EMPTY_VALUES or (key == "material" and value.isdigit()):
            continue
        found.setdefault(key, set()).add(value)
    for key, values in found.items():
        if len(values) == 1 and key not in data.title_block:
            data.title_block[key] = values.pop()


# ---- BOM table ----------------------------------------------------------
def _find_bom(data: DrawingData, tables: list[list[list[str]]], texts: list[TextItem]) -> None:
    best: TableImport | None = None
    for rows in tables:
        candidate = prepare_rows(rows)
        if len(candidate.mapping) >= 2 and (best is None or len(candidate.data_rows) > len(best.data_rows)):
            best = candidate
    if best:
        data.bom, data.bom_source = best, "table"
        return
    grid = _text_grid_table(texts)
    if grid:
        data.bom, data.bom_source = grid, "text"


def _group_rows(texts: list[TextItem]) -> list[list[TextItem]]:
    rows: list[list[TextItem]] = []
    for item in sorted(texts, key=lambda t: -t.y):
        if rows:
            ref = rows[-1][0]
            if abs(ref.y - item.y) <= max(ref.height, item.height) * 0.6:
                rows[-1].append(item)
                continue
        rows.append([item])
    for row in rows:
        row.sort(key=lambda t: t.x)
    return rows


def _text_grid_table(texts: list[TextItem]) -> TableImport | None:
    """Rebuild a BOM drawn as lines + TEXT (the usual way in ZWCAD title blocks)."""
    candidates = [t for t in texts if not _KEY_VALUE_RE.match(t.text)]
    rows = _group_rows(candidates)
    header_idx, header_hits = -1, 0
    for i, row in enumerate(rows):
        hits = len({match_header(t.text) for t in row} - {None})
        if hits >= 3 and hits > header_hits:
            header_idx, header_hits = i, hits
    if header_idx < 0:
        return None
    header = rows[header_idx]
    # Column boundaries half way between neighbouring header captions. Using the caption extents
    # (not their centres) keeps short left-aligned values such as "P-1" in the right column.
    bounds = [(a.right + b.left) / 2 for a, b in zip(header, header[1:])]
    margin = header[0].height * 6
    left, right = header[0].left - margin, header[-1].right + margin
    pitch = header[0].height * 2.5

    def to_cells(row: list[TextItem]) -> list[str] | None:
        cells = [""] * len(header)
        inside = [t for t in row if left <= t.x <= right]
        if not inside:
            return None
        for t in inside:
            idx = bisect.bisect(bounds, t.x)
            cells[idx] = (cells[idx] + " " + t.text).strip()
        return cells

    def collect(direction: int) -> list[list[str]]:
        out, last_y, i, limit = [], header[0].y, header_idx + direction, pitch * 2.2
        while 0 <= i < len(rows):
            row = rows[i]
            gap = abs(row[0].y - last_y)
            if gap > limit:
                break
            cells = to_cells(row)
            if cells is None or sum(1 for c in cells if c) < 2:
                break
            if not out:
                limit = max(limit, gap * 1.6)  # actual row pitch of this table
            out.append(cells)
            last_y = row[0].y
            i += direction
        return out

    below = collect(+1)
    above = collect(-1)  # BOM grows upward from the title block -> header at the bottom
    body = below if len(below) >= len(above) else above
    if not body:
        return None
    item_col = next((i for i, t in enumerate(header) if match_header(t.text) == "item_no"), None)
    if item_col is not None and all(re.fullmatch(r"\d+", r[item_col] or "") for r in body):
        body.sort(key=lambda r: int(r[item_col]))
    table = prepare_rows([[t.text for t in header]] + body)
    table.header_index = 0
    return table


# ---- profiles -------------------------------------------------------------
def _polygon(p, scale: float) -> list[tuple[float, float]]:
    return [(v.x * scale, v.y * scale) for v in p.flattening(0.05)]


def _area(points: list[tuple[float, float]]) -> float:
    s = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        s += x0 * y1 - x1 * y0
    return abs(s) / 2


def _perimeter(points: list[tuple[float, float]], closed: bool = True) -> float:
    pts = points + points[:1] if closed else points
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))


def _build_profiles(edge_entities, closed_paths, scale: float) -> list[Profile]:
    profiles: list[Profile] = []
    for p, layer in closed_paths:
        pts = _polygon(p, scale)
        if len(pts) >= 3:
            profiles.append(Profile(pts, _area(pts), _perimeter(pts), layer))
    if edge_entities:
        from ezdxf import edgeminer, edgesmith

        try:
            edges = list(edgesmith.edges_from_entities_2d(edge_entities, gap_tol=0.01))
            deposit = edgeminer.Deposit(edges, gap_tol=0.01)
            for chain in edgeminer.find_all_simple_chains(deposit):
                if edgeminer.is_loop(chain, gap_tol=0.01):
                    pts = _polygon(edgesmith.path2d_from_chain(chain), scale)
                    payload = getattr(chain[0], "payload", None)
                    layer = payload.dxf.layer if payload is not None else ""
                    if len(pts) >= 3:
                        profiles.append(Profile(pts, _area(pts), _perimeter(pts), layer))
        except Exception:  # noqa: BLE001 - chaining is best effort
            pass
    return [p for p in profiles if p.area > 1.0]  # drop specks (< 1 mm2)


def _inside(inner: Profile, outer: Profile) -> bool:
    from ezdxf.math import Vec2, is_point_in_polygon_2d

    ix0, iy0, ix1, iy1 = inner.bbox
    ox0, oy0, ox1, oy1 = outer.bbox
    if ix0 < ox0 or iy0 < oy0 or ix1 > ox1 or iy1 > oy1 or inner.area >= outer.area:
        return False
    poly = [Vec2(p) for p in outer.points]
    probe = inner.points[: max(1, min(8, len(inner.points)))]
    return all(is_point_in_polygon_2d(Vec2(pt), poly) >= 0 for pt in probe)


def _point_in(profile: Profile, x: float, y: float) -> bool:
    from ezdxf.math import Vec2, is_point_in_polygon_2d

    x0, y0, x1, y1 = profile.bbox
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    return is_point_in_polygon_2d(Vec2(x, y), [Vec2(p) for p in profile.points]) > 0


def _classify_profiles(data: DrawingData) -> None:
    profiles = data.profiles
    profiles.sort(key=lambda p: -p.area)
    # Frames and table borders: they contain the title block / BOM text.
    table_points = [(t.x, t.y) for t in data.texts if match_header(t.text) or _KEY_VALUE_RE.match(t.text)]
    table_points += [(t.x, t.y) for t in data.texts
                     if any(t.text == v for _b, _tag, v in data.attributes if v)]
    for prof in profiles:
        if any(_point_in(prof, x, y) for x, y in table_points):
            prof.is_container = True
    # Containment tree among the remaining loops (smallest enclosing loop = parent).
    active = [i for i, p in enumerate(profiles) if not p.is_container]
    for pos, i in enumerate(active):
        for j in reversed(active[:pos]):
            if _inside(profiles[i], profiles[j]):
                profiles[i].parent = j
                break
    # A loop whose children have children is a frame around parts, not a part.
    for i in active:
        kids = [k for k in active if profiles[k].parent == i]
        if any(profiles[g].parent in kids for g in active):
            profiles[i].is_container = True
            for k in kids:
                profiles[k].parent = None
    for i in active:
        prof = profiles[i]
        if prof.is_container:
            continue
        if prof.parent is not None and profiles[prof.parent].is_container:
            prof.parent = None
        if prof.parent is not None:
            profiles[prof.parent].holes.append(i)
    for prof in profiles:
        if prof.is_outer:
            holes = [profiles[h] for h in prof.holes]
            prof.net_area = prof.area - sum(h.area for h in holes)
            prof.cut_length = prof.perimeter + sum(h.perimeter for h in holes)
            labels = [t.text for t in data.texts
                      if _point_in(prof, t.x, t.y) and not any(_point_in(h, t.x, t.y) for h in holes)]
            prof.label = " ".join(labels[:2])


# --------------------------------------------------------------------------
# Drawing -> Part List rows
# --------------------------------------------------------------------------
def parse_thickness(text: str) -> float:
    """'t3.2', 'THK 3', '3.2 mm', 'SS400 t=4.5' -> mm."""
    if not text:
        return 0
    match = re.search(r"(?:\bt|thk\.?|หนา)\s*=?\s*(\d+(?:\.\d+)?)", str(text), re.IGNORECASE)
    if match:
        return float(match.group(1))
    if re.fullmatch(r"\s*\d+(?:\.\d+)?\s*(mm)?\s*", str(text), re.IGNORECASE):
        return float(to_number(text))
    return 0


def density_for(material: str, densities: dict[str, float] | None = None) -> float:
    densities = densities or DEFAULT_DENSITIES
    mat = (material or "").upper().replace(" ", "")
    for key in sorted(densities, key=len, reverse=True):
        if mat.startswith(key.upper()) or (len(key) > 3 and key.upper() in mat):
            return densities[key]
    return STEEL_DENSITY


def plate_weight(net_area_mm2: float, thickness_mm: float, density: float) -> float:
    """kg = mm2 x mm x kg/dm3 x 1e-6"""
    return round(net_area_mm2 * thickness_mm * density * 1e-6, 3)


@dataclass
class CandidatePart:
    part: Part
    source: str  # "bom" | "title" | "profile" | "block"
    profile_index: int | None = None
    selected: bool = True


def drawing_to_candidates(data: DrawingData, densities: dict[str, float] | None = None,
                          include_blocks: bool = False) -> list[CandidatePart]:
    """Propose Part List rows from a drawing. The user reviews them before they are added."""
    tb = data.title_block
    drawing_no = tb.get("drawing_no") or Path(data.file_name).stem
    thickness = data.thickness
    material = tb.get("material", "")
    candidates: list[CandidatePart] = []

    if data.bom:
        for part in data.bom.to_parts():
            part.drawing_no = part.drawing_no or drawing_no
            if not part.material and material:
                part.material = material
            candidates.append(CandidatePart(part, "bom"))

    outers = [(i, p) for i, p in enumerate(data.profiles) if p.is_outer]
    if not data.bom and outers:
        single = len(outers) == 1
        for n, (i, prof) in enumerate(outers, start=1):
            w, h = prof.size
            part = Part(
                part_no=(tb.get("part_no") or tb.get("drawing_no", "")) if single else "",
                drawing_no=drawing_no,
                name=(tb.get("name", "") if single else "") or prof.label or f"ชิ้นที่ {n}",
                material=material,
                spec=f"t{_fmt(thickness)} x {w:.0f} x {h:.0f}" if thickness else f"{w:.0f} x {h:.0f}",
                qty=(to_number(tb.get("qty", 1)) or 1) if single else 1,
                process="ตัด/พับ",
                remark=f"พื้นที่สุทธิ {prof.net_area / 1e6:.4f} m² · ระยะตัด {prof.cut_length:,.0f} mm"
                       f" · รู {len(prof.holes)}",
            )
            if thickness:
                part.weight = plate_weight(prof.net_area, thickness, density_for(material, densities))
            candidates.append(CandidatePart(part, "profile", profile_index=i))
    elif not data.bom and (tb.get("name") or tb.get("part_no")):
        candidates.append(CandidatePart(Part(
            part_no=tb.get("part_no", ""), drawing_no=drawing_no, name=tb.get("name", ""),
            material=material, spec=f"t{_fmt(thickness)}" if thickness else "",
            qty=to_number(tb.get("qty", 1)) or 1), "title"))

    if include_blocks:
        for name, count in sorted(data.blocks.items()):
            candidates.append(CandidatePart(
                Part(name=name, drawing_no=drawing_no, qty=count, process="ซื้อสำเร็จ", unit="ตัว"),
                "block", selected=False))
    return candidates


def _fmt(value: float) -> str:
    return f"{value:g}"


def drawing_record(data: DrawingData, part_count: int):
    from .models import DrawingRecord

    tb = data.title_block
    return DrawingRecord(
        file_name=data.file_name,
        path=data.source_path or data.path,
        drawing_no=tb.get("drawing_no", "") or Path(data.file_name).stem,
        title=tb.get("name", ""),
        revision=tb.get("revision", ""),
        material=tb.get("material", ""),
        thickness=_fmt(data.thickness) if data.thickness else "",
        part_count=part_count,
    )


# --------------------------------------------------------------------------
# Export: Part List as a table drawing ZWCAD can open / insert
# --------------------------------------------------------------------------
_DXF_COL_WIDTH = {"item_no": 12, "part_no": 35, "drawing_no": 35, "name": 60, "material": 28, "spec": 40,
                  "qty": 15, "unit": 15, "weight": 22, "stock_code": 30, "process": 28, "status": 22, "remark": 60}


def export_dxf_table(partlist: PartList, path: str | Path, thai_headers: bool = True,
                     text_height: float = 3.5) -> Path:
    import ezdxf
    from ezdxf.enums import TextEntityAlignment

    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.styles.add("PARTLIST", font="tahoma.ttf")  # Tahoma renders Thai in ZWCAD on Windows/macOS
    for name, color in (("PARTLIST-GRID", 8), ("PARTLIST-TEXT", 7)):
        doc.layers.add(name, color=color)
    msp = doc.modelspace()
    row_h = text_height * 2.2
    widths = [_DXF_COL_WIDTH[k] for k in COLUMN_KEYS]
    total_w = sum(widths)
    attribs_grid = {"layer": "PARTLIST-GRID"}

    def put(text, x, y, align=TextEntityAlignment.MIDDLE_LEFT, height=text_height):
        if text in ("", None):
            return
        msp.add_text(str(text), height=height, dxfattribs={"layer": "PARTLIST-TEXT", "style": "PARTLIST"}
                     ).set_placement((x, y), align=align)

    info = partlist.info
    put(f"PART LIST  {info.drawing_no}  {info.vehicle_model}", 0, row_h * 2.2, height=text_height * 1.6)
    put(f"SO: {info.so_no}   ลูกค้า: {info.customer}   แบบงาน: {info.job_type}   Rev.{info.revision}"
        f"   จำนวนผลิต {info.build_qty} คัน", 0, row_h * 1.0)
    headers = [COLUMN_LABELS[k] if thai_headers else CAD_HEADERS[k] for k in COLUMN_KEYS]
    rows = [headers] + [[_dxf_value(p, k) for k in COLUMN_KEYS] for p in partlist.parts]
    n = len(rows)
    for r in range(n + 1):
        msp.add_line((0, -r * row_h), (total_w, -r * row_h), dxfattribs=attribs_grid)
    x = 0.0
    for w in widths + [0]:
        msp.add_line((x, 0), (x, -n * row_h), dxfattribs=attribs_grid)
        x += w
    for r, row in enumerate(rows):
        y = -(r + 0.5) * row_h
        x = 0.0
        for key, w, value in zip(COLUMN_KEYS, widths, row):
            centered = r == 0 or key in ("item_no", "qty", "unit", "weight", "status")
            if centered:
                put(value, x + w / 2, y, TextEntityAlignment.MIDDLE_CENTER)
            else:
                put(value, x + 1.5, y)
            x += w
    path = Path(path)
    doc.saveas(path)
    return path


def _dxf_value(part: Part, key: str) -> str:
    value = part.get(key)
    if key == "weight":
        return f"{value:g}" if value else ""
    if key == "qty":
        return f"{value:g}"
    return str(value)
