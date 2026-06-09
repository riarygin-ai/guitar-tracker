import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateListing, type ListingType, type PromptOverride } from '@/lib/openai';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const VALID_LISTING_TYPES: ListingType[] = ['reverb', 'marketplace', 'kijiji'];

// Maps item subtype names → broad prompt category.
// Guitar family: Electric Guitar, Acoustic Guitar, Bass, Classical Guitar, etc.
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
  'Processor':        'Pedal',   // multi-effects units → Pedal category
  'Parts':            'Other',
  'Pickups':          'Other',
};

// Legacy item_type fallback (used when item_subtype_id is null)
const ITEM_TYPE_TO_CATEGORY: Record<string, string> = {
  'guitar':         'Guitar',
  'bass':           'Guitar',
  'acoustic guitar':'Guitar',
  'amp':            'Amp',
  'cab':            'Cabinet',
  'processor':      'Pedal',
  'pedal':          'Pedal',
  'parts':          'Other',
};

function detectCategory(subtypeName: string | null, itemType: string): string {
  if (subtypeName) {
    const mapped = SUBTYPE_TO_CATEGORY[subtypeName];
    if (mapped) return mapped;
  }
  return ITEM_TYPE_TO_CATEGORY[itemType?.toLowerCase()] ?? 'Other';
}

export async function POST(req: NextRequest) {
  // ── Parse request body ───────────────────────────────────────────────────────
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

  // ── Authenticate via bearer token ────────────────────────────────────────────
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });
  }

  // Create a scoped Supabase client that carries the user's JWT so RLS applies
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Fetch inventory item + brand + subtype ───────────────────────────────────
  const { data: item, error: itemError } = await db
    .from('inventory_items')
    .select('*, brands(name), item_subtypes(name)')
    .eq('id', inventoryItemId)
    .single();

  if (itemError || !item) {
    return NextResponse.json({ error: 'Item not found or access denied' }, { status: 404 });
  }

  // ── Detect broad category for prompt lookup ──────────────────────────────────
  const subtypeName = (item.item_subtypes as any)?.name as string | null ?? null;
  const category    = detectCategory(subtypeName, item.item_type);

  // Fallback order: detected category → Guitar → Other
  const candidateCategories: string[] = [category];
  if (category !== 'Guitar')  candidateCategories.push('Guitar');
  if (category !== 'Other')   candidateCategories.push('Other');

  // ── Load active prompt (user-scoped via RLS) ─────────────────────────────────
  let promptOverride: PromptOverride | undefined;
  let aiPromptId: number | null = null;

  for (const cat of candidateCategories) {
    const { data: promptRow } = await db
      .from('ai_prompts')
      .select('id, prompt_text, model, temperature, is_active')
      .eq('category',     cat)
      .eq('listing_type', listingType as string)
      .eq('is_active',    true)
      .maybeSingle();

    if (promptRow?.prompt_text?.trim()) {
      aiPromptId    = promptRow.id as number;
      promptOverride = {
        promptText:  promptRow.prompt_text,
        model:       promptRow.model       ?? null,
        temperature: promptRow.temperature != null ? Number(promptRow.temperature) : null,
      };
      break;
    }
  }

  // ── Call OpenAI (server-side only) ───────────────────────────────────────────
  try {
    const { text, model, promptSnapshot } = await generateListing(
      {
        brandName:          (item.brands as any)?.name       ?? 'Unknown brand',
        model:              item.model,
        itemType:           item.item_type,
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
      listingType as ListingType,
      typeof currentDraft === 'string' ? currentDraft : undefined,
      promptOverride,
    );

    return NextResponse.json({ text, ai_model: model, ai_prompt_id: aiPromptId, prompt_snapshot: promptSnapshot });
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
