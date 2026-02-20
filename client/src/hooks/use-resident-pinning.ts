import { useMemo, useCallback } from "react";
import { groupResidentsByYear } from "@/lib/residentOrdering";
import type { Resident } from "@/types";

export function useResidentPinning(
  residents: Resident[] | null | undefined,
  pinnedMcrs: Set<string>,
  setPinnedMcrs: React.Dispatch<React.SetStateAction<Set<string>>>
) {
    
  const groupedResidents = useMemo(
    () => (residents ? groupResidentsByYear(residents) : {}),
    [residents]
  );

  const togglePin = useCallback(
    (mcr: string) => {
      setPinnedMcrs((prev) => {
        const next = new Set(prev);
        if (next.has(mcr)) {
          next.delete(mcr);
        } else {
          next.add(mcr);
        }
        return next;
      });
    },
    [setPinnedMcrs]
  );

  const pinAllYear = useCallback(
    (year: number) => {
      const list = groupedResidents[year] || [];
      setPinnedMcrs((prev) => {
        const next = new Set(prev);
        list.forEach((r) => next.add(r.mcr));
        return next;
      });
    },
    [groupedResidents, setPinnedMcrs]
  );

  const unpinAllYear = useCallback(
    (year: number) => {
      const list = groupedResidents[year] || [];
      setPinnedMcrs((prev) => {
        const next = new Set(prev);
        list.forEach((r) => next.delete(r.mcr));
        return next;
      });
    },
    [groupedResidents, setPinnedMcrs]
  );

  const isYearFullyPinned = useCallback(
    (year: number) => {
      const list = groupedResidents[year] || [];
      if (list.length === 0) return false;
      return list.every((r) => pinnedMcrs.has(r.mcr));
    },
    [groupedResidents, pinnedMcrs]
  );

  return {
    groupedResidents,
    togglePin,
    pinAllYear,
    unpinAllYear,
    isYearFullyPinned,
  };
}