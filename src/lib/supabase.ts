import { createClient } from '@supabase/supabase-js';
import type {
  Brand,
  Deal,
  DealItem,
  InventoryItem,
  NewBrand,
  NewDeal,
  NewDealItem,
  NewInventoryItem,
  UpdateDeal,
  UpdateInventoryItem,
} from '@/types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function getBrands(search?: string) {
  let query = supabase.from('brands').select('*').order('name', { ascending: true });
  if (search?.trim()) {
    query = query.ilike('name', `%${search.trim()}%`);
  }
  return query;
}

export async function createBrand(brand: NewBrand) {
  return supabase.from('brands').insert(brand).select().single();
}

export async function getInventoryItems() {
  return supabase.from('inventory_items').select('*');
}

export async function getInventoryItemById(id: number) {
  return supabase.from('inventory_items').select('*').eq('id', id).single();
}

export async function createInventoryItem(item: NewInventoryItem) {
  return supabase.from('inventory_items').insert(item).select().single();
}

export async function updateInventoryItem(item: UpdateInventoryItem) {
  const { id, ...payload } = item;
  return supabase
    .from('inventory_items')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
}

export async function getDeals() {
  return supabase.from('deals').select('*');
}

export async function createDeal(deal: NewDeal) {
  return supabase.from('deals').insert(deal).select().single();
}

export async function createDealItem(dealItem: NewDealItem) {
  return supabase.from('deal_items').insert(dealItem).select().single();
}
