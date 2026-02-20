import React, { useState, useEffect } from "react";
import { useApiResponseContext } from "@/context/ApiResponseContext";
import { downloadCsv } from "@/api/api";
import { useResidentPinning } from "@/hooks/use-resident-pinning";
import PlanningOverviewTable from "../components/PlanningOverviewTable";
import ErrorAlert from "../components/ErrorAlert";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "lucide-react";

const OverviewPage: React.FC = () => {
  const { apiResponse } = useApiResponseContext();
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const {
    togglePin,
    pinAllYear,
    unpinAllYear
  } = useResidentPinning(apiResponse?.residents, pinnedMcrs, setPinnedMcrs);

  useEffect(() => {
    try {
      localStorage.setItem(
        "pinnedMcrs",
        JSON.stringify(Array.from(pinnedMcrs.values()))
      );
    } catch {}
  }, [pinnedMcrs]);

  const handleDownloadCSV = async () => {
    if (!apiResponse) {
      setError("No timetable data available to download");
      return;
    }

    setIsDownloading(true);
    setError(null);

    try {
      const blob = await downloadCsv(apiResponse);
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `generated_timetable_${timestamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unknown error occurred");
      }
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="container mx-auto bg-white rounded-xl border p-8 flex flex-col gap-6">
      {!apiResponse && (
        <p className="text-center">Please generate a timetable first.</p>
      )}

      {error && <ErrorAlert message={error} />}

      {apiResponse && (
        <PlanningOverviewTable
          apiResponse={apiResponse}
          pinnedMcrs={pinnedMcrs}
          setPinnedMcrs={setPinnedMcrs}
          onTogglePin={togglePin}
          onPinAllYear={pinAllYear}
          onUnpinAllYear={unpinAllYear}
        />
      )}

      <div className="col-span-1 md:col-span-2 text-sm text-gray-600">
        Tip: Use the 'Re-Generate Timetable' button on the Dashboard page to
        re-run the solver with pinned residents preserved.
      </div>

      {/* Export Button */}
      {apiResponse?.residents && (
        <div className="flex justify-end">
          <Button
            className="bg-green-600 text-white hover:bg-green-700"
            onClick={handleDownloadCSV}
            disabled={isDownloading}
          >
            {isDownloading ? (
              <>
                <Loader2Icon className="animate-spin" />
                Downloading...
              </>
            ) : (
              "Export Final Timetable CSV"
            )}
          </Button>
        </div>
      )}
    </div>
  );
};

export default OverviewPage;
