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
  NewCashFlow,
  NewInventoryExpense,
  CashFlow,
  InventoryExpense,
} from '@/types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;


if (!supabaseUrl) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
}

if (!supabaseAnonKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
}

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
  return supabase.from('inventory_items_with_value').select('*');
}

export async function getInventoryItemsWithValue() {
  return supabase
    .from('inventory_items_with_value')
    .select('*')
}

export async function searchInventoryItems(query: string) {
  const trimmed = query.trim();

  if (!trimmed) {
    return supabase
      .from('inventory_items_search')
      .select('*')
      .not('status', 'in', '("sold","traded")')
      .order('created_at', { ascending: false })
      .limit(20);
  }

  return supabase
    .from('inventory_items_search')
    .select('*')
    .not('status', 'in', '("sold","traded")')
    .or(`brand_name.ilike.%${trimmed}%,model.ilike.%${trimmed}%,color.ilike.%${trimmed}%`)
    .order('created_at', { ascending: false })
    .limit(20);
}

export async function getInventoryItemById(id: number) {
  return supabase.from('inventory_items').select('*').eq('id', id).single();
}

export async function getInventoryItemWithValueById(id: number) {
  return supabase.from('inventory_items_with_value').select('*').eq('id', id).single();
}

export async function getDealItemsByItemId(itemId: number) {
  return supabase.from('deal_items').select('*').eq('item_id', itemId);
}

export async function createInventoryItem(item: NewInventoryItem) {
  return supabase.from('inventory_items').insert(item).select().single();
}

export async function updateInventoryItem(id: number, item: UpdateInventoryItem) {
  const { id: _ignoredId, ...payload } = item;

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

export async function getCashFlows() {
  return supabase.from('cash_flow').select('*').order('transaction_date', { ascending: false });
}

export async function recalculateCashFlowBalancesFrom(cashFlowId: number) {
  return supabase.rpc('recalculate_cash_flow_balances_from', {
    p_start_id: cashFlowId,
  })
}

export async function createCashFlow(cashFlow: NewCashFlow) {
  return supabase.from('cash_flow').insert(cashFlow).select().single();
}

export async function getLatestCashFlow() {
  return supabase
    .from('cash_flow')
    .select('*')
    .order('transaction_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function createInventoryExpense(
  expense: NewInventoryExpense
) {
  return supabase
    .from('inventory_expenses')
    .insert(expense)
    .select()
    .single();
}

export async function getInventoryExpenses() {
  return supabase
    .from('inventory_expenses')
    .select('*')
    .order('expense_date', { ascending: false });
}


export async function getDealItems() {
  return supabase.from('deal_items').select('*')
}

export async function getDealById(id: number) {
  return supabase.from('deals').select('*').eq('id', id).single();
}

export async function getDealItemsForDeal(dealId: number) {
  return supabase.from('deal_items').select('*').eq('deal_id', dealId);
}

export async function getCashFlowsForDeal(dealId: number) {
  return supabase.from('cash_flow').select('*').eq('deal_id', dealId).order('transaction_date', { ascending: true });
}

export async function getInventoryExpensesForDeal(dealId: number) {
  return supabase.from('inventory_expenses').select('*').eq('deal_id', dealId);
}

export async function updateDeal(id: number, updates: Partial<Deal>) {
  const { id: _ignoredId, created_at: _ignoredCreated, ...payload } = updates as any;
  return supabase
    .from('deals')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
}

export async function updateCashFlow(id: number, updates: Partial<CashFlow>) {
  const { id: _ignoredId, created_at: _ignoredCreated, ...payload } = updates as any;
  return supabase
    .from('cash_flow')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
}

export async function updateInventoryExpense(id: number, updates: Partial<InventoryExpense>) {
  const { id: _ignoredId, created_at: _ignoredCreated, ...payload } = updates as any;
  return supabase
    .from('inventory_expenses')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
}

export async function editTradeOperation(params: {
  dealId: number;
  dealDate: string;
  channel: string | null;
  notes: string | null;
  cashPaid: number;
  cashReceived: number;
  outgoingItems: { item_id: number; trade_value: number; total_value: number }[];
  incomingItems: { item_id: number; trade_value: number; total_value: number }[];
  cfTransactionDate: string | null;
  cfDescription: string | null;
}) {
  return supabase.rpc('edit_trade_operation', {
    p_deal_id:             params.dealId,
    p_deal_date:           params.dealDate,
    p_channel:             params.channel,
    p_notes:               params.notes,
    p_cash_paid:           params.cashPaid,
    p_cash_received:       params.cashReceived,
    p_outgoing_items:      params.outgoingItems,
    p_incoming_items:      params.incomingItems,
    p_cf_transaction_date: params.cfTransactionDate,
    p_cf_description:      params.cfDescription,
  });
}



