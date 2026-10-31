import InventoryForm from '@/components/InventoryForm';
import { itemReturnLabel, safeItemReturnTo } from '@/lib/itemEditReturn';

interface InventoryEditPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InventoryEditPage({ params, searchParams }: InventoryEditPageProps) {
  const resolvedParams = await params;
  const resolvedSearch = await searchParams;

  // Optional validated return destination (e.g. back to an operation draft); otherwise the Inventory list with its filters.
  const returnTo = safeItemReturnTo(resolvedSearch.returnTo);
  const qs = new URLSearchParams(
    Object.entries(resolvedSearch)
      .filter(([k, v]) => k !== 'returnTo' && typeof v === 'string' && (v as string).length > 0)
      .map(([k, v]) => [k, v as string])
  ).toString();
  const backHref = returnTo ?? `/inventory${qs ? `?${qs}` : ''}`;

  return <InventoryForm itemId={resolvedParams.id} backHref={backHref} backLabel={itemReturnLabel(returnTo)} />;
}
