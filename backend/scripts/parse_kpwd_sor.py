"""
Parse the Karnataka PWD Schedule of Rates for Buildings 2023-24 (Volume 2)
into JSON the backend can search.

    pip install pypdf
    python scripts/parse_kpwd_sor.py path/to/PWDSR-Vol-IIBuildings-GrandFinale-15-11-2023.pdf

Writes, next to this repo's backend/data/sor/:
  materials.json — "Basic Cost of Materials" (Sl No, description, unit, rate, page)
  items.json     — finished items from chapters 4-22 (code, description, unit, rate, page)

`page` is the printed page label used for citations; `pdf_page` is the index in the PDF file.

These files are for browsing/search only. The cost estimator reads the
hand-checked subset in core_rates.json, because PDF tables extract with
columns out of order in places (see IMPLEMENTATION_LOCATION.md §2).
"""
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "sor"

UNITS = r"(?:m2|m²|m3|m³|cum|sqm|No|Nos|kg|q|t|m|L|l|Each|each|Set|set|Pair|pair|10\s*No|100\s*No|10\s*cudm|Rm|RM|Job|LS)"
_RATE_TAIL = re.compile(rf"\s({UNITS})\s+([\d,]+\.\d{{2}})\s*$")
_ITEM_START = re.compile(r"^(\d{1,2}\.\d{1,3}(?:\.\d{1,3})*)\s+(\S.*)$")
_MATERIAL_ROW = re.compile(rf"^(\d{{1,4}})\s+(.+?)\s+({UNITS})\s+([\d,]+\.\d{{2}})\s*$")
_PAGE_LABEL = re.compile(r"^(?:Page\s*-\s*\d+|A-\d+|Karnataka Public Works Department.*|Sl No .*)$")


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\t", " ")).strip()


def _rate(s: str) -> float:
    return float(s.replace(",", ""))


def parse(pdf_path: str) -> tuple[list[dict], list[dict]]:
    reader = PdfReader(pdf_path)
    materials: list[dict] = []
    items: list[dict] = []
    in_materials = False
    current: dict | None = None  # finished item being accumulated
    parents: dict[str, str] = {}  # rate-less headings (e.g. 9.12) whose sub-items (9.12.2) carry the rate

    for page_no, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        # Cite the printed page label ("Page - 134" / "A-12"), not the PDF index
        label = re.search(r"Page\s*-\s*(\d+)", text) or re.search(r"^(A-\d+)\s*$", text, re.M)
        printed = label.group(1) if label else None
        for raw in text.splitlines():
            line = _clean(raw)
            if not line or _PAGE_LABEL.match(line):
                continue
            if line.startswith("ii. Basic Cost of Materials"):
                in_materials = True
                continue
            if in_materials and line.startswith(("vii. General", "iii.", "General Notes")):
                in_materials = False

            if in_materials:
                m = _MATERIAL_ROW.match(line)
                if m:
                    materials.append({
                        "sl_no": int(m.group(1)), "description": _clean(m.group(2)),
                        "unit": m.group(3), "rate": _rate(m.group(4)), "page": printed, "pdf_page": page_no,
                    })
                elif materials and not re.match(r"^\d", line):
                    materials[-1]["description"] = _clean(materials[-1]["description"] + " " + line)
                continue

            start = _ITEM_START.match(line)
            if start and page_no > 20:
                if current is not None:
                    parents[current["code"]] = current["description"]
                code = start.group(1)
                parent = parents.get(code.rsplit(".", 1)[0])
                desc = f"{parent} — {start.group(2)}" if parent and code.count(".") >= 2 else start.group(2)
                current = {"code": code, "description": desc, "page": printed, "pdf_page": page_no}
                line = start.group(2)
            elif current is not None:
                current["description"] = _clean(current["description"] + " " + line)

            if current is None:
                continue
            tail = _RATE_TAIL.search(" " + line)
            if tail or re.fullmatch(rf"({UNITS})\s+([\d,]+\.\d{{2}})", line):
                m = tail or re.fullmatch(rf"({UNITS})\s+([\d,]+\.\d{{2}})", line)
                desc = current["description"]
                desc = desc[: desc.rfind(m.group(1))].strip() if m.group(1) in desc else desc
                items.append({
                    "code": current["code"],
                    "chapter": int(current["code"].split(".")[0]),
                    "description": _clean(desc),
                    "unit": m.group(1).replace("²", "2").replace("³", "3"),
                    "rate": _rate(m.group(2)),
                    "page": current["page"],
                    "pdf_page": current["pdf_page"],
                })
                current = None
    return materials, items


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    materials, items = parse(sys.argv[1])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, rows in (("materials.json", materials), ("items.json", items)):
        (OUT_DIR / name).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{name}: {len(rows)} rows")


if __name__ == "__main__":
    main()
