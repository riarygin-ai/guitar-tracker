import type { DraftType } from '@/lib/operations/operationDraftsClient';
import { DRAFT_TYPE_LABEL } from '@/lib/operations/operationDraftsClient';

/** "Draft Trade" — amber, dashed: never styled like a completed operation. */
export default function OperationDraftBadge({ type, className = '' }: { type: DraftType; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-dashed border-amber-400 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:border-amber-600 dark:bg-amber-900/20 dark:text-amber-300 ${className}`}
      data-testid="draft-badge"
    >
      Draft {DRAFT_TYPE_LABEL[type]}
    </span>
  );
}
