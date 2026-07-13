import { createClient } from '@supabase/supabase-js';
import { splitSearchTerms } from '@/lib/search';
import type {
  AiPrompt,
  AppUser,
  Brand,
  CashFlow,
  Deal,
  DealChannel,
  DealItem,
  InventoryExpense,
  InventoryItem,
  InventoryItemPhoto,
  InventoryItemWithValue,
  ItemCategory,
  ItemListing,
  ItemPurpose,
  ItemSubtype,
  NewBrand,
  NewCashFlow,
  NewDeal,
  NewDealItem,
  NewInventoryExpense,
  NewInventoryItem,
  UpdateAiPrompt,
  UpsertAiPrompt,
  UpdateDeal,
  UpdateInventoryItem,
  UpsertItemListing,
} from '@/types';

// ─── Item timeline types ──────────────────────────────────────────────────────

export interface ItemTimelineData {
  deals:           Deal[];
  dealItems:       DealItem[];
  inventoryItems:  InventoryItemWithValue[];
  brands:          Brand[];
  photoByItemId:   Record<number, string>;
}

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

// Clear the cached app user ID when the session changes so a new login
// does not accidentally inherit the previous user's cached ID.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
    _appUserId = null;
  }
});

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

export async function updateItemSubtype(id: number, updates: { name?: string; is_active?: boolean; category_id?: number }) {
  return supabase.from('item_subtypes').update(updates).eq('id', id).select().single();
}

export async function deleteItemCategory(id: number) {
  return supabase.from('item_categories').delete().eq('id', id);
}

export async function deleteItemSubtype(id: number) {
  return supabase.from('item_subtypes').delete().eq('id', id);
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

// ─── Historical import helpers ────────────────────────────────────────────────

export interface HistoricalImportInfo {
  dealItemId:  number;
  dealId:      number;
  total_value: number;
  deal_date:   string;
}

/** Returns the Historical Import deal_item for an item, or null if none exists. */
export async function getHistoricalImportByItemId(
  itemId: number,
): Promise<{ data: HistoricalImportInfo | null; error: string | null }> {
  const { data, error } = await supabase
    .from('deal_items')
    .select('id, deal_id, total_value, deals(id, deal_date, deal_type)')
    .eq('item_id', itemId)
    .eq('direction', 'in');

  if (error) return { data: null, error: error.message };

  const hit = (data as any[] | null)?.find(
    (di) => (di.deals as any)?.deal_type === 'Historical Import',
  );

  if (!hit) return { data: null, error: null };

  return {
    data: {
      dealItemId:  hit.id,
      dealId:      hit.deal_id,
      total_value: Number(hit.total_value ?? 0),
      deal_date:   (hit.deals as any)?.deal_date ?? '',
    },
    error: null,
  };
}

export interface CreateItemWithHistoricalImportParams {
  brandId:             number;
  itemSubtypeId:       number | null;
  model:               string;
  serialNumber:        string | null;
  year:                number | null;
  color:               string | null;
  condition:           string | null;
  purposeId:           number | null;
  estimatedSoldValue:  number | null;
  notes:               string | null;
  acquisitionDate:     string;
  valueIn:             number;
}

/** Calls the create_item_with_historical_import RPC (atomic transaction). */
export async function createItemWithHistoricalImport(
  params: CreateItemWithHistoricalImportParams,
): Promise<{ data: { item_id: number; deal_id: number } | null; error: string | null }> {
  if (!params.condition)           return { data: null, error: 'Condition is required.' };
  if (params.purposeId == null)    return { data: null, error: 'Purpose is required.' };
  if (params.estimatedSoldValue == null) return { data: null, error: 'Estimated Sold Value is required.' };

  const { data, error } = await supabase.rpc('create_item_with_historical_import', {
    p_brand_id:             params.brandId,
    p_item_subtype_id:      params.itemSubtypeId,
    p_model:                params.model,
    p_serial_number:        params.serialNumber,
    p_year:                 params.year,
    p_color:                params.color,
    p_condition:            params.condition,
    p_collection_type:      null,
    p_estimated_sold_value: params.estimatedSoldValue,
    p_notes:                params.notes,
    p_acquisition_date:     params.acquisitionDate,
    p_value_in:             params.valueIn,
    p_purpose_id:           params.purposeId,
  });

  if (error) return { data: null, error: error.message };
  return { data: data as { item_id: number; deal_id: number }, error: null };
}

export async function createInventoryItem(item: NewInventoryItem) {
  if (!item.condition)            return { data: null, error: { message: 'Condition is required.' }, status: 422, statusText: 'Unprocessable Entity', count: null } as const;
  if (item.purpose_id == null)    return { data: null, error: { message: 'Purpose is required.' }, status: 422, statusText: 'Unprocessable Entity', count: null } as const;
  if (item.estimated_sold_value == null) return { data: null, error: { message: 'Estimated Sold Value is required.' }, status: 422, statusText: 'Unprocessable Entity', count: null } as const;
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

export async function getDealChannels() {
  return supabase.from('deal_channels').select('*').order('sort_order', { ascending: true });
}

export async function createDealChannel(data: { name: string; is_listing_platform: boolean; sort_order: number }) {
  return supabase.from('deal_channels').insert(data).select().single<DealChannel>();
}

export async function updateDealChannel(id: number, updates: { name?: string; is_listing_platform?: boolean; sort_order?: number; is_active?: boolean }) {
  return supabase.from('deal_channels').update(updates).eq('id', id).select().single<DealChannel>();
}

export async function deleteDealChannel(id: number) {
  return supabase.from('deal_channels').delete().eq('id', id);
}

export async function getDealChannelUsageCount(channelId: number) {
  return supabase.from('deals').select('id', { count: 'exact', head: true }).eq('deal_channel_id', channelId);
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

export async function recalculateCashFlowBalancesFrom(cashFlowId: number, seedBalance?: number) {
  return supabase.rpc('recalculate_cash_flow_balances_from', {
    p_start_id:     cashFlowId,
    ...(seedBalance !== undefined ? { p_seed_balance: seedBalance } : {}),
  });
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

export async function getInventoryExpensesByItemIds(itemIds: number[]) {
  if (itemIds.length === 0) return { data: [] as InventoryExpense[], error: null };
  return supabase.from('inventory_expenses').select('*').in('item_id', itemIds);
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
  channelId: number;
  incomingItems: { item_id: number; total_value: number }[];
  notes?: string | null;
  cfDescription: string;
}) {
  return supabase.rpc('create_buy_operation', {
    p_deal_date:      params.dealDate,
    p_channel_id:     params.channelId,
    p_incoming_items: params.incomingItems,
    p_notes:          params.notes ?? null,
    p_cf_description: params.cfDescription,
  });
}

export async function createSellOperation(params: {
  dealDate: string;
  cashReceived: number;
  channelId: number;
  itemId: number;
  notes?: string | null;
  cfDescription: string;
}) {
  return supabase.rpc('create_sell_operation', {
    p_deal_date:      params.dealDate,
    p_cash_received:  params.cashReceived,
    p_channel_id:     params.channelId,
    p_item_id:        params.itemId,
    p_notes:          params.notes ?? null,
    p_cf_description: params.cfDescription,
  });
}

export async function createTradeOperation(params: {
  dealDate: string;
  channelId?: number | null;
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
    p_channel_id:          params.channelId ?? null,
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
  channelId: number | null;
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
    p_channel_id:          params.channelId,
    p_notes:               params.notes,
    p_cash_paid:           params.cashPaid,
    p_cash_received:       params.cashReceived,
    p_outgoing_items:      params.outgoingItems,
    p_incoming_items:      params.incomingItems,
    p_cf_transaction_date: params.cfTransactionDate,
    p_cf_description:      params.cfDescription,
  });
}

export async function editBuyOperation(params: {
  dealId: number;
  dealDate: string;
  channelId: number | null;
  notes: string | null;
  incomingItems: { item_id: number; total_value: number }[];
  cfDescription?: string | null;
}) {
  return supabase.rpc('edit_buy_operation', {
    p_deal_id:        params.dealId,
    p_deal_date:      params.dealDate,
    p_channel_id:     params.channelId,
    p_notes:          params.notes,
    p_incoming_items: params.incomingItems,
    p_cf_description: params.cfDescription ?? null,
  });
}

// ─── AI prompt functions ──────────────────────────────────────────────────────

export async function getAiPrompts() {
  return supabase
    .from('ai_prompts')
    .select('*')
    .order('category', { ascending: true })
    .order('deal_channel_id', { ascending: true });
}

export async function upsertAiPrompt(data: UpsertAiPrompt) {
  return supabase
    .from('ai_prompts')
    .upsert(data, { onConflict: 'user_id,category,deal_channel_id' })
    .select()
    .single<AiPrompt>();
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
  const { id, ...rest } = data;
  const payload = { ...rest, updated_at: new Date().toISOString() };
  if (id != null) {
    return supabase
      .from('item_listings')
      .update(payload)
      .eq('id', id)
      .select()
      .single<ItemListing>();
  }
  return supabase
    .from('item_listings')
    .insert(payload)
    .select()
    .single<ItemListing>();
}

// ─── Photo functions ──────────────────────────────────────────────────────────

const PHOTO_BUCKET = 'inventory-photos';
// Accepts compressed JPEG (always) plus the original types as a safety net.
// HEIC/HEIF are compressed to JPEG client-side before reaching this function.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_SIZE_BYTES = 30 * 1024 * 1024; // 30 MB — originals validated client-side; compressed files are tiny

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

// Up to 4 photos for AI listing generation: main first, then by sort_order.
export async function prepareListingImages(itemId: number): Promise<string[]> {
  const { data, error } = await supabase
    .from('inventory_item_photos')
    .select('storage_path, is_main, sort_order')
    .eq('inventory_item_id', itemId)
    .order('is_main', { ascending: false })
    .order('sort_order', { ascending: true })
    .limit(4);

  if (error || !data?.length) return [];
  return (data as { storage_path: string }[]).map((row) => getPhotoUrl(row.storage_path));
}

export async function uploadItemPhoto(
  itemId: number,
  file: File
): Promise<{ data: InventoryItemPhoto | null; error: string | null }> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { data: null, error: 'Only JPEG, PNG, WebP, and HEIC images are allowed.' };
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { data: null, error: 'File size must be 30 MB or less.' };
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

// ─── Item lineage ──────────────────────────────────────────────────────────────
// BFS traversal across the item-deal graph starting from rootItemId.
// Each iteration: mark queued items visited → find their unvisited deals →
// find all items in those deals → enqueue unvisited ones → repeat.
// Stops when no new deals are found or MAX_DEPTH is reached (cycle guard).
// Final batch: fetch deals, deal_items, items, brands, photos in parallel.

export async function getItemLineage(
  rootItemId: number,
): Promise<{ data: ItemTimelineData | null; error: string | null }> {
  const empty: ItemTimelineData = { deals: [], dealItems: [], inventoryItems: [], brands: [], photoByItemId: {} };

  const visitedDealIds = new Set<number>();
  const visitedItemIds = new Set<number>();
  const MAX_DEPTH = 10;

  let itemQueue: number[] = [rootItemId];

  for (let depth = 0; depth < MAX_DEPTH && itemQueue.length > 0; depth++) {
    itemQueue.forEach((id) => visitedItemIds.add(id));

    // Find deals involving any item in the current queue
    const { data: itemSlots, error: e1 } = await supabase
      .from('deal_items')
      .select('deal_id, item_id')
      .in('item_id', itemQueue);

    if (e1) return { data: null, error: e1.message };
    if (!itemSlots?.length) break;

    const newDealIds = Array.from(
      new Set((itemSlots as { deal_id: number }[]).map((s) => s.deal_id))
    ).filter((id) => !visitedDealIds.has(id));

    if (newDealIds.length === 0) break;
    newDealIds.forEach((id) => visitedDealIds.add(id));

    // Find all items in those new deals
    const { data: dealSlots, error: e2 } = await supabase
      .from('deal_items')
      .select('deal_id, item_id')
      .in('deal_id', newDealIds);

    if (e2) return { data: null, error: e2.message };
    if (!dealSlots) break;

    // Enqueue items we haven't visited yet
    itemQueue = Array.from(
      new Set((dealSlots as { item_id: number }[]).map((s) => s.item_id))
    ).filter((id) => !visitedItemIds.has(id));
  }

  if (visitedDealIds.size === 0) return { data: empty, error: null };

  const dealIdList = Array.from(visitedDealIds);
  const itemIdList = Array.from(visitedItemIds);

  const [dealsRes, allSlotsRes, itemsRes, brandsRes, photoByItemId] = await Promise.all([
    supabase.from('deals').select('*').in('id', dealIdList).order('deal_date', { ascending: true }),
    supabase.from('deal_items').select('*').in('deal_id', dealIdList),
    supabase.from('inventory_items_with_value').select('*').in('id', itemIdList),
    supabase.from('brands').select('*').order('name', { ascending: true }),
    getDisplayPhotosForItems(itemIdList),
  ]);

  if (dealsRes.error) return { data: null, error: dealsRes.error.message };

  return {
    data: {
      deals:          (dealsRes.data    ?? []) as Deal[],
      dealItems:      (allSlotsRes.data ?? []) as DealItem[],
      inventoryItems: (itemsRes.data    ?? []) as InventoryItemWithValue[],
      brands:         (brandsRes.data   ?? []) as Brand[],
      photoByItemId,
    },
    error: null,
  };
}

// ─── Item timeline (direct deals only) ────────────────────────────────────────
// Loads full deal history for a single inventory item in 3 parallel rounds.
// Round 1 : deal_items for this item → collect deal IDs
// Round 2 : deals + all deal_items for those deal IDs + brands (parallel)
// Round 3 : inventory_items_with_value for all item IDs + photos (parallel)

export async function getItemTimeline(
  itemId: number,
): Promise<{ data: ItemTimelineData | null; error: string | null }> {
  const empty: ItemTimelineData = { deals: [], dealItems: [], inventoryItems: [], brands: [], photoByItemId: {} };

  // Round 1 — which deals involve this item?
  const { data: mySlots, error: e1 } = await supabase
    .from('deal_items')
    .select('deal_id')
    .eq('item_id', itemId);

  if (e1) return { data: null, error: e1.message };
  if (!mySlots?.length) return { data: empty, error: null };

  const dealIds = Array.from(new Set(mySlots.map((s) => s.deal_id as number)));

  // Round 2 — full context for those deals (parallel)
  const [dealsRes, allSlotsRes, brandsRes] = await Promise.all([
    supabase
      .from('deals')
      .select('*')
      .in('id', dealIds)
      .order('deal_date', { ascending: true }),
    supabase
      .from('deal_items')
      .select('*')
      .in('deal_id', dealIds),
    supabase
      .from('brands')
      .select('*')
      .order('name', { ascending: true }),
  ]);

  if (dealsRes.error) return { data: null, error: dealsRes.error.message };

  const allSlots = (allSlotsRes.data ?? []) as DealItem[];
  const allItemIds = Array.from(new Set(allSlots.map((s) => s.item_id)));

  // Round 3 — item details + photos (parallel)
  const [itemsRes, photoByItemId] = await Promise.all([
    allItemIds.length > 0
      ? supabase.from('inventory_items_with_value').select('*').in('id', allItemIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    getDisplayPhotosForItems(allItemIds),
  ]);

  return {
    data: {
      deals:          (dealsRes.data   ?? []) as Deal[],
      dealItems:      allSlots,
      inventoryItems: (itemsRes.data   ?? []) as InventoryItemWithValue[],
      brands:         (brandsRes.data  ?? []) as Brand[],
      photoByItemId,
    },
    error: null,
  };
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

export async function getTags() {
  return supabase.from('inventory_tags').select('*').order('name', { ascending: true });
}

export async function createTag(name: string) {
  return supabase.from('inventory_tags').insert({ name: name.trim() }).select().single();
}

export async function updateTag(id: number, updates: { name?: string; is_active?: boolean }) {
  return supabase.from('inventory_tags').update(updates).eq('id', id).select().single();
}

export async function deleteTag(id: number) {
  return supabase.from('inventory_tags').delete().eq('id', id);
}

export async function getTagUsageCount(tagId: number) {
  return supabase
    .from('inventory_item_tags')
    .select('id', { count: 'exact', head: true })
    .eq('tag_id', tagId);
}

export async function getItemTags(itemId: number) {
  return supabase
    .from('inventory_item_tags')
    .select('tag_id')
    .eq('item_id', itemId);
}

export async function getTagsForItems(itemIds: number[]) {
  if (itemIds.length === 0) return { data: [] as { item_id: number; tag_id: number }[], error: null };
  return supabase
    .from('inventory_item_tags')
    .select('item_id, tag_id')
    .in('item_id', itemIds);
}

export async function setItemTags(itemId: number, tagIds: number[]) {
  const { error: delErr } = await supabase
    .from('inventory_item_tags')
    .delete()
    .eq('item_id', itemId);
  if (delErr) return { error: delErr };
  if (tagIds.length === 0) return { error: null };
  const { error: insErr } = await supabase
    .from('inventory_item_tags')
    .insert(tagIds.map((tag_id) => ({ item_id: itemId, tag_id })));
  return { error: insErr };
}

// ─── Item purposes ─────────────────────────────────────────────────────────────

export async function getItemPurposes() {
  return supabase.from('item_purposes').select('*').order('name', { ascending: true });
}

export async function createItemPurpose(name: string) {
  return supabase.from('item_purposes').insert({ name: name.trim() }).select().single();
}

export async function updateItemPurpose(id: number, updates: { name?: string; is_active?: boolean }) {
  return supabase.from('item_purposes').update(updates).eq('id', id).select().single();
}

export async function deleteItemPurpose(id: number) {
  return supabase.from('item_purposes').delete().eq('id', id);
}

export async function getPurposeUsageCount(purposeId: number) {
  return supabase
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('purpose_id', purposeId);
}

