"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MAX_SHOWN = 100; // the vendor list has 2,000+ entries; searching narrows it
const LIST_MAX_H = 240;
const PANEL_H = LIST_MAX_H + 56; // list + search bar

type Item = { kind: "clear" | "custom" | "option"; value: string; label: string };

/**
 * A select-like cell: it shows the chosen value (pointer cursor, no typing in the cell). A click opens a panel with a
 * search box on top and the options below. Arrows + Enter pick, Esc closes. The panel is portalled so the table's
 * overflow does not clip it. With `allowCustom`, a typed value that is not in the list can be used as-is
 * (Payment Status); otherwise only listed values can be chosen, and the cell can be cleared.
 */
export function Combobox({ value, onChange, options, className, title, placeholder, autoFocus, allowCustom }: {
  value: string; onChange: (v: string) => void; options: string[];
  className?: string; title?: string; placeholder?: string; autoFocus?: boolean; allowCustom?: boolean;
}) {
  const listId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);

  const { items, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    const out: Item[] = [];
    if (!q && value) out.push({ kind: "clear", value: "", label: "Kosongkan pilihan" });
    if (allowCustom && q && !options.some((o) => o.toLowerCase() === q)) out.push({ kind: "custom", value: query.trim(), label: `Gunakan "${query.trim()}"` });
    matches.slice(0, MAX_SHOWN).forEach((o) => out.push({ kind: "option", value: o, label: o }));
    return { items: out, total: matches.length };
  }, [options, query, value, allowCustom]);

  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < PANEL_H + 16 && r.top > below;
    setRect({ left: r.left, top: up ? r.top : r.bottom, width: Math.max(r.width, 280), up });
  };

  useLayoutEffect(() => { if (open) place(); }, [open, items.length]);
  useEffect(() => {
    if (!open) return;
    const on = () => place();
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    document.addEventListener("mousedown", outside);
    return () => { window.removeEventListener("scroll", on, true); window.removeEventListener("resize", on); document.removeEventListener("mousedown", outside); };
  }, [open]);
  const placed = rect !== null; // the panel mounts once it has a position; focus its search box then
  useEffect(() => { if (open && placed) searchRef.current?.focus(); }, [open, placed]);
  useEffect(() => { panelRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  useEffect(() => { if (autoFocus) btnRef.current?.focus(); }, [autoFocus]);

  const openList = () => {
    setQuery("");
    const i = items.findIndex((it) => it.kind === "option" && it.value === value);
    setActive(Math.max(i, items[0]?.kind === "clear" ? 1 : 0));
    setOpen(true);
  };
  const close = (refocus = true) => { setOpen(false); if (refocus) btnRef.current?.focus(); };
  const pick = (it: Item) => { onChange(it.value); close(); };

  return (
    <div className="relative h-full w-full">
      <button
        ref={btnRef}
        type="button"
        title={title ?? value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key) && !open) { e.preventDefault(); openList(); } }}
        className={`${className ?? ""} flex cursor-pointer items-center pr-7 text-left`}
      >
        <span className={`block min-w-0 flex-1 truncate ${value ? "" : "text-faint"}`}>{value || placeholder || "—"}</span>
      </button>
      <svg aria-hidden viewBox="0 0 20 20" className={`pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 5 5 5-5" /></svg>
      {open && rect && createPortal(
        <div
          ref={panelRef}
          style={{ position: "fixed", left: rect.left, width: rect.width, ...(rect.up ? { bottom: window.innerHeight - rect.top + 2 } : { top: rect.top + 2 }) }}
          className="z-[70] overflow-hidden rounded-md border border-line bg-white shadow-[0_8px_32px_0_rgba(0,0,0,0.14)]"
        >
          <div className="relative border-b border-line p-2">
            <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="9" r="5.5" /><path d="m13.5 13.5 3.5 3.5" /></svg>
            <input
              ref={searchRef}
              value={query}
              placeholder="Cari…"
              autoComplete="off"
              aria-label="Cari pilihan"
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                else if (e.key === "Enter") { e.preventDefault(); const it = items[active] ?? items[0]; if (it) pick(it); }
                else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
                else if (e.key === "Tab") close();
              }}
              className="h-9 w-full rounded-md border-2 border-faint bg-white pl-8 pr-2 text-sm text-ink outline-none placeholder:text-faint focus:border-brand-500"
            />
          </div>
          <div id={listId} role="listbox" style={{ maxHeight: LIST_MAX_H }} className="overflow-auto py-1">
            {items.length === 0 && <div className="px-3 py-2 text-sm text-subtle">Tidak ada yang cocok.</div>}
            {items.map((it, i) => (
              <div
                key={`${it.kind}:${it.value}`}
                data-i={i}
                role="option"
                aria-selected={it.kind === "option" && it.value === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(it)}
                className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-brand-100" : ""} ${it.kind === "clear" ? "text-danger" : it.kind === "custom" ? "font-bold text-brand-500" : it.value === value ? "font-bold text-brand-500" : "text-ink"}`}
              >
                {it.label}
              </div>
            ))}
          </div>
          {total > MAX_SHOWN && <div className="border-t border-line px-3 py-1.5 text-xs text-subtle">Menampilkan {MAX_SHOWN} dari {total}. Ketik untuk mempersempit.</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
