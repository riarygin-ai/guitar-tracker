import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  SYSTEM_PROMPT,
  LISTING_INSTRUCTIONS,
  buildItemContext,
  MODEL_ID,
  MAX_TOKENS,
  TEMPERATURE,
  type ListingType,
} from '@/lib/openai';

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const VALID_LISTING_TYPES: ListingType[] = ['reverb', 'marketplace', 'kijiji'];

const SUBTYPE_TO_CATEGORY: Record<string, string> = {
  'Electric Guitar':  'Guitar',
  'Acoustic Guitar':  'Guitar',
  'Classical Guitar': 'Guitar',
  'Resonator Guitar': 'Guitar',
  'Bass':             'Guitar',
  'Bass Guitar':      'Guitar',
  'Amp':              'Amp',
  'Cabinet':          'Cabinet',
  'Pedal':            'Pedal',
  'Processor':        'Pedal',
  'Parts':            'Other',
  'Pickups':          'Other',
};

const ITEM_TYPE_TO_CATEGORY: Record<string, string> = {
  'guitar':          'Guitar',
  'bass':            'Guitar',
  'acoustic guitar': 'Guitar',
  'amp':             'Amp',
  'cab':             'Cabinet',
  'processor':       'Pedal',
  'pedal':           'Pedal',
  'parts':           'Other',
};

function detectCategory(subtypeName: string | null, itemType: string): string {
  if (subtypeName) {
    const mapped = SUBTYPE_TO_CATEGORY[subtypeName];
    if (mapped) return mapped;
  }
  return ITEM_TYPE_TO_CATEGORY[itemType?.toLowerCase()] ?? 'Other';
}

export async function POST(req: NextRequest) {
  // ── Parse body ───────────────────────────────────────────────────────────────
  let body: { inventoryItemId?: unknown; listingType?: unknown; currentDraft?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { inventoryItemId, listingType, currentDraft } = body;

  if (typeof inventoryItemId !== 'number' || !Number.isInteger(inventoryItemId) || inventoryItemId < 1) {
    return NextResponse.json({ error: 'inventoryItemId must be a positive integer' }, { status: 400 });
  }
  if (!VALID_LISTING_TYPES.includes(listingType as ListingType)) {
    return NextResponse.json(
      { error: `listingType must be one of: ${VALID_LISTING_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  // ── Authenticate ─────────────────────────────────────────────────────────────
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

  // ── Admin check ───────────────────────────────────────────────────────────────
  const { data: appUser } = await db
    .from('app_users')
    .select('id, admin')
    .eq('auth_user_id', user.id)
    .single();

  if (!appUser?.admin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  // ── Fetch inventory item ──────────────────────────────────────────────────────
  const { data: item, error: itemError } = await db
    .from('inventory_items')
    .select('*, brands(name), item_subtypes(name)')
    .eq('id', inventoryItemId)
    .single();

  if (itemError || !item) {
    return NextResponse.json({ error: 'Item not found or access denied' }, { status: 404 });
  }

  // ── Category detection + prompt lookup ───────────────────────────────────────
  const subtypeName = (item.item_subtypes as any)?.name as string | null ?? null;
  const category    = detectCategory(subtypeName, item.item_type);

  const candidateCategories: string[] = [category];
  if (category !== 'Guitar') candidateCategories.push('Guitar');
  if (category !== 'Other')  candidateCategories.push('Other');

  let aiPromptId:   number | null = null;
  let promptName:   string | null = null;
  let resolvedInstruction         = LISTING_INSTRUCTIONS[listingType as ListingType];
  let resolvedModel               = MODEL_ID;
  let resolvedTemperature         = TEMPERATURE;
  let resolvedCategory            = category;

  for (const cat of candidateCategories) {
    const { data: promptRow } = await db
      .from('ai_prompts')
      .select('id, name, prompt_text, model, temperature, is_active')
      .eq('category',     cat)
      .eq('listing_type', listingType as string)
      .eq('is_active',    true)
      .maybeSingle();

    if (promptRow?.prompt_text?.trim()) {
      aiPromptId          = promptRow.id as number;
      promptName          = promptRow.name as string;
      resolvedInstruction = promptRow.prompt_text;
      resolvedModel       = (promptRow.model as string | null)?.trim() || MODEL_ID;
      resolvedTemperature = promptRow.temperature != null ? Number(promptRow.temperature) : TEMPERATURE;
      resolvedCategory    = cat;
      break;
    }
  }

  // ── Load photos (best-effort) ─────────────────────────────────────────────────
  let photoUrls: string[] = [];
  try {
    const { data: photos } = await db
      .from('inventory_item_photos')
      .select('storage_path, is_main, sort_order')
      .eq('inventory_item_id', inventoryItemId)
      .order('is_main', { ascending: false })
      .order('sort_order', { ascending: true })
      .limit(4);

    if (photos?.length) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const storageBase = `${supabaseUrl}/storage/v1/object/public/inventory-photos`;
      photoUrls = (photos as { storage_path: string }[]).map(
        (p) => `${storageBase}/${p.storage_path}`,
      );
    }
  } catch {
    // Continue without photos
  }

  // ── Build messages (mirrors generateListing, no OpenAI call) ─────────────────
  const listingItem = {
    brandName:          (item.brands as any)?.name ?? 'Unknown brand',
    model:              item.model,
    itemType:           item.item_type,
    subtypeName,
    year:               item.year               ?? null,
    color:              item.color              ?? null,
    condition:          item.condition          ?? null,
    serialNumber:       item.serial_number      ?? null,
    estimatedSoldValue: item.estimated_sold_value != null ? Number(item.estimated_sold_value) : null,
    notes:              item.notes              ?? null,
  };

  const itemDataBlock = buildItemContext(listingItem);
  const draftText     = typeof currentDraft === 'string' ? currentDraft.trim() : '';

  const textContent = [
    'Item details:',
    itemDataBlock,
    '',
    `Task: ${resolvedInstruction}`,
    draftText
      ? `\nThe seller has an existing draft they would like improved:\n"""\n${draftText}\n"""`
      : '',
  ].filter((l) => l !== '').join('\n');

  const hasPhotos = photoUrls.length > 0;

  const userContentForDebug = hasPhotos
    ? [
        { type: 'text', text: textContent },
        ...photoUrls.map((url) => ({
          type: 'image_url',
          image_url: { url, detail: 'low' },
        })),
      ]
    : textContent;

  const finalUserMessage   = textContent;
  const fullMessagesPayload = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userContentForDebug },
  ];

  return NextResponse.json({
    model:               resolvedModel,
    temperature:         resolvedTemperature,
    maxTokens:           MAX_TOKENS,
    listingType:         listingType as string,
    category:            resolvedCategory,
    detectedCategory:    category,
    aiPromptId,
    promptName,
    systemMessage:       SYSTEM_PROMPT,
    itemDataBlock,
    taskPrompt:          resolvedInstruction,
    existingDraft:       draftText || null,
    finalUserMessage,
    fullMessagesPayload,
    photoCount:          photoUrls.length,
    photoUrls,
  });
}
