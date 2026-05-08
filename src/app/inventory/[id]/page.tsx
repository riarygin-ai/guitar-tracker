import InventoryForm from '@/components/InventoryForm';

interface InventoryEditPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default async function InventoryEditPage({ params }: InventoryEditPageProps) {
  const resolvedParams = await params;
  console.log('Edit page params.id:', resolvedParams.id);
  return <InventoryForm itemId={resolvedParams.id} />;
}
