"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
      className={`block rounded-md px-3 py-2 font-display text-sm font-bold transition-colors ${active ? "bg-brand-100 text-brand-500" : "text-ink hover:bg-brand-50"}`}
    >
      {children}
    </Link>
  );
}
