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
import { useResidentPinning } from "@/hooks/use-resident-pinning";

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
  const { pinAllYear, togglePin } = useResidentPinning(apiResponse?.residents, pinnedMcrs, setPinnedMcrs);
  const [currentAcademicYearInput, setCurrentAcademicYearInput] =
    useState<string>(() => {
      try {
        return localStorage.getItem("planningAcademicYear") ?? "";
      } catch {
        return "";
      }
    });
  
  // Tracks which years (R3, R2, R1) have been generated in the timetable
  const [optimizedYears, setOptimizedYears] = useState<Set<number>>(new Set([]));

  // Reset when no timetable exists (fresh upload needed)
  useEffect(() => {
    if (!apiResponse) {
      setOptimizedYears(new Set([]));
    }
  }, [apiResponse]);

  const hasR3 = optimizedYears.has(3);
  const hasR2 = optimizedYears.has(2);
  const currentStage = optimizedYears.size;
  const nextYear = hasR3 ? (hasR2 ? 1 : 2) : 3;

  // Handler for year-specific generation
  const handleGenerateForYear = async (year: number, isFullReset: boolean = false) => {
    setIsProcessing(true);
    setError(null);

    const formData = new FormData();

    // Always include uploaded files if they exist
    Object.entries(csvFiles).forEach(([key, file]) => {
      if (file) formData.append(key, file);
    });

    // include weightages and pinned residents
    formData.append("weightages", JSON.stringify(weightages));
    formData.append("balancing_deviations", JSON.stringify(postingDeviation));
    formData.append("pinned_mcrs", JSON.stringify(Array.from(pinnedMcrs.values())));
    formData.append("max_time_in_minutes", maxTimeInMinutes.toString());

    // Sequential timetable generation for a specific R3/R2/R1 year
    formData.append("target_year", year.toString());
    formData.append("optimized_years", JSON.stringify(Array.from(optimizedYears)));

    try {
      const json: ApiResponse = await solve(formData);
      if (json.success && json.residents) {
        setApiResponse(json);
        
        if (!isFullReset) {
          // Normal sequential step — add the year
          setOptimizedYears(prev => new Set([...prev, year]));
        } else {
          // Full reset — clear state (or set only this year if backend re-did everything)
          setOptimizedYears(new Set([year]));
        }
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

  // For initial generation and reset
  const handleFullGenerate = async () => {
    setOptimizedYears(new Set([])); // reset progress
    await handleGenerateForYear(3, true); // start with R3, full reset
  };

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
      localStorage.setItem("planningAcademicYear", currentAcademicYearInput);
    } catch {}
  }, [currentAcademicYearInput]);

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
        {/* Always available: Initial generation and reset */}
        <Button
          variant={apiResponse ? "outline" : "default"}
          onClick={handleFullGenerate}
          disabled={
            isProcessing ||
            (!apiResponse &&
              (!csvFiles.residents ||
                !csvFiles.resident_preferences ||
                !csvFiles.resident_history ||
                !csvFiles.postings))
          }            
          className={cn(
            !apiResponse && "bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
          )}
        >
          {isProcessing && <><Loader2Icon className="animate-spin mr-2 h-4 w-4" /> Generating...</>}
          {apiResponse ? "Reset & Re-Generate Timetable" : "Upload & Generate Timetable"}
        </Button>

        {/* Sequential / regenerate buttons: only shown when there is a timetable */}
        {apiResponse && (
          <>
            {/* Button for generating timetable for the next year */}
            {currentStage <= 3 && (
              <>
                <Button
                  onClick={() => {
                    if (currentStage === 1) {
                      pinAllYear(3);     // pin all R3 before generating R2
                    } else if (currentStage === 2) {
                      pinAllYear(3);
                      pinAllYear(2);     // pin R3 + R2 before generating R1
                    }
                    handleGenerateForYear(nextYear);
                  }}
                  disabled={isProcessing}
                  className="bg-blue-600 hover:bg-blue-700 text-white min-w-[220px]"
                >
                  {isProcessing && <><Loader2Icon className="animate-spin mr-2 h-4 w-4" /> Generating...</>}
                  {currentStage === 0 && "Generate for R3"} 
                  {currentStage === 1 && "Generate for R2"} 
                  {currentStage === 2 && "Generate for R1"} 
                </Button>  
              </>  
            )}

            {/* Regenerate the most recently optimized year */}
            {currentStage >= 2 && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (currentStage === 2) {
                    pinAllYear(3);
                  } else if (currentStage === 3) {
                    pinAllYear(3);
                    pinAllYear(2);
                  }
                  handleGenerateForYear(currentStage === 2 ? 2 : 1, false)
                }}
                disabled={isProcessing}
                className="min-w-[200px]"
              >
                {isProcessing && <><Loader2Icon className="animate-spin mr-2 h-4 w-4" />Regenerating...</>}
                Regenerate {currentStage === 2 ? "R2" : "R1"}  
              </Button>
            )}
          </>
        )}
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
