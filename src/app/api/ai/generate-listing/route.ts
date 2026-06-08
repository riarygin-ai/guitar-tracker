import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateListing, type ListingType } from '@/lib/openai';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const VALID_LISTING_TYPES: ListingType[] = ['reverb', 'marketplace', 'trade'];

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

  // ── Call OpenAI (server-side only) ───────────────────────────────────────────
  try {
    const text = await generateListing(
      {
        brandName:          (item.brands as any)?.name       ?? 'Unknown brand',
        model:              item.model,
        itemType:           item.item_type,
        subtypeName:        (item.item_subtypes as any)?.name ?? null,
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
    );

    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generation failed';
    console.error('[generate-listing] OpenAI error:', message);

    // Surface quota/auth errors clearly; keep other details vague
    if (message.includes('API key') || message.includes('apiKey')) {
      return NextResponse.json({ error: 'OpenAI API key is not configured on the server' }, { status: 500 });
    }
    if (message.includes('quota') || message.includes('429')) {
      return NextResponse.json({ error: 'OpenAI quota exceeded — try again later' }, { status: 429 });
    }
    return NextResponse.json({ error: 'Failed to generate listing — please try again' }, { status: 500 });
  }
}
