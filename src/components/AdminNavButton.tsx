'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getOrCreateAppUser } from '@/lib/supabase';

export default function AdminNavButton() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    getOrCreateAppUser().then((user) => {
      if (user?.admin) setIsAdmin(true);
    });
  }, []);

  if (!isAdmin) return null;

  return (
    <Link
      href="/admin"
      className="inline-flex items-center rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
    >
      Admin
    </Link>
  );
}
