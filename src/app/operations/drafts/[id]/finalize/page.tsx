import { redirect } from 'next/navigation';

// Finalization now happens in the draft's own operation form (Finalize button);
// this older URL just opens the draft.
export default async function FinalizeOperationDraftRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/operations/drafts/${encodeURIComponent(id)}`);
}
