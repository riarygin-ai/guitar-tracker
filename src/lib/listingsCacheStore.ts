// Session-scoped Listings cache singleton (module-level, in-memory only).
//
// Auth: cached responses are per-user. Logout in this app is a client-side
// route push (LogoutButton -> router.push('/login')), NOT a full reload, so
// this module survives a logout->login in the same tab; supabase.ts
// therefore forwards every auth event to `listingsUserGuard`, which clears
// the cache on sign-out and whenever the signed-in user id changes.
// Nothing here is shared server-side.
//
// Deliberately free of any supabase import so supabase.ts can import the
// invalidators without a cycle.

import { createSwrCache, createUserScopeGuard } from './swrCache';
import { createListingsInvalidators } from './listingsCacheKeys';

export const listingsCache = createSwrCache();
export const listingsUserGuard = createUserScopeGuard(listingsCache);

export const {
  invalidateListingEvidenceCache,
  invalidateListingDemandCache,
  invalidateItemActivityCache,
  invalidateListingAdviceCache,
  invalidateListingsCache,
} = createListingsInvalidators(listingsCache);
