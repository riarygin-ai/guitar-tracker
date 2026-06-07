export type ItemType = 'guitar' | 'amp' | 'pedal' | 'cab' | 'parts' | 'bass' | 'processor' | 'acoustic guitar';
export type Status = 'new' | 'owned' | 'listed' | 'sold' | 'traded';
export type DealType = 'purchase' | 'sale' | 'trade' | 'expense';
export type Direction = 'in' | 'out';
export type CollectionType = 'Personal' | 'Business' | 'Hybrid';
export type Condition = 'Mint' | 'Excellent' | 'Very Good' | 'Good' | 'Fair';

export interface AppUser {
  id: number;
  auth_user_id: string;
  email: string | null;
  display_name: string;
  created_at: string;
}

export interface Brand {
  id: number;
  name: string;
  created_at: string;
}

export interface InventoryItem {
  id: number;
  user_id: number;
  brand_id: number;
  item_type: ItemType;
  model: string;
  serial_number: string | null;
  date_listed: string | null;
  sold_date: string | null;
  estimated_sold_value: number | null;
  collection_type: CollectionType | null;
  condition: Condition | null;
  status: Status;
  notes: string | null;
  year: number | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export type InventoryItemWithValue = InventoryItem & {
  value_in: number | null;
  value_out?: number | null;
  acquired_date?: string | null;
};

export interface Deal {
  id: number;
  user_id: number;
  deal_date: string;
  deal_type: DealType;
  channel: string | null;
  cash_received: number | null;
  cash_paid: number | null;
  fees: number | null;
  notes: string | null;
  created_at: string;
}

export interface DealItem {
  id: number;
  user_id: number;
  deal_id: number;
  item_id: number;
  direction: Direction;
  total_value: number | null;
  notes: string | null;
  created_at: string;
}

export interface CashFlow {
  id: number;
  user_id: number;
  deal_id: number | null;
  transaction_date: string;
  opening_balance: number;
  cash_in: number;
  cash_out: number;
  closing_balance: number;
  description: string | null;
  created_at: string;
}

export interface InventoryExpense {
  id: number;
  user_id: number;
  deal_id: number | null;
  item_id: number | null;
  expense_date: string;
  amount: number;
  notes: string;
  created_at: string;
}

export interface InventoryItemPhoto {
  id: number;
  user_id: number;
  inventory_item_id: number;
  storage_path: string;
  file_name: string | null;
  content_type: string | null;
  file_size: number | null;
  is_main: boolean;
  sort_order: number;
  created_at: string;
}

export type NewBrand = Pick<Brand, 'name'>;

export type NewInventoryItem = Omit<InventoryItem, 'id' | 'created_at' | 'updated_at' | 'user_id'>;
export type NewDeal = Omit<Deal, 'id' | 'created_at' | 'user_id'>;
export type NewDealItem = Omit<DealItem, 'id' | 'created_at' | 'user_id'>;
export type NewCashFlow = Omit<CashFlow, 'id' | 'created_at' | 'user_id'>;
export type NewInventoryExpense = Omit<InventoryExpense, 'id' | 'created_at' | 'user_id'>;

export type UpdateInventoryItem = Partial<Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>> & {
  id: number;
};

export type UpdateDeal = Partial<Omit<Deal, 'id' | 'created_at'>> & {
  id: number;
};

export interface InventorySearchItem extends InventoryItem {
  brand_name: string;
}
