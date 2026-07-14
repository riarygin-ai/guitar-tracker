import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateListing, type PromptOverride } from '@/lib/openai';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;


export async function POST(req: NextRequest) {
  // ── Parse request body ───────────────────────────────────────────────────────
  let body: { inventoryItemId?: unknown; dealChannelId?: unknown; currentDraft?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { inventoryItemId, dealChannelId, currentDraft } = body;

  if (typeof inventoryItemId !== 'number' || !Number.isInteger(inventoryItemId) || inventoryItemId < 1) {
    return NextResponse.json({ error: 'inventoryItemId must be a positive integer' }, { status: 400 });
  }
  if (typeof dealChannelId !== 'number' || !Number.isInteger(dealChannelId) || dealChannelId < 1) {
    return NextResponse.json({ error: 'dealChannelId must be a positive integer' }, { status: 400 });
  }

  // ── Authenticate via bearer token ────────────────────────────────────────────
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Look up deal channel ─────────────────────────────────────────────────────
  const { data: channelRow, error: channelError } = await db
    .from('deal_channels')
    .select('id, name, is_listing_platform, is_active')
    .eq('id', dealChannelId)
    .single();

  if (channelError || !channelRow) {
    return NextResponse.json({ error: 'Deal channel not found' }, { status: 404 });
  }
  if (!(channelRow as any).is_listing_platform) {
    return NextResponse.json({ error: 'Deal channel is not a listing platform' }, { status: 400 });
  }
  if (!(channelRow as any).is_active) {
    return NextResponse.json({ error: 'Deal channel is not active' }, { status: 400 });
  }

  const channelName = (channelRow as any).name as string;

  // ── Fetch inventory item + brand + subtype (with category_id) ───────────────
  const { data: item, error: itemError } = await db
    .from('inventory_items')
    .select('*, brands(name), item_subtypes(name, category_id)')
    .eq('id', inventoryItemId)
    .single();

  if (itemError || !item) {
    return NextResponse.json({ error: 'Item not found or access denied' }, { status: 404 });
  }

  const subtypeName = (item.item_subtypes as any)?.name as string | null ?? null;
  const categoryId  = (item.item_subtypes as any)?.category_id as number | null ?? null;

  // ── Load active prompt by category_id + channel (user-scoped via RLS) ───────
  let promptOverride: PromptOverride | undefined;
  let aiPromptId: number | null = null;

  if (categoryId !== null) {
    const { data: promptRow } = await db
      .from('ai_prompts')
      .select('id, prompt_text, model, temperature, is_active')
      .eq('category_id',     categoryId)
      .eq('deal_channel_id', dealChannelId)
      .eq('is_active',       true)
      .maybeSingle();

    if (promptRow?.prompt_text?.trim()) {
      aiPromptId    = promptRow.id as number;
      promptOverride = {
        promptText:  promptRow.prompt_text,
        model:       promptRow.model       ?? null,
        temperature: promptRow.temperature != null ? Number(promptRow.temperature) : null,
      };
    }
  }

  // ── Load photos for vision (best-effort) ────────────────────────────────────
  let imageUrls: string[] = [];
  try {
    const { data: photos } = await db
      .from('inventory_item_photos')
      .select('storage_path, is_main, sort_order')
      .eq('inventory_item_id', inventoryItemId)
      .order('is_main', { ascending: false })
      .order('sort_order', { ascending: true })
      .limit(4);

    if (photos?.length) {
      const storageBase = `${SUPABASE_URL}/storage/v1/object/public/inventory-photos`;
      imageUrls = (photos as { storage_path: string }[]).map(
        (p) => `${storageBase}/${p.storage_path}`,
      );
    }
  } catch {
    // Continue without photos
  }

  // ── Call OpenAI ──────────────────────────────────────────────────────────────
  try {
    const { text, model, promptSnapshot, visionNotes } = await generateListing(
      {
        brandName:          (item.brands as any)?.name       ?? 'Unknown brand',
        model:              item.model,
        subtypeName:        subtypeName,
        year:               item.year               ?? null,
        color:              item.color              ?? null,
        condition:          item.condition          ?? null,
        serialNumber:       item.serial_number      ?? null,
        estimatedSoldValue: item.estimated_sold_value != null
                              ? Number(item.estimated_sold_value)
                              : null,
        notes:              item.notes              ?? null,
      },
      channelName,
      typeof currentDraft === 'string' ? currentDraft : undefined,
      promptOverride,
      imageUrls,
    );

    return NextResponse.json({
      text,
      ai_model:           model,
      ai_prompt_id:       aiPromptId,
      prompt_snapshot:    promptSnapshot,
      vision_photo_count: imageUrls.length,
      vision_notes:       visionNotes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generation failed';
    console.error('[generate-listing] OpenAI error:', message);

    if (message.includes('API key') || message.includes('apiKey')) {
      return NextResponse.json({ error: 'OpenAI API key is not configured on the server' }, { status: 500 });
    }
    if (message.includes('quota') || message.includes('429')) {
      return NextResponse.json({ error: 'OpenAI quota exceeded — try again later' }, { status: 429 });
    }
    return NextResponse.json({ error: 'Failed to generate listing — please try again' }, { status: 500 });
  }
}
