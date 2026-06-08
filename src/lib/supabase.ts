import { createClient } from '@supabase/supabase-js';
import { splitSearchTerms } from '@/lib/search';
import type {
  AiPrompt,
  AppUser,
  Brand,
  CashFlow,
  Deal,
  DealItem,
  InventoryExpense,
  InventoryItem,
  InventoryItemPhoto,
  ItemCategory,
  ItemListing,
  ItemSubtype,
  NewBrand,
  NewCashFlow,
  NewDeal,
  NewDealItem,
  NewInventoryExpense,
  NewInventoryItem,
  UpdateAiPrompt,
  UpdateDeal,
  UpdateInventoryItem,
  UpsertItemListing,
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

// ─── App user ─────────────────────────────────────────────────────────────────

let _appUserId: number | null = null;

export async function getOrCreateAppUser(): Promise<AppUser | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // With RLS, this returns only the current user's record
  const { data: existing } = await supabase
    .from('app_users')
    .select('*')
    .maybeSingle();

  if (existing) {
    _appUserId = (existing as AppUser).id;
    return existing as AppUser;
  }

  // Safety net: create record if the auth trigger didn't fire
  const displayName = (user.user_metadata?.full_name as string | undefined)
    || user.email?.split('@')[0]
    || 'User';

  const { data: created } = await supabase
    .from('app_users')
    .insert({ auth_user_id: user.id, email: user.email, display_name: displayName })
    .select()
    .single();

  if (created) {
    _appUserId = (created as AppUser).id;
    return created as AppUser;
  }

  return null;
}

export async function getCurrentAppUserId(): Promise<number | null> {
  if (_appUserId !== null) return _appUserId;
  const user = await getOrCreateAppUser();
  return user?.id ?? null;
}

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

export async function updateBrand(id: number, name: string) {
  return supabase.from('brands').update({ name: name.trim() }).eq('id', id).select().single();
}

export async function deleteBrand(id: number) {
  return supabase.from('brands').delete().eq('id', id);
}

export async function getBrandUsageCount(brandId: number) {
  return supabase
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('brand_id', brandId);
}

// ─── Item categories & subtypes ───────────────────────────────────────────────

export async function getItemCategories() {
  return supabase
    .from('item_categories')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
}

export async function getItemSubtypes(categoryId?: number) {
  let q = supabase
    .from('item_subtypes')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (categoryId != null) q = q.eq('category_id', categoryId);
  return q;
}

export async function createItemCategory(name: string) {
  return supabase.from('item_categories').insert({ name: name.trim() }).select().single();
}

export async function updateItemCategory(id: number, updates: { name?: string; is_active?: boolean }) {
  return supabase.from('item_categories').update(updates).eq('id', id).select().single();
}

export async function createItemSubtype(categoryId: number, name: string) {
  return supabase
    .from('item_subtypes')
    .insert({ category_id: categoryId, name: name.trim() })
    .select()
    .single();
}

export async function updateItemSubtype(id: number, updates: { name?: string; is_active?: boolean }) {
  return supabase.from('item_subtypes').update(updates).eq('id', id).select().single();
}

export async function getSubtypeUsageCount(subtypeId: number) {
  return supabase
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('item_subtype_id', subtypeId);
}

export async function getInventoryItems() {
  return supabase.from('inventory_items_with_value').select('*');
}

export async function getInventoryItemsWithValue() {
  return supabase
    .from('inventory_items_with_value')
    .select('*')
}

export async function searchInventoryItems(query: string, allowedStatuses?: string[]) {
  let dbQuery = supabase
    .from('inventory_items_search')
    .select('*')
    .order('created_at', { ascending: false });

  if (allowedStatuses && allowedStatuses.length > 0) {
    dbQuery = dbQuery.in('status', allowedStatuses);
  } else {
    dbQuery = dbQuery.not('status', 'in', '("sold","traded")');
  }

  const result = await dbQuery;

  if (result.error || !result.data) return result;

  const terms = splitSearchTerms(query);

  if (terms.length === 0) {
    return { ...result, data: result.data.slice(0, 20) };
  }

  const filtered = (result.data as any[]).filter((item) =>
    terms.every((term) =>
      (item.brand_name ?? '').toLowerCase().includes(term) ||
      (item.model ?? '').toLowerCase().includes(term) ||
      (item.color ?? '').toLowerCase().includes(term) ||
      String(item.year ?? '').toLowerCase().includes(term) ||
      (item.serial_number ?? '').toLowerCase().includes(term) ||
      (item.notes ?? '').toLowerCase().includes(term)
    )
  );

  return { ...result, data: filtered.slice(0, 20) };
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

export async function getItemAcquisitionDates() {
  return supabase
    .from('deal_items')
    .select('item_id, deals(deal_date)')
    .eq('direction', 'in');
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

export async function createExpenseOperation(params: {
  expenseDate: string;
  amount: number;
  notes: string;
  itemId?: number | null;
  cfDescription: string;
}) {
  return supabase.rpc('create_expense_operation', {
    p_expense_date:   params.expenseDate,
    p_amount:         params.amount,
    p_notes:          params.notes,
    p_item_id:        params.itemId ?? null,
    p_cf_description: params.cfDescription,
  });
}

export async function createBuyOperation(params: {
  dealDate: string;
  cashPaid: number;
  channel: string;
  itemId: number;
  notes?: string | null;
  cfDescription: string;
}) {
  return supabase.rpc('create_buy_operation', {
    p_deal_date:      params.dealDate,
    p_cash_paid:      params.cashPaid,
    p_channel:        params.channel,
    p_item_id:        params.itemId,
    p_notes:          params.notes ?? null,
    p_cf_description: params.cfDescription,
  });
}

export async function createSellOperation(params: {
  dealDate: string;
  cashReceived: number;
  channel: string;
  itemId: number;
  notes?: string | null;
  cfDescription: string;
}) {
  return supabase.rpc('create_sell_operation', {
    p_deal_date:      params.dealDate,
    p_cash_received:  params.cashReceived,
    p_channel:        params.channel,
    p_item_id:        params.itemId,
    p_notes:          params.notes ?? null,
    p_cf_description: params.cfDescription,
  });
}

export async function createTradeOperation(params: {
  dealDate: string;
  channel?: string | null;
  notes?: string | null;
  cashPaid?: number;
  cashReceived?: number;
  outgoingItems: { item_id: number; total_value: number }[];
  incomingItems: { item_id: number; total_value: number }[];
  cfTransactionDate?: string | null;
  cfDescription?: string | null;
}) {
  return supabase.rpc('create_trade_operation', {
    p_deal_date:           params.dealDate,
    p_channel:             params.channel ?? null,
    p_notes:               params.notes ?? null,
    p_cash_paid:           params.cashPaid ?? 0,
    p_cash_received:       params.cashReceived ?? 0,
    p_outgoing_items:      params.outgoingItems,
    p_incoming_items:      params.incomingItems,
    p_cf_transaction_date: params.cfTransactionDate ?? null,
    p_cf_description:      params.cfDescription ?? null,
  });
}

export async function editTradeOperation(params: {
  dealId: number;
  dealDate: string;
  channel: string | null;
  notes: string | null;
  cashPaid: number;
  cashReceived: number;
  outgoingItems: { item_id: number; total_value: number }[];
  incomingItems: { item_id: number; total_value: number }[];
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

// ─── AI prompt functions ──────────────────────────────────────────────────────

export async function getAiPrompts() {
  return supabase
    .from('ai_prompts')
    .select('*')
    .order('prompt_key', { ascending: true });
}

export async function updateAiPromptById(id: number, updates: UpdateAiPrompt) {
  return supabase
    .from('ai_prompts')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single<AiPrompt>();
}

// ─── Item listing functions ───────────────────────────────────────────────────

export async function getItemListings(itemId: number) {
  return supabase
    .from('item_listings')
    .select('*')
    .eq('inventory_item_id', itemId);
}

export async function upsertItemListing(data: UpsertItemListing) {
  return supabase
    .from('item_listings')
    .upsert(
      { ...data, updated_at: new Date().toISOString() },
      { onConflict: 'inventory_item_id,listing_type' },
    )
    .select()
    .single<ItemListing>();
}

// ─── Photo functions ──────────────────────────────────────────────────────────

const PHOTO_BUCKET = 'inventory-photos';
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export function getPhotoUrl(storagePath: string): string {
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

export async function getItemPhotos(itemId: number) {
  return supabase
    .from('inventory_item_photos')
    .select('*')
    .eq('inventory_item_id', itemId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
}

export async function getMainPhotosForItems(
  itemIds: number[]
): Promise<{ data: { inventory_item_id: number; storage_path: string }[] | null; error: unknown }> {
  if (itemIds.length === 0) return { data: [], error: null };
  return supabase
    .from('inventory_item_photos')
    .select('inventory_item_id, storage_path')
    .in('inventory_item_id', itemIds)
    .eq('is_main', true) as any;
}

// Best display photo per item: is_main=true first, then lowest sort_order.
// Single query for any number of items — no N+1.
export async function getDisplayPhotosForItems(
  itemIds: number[]
): Promise<Record<number, string>> {
  if (itemIds.length === 0) return {};

  const { data, error } = await supabase
    .from('inventory_item_photos')
    .select('inventory_item_id, storage_path, is_main, sort_order')
    .in('inventory_item_id', itemIds)
    .order('inventory_item_id', { ascending: true })
    .order('is_main', { ascending: false })
    .order('sort_order', { ascending: true });

  if (error || !data) return {};

  const result: Record<number, string> = {};
  for (const row of data as { inventory_item_id: number; storage_path: string }[]) {
    if (!(row.inventory_item_id in result)) {
      result[row.inventory_item_id] = getPhotoUrl(row.storage_path);
    }
  }
  return result;
}

export async function uploadItemPhoto(
  itemId: number,
  file: File
): Promise<{ data: InventoryItemPhoto | null; error: string | null }> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { data: null, error: 'Only JPEG, PNG, and WebP images are allowed.' };
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { data: null, error: 'File size must be 10 MB or less.' };
  }

  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: 'Not authenticated.' };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${userId}/${itemId}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });

  if (uploadError) return { data: null, error: uploadError.message };

  const { data, error: dbError } = await supabase
    .from('inventory_item_photos')
    .insert({
      inventory_item_id: itemId,
      storage_path: storagePath,
      file_name: file.name,
      content_type: file.type,
      file_size: file.size,
      is_main: false,
      sort_order: 0,
    })
    .select()
    .single();

  if (dbError) {
    await supabase.storage.from(PHOTO_BUCKET).remove([storagePath]);
    return { data: null, error: dbError.message };
  }

  return { data: data as InventoryItemPhoto, error: null };
}

export async function setMainPhoto(
  itemId: number,
  photoId: number
): Promise<{ error: string | null }> {
  const { error: unsetError } = await supabase
    .from('inventory_item_photos')
    .update({ is_main: false })
    .eq('inventory_item_id', itemId);

  if (unsetError) return { error: unsetError.message };

  const { error: setError } = await supabase
    .from('inventory_item_photos')
    .update({ is_main: true })
    .eq('id', photoId);

  return { error: setError ? setError.message : null };
}

export async function deleteItemPhoto(
  photoId: number,
  storagePath: string
): Promise<{ error: string | null }> {
  const { error: storageError } = await supabase.storage
    .from(PHOTO_BUCKET)
    .remove([storagePath]);

  if (storageError) return { error: `Storage error: ${storageError.message}` };

  const { error: dbError } = await supabase
    .from('inventory_item_photos')
    .delete()
    .eq('id', photoId);

  if (dbError) return { error: `Database error: ${dbError.message}` };

  return { error: null };
}



