export type ItemType = 'guitar' | 'amp' | 'pedal' | 'cab' | 'pickups';
export type Status = 'owned' | 'listed' | 'sold' | 'traded';
export type DealType = 'purchase' | 'sale' | 'trade' | 'expense';
export type Direction = 'in' | 'out';
export type CollectionType = 'Personal' | 'Business' | 'Hybrid';
export type Condition = 'Mint' | 'Excellent' | 'Very Good' | 'Good' | 'Fair';

export interface Brand {
  id: number;
  name: string;
  created_at: string;
}

export interface InventoryItem {
  id: number;
  brand_id: number;
  item_type: ItemType;
  model: string;
  date_acquired: string | null;
  date_listed: string | null;
  sold_date: string | null;
  estimated_sold_value: number | null;
  collection_type: CollectionType | null;
  condition: Condition | null;
  status: Status;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Deal {
  id: number;
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
  deal_id: number;
  item_id: number;
  direction: Direction;
  cash_value: number | null;
  trade_value: number | null;
  total_value: number | null;
  notes: string | null;
  created_at: string;
}

export type NewBrand = Pick<Brand, 'name'>;

export type NewInventoryItem = Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>;
export type NewDeal = Omit<Deal, 'id' | 'created_at'>;
export type NewDealItem = Omit<DealItem, 'id' | 'created_at'>;

export type UpdateInventoryItem = Partial<Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>> & {
  id: number;
};

export type UpdateDeal = Partial<Omit<Deal, 'id' | 'created_at'>> & {
  id: number;
};