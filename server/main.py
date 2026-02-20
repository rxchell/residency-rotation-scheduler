import copy
from typing import Any, Dict, List, Optional

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from server.services.posting_allocator import allocate_timetable
from server.services.postprocess import compute_postprocess
from server.services.preprocessing import (
    normalise_current_year_entries,
    prepare_solver_input,
)
from server.services.validate import validate_assignment
from server.utils import MONTH_LABELS


# define a store class for local storage of latest inputs and API response
class Store:
    def __init__(self) -> None:
        self.latest_inputs: Optional[Dict[str, Any]] = None
        self.latest_api_response: Optional[Dict[str, Any]] = None


# instantiate the store and FastAPI app
store = Store()
app = FastAPI(title="R2S API")

# configure CORS middleware
origins = [
    "http://localhost:5173",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# helper functions for deepcopy and building postprocess payload
def _deepcopy(value: Any) -> Any:
    return copy.deepcopy(value)


def _build_postprocess_payload(
    base_input: Dict[str, Any], solver_solution: Dict[str, Any]
) -> Dict[str, Any]:
    payload = {
        "residents": _deepcopy(base_input.get("residents") or []),
        "resident_history": _deepcopy(base_input.get("resident_history") or []),
        "resident_preferences": _deepcopy(base_input.get("resident_preferences") or []),
        "resident_sr_preferences": _deepcopy(
            base_input.get("resident_sr_preferences") or []
        ),
        "chosen_sr_by_resident": _deepcopy(base_input.get("chosen_sr_by_resident") or []),
        "postings": _deepcopy(base_input.get("postings") or []),
        "weightages": _deepcopy(base_input.get("weightages") or {}),
        "balancing_deviations": _deepcopy(base_input.get("balancing_deviations") or {}),
        "resident_leaves": _deepcopy(base_input.get("resident_leaves") or []),
        "solver_solution": solver_solution,
    }
    return payload


@app.post("/api/solve")
async def solve(request: Request):
    try:
        # parse form data
        form = await request.form()

        print("store.latest_api_response", store.latest_api_response)

        # prepare input to solver
        solver_input, latest_inputs_snapshot = await prepare_solver_input(
            form=form,
            latest_inputs=store.latest_inputs,
            latest_api_response=store.latest_api_response,
        )
        if latest_inputs_snapshot is not None:
            store.latest_inputs = latest_inputs_snapshot
        solver_payload = _deepcopy(solver_input)

        # call the posting allocator
        allocator_result = allocate_timetable(
            residents=solver_payload["residents"],
            resident_history=solver_payload["resident_history"],
            resident_preferences=solver_payload["resident_preferences"],
            resident_sr_preferences=solver_payload["resident_sr_preferences"],
            postings=solver_payload["postings"],
            weightages=solver_payload["weightages"],
            balancing_deviations=solver_payload["balancing_deviations"],
            resident_leaves=solver_payload.get("resident_leaves", []),
            pinned_assignments=solver_payload.get("pinned_assignments", []),
            max_time_in_minutes=solver_payload.get("max_time_in_minutes"),
        )
        if not allocator_result.get("success"):
            raise HTTPException(
                status_code=500,
                detail=allocator_result.get(
                    "error", "Posting allocator service failed unexpectedly."
                ),
            )

        # extract solver solution
        solver_solution = allocator_result.get("solver_solution")

        # build postprocess payload
        postprocess_payload = _build_postprocess_payload(
            allocator_result, solver_solution
        )

        # call the postprocess service
        final_result = compute_postprocess(postprocess_payload)
        if not final_result.get("success"):
            raise HTTPException(
                status_code=500,
                detail=final_result.get("error", "Postprocess failed"),
            )

        # store the latest API response
        store.latest_api_response = _deepcopy(final_result)
        return final_result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=str(exc) or "Failed to process files"
        )


@app.post("/api/save")
async def save(payload: Dict[str, Any] = Body(...)):
    resident_mcr = str(payload.get("resident_mcr") or "").strip()
    if not resident_mcr:
        raise HTTPException(status_code=400, detail="missing resident_mcr")

    store_snapshot = store.latest_api_response or store.latest_inputs
    if not store_snapshot:
        raise HTTPException(
            status_code=400,
            detail="No dataset loaded. Upload CSV and run optimiser first.",
        )

    current_year = normalise_current_year_entries(payload.get("current_year") or [])

    validation_payload = {
        "resident_mcr": resident_mcr,
        "current_year": [
            {"month_block": entry["month_block"], "posting_code": entry["posting_code"], "is_leave": entry["is_leave"]}
            for entry in current_year
        ],
        "residents": store_snapshot.get("residents") or [],
        "resident_history": store_snapshot.get("resident_history") or [],
        "postings": store_snapshot.get("postings") or [],
    }

    validation_result = validate_assignment(validation_payload)
    if not validation_result.get("success"):
        return JSONResponse(status_code=400, content=validation_result)

    residents = _deepcopy(store_snapshot.get("residents") or [])
    resident_history = _deepcopy(store_snapshot.get("resident_history") or [])

    filtered_history = [
        row
        for row in resident_history
        if not (row.get("mcr") == resident_mcr and row.get("is_current_year"))
    ]

    resident = next((r for r in residents if r.get("mcr") == resident_mcr), None)
    resident_year = resident.get("resident_year") if resident else None

    new_entries: List[Dict[str, Any]] = []
    for entry in current_year:
        month_block = entry["month_block"]
        posting_code = entry["posting_code"]
        career_block = entry.get("career_block")
        new_entries.append(
            {
                "mcr": resident_mcr,
                "year": resident_year,
                "month_block": month_block,
                "career_block": career_block,
                "posting_code": posting_code,
                "is_current_year": True,
                "is_leave": False,
                "leave_type": "",
            }
        )

    weightages = _deepcopy(
        store_snapshot.get("weightages")
        or (store.latest_inputs or {}).get("weightages")
        or {}
    )

    balancing_deviations = _deepcopy(
        store_snapshot.get("balancing_deviations")
        or (store.latest_inputs or {}).get("balancing_deviations")
        or {}
    )

    updated_payload = {
        "residents": residents,
        "resident_history": filtered_history + new_entries,
        "resident_preferences": store_snapshot.get("resident_preferences") or [],
        "resident_sr_preferences": store_snapshot.get("resident_sr_preferences") or [],
        "postings": store_snapshot.get("postings") or [],
        "weightages": weightages,
        "balancing_deviations": balancing_deviations,
        "resident_leaves": store_snapshot.get("resident_leaves") or [],
    }

    result = compute_postprocess(updated_payload)
    if not result.get("success"):
        raise HTTPException(
            status_code=500, detail=result.get("error", "Postprocess failed")
        )

    store.latest_api_response = _deepcopy(result)
    return result


@app.post("/api/download-csv")
async def download_csv(payload: Dict[str, Any] = Body(...)):
    success = payload.get("success")
    residents = payload.get("residents")
    resident_history = payload.get("resident_history")
    # optimisation_scores = payload.get("optimisation_scores")

    if not (
        success
        and isinstance(residents, list)
        and isinstance(resident_history, list)
        # and isinstance(optimisation_scores, list)
    ):
        raise HTTPException(status_code=400, detail="Invalid API response shape")

    history_by_mcr: Dict[str, Dict[int, str]] = {}
    for row in resident_history:
        if not row.get("is_current_year"):
            continue
        mcr = str(row.get("mcr") or "").strip()
        block = row.get("month_block") or row.get("block")
        try:
            block_int = int(block)
        except (TypeError, ValueError):
            continue
        posting_code = str(row.get("posting_code") or "").strip()
        if mcr and posting_code:
            history_by_mcr.setdefault(mcr, {})[block_int] = posting_code

    header_cols = [
        "mcr",
        "name",
        "resident_year",
        # "optimisation_score",
        *MONTH_LABELS,
        "ccr_posting_code",
    ]

    rows: List[str] = []
    for idx, resident in enumerate(residents):
        mcr = resident.get("mcr", "")
        name = resident.get("name", "")
        year = resident.get("resident_year", "")
        # score = optimisation_scores[idx] if idx < len(optimisation_scores) else ""
        by_block = history_by_mcr.get(mcr, {})
        block_codes = [by_block.get(i + 1, "") for i in range(12)]
        ccr = resident.get("ccr_status", {}).get("posting_code", "")
        cols = [mcr, name, year, *block_codes, ccr]
        escaped = ['"{}"'.format(str(col).replace('"', '""')) for col in cols]
        rows.append(",".join(escaped))

    csv_content = ",".join(header_cols) + "\n" + "\n".join(rows)
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="final_timetable.csv"',
        },
    )
