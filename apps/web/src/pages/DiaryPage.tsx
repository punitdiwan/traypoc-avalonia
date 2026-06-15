import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import NavBar from "@/components/NavBar";
import DiaryTimeline from "@/components/DiaryTimeline";
import { diaryApi } from "@/lib/api";

export default function DiaryPage() {
  const { userId } = useParams<{ userId: string }>();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const { data, isLoading, error } = useQuery({
    queryKey: ["diary", userId, date],
    queryFn: () => diaryApi.get(userId!, date),
    enabled: !!userId,
  });

  const totalMinutes = data?.hours.reduce((acc, h) => acc + h.total_seconds, 0) ?? 0;
  const avgActivity =
    data && data.hours.length > 0
      ? Math.round(data.hours.reduce((a, h) => a + h.avg_activity, 0) / data.hours.length)
      : 0;

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Work Diary</h1>
            <p className="text-sm text-gray-400 font-mono mt-0.5">{userId}</p>
          </div>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {/* Summary bar */}
        {data && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            <Stat label="Hours tracked" value={`${(totalMinutes / 3600).toFixed(1)}h`} />
            <Stat label="Avg activity" value={`${avgActivity}%`} />
            <Stat label="Intervals" value={`${data.hours.reduce((a, h) => a + h.slots.length, 0)}`} />
          </div>
        )}

        {/* Timeline */}
        {isLoading && <p className="text-gray-400 text-sm">Loading…</p>}
        {error && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load diary"}
          </p>
        )}
        {data && <DiaryTimeline hours={data.hours} />}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className="text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}
