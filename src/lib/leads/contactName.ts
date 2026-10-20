// Contact-name normalization and deliberately CONSERVATIVE matching for the
// MCP find_contact_history tool. Pure, no dependencies.
//
// item_leads.contact_name is stored verbatim from the Lead Log; nothing is
// merged or rewritten in the database. A name is never an identity:
//   - exact   = identical after normalization (case, whitespace, periods,
//               commas, apostrophe variants, accents)
//   - possible = a small set of explicit, explainable patterns (below),
//               always returned with a reason and score and never counted
//               as confirmed history
// No edit-distance / phonetic / nickname-dictionary fuzziness.

export function normalizeContactName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents (é -> e)
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type PossibleMatchReason =
  | 'last_name_initial'   // "john s" ~ "john smith"
  | 'first_name_prefix'   // "john smith" ~ "johnny smith"
  | 'extra_name_token'    // "john smith" ~ "john smith jr" / "john a smith"
  | 'first_name_only';    // query "john" ~ "john smith" (query has a single token)

export interface PossibleMatch {
  reason: PossibleMatchReason;
  /** 0-1, fixed per reason — an ordering hint, not a probability. */
  score: number;
}

const SCORE: Record<PossibleMatchReason, number> = {
  last_name_initial: 0.8,
  extra_name_token: 0.75,
  first_name_prefix: 0.7,
  first_name_only: 0.4,
};

/**
 * Classifies two ALREADY-NORMALIZED names that are not exactly equal.
 * Returns null when no conservative pattern applies.
 */
export function possibleNameMatch(query: string, stored: string): PossibleMatch | null {
  if (!query || !stored || query === stored) return null;
  const q = query.split(' ');
  const s = stored.split(' ');
  const hit = (reason: PossibleMatchReason): PossibleMatch => ({ reason, score: SCORE[reason] });

  if (q.length === 1) {
    return s.length > 1 && s[0] === q[0] ? hit('first_name_only') : null;
  }
  if (s.length < 2) return null;

  const qFirst = q[0], sFirst = s[0], qLast = q[q.length - 1], sLast = s[s.length - 1];

  // Same first name, one side's last name is the other's initial.
  if (q.length === 2 && s.length === 2 && qFirst === sFirst) {
    if ((qLast.length === 1 && sLast.startsWith(qLast)) || (sLast.length === 1 && qLast.startsWith(sLast))) {
      return hit('last_name_initial');
    }
  }

  // One name's tokens are all contained, in order, in the other's (adds a middle name / suffix).
  const shorter = q.length < s.length ? q : s;
  const longer = q.length < s.length ? s : q;
  if (shorter.length >= 2 && shorter.length < longer.length) {
    let i = 0;
    for (const t of longer) if (t === shorter[i]) i++;
    if (i === shorter.length) return hit('extra_name_token');
  }

  // Same last name, one first name is a prefix (>= 3 chars) of the other.
  if (q.length === 2 && s.length === 2 && qLast === sLast && qFirst !== sFirst) {
    const [a, b] = qFirst.length <= sFirst.length ? [qFirst, sFirst] : [sFirst, qFirst];
    if (a.length >= 3 && b.startsWith(a)) return hit('first_name_prefix');
  }

  return null;
}
