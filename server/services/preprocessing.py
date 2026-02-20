import copy
import csv
import io
import json
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from starlette.datastructures import FormData, UploadFile


CSV_HEADER_SPECS: Dict[str, Dict[str, Any]] = {
    "residents": {
        "label": "Residents CSV",
        "required": ["mcr", "name", "resident_year", "career_blocks_completed"],
        "aliases": {"career_blocks_completed": ["careerBlocksCompleted"]},
    },
    "resident_history": {
        "label": "Resident History CSV",
        "required": [
            "mcr",
            "year",
            "month_block",
            "career_block",
            "posting_code",
            "is_current_year",
            "is_leave",
            "leave_type",
        ],
        "aliases": {"is_current_year": ["isCurrentYear"], "is_leave": ["isLeave"]},
    },
    "resident_preferences": {
        "label": "Preferences CSV",
        "required": [
            "mcr",
            "preference_rank",
            "posting_code",
            "resident_sr_preferences",
        ],
        "aliases": {},
    },
    "postings": {
        "label": "Postings CSV",
        "required": [
            "posting_code",
            "posting_type",
            "max_residents",
            "required_block_duration",
        ],
        "aliases": {},
    },
}


SR_PREFERENCE_ALIASES: Dict[str, str] = {
    # aliases mapped to canonical base names.
    "Cardio": "CVM",
    "Endocrine": "Endocrine",
    "Gastro": "Gastro",
    "AIM": "GM",
    "GRM": "GRM",
    "Haemato": "Haemato",
    "ID": "ID",
    "Med Onco": "Med Onco",
    "Pall Med": "PMD",
    "RAI": "RAI",
    "Respi": "RCCM",
    "Respi": "MICU",
    "Rehab": "Rehab",
    "Renal": "Renal",
    "Neuro": "NL",
    "Derm": "Derm",
    "Unsure": "",
    "Gap Year": "",
}

def _normalise_sr_preference(value: Any) -> str:
    cleaned = str(value or "").strip()
    if not cleaned:
        return ""
    base = cleaned.split(" (")[0].strip()
    canonical = SR_PREFERENCE_ALIASES.get(base.lower())
    return canonical or base


def _sanitise_header(value: Any) -> str:
    try:
        text = str(value or "")
    except Exception:
        text = ""
    return text.strip().lstrip("\ufeff")


def _validate_csv_headers(
    headers: Optional[List[str]],
    required_headers: List[str],
    file_label: str,
    header_aliases: Optional[Dict[str, List[str]]] = None,
) -> None:
    """
    Ensure each CSV contains the expected headers without blanks or duplicates.
    """

    if not headers:
        raise HTTPException(
            status_code=400,
            detail=f"[{file_label}] No column headers found. Please check the CSV formatting.",
        )

    stripped_headers: List[str] = []
    blank_headers = []
    for header in headers:
        sanitised = _sanitise_header(header)
        if not sanitised:
            blank_headers.append(header)
        else:
            stripped_headers.append(sanitised)

    if blank_headers:
        raise HTTPException(
            status_code=400,
            detail=f"[{file_label}] Found blank column header(s). Please name every column.",
        )

    duplicates = [h for h, count in Counter(stripped_headers).items() if count > 1]
    if duplicates:
        dup_list = ", ".join(duplicates)
        raise HTTPException(
            status_code=400,
            detail=f"[{file_label}] Duplicate column header(s): {dup_list}.",
        )

    header_aliases = header_aliases or {}
    missing = []
    for required in required_headers:
        candidates = [required] + header_aliases.get(required, [])
        if not any(candidate in stripped_headers for candidate in candidates):
            missing.append(required)
    if missing:
        missing_list = ", ".join(missing)
        raise HTTPException(
            status_code=400,
            detail=f"[{file_label}] Missing required column(s): {missing_list}.",
        )


def parse_boolean_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    try:
        value_str = str(value).strip().lower()
    except Exception:
        return False
    if not value_str:
        return False
    if value_str in {"1", "true", "yes", "y"}:
        return True
    if value_str in {"0", "false", "no", "n"}:
        return False
    try:
        return float(value_str) != 0
    except (TypeError, ValueError):
        return False


def parse_int(value: Any) -> Optional[int]:
    try:
        result = int(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None
    return result

def parse_optimized_years(raw_values: List[str]) -> List[int]:
    """
    Normalize and parse optimized_years from form data.
    Handles common frontend mistakes like sending '[]', '', 'null', etc.
    Returns empty list if no valid years are provided.
    Raises HTTPException if invalid non-empty values are sent.
    """
    if not raw_values:
        return []

    # Clean and filter out junk
    cleaned = [v.strip() for v in raw_values if v is not None and v.strip()]

    # Treat these as explicitly empty
    if not cleaned or cleaned in [["[]"], [""], ["null"], ["[] "]]:  # allow some whitespace
        return []

    # Try to parse as integers
    try:
        years = [int(v) for v in cleaned]
        return years
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"optimized_years must be empty or contain valid integers. Got: {raw_values!r}"
        )

def parse_max_time_in_minutes(raw: Any) -> Optional[int]:
    value = parse_int(raw)
    if value is None or value <= 0:
        return None
    return value


def parse_weightages(
    raw: Any, fallback: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    fallback = {**(fallback or {})}
    if raw is None:
        return fallback
    try:
        if isinstance(raw, str) and raw.strip():
            data = json.loads(raw)
        elif isinstance(raw, dict):
            data = raw
        else:
            data = {}
    except json.JSONDecodeError:
        data = {}
    merged = fallback.copy()
    merged.update(data or {})
    return merged

def parse_balancing_deviations(
    raw: Any, fallback: Optional[Dict[str, int]] = None
) -> Dict[str, int]:
    fallback = {**(fallback or {})}
    if raw is None:
        return fallback
    try:
        if isinstance(raw, str) and raw.strip():
            data = json.loads(raw)
        elif isinstance(raw, dict):
            data = raw
        else:
            data = {}
    except json.JSONDecodeError:
        data = {}
    merged = fallback.copy()
    merged.update({
        k: int(v)
        for k, v in (data or {}).items()
        if isinstance(k, str)
    })
    return merged


def parse_pinned_list(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


async def _read_csv_upload(
    upload: UploadFile,
    expected_headers: List[str],
    file_label: str,
    header_aliases: Optional[Dict[str, List[str]]] = None,
) -> List[Dict[str, Any]]:
    content = await upload.read()
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"[{file_label}] Unable to decode CSV as UTF-8: {exc}",
        ) from exc

    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    _validate_csv_headers(
        reader.fieldnames, expected_headers, file_label, header_aliases
    )
    if reader.fieldnames:
        reader.fieldnames = [_sanitise_header(h) for h in reader.fieldnames]
    try:
        return [dict(row) for row in reader]
    except csv.Error as exc:
        raise HTTPException(
            status_code=400, detail=f"[{file_label}] Invalid CSV format: {exc}"
        ) from exc

########################################################################
# Helpers for validating columns in each CSV type
########################################################################
def _require(condition: bool, message: str, label: str) -> None:
    if not condition:
        raise HTTPException(
            status_code=400,
            detail=f"[{label}] {message}",
        )

def _require_int_in(
    value: Any, allowed: List[int], field: str, label: str
) -> int:
    parsed = parse_int(value)
    _require(parsed in allowed, f"{field} must be one of {allowed}", label)
    return parsed

def _require_int_min(
    value: Any, min_value: int, field: str, label: str
) -> int:
    parsed = parse_int(value)
    _require(
        parsed is not None and parsed >= min_value,
        f"{field} must be ≥ {min_value}",
        label,
    )
    return parsed

def _validate_residents_strict(residents: List[Dict[str, Any]]) -> None:
    label = CSV_HEADER_SPECS["residents"]["label"]

    for idx, r in enumerate(residents, start=1):
        mcr = str(r.get("mcr") or "").strip()
        _require(mcr.startswith("M"), f"Row {idx}: mcr must start with 'M'", label)
        _require(
            isinstance(r.get("name"), str) and r["name"].strip(),
            f"Row {idx}: name must be a non-empty string",
            label,
        )
        _require_int_in(
            r.get("resident_year"),
            [1, 2, 3],
            f"Row {idx}: resident_year",
            label,
        )
        _require_int_min(
            r.get("career_blocks_completed"),
            0,
            f"Row {idx}: career_blocks_completed",
            label,
        )

def _validate_postings_strict(postings: List[Dict[str, Any]]) -> None:
    label = CSV_HEADER_SPECS["postings"]["label"]

    for idx, p in enumerate(postings, start=1):
        code = str(p.get("posting_code") or "").strip()
        _require(
            "(" in code and ")" in code,
            f"Row {idx}: posting_code must contain '(' and ')'",
            label,
        )
        _require(
            p.get("posting_type") in {"core", "elective"},
            f"Row {idx}: posting_type must be 'core' or 'elective'",
            label,
        )
        _require_int_min(
            p.get("max_residents"),
            0,
            f"Row {idx}: max_residents",
            label,
        )
        _require_int_min(
            p.get("required_block_duration"),
            1,
            f"Row {idx}: required_block_duration",
            label,
        )

def _validate_preferences_strict(
    prefs: List[Dict[str, Any]], posting_codes: set
) -> None:
    label = CSV_HEADER_SPECS["resident_preferences"]["label"]

    for idx, r in enumerate(prefs, start=1):
        mcr = str(r.get("mcr") or "").strip()
        _require(mcr.startswith("M"), f"Row {idx}: invalid mcr", label)
        _require_int_in(
            r.get("preference_rank"),
            [1, 2, 3, 4, 5],
            f"Row {idx}: preference_rank",
            label,
        )
        posting_code = str(r.get("posting_code") or "").strip()
        if posting_code:
            _require(
                posting_code in posting_codes,
                f"Row {idx}: posting_code '{posting_code}' not found in postings CSV",
                label,
            )

def _validate_resident_history_strict(
    history: List[Dict[str, Any]], posting_codes: set
) -> None:
    label = CSV_HEADER_SPECS["resident_history"]["label"]

    for idx, r in enumerate(history, start=1):
        mcr = str(r.get("mcr") or "").strip()
        _require(mcr.startswith("M"), f"Row {idx}: invalid mcr", label)
        _require_int_min(r.get("year"), 0, f"Row {idx}: year", label)
        month = _require_int_in(
            r.get("month_block"),
            list(range(1, 13)),
            f"Row {idx}: month_block",
            label,
        )
        _require_int_in(
            r.get("career_block"),
            list(range(0, 37)),
            f"Row {idx}: career_block",
            label,
        )
        posting_code = str(r.get("posting_code") or "").strip()
        is_leave = r.get("is_leave")

        # Allow empty posting_code if on leave; otherwise must exist in posting_codes
        if posting_code and is_leave != 1:
            _require(
                posting_code in posting_codes,
                f"Row {idx}: posting_code '{posting_code}' not found in postings CSV",
                label,
            )
        elif not posting_code and is_leave != 1:
            _require(
                False,
                f"Row {idx}: posting_code cannot be empty when not on leave",
                label,
            )
            
        leave_type = str(r.get("leave_type") or "").strip()
        if is_leave == 0:
            _require(
                leave_type == "0" or not leave_type,
                f"Row {idx}: leave_type must be 0 when is_leave=0",
                label,
            )
        else:
            _require(
                leave_type in {"LOA", "MOPEX", "NS"},
                f"Row {idx}: leave_type must be LOA or MOPEX or NS",
                label,
            )

########################################################################
# Formatting functions for each CSV type
########################################################################
def _format_residents(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    formatted = []
    for row in records:
        career_blocks = parse_int(
            row.get("career_blocks_completed") or row.get("careerBlocksCompleted")
        )
        resident_year = parse_int(row.get("resident_year"))
        formatted.append(
            {
                "mcr": str(row.get("mcr") or "").strip(),
                "name": str(row.get("name") or "").strip(),
                "resident_year": resident_year,
                "career_blocks_completed": career_blocks,
            }
        )
    return formatted


def _format_resident_history(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    formatted: List[Dict[str, Any]] = []
    for row in records:
        mcr = str(row.get("mcr") or "").strip()
        month_block = parse_int(row.get("month_block"))
        if month_block is None:
            continue
        if month_block < 1 or month_block > 12:
            raise HTTPException(
                status_code=400,
                detail=f"[Resident History CSV] Invalid month_block '{month_block}' for resident {mcr}: must be between 1 and 12.",
            )
        year = parse_int(row.get("year"))
        if year is None:
            continue
        career_block = parse_int(row.get("career_block"))
        formatted.append(
            {
                "mcr": mcr,
                "year": year,
                "month_block": month_block,
                "career_block": career_block,
                "posting_code": str(row.get("posting_code") or "").strip(),
                "is_current_year": parse_boolean_flag(
                    row.get("is_current_year") or row.get("isCurrentYear")
                ),
                "is_leave": parse_boolean_flag(
                    row.get("is_leave") or row.get("isLeave")
                ),
                "leave_type": str(row.get("leave_type") or "").strip(),
            }
        )
    return formatted


def _derive_resident_leaves_from_history(
    resident_history: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    derived: List[Dict[str, Any]] = []
    for row in resident_history:
        if not row.get("is_leave") or not row.get("is_current_year"):
            continue
        mcr = str(row.get("mcr") or "").strip()
        month_block = parse_int(row.get("month_block"))
        if not mcr or month_block is None:
            continue
        derived.append(
            {
                "mcr": mcr,
                "month_block": month_block,
                "leave_type": str(row.get("leave_type") or "").strip(),
                "posting_code": str(row.get("posting_code") or "").strip(),
            }
        )
    return derived


def _format_preferences(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    formatted = []
    for row in records:
        posting_code = str(row.get("posting_code") or "").strip()
        mcr = str(row.get("mcr") or "").strip().upper()
        if not posting_code:
            continue
        formatted.append(
            {
                "mcr": mcr,
                "preference_rank": parse_int(row.get("preference_rank")),
                "posting_code": posting_code,
            }
        )
    return formatted


def _format_sr_preferences_from_preferences(
    records: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    formatted = []
    for row in records:
        base_posting = _normalise_sr_preference(row.get("resident_sr_preferences"))
        if not base_posting:
            continue
        formatted.append(
            {
                "mcr": str(row.get("mcr") or "").strip(),
                "preference_rank": parse_int(row.get("preference_rank")) or 0,
                "base_posting": base_posting,
            }
        )
    return formatted


def _format_postings(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    formatted = []
    for row in records:
        max_residents = parse_int(row.get("max_residents"))
        if max_residents is None:
            max_residents = 0

        required_block_duration = parse_int(row.get("required_block_duration"))
        if required_block_duration is None:
            required_block_duration = 1

        formatted.append(
            {
                "posting_code": str(row.get("posting_code") or "").strip(),
                "posting_type": str(row.get("posting_type") or "").strip(),
                "max_residents": max_residents,
                "required_block_duration": required_block_duration,
            }
        )
    return formatted


def _validate_no_duplicate_mcrs(residents: List[Dict[str, Any]]) -> None:
    label = CSV_HEADER_SPECS["residents"]["label"]
    seen = set()
    duplicates = set()
    missing_rows: List[int] = []

    for idx, resident in enumerate(residents, start=1):
        mcr = str(resident.get("mcr") or "").strip()
        if not mcr:
            missing_rows.append(idx)
            continue
        if mcr in seen:
            duplicates.add(mcr)
        else:
            seen.add(mcr)

    if missing_rows:
        rows = ", ".join(str(num) for num in missing_rows)
        raise HTTPException(
            status_code=400,
            detail=f"[{label}] Missing MCR for row(s): {rows}. Each resident must have a unique MCR.",
        )

    if duplicates:
        dup_list = ", ".join(sorted(duplicates))
        raise HTTPException(
            status_code=400,
            detail=f"[{label}] Duplicate MCR(s) found: {dup_list}. Each resident must have a unique MCR.",
        )


def _validate_no_duplicate_posting_codes(postings: List[Dict[str, Any]]) -> None:
    label = CSV_HEADER_SPECS["postings"]["label"]
    seen = set()
    duplicates = set()
    missing_rows: List[int] = []

    for idx, posting in enumerate(postings, start=1):
        posting_code = str(posting.get("posting_code") or "").strip()
        if not posting_code:
            missing_rows.append(idx)
            continue
        if posting_code in seen:
            duplicates.add(posting_code)
        else:
            seen.add(posting_code)

    if missing_rows:
        rows = ", ".join(str(num) for num in missing_rows)
        raise HTTPException(
            status_code=400,
            detail=f"[{label}] Missing posting_code for row(s): {rows}. Each posting must have a unique code.",
        )

    if duplicates:
        dup_list = ", ".join(sorted(duplicates))
        raise HTTPException(
            status_code=400,
            detail=f"[{label}] Duplicate posting_code(s) found: {dup_list}. Each posting must have a unique code.",
        )


def _validate_posting_capacity_and_duration(postings: List[Dict[str, Any]]) -> None:
    label = CSV_HEADER_SPECS["postings"]["label"]
    invalid_capacity: List[str] = []
    invalid_duration: List[str] = []

    for idx, posting in enumerate(postings, start=1):
        posting_code = str(posting.get("posting_code") or "").strip()
        row_label = posting_code or f"row {idx}"

        max_residents_raw = posting.get("max_residents")
        try:
            max_residents = int(max_residents_raw)
        except (TypeError, ValueError):
            max_residents = None

        if max_residents is None or max_residents < 0:
            invalid_capacity.append(f"{row_label} (value: {max_residents_raw})")

        duration_raw = posting.get("required_block_duration")
        try:
            duration = int(duration_raw)
        except (TypeError, ValueError):
            duration = None

        if duration is None or duration < 1 or duration > 12:
            invalid_duration.append(f"{row_label} (value: {duration_raw})")

    if invalid_capacity:
        joined = ", ".join(invalid_capacity)
        raise HTTPException(
            status_code=400,
            detail=f"[{label}] Invalid max_residents for posting(s): {joined}. Provide a positive integer capacity.",
        )

    if invalid_duration:
        joined = ", ".join(invalid_duration)
        raise HTTPException(
            status_code=400,
            detail=f"[{label}] Invalid required_block_duration for posting(s): {joined}. Value must be between 1 and 12 months.",
        )

########################################################################
# Helpers for filtering data in CSV files based on resident year
########################################################################
def filter_residents_by_year(
    residents: List[Dict[str, Any]],
    target_year: int
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    Filters formatted residents to only those with the specified resident_year.
    
    Returns:
        (filtered_residents_list, list_of_matching_mcrs)
    """
    filtered = []
    mcrs = []
    
    for resident in residents:
        ry = resident.get("resident_year")
        mcr = resident.get("mcr", "").strip()
        
        if mcr and isinstance(ry, int) and ry == target_year:
            filtered.append(resident)
            mcrs.append(mcr)
    
    return filtered, mcrs


def filter_by_mcrs(
    data: List[Dict[str, Any]],
    allowed_mcrs: List[str]
) -> List[Dict[str, Any]]:
    """
    Keeps only rows from formatted data where mcr is in allowed_mcrs.
    """
    allowed = set(allowed_mcrs) 
    return [
        row for row in data
        if row.get("mcr", "").strip() in allowed
    ]

def filter_data_for_residency_year(
    residents: List[Dict[str, Any]],
    resident_history: List[Dict[str, Any]],
    resident_preferences: List[Dict[str, Any]],
    resident_sr_preferences: List[Dict[str, Any]],
    target_year: int
) -> Tuple[
    List[Dict[str, Any]],           # filtered residents
    List[Dict[str, Any]],           # filtered history
    List[Dict[str, Any]],           # filtered preferences
    List[Dict[str, Any]],           # filtered sr_preferences
    List[str]                       
]:
    """
    Filters all relevant datasets to include only residents of the target year.
    
    Returns:
        (filtered_residents, filtered_history, filtered_prefs, filtered_sr_prefs, mcrs)
    """
    print(f"filtering from {len(residents)} residents for target_year: {target_year}")
    filtered_residents, mcrs = filter_residents_by_year(residents, target_year)
    
    if not mcrs:
        return [], [], [], [], []
    
    allowed_mcrs_set = set(mcrs)
    
    filtered_history = filter_by_mcrs(resident_history, allowed_mcrs_set)
    filtered_prefs = filter_by_mcrs(resident_preferences, allowed_mcrs_set)
    filtered_sr_prefs = filter_by_mcrs(resident_sr_preferences, allowed_mcrs_set)
    
    return (
        filtered_residents,
        filtered_history,
        filtered_prefs,
        filtered_sr_prefs,
        mcrs
    )

########################################################################
# Preprocessing functions 
########################################################################
async def preprocess_initial_upload(form: FormData) -> Dict[str, Any]: 
    print("preprocess_initial_upload called")
    target_year_raw = form.get("target_year")
    optimized_years_raw: List[str] = form.getlist("optimized_years")

    try:
        target_year = int(target_year_raw.strip()) if target_year_raw else None
    except (ValueError, AttributeError, TypeError):
        target_year = None

    if target_year is None:
        raise HTTPException(400, "target_year is required and must be an integer")
    if target_year != 3:
        raise HTTPException(400, f"target_year must be 3 for initial upload, got {target_year}")

    optimized_years = parse_optimized_years(optimized_years_raw)
    if optimized_years:
        raise HTTPException(
            status_code=400,
            detail=(
                f"For initial upload, optimized_years must be empty. "
                f"Got: {optimized_years}"
            )
        )

    def require_upload(key: str, optional: bool = False) -> Optional[UploadFile]:
        value = form.get(key)
        if isinstance(value, UploadFile):
            return value
        if optional:
            return None
        available_keys = list(form.keys())
        value_type = type(value).__name__ if value is not None else "None"
        raise HTTPException(
            status_code=400,
            detail=(
                f"Missing required file '{key}'. "
                f"Received type '{value_type}'. "
                f"Available keys: {available_keys}"
            ),
        )

    residents_upload = require_upload("residents")
    history_upload = require_upload("resident_history")
    prefs_upload = require_upload("resident_preferences")
    postings_upload = require_upload("postings")

    residents_csv = await _read_csv_upload(
        residents_upload,
        expected_headers=CSV_HEADER_SPECS["residents"]["required"],
        file_label=CSV_HEADER_SPECS["residents"]["label"],
        header_aliases=CSV_HEADER_SPECS["residents"]["aliases"],
    )
    history_csv = await _read_csv_upload(
        history_upload,
        expected_headers=CSV_HEADER_SPECS["resident_history"]["required"],
        file_label=CSV_HEADER_SPECS["resident_history"]["label"],
        header_aliases=CSV_HEADER_SPECS["resident_history"]["aliases"],
    )
    prefs_csv = await _read_csv_upload(
        prefs_upload,
        expected_headers=CSV_HEADER_SPECS["resident_preferences"]["required"],
        file_label=CSV_HEADER_SPECS["resident_preferences"]["label"],
        header_aliases=CSV_HEADER_SPECS["resident_preferences"]["aliases"],
    )
    postings_csv = await _read_csv_upload(
        postings_upload,
        expected_headers=CSV_HEADER_SPECS["postings"]["required"],
        file_label=CSV_HEADER_SPECS["postings"]["label"],
        header_aliases=CSV_HEADER_SPECS["postings"]["aliases"],
    )
    residents = _format_residents(residents_csv)
    resident_history = _format_resident_history(history_csv)
    resident_preferences = _format_preferences(prefs_csv)
    resident_sr_preferences = _format_sr_preferences_from_preferences(prefs_csv)
    postings = _format_postings(postings_csv)
    resident_leaves = _derive_resident_leaves_from_history(resident_history)

    print(f"Total residents before filtering: {len(residents)}")
    filtered_residents, filtered_history, filtered_prefs, filtered_sr_prefs, mcrs = filter_data_for_residency_year(
        residents,
        resident_history,
        resident_preferences,
        resident_sr_preferences,
        target_year=3
    )
    print(f"Residents after filtering for target_year=3: {len(filtered_residents)}")

    posting_codes = {p["posting_code"] for p in postings if p["posting_code"]}
    _validate_residents_strict(residents)
    _validate_postings_strict(postings)
    _validate_preferences_strict(resident_preferences, posting_codes)
    _validate_resident_history_strict(resident_history, posting_codes)

    _validate_no_duplicate_mcrs(residents)
    _validate_no_duplicate_posting_codes(postings)
    _validate_posting_capacity_and_duration(postings)

    balancing_deviations = parse_balancing_deviations(form.get("balancing_deviations"), {})
    print(f"balancing_deviations in preprocess_initial_upload {balancing_deviations}")
    weightages = parse_weightages(form.get("weightages"), {})
    max_time_in_minutes = parse_max_time_in_minutes(form.get("max_time_in_minutes"))

    return {
        "residents": filtered_residents,
        "resident_history": filtered_history,
        "resident_preferences": filtered_prefs,
        "resident_sr_preferences": filtered_sr_prefs,
        "postings": postings,
        "weightages": weightages,
        "balancing_deviations": balancing_deviations,
        "resident_leaves": resident_leaves,
        "max_time_in_minutes": max_time_in_minutes,
        # Preserve full data for later filtering in pinned runs
        "full_residents": residents,  
        "full_resident_history": resident_history,
        "full_resident_preferences": resident_preferences,
        "full_resident_sr_preferences": resident_sr_preferences
    }


async def prepare_solver_input(
    form: FormData,
    latest_inputs: Optional[Dict[str, Any]],
    latest_api_response: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """
    Build the solver input payload based on uploaded files and/or pinned selections.
    Returns the payload plus an optional deep copy to refresh the cached latest_inputs.
    """
    print("in prepare_solver_input")
    pinned_mcrs = parse_pinned_list(form.get("pinned_mcrs"))
    has_pinned = bool(pinned_mcrs)
    api_response_cache = form.get("api_response_cache")
    has_cached_run = bool(latest_api_response or api_response_cache)

    if has_pinned and has_cached_run:
        solver_input = build_pinned_run_input(
            latest_inputs=latest_inputs,
            latest_api_response=latest_api_response or api_response_cache,
            pinned_mcrs=pinned_mcrs,
            target_year=form.get("target_year"),
            optimized_years=form.get("optimized_years"),
            weightages_override=form.get("weightages"),
            balancing_deviations=form.get("balancing_deviations"),
            max_time_in_minutes=form.get("max_time_in_minutes")
        )
    else:
        solver_input = await preprocess_initial_upload(form)
    
    latest_inputs_snapshot = copy.deepcopy(solver_input)
    return solver_input, latest_inputs_snapshot


def build_pinned_run_input(
    latest_inputs: Optional[Dict[str, Any]],
    latest_api_response: Optional[Dict[str, Any]],
    pinned_mcrs: List[str],
    target_year: int,
    optimized_years: List[int],
    weightages_override: Any = None,
    balancing_deviations: Any = None,
    max_time_in_minutes: Any = None,
) -> Dict[str, Any]:
    if not latest_api_response:
        raise HTTPException(
            status_code=400,
            detail="No existing timetable found. Upload CSV files before pinning residents.",
        )
    if not latest_inputs:
        raise HTTPException(
            status_code=400,
            detail="No existing inputs found. Upload CSV files before pinning residents.",
        )
    print(f"Building pinned run input with target_year: {target_year}, optimized_years: {optimized_years}")
    pinned_set = {mcr for mcr in pinned_mcrs if mcr}
    history = latest_api_response.get("resident_history") or []
    resident_history = [
        copy.deepcopy(row)
        for row in history
        if not parse_boolean_flag(row.get("is_current_year"))
    ]

    pinned_assignments: Dict[str, List[Dict[str, Any]]] = {}
    derived_leaves: List[Dict[str, Any]] = []
    for row in history:
        if not parse_boolean_flag(row.get("is_current_year")):
            continue
        mcr = str(row.get("mcr") or "").strip()
        month_block = parse_int(row.get("month_block"))
        posting_code = str(row.get("posting_code") or "").strip()
        if month_block is None:
            continue
        is_leave = parse_boolean_flag(row.get("is_leave"))
        if is_leave:
            derived_leaves.append(
                {
                    "mcr": mcr,
                    "month_block": month_block,
                    "posting_code": posting_code,
                    "leave_type": str(row.get("leave_type") or "").strip(),
                }
            )
            continue
        if not mcr or mcr not in pinned_set or not posting_code:
            continue
        pinned_assignments.setdefault(mcr, []).append(
            {"month_block": month_block, "posting_code": posting_code}
        )

    for assignments in pinned_assignments.values():
        assignments.sort(key=lambda item: item["month_block"])

    base_weightages = (
        (latest_api_response.get("weightages") or {})
        or (latest_inputs.get("weightages") if latest_inputs else {})
        or {}
    )
    weightages = parse_weightages(weightages_override, base_weightages)

    # Get full dataset from latest_inputs to filter down to target_year
    def get_full(key: str) -> List[Dict]:
        full_key = f"full_{key}"
        if latest_inputs and full_key in latest_inputs and latest_inputs[full_key]:
            return copy.deepcopy(latest_inputs[full_key])
        return []
    full_residents = get_full("residents")
    full_history = get_full("resident_history")
    full_prefs = get_full("resident_preferences")
    full_sr_prefs = get_full("resident_sr_preferences")
        
    print("Number of residents before filtering", len(full_residents))
    filtered_residents, filtered_history, filtered_prefs, filtered_sr_prefs, _ = filter_data_for_residency_year(
        residents=full_residents,
        resident_history=full_history,
        resident_preferences=full_prefs,
        resident_sr_preferences=full_sr_prefs,
        target_year=target_year
    )
    print("Number of residents after filtering", len(filtered_residents))

    def merged(key: str) -> List[Dict[str, Any]]:
        if latest_api_response and key in latest_api_response:
            return copy.deepcopy(latest_api_response.get(key) or [])
        if latest_inputs and key in latest_inputs:
            return copy.deepcopy(latest_inputs.get(key) or [])
        return []

    base_leaves = merged("resident_leaves")
    combined_leaves = (base_leaves or []) + derived_leaves

    # dedupe leaves by resident/block while normalising fields
    deduped_leaves: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for row in combined_leaves:
        mcr = str(row.get("mcr") or "").strip()
        block = parse_int(row.get("month_block"))
        if not mcr or block is None:
            continue
        key = (mcr, block)
        if key in deduped_leaves:
            continue
        deduped_leaves[key] = {
            "mcr": mcr,
            "month_block": block,
            "posting_code": str(row.get("posting_code") or "").strip(),
            "leave_type": str(row.get("leave_type") or "").strip(),
        }

    final_residents = filtered_residents + merged("residents")
    print("Final residents count after merging", len(final_residents))
    final_history = filtered_history + merged("resident_history")
    final_prefs = filtered_prefs + merged("resident_preferences")
    final_sr_prefs = filtered_sr_prefs + merged("resident_sr_preferences")

    return {
        "residents": final_residents,
        "resident_history": final_history,
        "resident_preferences": final_prefs,
        "resident_sr_preferences": final_sr_prefs,
        "postings": merged("postings"),
        "weightages": weightages,
        "balancing_deviations": balancing_deviations,
        "resident_leaves": list(deduped_leaves.values()),
        "pinned_assignments": pinned_assignments,
        "max_time_in_minutes": max_time_in_minutes,
    }


def normalise_current_year_entries(entries: Any) -> List[Dict[str, Any]]:
    normalised: List[Dict[str, Any]] = []
    if not isinstance(entries, list):
        return normalised
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        month_block = parse_int(entry.get("month_block"))
        posting_code = str(entry.get("posting_code") or "").strip()
        is_leave = str(entry.get("is_leave"))
        if month_block is None or not posting_code or is_leave is None:
            continue
        career_block = parse_int(entry.get("career_block"))
        normalised.append(
            {
                "month_block": month_block,
                "posting_code": posting_code,
                "is_leave": is_leave,
                "career_block": career_block,
            }
        )
    return normalised
