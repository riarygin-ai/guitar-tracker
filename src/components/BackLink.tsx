import Link from 'next/link';

// The small back-arrow navigation pattern used by Inventory item detail
// (InventoryForm "Back to Inventory"): 14px arrow + text link, subtle slate
// with hover emphasis. Shared here so /leads does not invent a different
// back control. The vertical padding only grows the tap target — the
// visual size is unchanged.
export default function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="-my-2 inline-flex items-center gap-1.5 rounded py-2 text-sm font-medium text-slate-500 transition hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400 dark:hover:text-white"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      {label}
    </Link>
  );
}
