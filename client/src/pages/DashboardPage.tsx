import Papa from "papaparse";
import { useApiResponseContext } from "@/context/ApiResponseContext";
import { groupResidentsByYear } from "@/lib/residentOrdering";
import React, { useEffect, useMemo, useState } from "react";
import { solve } from "../api/api";
import type {
  ApiResponse,
  CsvFilesState,
  Resident,
  Weightages,
  PinnedBlocksByResident
} from "../types";

import CohortStatistics from "../components/CohortStatistics";
import ErrorAlert from "../components/ErrorAlert";
import FileUpload from "../components/FileUpload";
import PostingBalancingDeviationSelector from "@/components/PostingBalancingDeviationSelector";
import PostingUtilTable from "../components/PostingUtilTable";
import ResidentDropdown from "../components/ResidentDropdown";
import ResidentTimetable from "../components/ResidentTimetable";
import WeightageSelector from "../components/WeightageSelector";
import { generateSampleCSV } from "../lib/generateSampleCSV";
import { validators } from "../lib/csvValidators";

import {
  cn,
  parseAcademicYearInput,
  type AcademicYearRange,
} from "@/lib/utils";
import { Loader2Icon, PinIcon, PinOffIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Separator } from "../components/ui/separator";

const HomePage: React.FC = () => {
  const { apiResponse, setApiResponse } = useApiResponseContext();
  const [csvFiles, setCsvFiles] = useState<CsvFilesState>({
    residents: null,
    resident_history: null,
    resident_preferences: null,
    postings: null,
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedResidentMcr, setSelectedResidentMcr] = useState<string | null>(
    () => localStorage.getItem("selectedResidentMcr")
  );
  const [weightages, setWeightages] = useState<Weightages>({
    preference: 1,
    seniority: 1,
    elective_shortfall_penalty: 10,
    core_shortfall_penalty: 10,
  });
  const [postingCodes, setPostingCodes] = useState<string[]>([]);
  const [postingDeviation, setPostingDeviation] = useState<Record<string, number>>({});
  const [maxTimeInMinutes, setMaxTimeInMinutes] = useState<string>("20");
  const [pinnedMcrs, setPinnedMcrs] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("pinnedMcrs");
      if (!raw) return new Set<string>();
      const arr = JSON.parse(raw);
      return new Set<string>(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set<string>();
    }
  });

  const [pinnedBlocksByResident, setPinnedBlocksByResident] = useState<PinnedBlocksByResident>(() => {
    try {
      const raw = localStorage.getItem("pinnedBlocksByResident");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const [currentAcademicYearInput, setCurrentAcademicYearInput] =
    useState<string>(() => {
      try {
        return localStorage.getItem("planningAcademicYear") ?? "";
      } catch {
        return "";
      }
    });

  const handleFileUpload =
    (fileType: keyof typeof csvFiles) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.name.endsWith(".csv")) {
        setError("Please upload a CSV file.");
        return;
      }

      setError(null);
      setApiResponse(null);

      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        worker: true, // for performance
        complete: (results: { data: any[] }) => {
          // validate rows 
          if (validators[fileType as keyof typeof validators]) {
            for (let i = 0; i < results.data.length; i++) {
              const res = validators[fileType as keyof typeof validators](
                results.data[i],
                i + 2 // CSV header offset
              );
              if (!res.ok) {
                setError(res.error);
                return;
              }
            }
          }

        // extract posting codes
        if (fileType === "postings") {
          const codes = Array.from(
            new Set(
              results.data
                .map((row: any) => row.posting_code)
                .filter(Boolean)
            )
          );
          setPostingCodes(codes);
        }

        // save file only after validation
        setCsvFiles((prev) => ({ ...prev, [fileType]: file }));
      },
      error: () => setError(`Failed to parse ${fileType} CSV.`),
    });
  };

  const handleProcessFiles = async () => {
    setIsProcessing(true);
    setError(null);

    const formData = new FormData();

    // if CSVs present, always include them, else omit
    Object.entries(csvFiles).forEach(([key, file]) => {
      if (file) formData.append(key, file);
    })
    
    // include weightages and pinned residents
    formData.append("weightages", JSON.stringify(weightages));
    formData.append("balancing_deviations", JSON.stringify(postingDeviation));
    formData.append("pinned_mcrs", JSON.stringify(Array.from(pinnedMcrs.values())));
    formData.append("pinned_blocks_by_resident", JSON.stringify(pinnedBlocksByResident));
    formData.append("max_time_in_minutes", maxTimeInMinutes.toString());

    try {
      const json: ApiResponse = await solve(formData);
      if (json.success && json.residents) {
        setApiResponse(json);
      }
    } catch (err: any) {
      setError(
        err?.response?.data?.detail ||
          "An error occurred while processing the files."
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const selectedResidentData = apiResponse?.residents?.find(
    (r: Resident) => r.mcr === selectedResidentMcr
  );

  // order residents by their resident year
  const groupedResidents = useMemo(
    () =>
      apiResponse?.residents ? groupResidentsByYear(apiResponse.residents) : {},
    [apiResponse?.residents]
  );

  // then flatmap and order by year
  const orderedResidentMcrs = useMemo(
    () =>
      Object.keys(groupedResidents)
        .sort((a, b) => Number(a) - Number(b))
        .flatMap((year) =>
          groupedResidents[Number(year)].map((resident) => resident.mcr)
        ),
    [groupedResidents]
  );

  const currentIndex = orderedResidentMcrs.findIndex(
    (mcr) => mcr === selectedResidentMcr
  );

  const goPrev = () => {
    if (currentIndex > 0) {
      setSelectedResidentMcr(orderedResidentMcrs[currentIndex - 1]);
    }
  };

  const goNext = () => {
    if (currentIndex < orderedResidentMcrs.length - 1) {
      setSelectedResidentMcr(orderedResidentMcrs[currentIndex + 1]);
    }
  };

  const disablePrev = currentIndex <= 0;
  const disableNext =
    currentIndex === -1 || currentIndex >= orderedResidentMcrs.length - 1;

  const parsedAcademicYear = useMemo<AcademicYearRange | null>(
    () => parseAcademicYearInput(currentAcademicYearInput),
    [currentAcademicYearInput]
  );
  const hasAcademicYearInputError =
    Boolean(currentAcademicYearInput.trim()) && !parsedAcademicYear;

  // select first resident if there is no currently selected resident
  useEffect(() => {
    if (!selectedResidentMcr && orderedResidentMcrs.length > 0) {
      setSelectedResidentMcr(orderedResidentMcrs[0]);
    }
  }, [orderedResidentMcrs, selectedResidentMcr]);

  // update selected resident to persist in local storage
  useEffect(() => {
    if (selectedResidentMcr)
      localStorage.setItem("selectedResidentMcr", selectedResidentMcr);
  }, [selectedResidentMcr]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "pinnedMcrs",
        JSON.stringify(Array.from(pinnedMcrs.values()))
      );
    } catch {}
  }, [pinnedMcrs]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "pinnedBlocksByResident",
        JSON.stringify(pinnedBlocksByResident)
      );
    } catch {}
  }, [pinnedBlocksByResident]);

  useEffect(() => {
    try {
      localStorage.setItem("planningAcademicYear", currentAcademicYearInput);
    } catch {}
  }, [currentAcademicYearInput]);

  const togglePin = (mcr: string) => {
    setPinnedMcrs((prev) => {
      const next = new Set(prev);
      if (next.has(mcr)) next.delete(mcr);
      else next.add(mcr);
      return next;
    });
  };

  return (
    <div className="container mx-auto bg-white rounded-xl border p-8 flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-center mb-6 text-gray-800">
        IM Residency Rotation Scheduler (R2S)
      </h1>

      {/* Upload Section */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <FileUpload
          label="Residents CSV"
          onChange={handleFileUpload("residents")}
        />
        <FileUpload
          label="Resident History CSV"
          onChange={handleFileUpload("resident_history")}
        />
        <FileUpload
          label="Resident Preferences CSV"
          onChange={handleFileUpload("resident_preferences")}
        />
        <FileUpload
          label="Postings CSV"
          onChange={handleFileUpload("postings")}
        />
      </div>

      {/* weightage selector */}
      <WeightageSelector value={weightages} setValue={setWeightages} />

      <PostingBalancingDeviationSelector value={postingDeviation} setValue={setPostingDeviation} postings={postingCodes} />

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Run Configurations</h2>
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex flex-col gap-1 max-w-xs">
            <Label htmlFor="max-time-in-minutes">
              Solver time limit (minutes)
            </Label>
            <Input
              id="max-time-in-minutes"
              type="number"
              min={1}
              value={maxTimeInMinutes}
              onChange={(event) => setMaxTimeInMinutes(event.target.value)}
              placeholder="e.g. 20"
            />
            <span className="text-xs text-gray-600">Default: 20 minutes</span>
          </div>

          <div className="flex flex-col gap-1 max-w-xs">
            <Label htmlFor="current-academic-year">
              Planning for Academic Year:
            </Label>
            <Input
              id="current-academic-year"
              value={currentAcademicYearInput}
              onChange={(event) =>
                setCurrentAcademicYearInput(event.target.value)
              }
              placeholder="2025/2026"
              className={cn(
                "max-w-xs",
                hasAcademicYearInputError && "border-red-500 visible:ring-red-500"
              )}
            />
            {hasAcademicYearInputError ? (
              <span className="text-xs text-red-600">
                Please use the format &quot;YYYY/YYYY&quot;.
              </span>
            ) : (
              currentAcademicYearInput && (
                <span className="text-xs text-gray-600">
                  Current year planning will align with AY
                  {currentAcademicYearInput.trim()}.
                </span>
              )
            )}
          </div>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-4 justify-center items-center">
        <Button
          onClick={handleProcessFiles}
          disabled={
            isProcessing ||
            (!apiResponse &&
              (!csvFiles.residents ||
                !csvFiles.resident_preferences ||
                !csvFiles.resident_history ||
                !csvFiles.postings))
          }
          className="bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
        >
          {isProcessing ? (
            <>
              <Loader2Icon className="animate-spin" />
              Generating...
            </>
          ) : apiResponse ? (
            "Re-Generate Timetable"
          ) : (
            "Upload & Generate Timetable"
          )}
        </Button>
        <Button
          variant="secondary"
          onClick={generateSampleCSV}
          className="cursor-pointer"
        >
          Download Sample CSV
        </Button>
      </div>

      {/* Error Message */}
      {error && <ErrorAlert message={error} variantType={"destructive"} />}

      {/* Timetable Results */}
      {apiResponse && (
        <div className="flex flex-col gap-6">
          <Separator />
          <div className="flex justify-between items-center">
            <ResidentDropdown
              groupedResidents={groupedResidents}
              selectedResidentMcr={selectedResidentMcr}
              setSelectedResidentMcr={setSelectedResidentMcr}
            />
            {selectedResidentMcr && (
              <div>
                <Button
                  variant={
                    pinnedMcrs.has(selectedResidentMcr)
                      ? "secondary"
                      : "outline"
                  }
                  className="cursor-pointer"
                  onClick={() => togglePin(selectedResidentMcr)}
                >
                  {pinnedMcrs.has(selectedResidentMcr) ? (
                    <>
                      <PinOffIcon fill="red" />
                      Unpin Resident
                    </>
                  ) : (
                    <>
                      <PinIcon fill="yellowgreen" />
                      Pin Resident
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
          {selectedResidentData && (
            <ResidentTimetable
              resident={selectedResidentData}
              pinnedBlocks={
                pinnedBlocksByResident[selectedResidentData.mcr] ?? []
              }
              onTogglePinBlock={(blockNumber) => {
                const mcr = selectedResidentData.mcr;

                setPinnedBlocksByResident((prev) => {
                  const current = new Set(prev[mcr] ?? []);
                  current.has(blockNumber)
                    ? current.delete(blockNumber)
                    : current.add(blockNumber);

                  return {
                    ...prev,
                    [mcr]: Array.from(current),
                  };
                });
              }}
              onPrev={goPrev}
              onNext={goNext}
              disablePrev={disablePrev}
              disableNext={disableNext}
              academicYearRange={parsedAcademicYear}
            />
          )}
          <CohortStatistics
            statistics={apiResponse.statistics}
          />
          <PostingUtilTable
            postingUtil={apiResponse.statistics.cohort.posting_util}
          />
        </div>
      )}
    </div>
  );
};

export default HomePage;
