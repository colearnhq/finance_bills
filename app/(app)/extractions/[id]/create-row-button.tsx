"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createFromExtraction } from "@/lib/payment-schedule/actions";

export function CreateRowButton({ extractionId, existingRowId }: { extractionId: string; existingRowId: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (rowId: string) => router.push(`/payment-schedule?highlight=${rowId}`);
  if (existingRowId) return <button className="btn" onClick={() => go(existingRowId)}>Lihat di Payment Schedule</button>;
  return (
    <span className="inline-flex items-center gap-3">
      <button
        className="btn btn-primary"
        disabled={pending}
        onClick={() => start(async () => {
          const res = await createFromExtraction(extractionId);
          if (res.ok) go(res.row.id); else setError(res.error);
        })}
      >
        {pending ? "Membuat…" : "Buat baris Payment Schedule"}
      </button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </span>
  );
}
