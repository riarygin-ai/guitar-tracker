export type ItemType = 'guitar' | 'amp' | 'pedal' | 'cab' | 'parts' | 'bass' | 'processor' | 'acoustic guitar';
export type Status = 'new' | 'owned' | 'listed' | 'sold' | 'traded';

export interface ItemCategory {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

export interface ItemSubtype {
  id: number;
  category_id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}
export type DealType = 'purchase' | 'sale' | 'trade' | 'expense';
export type Direction = 'in' | 'out';
export type CollectionType = 'Personal' | 'Business' | 'Hybrid';
export type Condition = 'Mint' | 'Excellent' | 'Very Good' | 'Good' | 'Fair';

export interface AppUser {
  id: number;
  auth_user_id: string;
  email: string | null;
  display_name: string;
  admin: boolean;
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
  item_subtype_id: number | null;
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

export type ListingType = 'reverb' | 'marketplace' | 'kijiji';
export type ListingStatus = 'draft' | 'published' | 'archived';

export interface ItemListing {
  id: number;
  user_id: number;
  inventory_item_id: number;
  listing_type: ListingType;
  title: string | null;
  description: string;
  asking_price: number | null;
  trade_value: number | null;
  currency: string;
  status: ListingStatus;
  is_ai_generated: boolean;
  ai_model: string | null;
  prompt_version: string | null;
  created_at: string;
  updated_at: string;
}

export type UpsertItemListing = Pick<
  ItemListing,
  | 'inventory_item_id'
  | 'listing_type'
  | 'description'
  | 'status'
  | 'is_ai_generated'
> &
  Partial<Pick<ItemListing, 'title' | 'asking_price' | 'trade_value' | 'currency' | 'ai_model' | 'prompt_version'>>;

export interface AiPrompt {
  id:          number;
  prompt_key:  string;
  name:        string;
  description: string | null;
  prompt_text: string;
  model:       string | null;
  temperature: number | null;
  is_active:   boolean;
  created_at:  string;
  updated_at:  string;
}

export type UpdateAiPrompt = Partial<Pick<
  AiPrompt,
  'name' | 'description' | 'prompt_text' | 'model' | 'temperature' | 'is_active'
>>;

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
