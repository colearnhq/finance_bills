/** Shown instantly while a page's data streams in, so the sidebar responds to a click right away. */
export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Memuat">
      <div className="h-9 w-64 rounded-md bg-brand-100" />
      <div className="h-4 w-96 max-w-full rounded bg-brand-50" />
      <div className="card space-y-3 p-4">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-8 rounded bg-brand-50" />)}
      </div>
    </div>
  );
}
