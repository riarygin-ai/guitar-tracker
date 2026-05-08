import InventoryForm from '@/components/InventoryForm';

interface InventoryEditPageProps {
  params: {
    id: string;
  };
}

export default function InventoryEditPage({ params }: InventoryEditPageProps) {
  return <InventoryForm itemId={params.id} />;
}
