/** Truncates a description string to `max` characters, appending an
 *  ellipsis, so a many-item multi-item Purchase/Sale cash_flow.description
 *  never grows unbounded. Safe no-op for strings already within the limit. */
export function truncateDescription(text: string, max = 80): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
