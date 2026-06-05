import InventoryForm from '@/components/InventoryForm';

interface InventoryEditPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InventoryEditPage({ params, searchParams }: InventoryEditPageProps) {
  const resolvedParams = await params;
  const resolvedSearch = await searchParams;

  const qs = new URLSearchParams(
    Object.entries(resolvedSearch)
      .filter(([, v]) => typeof v === 'string' && (v as string).length > 0)
      .map(([k, v]) => [k, v as string])
  ).toString();
  const backHref = `/inventory${qs ? `?${qs}` : ''}`;

  return <InventoryForm itemId={resolvedParams.id} backHref={backHref} />;
}
