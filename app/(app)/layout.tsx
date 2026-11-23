import { Suspense } from "react";
import { logout } from "@/app/login/actions";
import { LISTS } from "@/lib/master-data/lists";
import { NavLink } from "./nav-link";

const Section = ({ children }: { children: React.ReactNode }) => (
  <div className="px-3 pb-1 pt-4 font-display text-[11px] font-bold uppercase tracking-wider text-faint">{children}</div>
);

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-1">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-white p-4 text-sm shadow-[0_0_32px_0_rgba(0,0,0,0.07)]">
        <div className="px-3 pb-4 pt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/colearn-logo.svg" alt="CoLearn" width={120} height={26} />
        </div>
        <Suspense fallback={<div className="flex-1" />}>
        <nav className="flex-1 space-y-0.5 overflow-y-auto">
          <NavLink href="/payment-schedule">Payment Schedule</NavLink>
          <NavLink href="/xero-bills">Xero Bills</NavLink>
          <NavLink href="/inbox">Inbox</NavLink>
          <NavLink href="/inbox/filters">Filter email</NavLink>
          <NavLink href="/extractions">Hasil ekstraksi</NavLink>
          <Section>Master Data</Section>
          {LISTS.map((l) => (
            <NavLink key={l.slug} href={`/master-data/${l.slug}`}>{l.title}</NavLink>
          ))}
          <Section>Kurs</Section>
          <NavLink href="/rates">Rate</NavLink>
        </nav>
        </Suspense>
        <form action={logout}>
          <button className="w-full rounded-md px-3 py-2 text-left font-display text-sm font-bold text-danger hover:bg-danger-50">Keluar</button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 p-8">
        <div className="mx-auto max-w-6xl">
          <Suspense fallback={<p className="muted">Memuat…</p>}>{children}</Suspense>
        </div>
      </main>
    </div>
  );
}
