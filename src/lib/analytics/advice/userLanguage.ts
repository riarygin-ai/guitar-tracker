// Server-only. The ONE resolver of a user's preferred AI Advice language,
// used by runAnalyticsWorkflow (so manual Run Analytics and the weekly
// automation cannot drift) and by the generators' own fallback. Reads the
// app-owned public.app_users row through the service client, keyed by the
// authenticated caller's server-resolved app_users.id — never a browser value.
// Never throws: any failure or invalid stored value resolves to English so an
// Analytics run can never fail just because a preference is unreadable.

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_ADVICE_LANGUAGE, normalizeAdviceLanguage, type AdviceLanguage } from './adviceLanguage';

export async function getUserPreferredLanguage(serviceClient: SupabaseClient, appUserId: number): Promise<AdviceLanguage> {
  try {
    const { data, error } = await serviceClient
      .from('app_users')
      .select('preferred_language')
      .eq('id', appUserId)
      .maybeSingle();
    if (error || !data) return DEFAULT_ADVICE_LANGUAGE;
    return normalizeAdviceLanguage((data as { preferred_language?: unknown }).preferred_language);
  } catch {
    return DEFAULT_ADVICE_LANGUAGE;
  }
}
