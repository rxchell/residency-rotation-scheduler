import React, { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { Posting, ResidentHistory } from "../types";
import { cn } from "@/lib/utils";
import { CCR_POSTINGS } from "@/lib/constants";

import { PinOffIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { TableCell } from "./ui/table";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ChevronsUpDownIcon, CheckIcon, TrashIcon } from "lucide-react";

interface SortableBlockCellProps {
  blockNumber: number;
  postingAssignment?: ResidentHistory;
  edited: boolean;
  postingMap: Record<string, Posting>;
  isPinned: boolean;
  onTogglePin: ()=> void;
  onSelectPosting?: (code: string) => void;
}

const SortableBlockCell: React.FC<SortableBlockCellProps> = ({
  blockNumber,
  postingAssignment,
  edited,
  postingMap,
  isPinned,
  onTogglePin,
  onSelectPosting,
}) => {
  const [open, setOpen] = useState<boolean>(false);

  const posting = postingAssignment
    ? postingMap[postingAssignment.posting_code]
    : null;

  const code = posting?.posting_code;
  const isLeave = postingAssignment?.is_leave;
  const leaveType = postingAssignment?.leave_type;
  const leavePosting = (isLeave && postingAssignment?.posting_code) || "-";

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: blockNumber.toString(),
    animateLayoutChanges: () => false,
    disabled: Boolean(isLeave || isPinned),
  });

  const sortableListeners = isLeave ? undefined : listeners;
  const sortableAttributes = isLeave ? undefined : attributes;

  const style: React.CSSProperties = {
    transform: transform ? CSS.Transform.toString(transform) : undefined,
    transition,
  };

  const badgeClass =
    posting?.posting_code && CCR_POSTINGS.includes(posting.posting_code)
      ? "bg-purple-100 text-purple-800"
      : posting?.posting_type === "core"
      ? "bg-orange-100 text-orange-800"
      : "bg-green-100 text-green-800";

  const selected = postingAssignment?.posting_code ?? "";

  return (
    <TableCell
      className={cn(
        "relative text-center bg-blue-100 hover:bg-blue-200",
        edited && !isPinned && "bg-yellow-100 hover:bg-yellow-200",
        isOver && "bg-blue-200",
        isLeave && "bg-gray-200 hover:bg-gray-300",
        isPinned && "ring-1 ring-amber-400"
      )}
    >
      <div
        ref={setNodeRef}
        style={style}
        {...(sortableListeners ?? {})}
        {...(sortableAttributes ?? {})}
        className={cn(
          "space-y-1",
          isLeave ? "cursor-not-allowed" : "cursor-grab",
          isDragging && !isLeave && "cursor-grabbing"
        )}
      >
        {/* LEAVE BLOCK */}
        {isLeave ? (
          <div className="flex items-center justify-center">
            <p className="font-medium text-sm text-gray-700">{leavePosting}</p>
          </div>
        ) : (
          /* NORMAL / PINNED BLOCK */
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <div className="flex items-center justify-center">
                <p className="font-medium text-sm text-blue-800">
                  {code ?? "-"}
                </p>
                <ChevronsUpDownIcon
                  color="blue"
                  className="ml-2 h-4 w-4 shrink-0 opacity-50"
                />
              </div>
            </PopoverTrigger>
            <PopoverContent className="w-[260px] p-0">
              <Command>
                <div className="flex justify-between items-center pr-2">
                  <CommandInput placeholder="Search code" />
                  <Button
                    type="button"
                    size="sm"
                    variant={isPinned ? "secondary" : "outline"}
                    onClick={() => {
                      onTogglePin();
                      setOpen(false);
                    }}
                    className="shrink-0"
                  >
                    {isPinned ? "Unpin block" : "Pin block"}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    onClick={() => {
                      onSelectPosting?.("");
                      setOpen(false);
                    }}
                    className="size-6 cursor-pointer"
                  >
                    <TrashIcon />
                  </Button>
                </div>
                <CommandList>
                  <CommandEmpty>No posting found.</CommandEmpty>
                  {(() => {
                    // group postings by type (and CCR)
                    const postings = Object.values(postingMap);
                    const ccr = postings.filter((p) =>
                      CCR_POSTINGS.includes(p.posting_code)
                    );
                    const core = postings.filter(
                      (p) =>
                        !CCR_POSTINGS.includes(p.posting_code) &&
                        p.posting_type === "core"
                    );
                    const elective = postings.filter(
                      (p) =>
                        !CCR_POSTINGS.includes(p.posting_code) &&
                        p.posting_type === "elective"
                    );
                    const others = postings.filter(
                      (p) =>
                        !CCR_POSTINGS.includes(p.posting_code) &&
                        p.posting_type !== "core" &&
                        p.posting_type !== "elective"
                    );

                    // define callback function to render each posting item
                    const renderItem = (p: Posting) => (
                      <CommandItem
                        key={p.posting_code}
                        value={`${p.posting_code} ${p.posting_type}`}
                        onSelect={(_) => {
                          onSelectPosting?.(p.posting_code);
                          setOpen(false);
                        }}
                      >
                        <CheckIcon
                          className={cn(
                            "mr-2 h-4 w-4",
                            selected === p.posting_code
                              ? "opacity-100"
                              : "opacity-0"
                          )}
                        />
                        <div className="flex flex-col">
                          <span className="font-medium">{p.posting_code}</span>
                          <span className="text-xs text-muted-foreground">
                            {p.posting_type
                              ? p.posting_type.toUpperCase()
                              : "UNKNOWN"}
                          </span>
                        </div>
                      </CommandItem>
                    );

                    return (
                      <>
                        {ccr.length > 0 && (
                          <CommandGroup heading="CCR">
                            {ccr.map(renderItem)}
                          </CommandGroup>
                        )}
                        {core.length > 0 && (
                          <CommandGroup heading="Core">
                            {core.map(renderItem)}
                          </CommandGroup>
                        )}
                        {elective.length > 0 && (
                          <CommandGroup heading="Elective">
                            {elective.map(renderItem)}
                          </CommandGroup>
                        )}
                        {others.length > 0 && (
                          <CommandGroup heading="Others">
                            {others.map(renderItem)}
                          </CommandGroup>
                        )}
                      </>
                    );
                  })()}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
        <div className="flex items-center gap-1 justify-center">
          {posting && (
            <Badge className={badgeClass} variant="outline">
              {posting?.posting_code &&
              CCR_POSTINGS.includes(posting.posting_code)
                ? "CCR"
                : posting?.posting_type.toUpperCase() || ""}
            </Badge>
          )}
          {isLeave && (
            <Badge variant="secondary" className="bg-gray-100 text-gray-700">
              {leaveType}
            </Badge>
          )}
        </div>
        {/*UNPIN ACTION (VISIBLE WHEN PINNED) */}
        {isPinned && (
          <Button
            size="icon"
            variant="ghost"
            className="mx-auto mt-1 h-6 w-6"
            onClick={onTogglePin}
          >
            <PinOffIcon className="h-4 w-4 text-red" />
          </Button>
        )}
      </div>
    </TableCell>
  );
};

export default SortableBlockCell;
