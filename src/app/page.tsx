import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="space-y-8 py-10">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Guitar Tracker</p>
        <h1 className="mt-4 text-3xl font-semibold text-slate-900 sm:text-4xl">
          Track your buying, selling, and trading from the browser.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
          A mobile-first inventory app for your guitars, amps, pedals, and cabinets. Start by viewing your active inventory and filter quickly by status.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/inventory"
            className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            Inventory
          </Link>
          <Link
            href="/operations"
            className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
          >
            Insert deal
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Mobile first</h2>
          <p className="mt-2 text-sm text-slate-600">
            Designed to work smoothly from a phone browser with responsive cards and easy navigation.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Supabase backend</h2>
          <p className="mt-2 text-sm text-slate-600">
            Inventory data is stored in Postgres and can be extended with auth, storage, and workflows.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Clean inventory UI</h2>
          <p className="mt-2 text-sm text-slate-600">
            Search, filter, and browse your guitars with a simple mobile-friendly interface.
          </p>
        </div>
      </section>
    </main>
  );
}
