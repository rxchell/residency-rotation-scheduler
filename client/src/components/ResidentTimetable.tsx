import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  restrictToFirstScrollableAncestor,
  restrictToHorizontalAxis,
  restrictToWindowEdges,
} from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CCR_POSTINGS,
  CORE_REQUIREMENTS,
  ELECTIVE_REQUIREMENT,
  monthLabels,
} from "@/lib/constants";
import type { AcademicYearRange } from "@/lib/utils";
import {
  areSchedulesEqual,
  cn,
  formatAcademicYearLabel,
  moveByInsert,
} from "@/lib/utils";
import type { Posting, Resident, ResidentHistory, Warning } from "../types";

import { saveSchedule } from "@/api/api";
import { useApiResponseContext } from "@/context/ApiResponseContext";

import ConstraintsAccordion from "./ConstraintsAccordion";
import ErrorAlert from "./ErrorAlert";
import SortableBlockCell from "./SortableBlockCell";

import {
  ChevronLeft,
  ChevronRight,
  Info,
  InfoIcon,
  Loader2Icon,
} from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type BlockMap = Record<number, ResidentHistory>;

interface Props {
  resident: Resident;
  pinnedBlocks: number[];
  onTogglePinBlock: (blockNumber: number, postingCode: string) => void;
  onPrev: () => void;
  onNext: () => void;
  disablePrev: boolean;
  disableNext: boolean;
  academicYearRange: AcademicYearRange | null;
}

const ResidentTimetable: React.FC<Props> = ({
  resident,
  pinnedBlocks,
  onTogglePinBlock,
  onPrev,
  onNext,
  disablePrev,
  disableNext,
  academicYearRange,
}) => {
  const { apiResponse, setApiResponse } = useApiResponseContext();
  const [isSaving, setIsSaving] = useState(false);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const hasHydratedRef = useRef(false);

  // required so that popover does not get "eaten" by the DnD overlay
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 1,
      },
    })
  );

  const {
    postingMap,
    preferenceMap,
    srPreferenceMap,
    chosenSrBase,
    pastYearBlockPostings,
    initialCurrentYearBlockPostings,
    electiveCounts,
    currentYearItemIds,
    optimisationScoreRaw,
    optimisationScoreNormalised,
    residentIndex,
    electivePreferenceBases,
    corePostingBases,
  } = useMemo(() => {
    const postingMap: Record<string, Posting> = (
      apiResponse?.postings ?? []
    ).reduce((m, p) => {
      m[p.posting_code] = p;
      return m;
    }, {} as Record<string, Posting>);

    const allHistory = (apiResponse?.resident_history ?? []).filter(
      (h) => h.mcr === resident.mcr
    );

    const currentYear = allHistory.filter((h) => h.is_current_year === true);
    const pastYear = allHistory.filter((h) => h.is_current_year === false);
    const initialCurrentYearBlockPostings = currentYear.reduce<BlockMap>(
      (m, a) => {
        m[a.month_block] = a;
        return m;
      },
      {}
    );

    const pastYearBlockPostings = pastYear.reduce<
      Record<number, Record<number, ResidentHistory>>
    >((m, a) => {
      (m[a.year] ??= {})[a.month_block] = a;
      return m;
    }, {});

    const preferenceMap = (apiResponse?.resident_preferences ?? [])
      .filter((p) => p.mcr === resident.mcr && p.posting_code)
      .reduce<Record<number, string>>((m, p) => {
        m[p.preference_rank] = p.posting_code;
        return m;
      }, {});

    const srPreferenceMap = (apiResponse?.resident_sr_preferences ?? [])
      .filter((p) => p.mcr === resident.mcr && p.base_posting)
      .reduce<Record<number, string>>((m, p) => {
        m[p.preference_rank] = p.base_posting;
        return m;
      }, {});

    const chosenSrBase = apiResponse?.chosen_sr_by_resident?.[resident.mcr]?.trim() || undefined;

    const electivePreferenceBases = Object.values(preferenceMap)
      .map((code) => code?.split(" (")[0]?.trim())
      .filter((base): base is string => Boolean(base));

    const electiveCounts = allHistory
      .filter(
        (h) =>
          postingMap[h.posting_code]?.posting_type === "elective" && !h.is_leave
      )
      .reduce<Record<string, number>>((acc, h) => {
        acc[h.posting_code] = (acc[h.posting_code] ?? 0) + 1;
        return acc;
      }, {});

    const currentYearItemIds = monthLabels.map((_, i) => String(i + 1));

    const residentIndex =
      apiResponse?.residents?.findIndex((r) => r.mcr === resident.mcr) ?? -1;
    const optimisationScoreRaw =
      apiResponse?.statistics?.cohort?.optimisation_scores?.[residentIndex];
    const optimisationScoreNormalised =
      apiResponse?.statistics?.cohort?.optimisation_scores_normalised?.[
        residentIndex
      ];

    const corePostingBases = new Set(
      Object.values(postingMap)
        .filter((posting) => posting.posting_type === "core")
        .map((posting) => posting.posting_code.split(" (")[0]?.trim())
        .filter((base): base is string => Boolean(base))
    );

    return {
      postingMap,
      preferenceMap,
      srPreferenceMap,
      chosenSrBase,
      pastYearBlockPostings,
      initialCurrentYearBlockPostings,
      electiveCounts,
      currentYearItemIds,
      optimisationScoreRaw,
      optimisationScoreNormalised,
      residentIndex,      
      electivePreferenceBases,
      corePostingBases,
    };
  }, [apiResponse, resident.mcr]);

  // define formatted year label for current year row
  const currentYearLabel = useMemo(
    () =>
      formatAcademicYearLabel(
        resident.resident_year,
        resident.resident_year,
        academicYearRange
      ),
    [academicYearRange, resident.resident_year]
  );

  // define callback to pass past year labels into formatter
  const formatYearLabel = useCallback(
    (targetYear: number) =>
      formatAcademicYearLabel(
        targetYear,
        resident.resident_year,
        academicYearRange
      ),
    [academicYearRange, resident.resident_year]
  );

  const coreRequirementEntries = useMemo(
    () => Object.entries(CORE_REQUIREMENTS) as [string, number][],
    []
  );

  const electivesCompleted = resident.unique_electives_completed.length;
  const electiveRequirementMet = electivesCompleted >= ELECTIVE_REQUIREMENT;

  const requirementBadgeClass = (fulfilled: boolean) =>
    cn(
      "text-sm",
      fulfilled ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
    );

  const isPinned = (blockNumber: number) => pinnedBlocks.includes(blockNumber);

  // define current evolving state for current year block postings
  const [currentYearBlockPostings, setCurrentYearBlockPostings] =
    useState<BlockMap>(initialCurrentYearBlockPostings);
  // reference the original postings for comparison to current state
  const originalBlockPostings = useRef<BlockMap>(
    initialCurrentYearBlockPostings
  );
  // track which blocks have been edited
  const [editedBlocks, setEditedBlocks] = useState<Set<number>>(new Set());

  // boolean value to track if edits were made
  const hasEdits = useMemo(
    () =>
      !areSchedulesEqual(
        currentYearBlockPostings,
        originalBlockPostings.current
      ),
    [currentYearBlockPostings]
  );

  const handleDragEnd = (event: DragEndEvent) => {
    if (isSaving) return;
    const { active, over } = event;
    if (!over) return;

    const from = parseInt(String(active.id), 10);
    const to = parseInt(String(over.id), 10);
    if (Number.isNaN(from) || Number.isNaN(to) || from === to) return;

    const fromEntry = currentYearBlockPostings[from];
    const toEntry = currentYearBlockPostings[to];
    if (fromEntry?.is_leave || toEntry?.is_leave) return;

    setCurrentYearBlockPostings((prev) => {
      // insert and move other postings
      const updated = moveByInsert(prev, from, to);

      // recompute edited blocks vs baseline snapshot
      const newEdited = new Set<number>();
      for (let i = 1; i <= 12; i++) {
        const orig = originalBlockPostings.current[i]?.posting_code ?? "";
        const curr = updated[i]?.posting_code ?? "";
        if (orig !== curr) newEdited.add(i);
      }
      setEditedBlocks(newEdited);

      return updated;
    });
  };

  const handleCancel = () => {
    setCurrentYearBlockPostings(originalBlockPostings.current);
    setEditedBlocks(new Set());
    setWarnings([]);
  };

  const handleSelectPosting = (monthBlock: number, newPostingCode: string) => {
    if (isSaving) return;
    setCurrentYearBlockPostings((prev) => {
      if (prev[monthBlock]?.is_leave) {
        return prev;
      }
      const updated: BlockMap = { ...prev } as BlockMap;

      const existing: ResidentHistory = updated[monthBlock];
      const inferredYear =
        existing?.year ||
        Object.values(initialCurrentYearBlockPostings)[0]?.year ||
        0;
      const inferredCareerBlock =
        existing?.career_block ||
        (Object.values(initialCurrentYearBlockPostings)[0]?.career_block ?? 0) +
          (monthBlock - 1);

      updated[monthBlock] = existing
        ? {
            ...existing,
            posting_code: newPostingCode,
            is_leave: false,
            leave_type: "",
          }
        : {
            mcr: resident.mcr,
            year: inferredYear,
            month_block: monthBlock, // Ensure month_block is used here
            career_block: inferredCareerBlock, // Add career_block
            posting_code: newPostingCode,
            is_current_year: true,
            is_leave: false,
            leave_type: "",
          };

      // recompute edited blocks vs baseline snapshot
      const newEdited = new Set<number>();
      for (let i = 1; i <= 12; i++) {
        const orig = originalBlockPostings.current[i]?.posting_code ?? "";
        const curr = updated[i]?.posting_code ?? "";
        if (orig !== curr) newEdited.add(i);
      }
      setEditedBlocks(newEdited);

      return updated;
    });
  };

  const handleSave = async () => {
    if (isSaving || !resident) return;
    if (!hasEdits) return;

    setIsSaving(true);
    try {
      const current_year = Array.from({ length: 12 }, (_, i) => {
        const month_block = i + 1;
        const assignment = currentYearBlockPostings[month_block];
        if (!assignment) return null;
        return { 
          month_block, 
          posting_code: assignment.posting_code ?? null, 
          is_leave: assignment.is_leave ?? false
        }
      }).filter(Boolean) as { month_block: number; posting_code: string; is_leave: boolean }[];

      const updatedApi = await saveSchedule({
        resident_mcr: resident.mcr,
        current_year,
      });
      setApiResponse(updatedApi);
      setWarnings([]); // clear alerts on successful save
    } catch (err: any) {
      const validationWarnings = err?.response?.data?.warnings;
      if (Array.isArray(validationWarnings) && validationWarnings.length > 0) {
        setWarnings(validationWarnings);
        return;
      }
      const statusCode = err?.response?.status;
      const msg =
        err?.response?.data?.detail || "An error occurred while saving.";
      setWarnings([{ code: `ERR ${statusCode}`, description: msg }]);
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    // Nothing to hydrate
    if (!Object.keys(initialCurrentYearBlockPostings).length) return;

    // when timetable is first generated, set it with backend data
    if (!hasHydratedRef.current) {
      setCurrentYearBlockPostings(initialCurrentYearBlockPostings);
      originalBlockPostings.current = initialCurrentYearBlockPostings;
      hasHydratedRef.current = true;
      return;
    }

    // after saving, keep the blocks with leaves
    setCurrentYearBlockPostings(prev => {
      const merged: BlockMap = { ...initialCurrentYearBlockPostings };

      for (let i = 1; i <= 12; i++) {
        const existing = prev[i];

        if (existing?.is_leave) {
          merged[i] = existing;
        } else if (editedBlocks.has(i) && existing) {
          merged[i] = existing;
        }
      }

      return merged;
    });

    originalBlockPostings.current = initialCurrentYearBlockPostings;
    setEditedBlocks(new Set());
  }, [initialCurrentYearBlockPostings]);

  return (
    <Card className="bg-gray-50">
      {/* resident information */}
      <CardHeader>
        <CardTitle>Resident Information & Timetable</CardTitle>
        <CardDescription className="flex gap-8 items-center">
          <p>
            Name: {resident.name} ({resident.mcr})
          </p>
          <p>
            Current Residency Year:{" "}
            <Badge
              variant="outline"
              className="bg-blue-200 text-blue-800 text-md"
            >
              {resident.resident_year}
            </Badge>
          </p>
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="text-md bg-yellow-100 text-yellow-800 flex items-center gap-1"
          >
            Optimisation Score:{" "}
            {residentIndex >= 0 ? optimisationScoreNormalised : "-"}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-pointer">
                  <Info size={16} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-3xs">
                <div className="flex flex-col justify-center items-center text-center">
                  <p>
                    This score reflects how well this resident's timetable
                    matches their preferences and programme goals, normalised to
                    the top-performing resident in the cohort (100% = best score
                    achieved).
                  </p>
                  <br />
                  <span>
                    (Raw Score:{" "}
                    {residentIndex >= 0 ? optimisationScoreRaw : "-"})
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            onClick={onPrev}
            disabled={disablePrev}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onNext}
            disabled={disableNext}
          >
            <ChevronRight />
          </Button>
        </CardAction>
      </CardHeader>

      {/* resident timetable */}
      <CardContent>
        <div className="bg-white rounded-md border p-2">
          <DndContext
            modifiers={[
              restrictToHorizontalAxis, // lock movement to X only
              restrictToFirstScrollableAncestor, // prevent pulling the page/container vertically
              restrictToWindowEdges, // keep overlay within viewport
            ]}
            onDragEnd={isSaving ? undefined : handleDragEnd}
            sensors={sensors}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-left">Academic Year</TableHead>
                  {monthLabels.map((month) => (
                    <TableHead key={month} className="text-center">
                      {month}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Past years */}
                {Object.keys(pastYearBlockPostings)
                  .sort(
                    (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)
                  )
                  .map((yearKey) => {
                    const numericYear = Number.parseInt(yearKey, 10);
                    const yearPostings =
                      pastYearBlockPostings[numericYear] ?? {};
                    return (
                      <TableRow key={`year-${yearKey}`}>
                        <TableCell className="font-medium text-gray-600">
                          {formatYearLabel(numericYear)}
                        </TableCell>
                        {monthLabels.map((month, index) => {
                          const blockNumber = index + 1;
                          const postingAssignment = yearPostings[blockNumber];
                          const posting = postingAssignment
                            ? postingMap[postingAssignment.posting_code]
                            : null;

                          const code = posting?.posting_code;
                          const isLeave = postingAssignment?.is_leave;
                          const leaveType = postingAssignment?.leave_type;

                          const badgeClass =
                            posting?.posting_code &&
                            CCR_POSTINGS.includes(posting.posting_code)
                              ? "bg-purple-100 text-purple-800"
                              : posting?.posting_type === "core"
                              ? "bg-orange-100 text-orange-800"
                              : "bg-green-100 text-green-800";

                          return (
                            <TableCell
                              key={month}
                              className={cn(
                                "text-center",
                                isLeave && "bg-gray-100"
                              )}
                            >
                              {postingAssignment ? (
                                <div className="space-y-1">
                                  <div className="font-medium text-sm text-gray-600">
                                    {code ?? "-"}
                                  </div>
                                  <div className="flex items-center gap-1 justify-center">
                                    {posting && (
                                      <Badge
                                        className={badgeClass}
                                        variant="outline"
                                      >
                                        {posting?.posting_code &&
                                        CCR_POSTINGS.includes(
                                          posting.posting_code
                                        )
                                          ? "CCR"
                                          : posting?.posting_type.toUpperCase() ||
                                            ""}
                                      </Badge>
                                    )}
                                    {isLeave && (
                                      <Badge
                                        variant="secondary"
                                        className="bg-gray-200 text-gray-700"
                                      >
                                        {leaveType}
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-gray-300 text-sm">-</span>
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  })}

                {/* Current year */}
                <SortableContext
                  items={currentYearItemIds}
                  strategy={horizontalListSortingStrategy}
                >
                  <TableRow>
                    <TableCell className="bg-blue-100 font-semibold">
                      {currentYearLabel}
                    </TableCell>
                    {monthLabels.map((month, index) => {
                      const blockNumber = index + 1;
                      const postingAssignment =
                        currentYearBlockPostings[blockNumber];

                      return (
                        <SortableBlockCell
                          key={month}
                          blockNumber={blockNumber}
                          postingAssignment={postingAssignment}
                          edited={editedBlocks.has(blockNumber)}
                          postingMap={postingMap}
                          isPinned={isPinned(blockNumber)}
                          onTogglePin={(postingCode) => onTogglePinBlock(blockNumber, postingCode)}
                          onSelectPosting={(code) =>
                            handleSelectPosting(blockNumber, code)
                          }
                        />
                      );
                    })}
                  </TableRow>
                </SortableContext>
              </TableBody>
            </Table>
          </DndContext>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="ghost"
            className="cursor-pointer"
            onClick={handleCancel}
            disabled={!hasEdits || isSaving}
          >
            Cancel
          </Button>
          <Button
            className="bg-green-600 text-white hover:bg-green-700 cursor-pointer"
            onClick={handleSave}
            disabled={!hasEdits || isSaving}
          >
            {isSaving ? (
              <Loader2Icon>Validating & Saving...</Loader2Icon>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </CardContent>

      {/* validation results */}
      <CardContent className="flex gap-6">
        <div className="flex flex-col gap-2 w-1/2">
          {warnings.length > 0 ? (
            <ErrorAlert
              message="Warnings"
              description={warnings.map((v) => `[${v.code}] ${v.description}`)}
              variantType="destructive"
            />
          ) : (
            <>
              {resident.warnings && resident.warnings.length > 0 && (
                <ErrorAlert
                  message="Warnings"
                  description={resident.warnings.map(
                    (v) => `[${v.code}] ${v.description}`
                  )}
                />
              )}
              {(!resident.warnings || resident.warnings.length === 0) && (
                <ErrorAlert message="No warnings." />
              )}
            </>
          )}
        </div>
        <div className="w-1/2">
          <ConstraintsAccordion />
        </div>
      </CardContent>

      {/* resident statistics */}
      <CardContent className="flex flex-col md:flex-row justify-between gap-6 overflow-auto">
        <div className="flex gap-6">
          {/* core postings completed */}
          <div className="flex flex-col gap-2">
            {coreRequirementEntries.map(([basePosting, requiredBlocks]) => {
              const completedBlocks =
                resident.core_blocks_completed?.[basePosting] ?? 0;
              const isFulfilled = completedBlocks >= requiredBlocks;
              return (
                <div key={basePosting}>
                  <Badge
                    variant="outline"
                    className={requirementBadgeClass(isFulfilled)}
                  >
                    {basePosting} : {completedBlocks} / {requiredBlocks}
                  </Badge>
                </div>
              );
            })}
          </div>

          {/* ccr status */}
          <div className="flex flex-col gap-2">
            <Badge
              variant="outline"
              className={requirementBadgeClass(resident.ccr_status.completed)}
            >
              CCR Completed : {resident.ccr_status.completed ? "YES" : "NO"}
              <br />
              CCR Posting : {resident.ccr_status.posting_code}
            </Badge>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-6">
          {/* resident preferences */}
          <Card>
            <CardContent>
              <div className="flex justify-center mb-2">
                <Badge variant="secondary" className="text-sm">
                  Total Elective Preferences:{" "}
                  {
                    Object.values(preferenceMap).filter(
                      (code) => code.trim() !== ""
                    ).length
                  }
                </Badge>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center">Rank</TableHead>
                    <TableHead className="text-center">Elective Code</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(preferenceMap).map(([rank, postingCode]) => (
                    <TableRow key={rank}>
                      <TableCell className="text-center">{rank}</TableCell>
                      <TableCell className="text-center">
                        {postingCode.length > 0 ? postingCode : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* SR base preferences */}
          <Card>
            <CardContent>
              <div className="flex justify-center mb-2">
                <Badge variant="secondary" className="text-sm">
                  Total SR Preferences:{" "}
                  {
                    (Object.values(srPreferenceMap) as string[]).filter(
                      (base) => base.trim() !== ""
                    ).length
                  }
                </Badge>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center">Rank</TableHead>
                    <TableHead className="text-center">Department</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(Object.entries(srPreferenceMap) as [string, string][]).map(
                    ([rank, base]) => {
                      const trimmedBase = base?.trim() ?? "";
                      const isAssignedSr =
                        chosenSrBase && trimmedBase === chosenSrBase;
                      const isCoreSrBase =
                        trimmedBase.length > 0 &&
                        corePostingBases.has(trimmedBase);
                      const isNotValidSr =
                        trimmedBase.length > 0 &&
                        electivePreferenceBases.length > 0 &&
                        !electivePreferenceBases.includes(trimmedBase) &&
                        !isCoreSrBase;
                      return (
                        <TableRow
                          key={rank}
                          className={cn(
                            isAssignedSr &&
                              "bg-green-50 hover:bg-green-100 font-semibold",
                            isNotValidSr &&
                              "bg-gray-100 hover:bg-gray-200 font-semibold"
                          )}
                        >
                          <TableCell className="text-center">{rank}</TableCell>
                          <TableCell className="flex justify-center text-center">
                            {trimmedBase.length > 0 ? trimmedBase : "-"}
                            {isAssignedSr && (
                              <Badge className="ml-2 text-xs bg-green-200 text-green-900">
                                <Tooltip>
                                  <TooltipTrigger>
                                    <InfoIcon size={14} />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>
                                      Assigned at month{" "}
                                      {currentYearBlockPostings &&
                                        Object.entries(currentYearBlockPostings)
                                          .filter(
                                            ([, assignment]) =>
                                              assignment &&
                                              assignment.posting_code
                                                .split(" (")[0]
                                                .trim() === trimmedBase
                                          )
                                          .map(([block]) => block)
                                          .join(", ")}
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </Badge>
                            )}
                            {isNotValidSr && (
                              <>
                                <Badge className="ml-2 text-xs bg-gray-300 text-gray-900">
                                  <Tooltip>
                                    <TooltipTrigger>
                                      <InfoIcon size={14} />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>
                                        Not indicated in elective preferences.
                                      </p>
                                    </TooltipContent>
                                  </Tooltip>
                                </Badge>
                              </>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    }
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* electives completed */}
          <Card>
            <CardContent>
              <div className="flex justify-center mb-2">
                <Badge
                  variant="outline"
                  className={requirementBadgeClass(electiveRequirementMet)}
                >
                  Total Electives Completed: {electivesCompleted} /{" "}
                  {ELECTIVE_REQUIREMENT}
                </Badge>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center">Elective Name</TableHead>
                    <TableHead className="text-center">Month(s)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(electiveCounts).map(([code, count]) => {
                    const base = code.split(" (")[0].trim();
                    const isChosenSr = chosenSrBase && base === chosenSrBase;
                    return (
                      <TableRow
                        key={code}
                        className={cn(
                          isChosenSr &&
                            "bg-green-50 hover:bg-green-100 font-semibold border border-green-200"
                        )}
                      >
                        <TableCell className="text-center align-middle">
                          {postingMap[code]?.posting_code || code}
                          {isChosenSr && (
                            <Badge className="ml-2 text-xs bg-green-200 text-green-900">
                              Assigned
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-center align-middle">
                          {count}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </CardContent>
    </Card>
  );
};

export default ResidentTimetable;
