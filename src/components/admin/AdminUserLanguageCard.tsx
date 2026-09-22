'use client';

// Compact "Users" card on the existing Admin page: per-user Preferred AI
// Language (General Business Coach + Listing Advice prose only — not app
// localization). Reads/writes through the admin-gated /api/admin/users route;
// the change applies on the NEXT analytics run and never rewrites old advice.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { ADVICE_LANGUAGE_OPTIONS, isAdviceLanguage, type AdviceLanguage } from '@/lib/analytics/advice/adviceLanguage';

interface AdminUserRow { id: number; email: string | null; display_name: string; preferred_language: AdviceLanguage }

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  return { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
}

export default function AdminUserLanguageCard() {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/users', { headers: await authHeaders() });
        if (!res.ok) throw new Error('Failed to load users');
        setUsers(((await res.json()).users ?? []) as AdminUserRow[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load users');
      }
    })();
  }, []);

  async function change(userId: number, value: string) {
    if (!isAdviceLanguage(value)) return;
    setSavingId(userId);
    setError(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify({ userId, preferredLanguage: value }),
      });
      if (!res.ok) throw new Error('Failed to update language');
      setUsers((prev) => prev?.map((u) => (u.id === userId ? { ...u, preferred_language: value } : u)) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update language');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800" data-admin-user-language>
      <h2 className="text-base font-semibold text-slate-900 dark:text-white">Users</h2>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Preferred AI Language applies to Business Coach and Listing Advice text only. It takes effect on the next Analytics run; existing advice is not changed.
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {!users && !error && <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Loading users…</p>}
      {users && (
        <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-700">
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-white">{u.display_name}</p>
                {u.email && <p className="truncate text-xs text-slate-500 dark:text-slate-400">{u.email}</p>}
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <span>Preferred AI Language</span>
                <select
                  value={u.preferred_language}
                  disabled={savingId === u.id}
                  onChange={(e) => change(u.id, e.target.value)}
                  aria-label={`Preferred AI Language for ${u.display_name}`}
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs dark:border-slate-600 dark:bg-slate-700 dark:text-white"
                >
                  {ADVICE_LANGUAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
