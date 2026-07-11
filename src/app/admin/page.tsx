'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AiPromptsCard from '@/components/AiPromptsCard';
import CompactPageHeader from '@/components/CompactPageHeader';
import {
  createBrand,
  createItemCategory,
  createItemPurpose,
  createItemSubtype,
  createTag,
  deleteBrand,
  deleteItemCategory,
  deleteItemPurpose,
  deleteItemSubtype,
  deleteTag,
  getBrandUsageCount,
  getBrands,
  getItemCategories,
  getItemPurposes,
  getItemSubtypes,
  getOrCreateAppUser,
  getPurposeUsageCount,
  getSubtypeUsageCount,
  getTagUsageCount,
  getTags,
  updateBrand,
  updateItemCategory,
  updateItemPurpose,
  updateItemSubtype,
  updateTag,
} from '@/lib/supabase';
import type { AppUser, Brand, InventoryTag, ItemCategory, ItemPurpose, ItemSubtype } from '@/types';

const BRAND_PAGE_SIZE = 5;

type EditState = { id: number; name: string };

// per-item delete: phase drives which UI to show; msg is user-visible text
type CatDelPhase = 'confirm' | 'deleting';
type SubDelPhase = 'checking' | 'confirm' | 'deleting';

export default function AdminPage() {
  const router = useRouter();

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AppUser | null>(null);

  // ── Brands ────────────────────────────────────────────────────────────────
  const [brands,        setBrands]        = useState<Brand[]>([]);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [search,        setSearch]        = useState('');
  const [brandExpanded, setBrandExpanded] = useState(false);
  // edit
  const [editing,    setEditing]    = useState<EditState | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError,  setEditError]  = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  // delete
  const [deleting,     setDeleting]     = useState<{ id: number; name: string; checking: boolean } | null>(null);
  const [deleteError,  setDeleteError]  = useState<string | null>(null);
  // add brand
  const [showAddBrand,  setShowAddBrand]  = useState(false);
  const [newBrandName,  setNewBrandName]  = useState('');
  const [newBrandSaving,setNewBrandSaving]= useState(false);
  const [newBrandError, setNewBrandError] = useState<string | null>(null);
  const newBrandInputRef = useRef<HTMLInputElement>(null);

  // ── Categories ────────────────────────────────────────────────────────────
  const [categories,  setCategories]  = useState<ItemCategory[]>([]);
  const [catsLoading, setCatsLoading] = useState(false);
  const [expandedCats, setExpandedCats] = useState<Set<number>>(new Set());
  // edit
  const [catEditing,    setCatEditing]   = useState<EditState | null>(null);
  const [catEditSaving, setCatEditSaving] = useState(false);
  const [catEditError,  setCatEditError]  = useState<string | null>(null);
  const catEditInputRef = useRef<HTMLInputElement>(null);
  // create
  const [catCreateName,  setCatCreateName]  = useState('');
  const [catCreating,    setCatCreating]    = useState(false);
  const [catCreateError, setCatCreateError] = useState<string | null>(null);
  // toggle active
  const [catToggling, setCatToggling] = useState<Set<number>>(new Set());
  // delete (per-category)
  const [catDelPhase, setCatDelPhase] = useState<Record<number, CatDelPhase>>({});
  const [catDelMsg,   setCatDelMsg]   = useState<Record<number, string>>({});

  // ── Subtypes ──────────────────────────────────────────────────────────────
  const [subtypes,    setSubtypes]    = useState<ItemSubtype[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  // edit
  const [subEditing,    setSubEditing]   = useState<EditState | null>(null);
  const [subEditSaving, setSubEditSaving] = useState(false);
  const [subEditError,  setSubEditError]  = useState<string | null>(null);
  const subEditInputRef = useRef<HTMLInputElement>(null);
  // create
  const [subCreateNames,   setSubCreateNames]   = useState<Record<number, string>>({});
  const [subCreatingCatId, setSubCreatingCatId] = useState<number | null>(null);
  const [subCreateErrors,  setSubCreateErrors]  = useState<Record<number, string>>({});
  // toggle active
  const [subToggling, setSubToggling] = useState<Set<number>>(new Set());
  // delete (per-subtype)
  const [subDelPhase, setSubDelPhase] = useState<Record<number, SubDelPhase>>({});
  const [subDelMsg,   setSubDelMsg]   = useState<Record<number, string>>({});
  // move
  const [subMovingId, setSubMovingId] = useState<number | null>(null);

  // ── Purposes ──────────────────────────────────────────────────────────────
  const [purposes,        setPurposes]       = useState<ItemPurpose[]>([]);
  const [purposesLoading, setPurposesLoading] = useState(false);
  const [purposeSearch,   setPurposeSearch]   = useState('');
  const [purposeCreateName,  setPurposeCreateName]  = useState('');
  const [purposeCreating,    setPurposeCreating]    = useState(false);
  const [purposeCreateError, setPurposeCreateError] = useState<string | null>(null);
  const [purposeEditing,    setPurposeEditing]   = useState<EditState | null>(null);
  const [purposeEditSaving, setPurposeEditSaving] = useState(false);
  const [purposeEditError,  setPurposeEditError]  = useState<string | null>(null);
  const purposeEditInputRef = useRef<HTMLInputElement>(null);
  const [purposeToggling, setPurposeToggling] = useState<Set<number>>(new Set());
  type PurposeDelPhase = 'checking' | 'confirm' | 'deleting';
  const [purposeDelPhase, setPurposeDelPhase] = useState<Record<number, PurposeDelPhase>>({});
  const [purposeDelMsg,   setPurposeDelMsg]   = useState<Record<number, string>>({});

  // ── Tags ──────────────────────────────────────────────────────────────────
  const [tags,        setTags]        = useState<InventoryTag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagSearch,   setTagSearch]   = useState('');
  // create
  const [tagCreateName,  setTagCreateName]  = useState('');
  const [tagCreating,    setTagCreating]    = useState(false);
  const [tagCreateError, setTagCreateError] = useState<string | null>(null);
  // edit
  const [tagEditing,    setTagEditing]    = useState<EditState | null>(null);
  const [tagEditSaving, setTagEditSaving] = useState(false);
  const [tagEditError,  setTagEditError]  = useState<string | null>(null);
  const tagEditInputRef = useRef<HTMLInputElement>(null);
  // toggle active
  const [tagToggling, setTagToggling] = useState<Set<number>>(new Set());
  // delete
  type TagDelPhase = 'checking' | 'confirm' | 'deleting';
  const [tagDelPhase, setTagDelPhase] = useState<Record<number, TagDelPhase>>({});
  const [tagDelMsg,   setTagDelMsg]   = useState<Record<number, string>>({});

  // ── Auth ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    getOrCreateAppUser().then((u) => {
      setUser(u);
      setAuthLoading(false);
      if (!u) router.replace('/login');
    });
  }, [router]);

  useEffect(() => {
    if (!user?.admin) return;
    loadBrands();
    loadCategories();
    loadSubtypes();
    loadPurposes();
    loadTags();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Brands CRUD ───────────────────────────────────────────────────────────

  async function loadBrands() {
    setBrandsLoading(true);
    const { data, error } = await getBrands();
    setBrandsLoading(false);
    if (!error) setBrands((data as Brand[]) ?? []);
  }

  useEffect(() => {
    if (editing) editInputRef.current?.focus();
  }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (showAddBrand) newBrandInputRef.current?.focus();
  }, [showAddBrand]);

  useEffect(() => { setBrandExpanded(false); }, [search]);

  const filteredBrands = brands.filter((b) =>
    b.name.toLowerCase().includes(search.trim().toLowerCase())
  );
  const visibleBrands = brandExpanded ? filteredBrands : filteredBrands.slice(0, BRAND_PAGE_SIZE);
  const hiddenCount   = filteredBrands.length - BRAND_PAGE_SIZE;

  async function handleAddBrand() {
    const trimmed = newBrandName.trim();
    if (!trimmed) { setNewBrandError('Brand name is required.'); return; }
    const dup = brands.find((b) => b.name.toLowerCase() === trimmed.toLowerCase());
    if (dup) { setNewBrandError('A brand with this name already exists.'); return; }
    setNewBrandSaving(true);
    setNewBrandError(null);
    const { data, error } = await createBrand({ name: trimmed });
    setNewBrandSaving(false);
    if (error) { setNewBrandError('Could not create brand.'); return; }
    setBrands((prev) => [...prev, data as Brand].sort((a, b) => a.name.localeCompare(b.name)));
    setNewBrandName('');
    setShowAddBrand(false);
  }

  function startEdit(brand: Brand) {
    setEditing({ id: brand.id, name: brand.name });
    setEditError(null);
    setDeleting(null);
    setDeleteError(null);
  }
  function cancelEdit() { setEditing(null); setEditError(null); }

  async function saveEdit() {
    if (!editing) return;
    const trimmed = editing.name.trim();
    if (!trimmed) { setEditError('Brand name is required.'); return; }
    const dup = brands.find((b) => b.name.toLowerCase() === trimmed.toLowerCase() && b.id !== editing.id);
    if (dup) { setEditError('A brand with this name already exists.'); return; }
    setEditSaving(true);
    setEditError(null);
    const { data, error } = await updateBrand(editing.id, trimmed);
    setEditSaving(false);
    if (error) { setEditError(error.message || 'Could not update brand.'); return; }
    setBrands((prev) => prev.map((b) => (b.id === editing.id ? (data as Brand) : b)));
    setEditing(null);
  }

  async function startDelete(brand: Brand) {
    setDeleting({ id: brand.id, name: brand.name, checking: true });
    setDeleteError(null);
    setEditing(null);
    setEditError(null);
    const { count, error } = await getBrandUsageCount(brand.id);
    if (error) { setDeleteError('Could not check brand usage.'); setDeleting(null); return; }
    if ((count ?? 0) > 0) {
      setDeleteError(`"${brand.name}" is already used by one or more inventory items and cannot be deleted. You can rename it instead.`);
      setDeleting(null);
      return;
    }
    setDeleting({ id: brand.id, name: brand.name, checking: false });
  }
  function cancelDelete() { setDeleting(null); setDeleteError(null); }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleting((d) => d && { ...d, checking: true });
    setDeleteError(null);
    const { error } = await deleteBrand(deleting.id);
    if (error) { setDeleteError(error.message || 'Could not delete brand.'); setDeleting(null); return; }
    setBrands((prev) => prev.filter((b) => b.id !== deleting.id));
    setDeleting(null);
  }

  // ── Categories CRUD ───────────────────────────────────────────────────────

  async function loadCategories() {
    setCatsLoading(true);
    const { data, error } = await getItemCategories();
    setCatsLoading(false);
    if (!error) setCategories((data as ItemCategory[]) ?? []);
  }

  useEffect(() => {
    if (catEditing) catEditInputRef.current?.focus();
  }, [catEditing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleCatExpand(id: number) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function startCatEdit(cat: ItemCategory) { setCatEditing({ id: cat.id, name: cat.name }); setCatEditError(null); }
  function cancelCatEdit() { setCatEditing(null); setCatEditError(null); }

  async function saveCatEdit() {
    if (!catEditing) return;
    const trimmed = catEditing.name.trim();
    if (!trimmed) { setCatEditError('Name is required.'); return; }
    setCatEditSaving(true);
    setCatEditError(null);
    const { error } = await updateItemCategory(catEditing.id, { name: trimmed });
    setCatEditSaving(false);
    if (error) { setCatEditError(error.message || 'Could not update category.'); return; }
    setCategories((prev) => prev.map((c) => c.id === catEditing.id ? { ...c, name: trimmed } : c));
    setCatEditing(null);
  }

  async function toggleCatActive(cat: ItemCategory) {
    setCatToggling((s) => new Set(s).add(cat.id));
    const { error } = await updateItemCategory(cat.id, { is_active: !cat.is_active });
    setCatToggling((s) => { const n = new Set(s); n.delete(cat.id); return n; });
    if (!error) setCategories((prev) => prev.map((c) => c.id === cat.id ? { ...c, is_active: !cat.is_active } : c));
  }

  async function handleCreateCategory() {
    const trimmed = catCreateName.trim();
    if (!trimmed) { setCatCreateError('Name is required.'); return; }
    setCatCreating(true);
    setCatCreateError(null);
    const { data, error } = await createItemCategory(trimmed);
    setCatCreating(false);
    if (error) { setCatCreateError(error.message || 'Could not create category.'); return; }
    setCategories((prev) => [...prev, data as ItemCategory]);
    setCatCreateName('');
  }

  function startCatDelete(cat: ItemCategory) {
    const catSubs = subtypes.filter((s) => s.category_id === cat.id);
    if (catSubs.length > 0) {
      setCatDelMsg((prev) => ({
        ...prev,
        [cat.id]: `"${cat.name}" has ${catSubs.length} type${catSubs.length !== 1 ? 's' : ''} and cannot be deleted. Move or remove its types first, or deactivate the category instead.`,
      }));
      return;
    }
    setCatDelPhase((prev) => ({ ...prev, [cat.id]: 'confirm' }));
  }

  function cancelCatDelete(id: number) {
    setCatDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setCatDelMsg((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function confirmCatDelete(id: number) {
    setCatDelPhase((prev) => ({ ...prev, [id]: 'deleting' }));
    const { error } = await deleteItemCategory(id);
    if (error) {
      setCatDelMsg((prev) => ({ ...prev, [id]: 'Could not delete category.' }));
      setCatDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
      return;
    }
    setCategories((prev) => prev.filter((c) => c.id !== id));
    setCatDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setCatDelMsg((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setExpandedCats((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }

  // ── Subtypes CRUD ─────────────────────────────────────────────────────────

  async function loadSubtypes() {
    setSubsLoading(true);
    const { data, error } = await getItemSubtypes();
    setSubsLoading(false);
    if (!error) setSubtypes((data as ItemSubtype[]) ?? []);
  }

  useEffect(() => {
    if (subEditing) subEditInputRef.current?.focus();
  }, [subEditing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function startSubEdit(sub: ItemSubtype) { setSubEditing({ id: sub.id, name: sub.name }); setSubEditError(null); }
  function cancelSubEdit() { setSubEditing(null); setSubEditError(null); }

  async function saveSubEdit() {
    if (!subEditing) return;
    const trimmed = subEditing.name.trim();
    if (!trimmed) { setSubEditError('Name is required.'); return; }
    setSubEditSaving(true);
    setSubEditError(null);
    const { error } = await updateItemSubtype(subEditing.id, { name: trimmed });
    setSubEditSaving(false);
    if (error) { setSubEditError(error.message || 'Could not update type.'); return; }
    setSubtypes((prev) => prev.map((s) => s.id === subEditing.id ? { ...s, name: trimmed } : s));
    setSubEditing(null);
  }

  async function toggleSubActive(sub: ItemSubtype) {
    setSubToggling((s) => new Set(s).add(sub.id));
    const { error } = await updateItemSubtype(sub.id, { is_active: !sub.is_active });
    setSubToggling((s) => { const n = new Set(s); n.delete(sub.id); return n; });
    if (!error) setSubtypes((prev) => prev.map((s) => s.id === sub.id ? { ...s, is_active: !sub.is_active } : s));
  }

  async function handleCreateSubtype(catId: number) {
    const trimmed = (subCreateNames[catId] ?? '').trim();
    if (!trimmed) { setSubCreateErrors((prev) => ({ ...prev, [catId]: 'Name is required.' })); return; }
    setSubCreatingCatId(catId);
    setSubCreateErrors((prev) => { const n = { ...prev }; delete n[catId]; return n; });
    const { data, error } = await createItemSubtype(catId, trimmed);
    setSubCreatingCatId(null);
    if (error) { setSubCreateErrors((prev) => ({ ...prev, [catId]: error.message || 'Could not create type.' })); return; }
    setSubtypes((prev) => [...prev, data as ItemSubtype]);
    setSubCreateNames((prev) => ({ ...prev, [catId]: '' }));
  }

  async function startSubDelete(sub: ItemSubtype) {
    setSubDelPhase((prev) => ({ ...prev, [sub.id]: 'checking' }));
    const { count, error } = await getSubtypeUsageCount(sub.id);
    if (error) {
      setSubDelMsg((prev) => ({ ...prev, [sub.id]: 'Could not check usage.' }));
      setSubDelPhase((prev) => { const n = { ...prev }; delete n[sub.id]; return n; });
      return;
    }
    if ((count ?? 0) > 0) {
      setSubDelMsg((prev) => ({
        ...prev,
        [sub.id]: `"${sub.name}" is used by ${count} inventory item${count !== 1 ? 's' : ''} and cannot be deleted. You can deactivate it instead.`,
      }));
      setSubDelPhase((prev) => { const n = { ...prev }; delete n[sub.id]; return n; });
      return;
    }
    setSubDelPhase((prev) => ({ ...prev, [sub.id]: 'confirm' }));
  }

  function cancelSubDelete(id: number) {
    setSubDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setSubDelMsg((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function confirmSubDelete(id: number) {
    setSubDelPhase((prev) => ({ ...prev, [id]: 'deleting' }));
    const { error } = await deleteItemSubtype(id);
    if (error) {
      setSubDelMsg((prev) => ({ ...prev, [id]: 'Could not delete type.' }));
      setSubDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
      return;
    }
    setSubtypes((prev) => prev.filter((s) => s.id !== id));
    setSubDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  // ── Purposes CRUD ─────────────────────────────────────────────────────────

  async function loadPurposes() {
    setPurposesLoading(true);
    const { data, error } = await getItemPurposes();
    setPurposesLoading(false);
    if (!error) setPurposes((data as ItemPurpose[]) ?? []);
  }

  useEffect(() => {
    if (purposeEditing) purposeEditInputRef.current?.focus();
  }, [purposeEditing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredPurposes = purposes.filter((p) =>
    p.name.toLowerCase().includes(purposeSearch.trim().toLowerCase())
  );

  async function handleCreatePurpose() {
    const trimmed = purposeCreateName.trim();
    if (!trimmed) { setPurposeCreateError('Name is required.'); return; }
    const dup = purposes.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    if (dup) { setPurposeCreateError('A purpose with this name already exists.'); return; }
    setPurposeCreating(true);
    setPurposeCreateError(null);
    const { data, error } = await createItemPurpose(trimmed);
    setPurposeCreating(false);
    if (error) { setPurposeCreateError((error as { message?: string })?.message || 'Could not create purpose.'); return; }
    setPurposes((prev) => [...prev, data as ItemPurpose].sort((a, b) => a.name.localeCompare(b.name)));
    setPurposeCreateName('');
  }

  function startPurposeEdit(purpose: ItemPurpose) { setPurposeEditing({ id: purpose.id, name: purpose.name }); setPurposeEditError(null); }
  function cancelPurposeEdit() { setPurposeEditing(null); setPurposeEditError(null); }

  async function savePurposeEdit() {
    if (!purposeEditing) return;
    const trimmed = purposeEditing.name.trim();
    if (!trimmed) { setPurposeEditError('Name is required.'); return; }
    const dup = purposes.find((p) => p.name.toLowerCase() === trimmed.toLowerCase() && p.id !== purposeEditing.id);
    if (dup) { setPurposeEditError('A purpose with this name already exists.'); return; }
    setPurposeEditSaving(true);
    setPurposeEditError(null);
    const { error } = await updateItemPurpose(purposeEditing.id, { name: trimmed });
    setPurposeEditSaving(false);
    if (error) { setPurposeEditError((error as { message?: string })?.message || 'Could not update purpose.'); return; }
    setPurposes((prev) => prev.map((p) => p.id === purposeEditing.id ? { ...p, name: trimmed } : p));
    setPurposeEditing(null);
  }

  async function togglePurposeActive(purpose: ItemPurpose) {
    setPurposeToggling((s) => new Set(s).add(purpose.id));
    const { error } = await updateItemPurpose(purpose.id, { is_active: !purpose.is_active });
    setPurposeToggling((s) => { const n = new Set(s); n.delete(purpose.id); return n; });
    if (!error) setPurposes((prev) => prev.map((p) => p.id === purpose.id ? { ...p, is_active: !purpose.is_active } : p));
  }

  async function startPurposeDelete(purpose: ItemPurpose) {
    setPurposeDelPhase((prev) => ({ ...prev, [purpose.id]: 'checking' }));
    const { count, error } = await getPurposeUsageCount(purpose.id);
    if (error) {
      setPurposeDelMsg((prev) => ({ ...prev, [purpose.id]: 'Could not check usage.' }));
      setPurposeDelPhase((prev) => { const n = { ...prev }; delete n[purpose.id]; return n; });
      return;
    }
    if ((count ?? 0) > 0) {
      setPurposeDelMsg((prev) => ({
        ...prev,
        [purpose.id]: `"${purpose.name}" is used by ${count} item${count !== 1 ? 's' : ''} and cannot be deleted. Deactivate it instead.`,
      }));
      setPurposeDelPhase((prev) => { const n = { ...prev }; delete n[purpose.id]; return n; });
      return;
    }
    setPurposeDelPhase((prev) => ({ ...prev, [purpose.id]: 'confirm' }));
  }

  function cancelPurposeDelete(id: number) {
    setPurposeDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setPurposeDelMsg((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function confirmPurposeDelete(id: number) {
    setPurposeDelPhase((prev) => ({ ...prev, [id]: 'deleting' }));
    const { error } = await deleteItemPurpose(id);
    if (error) {
      setPurposeDelMsg((prev) => ({ ...prev, [id]: 'Could not delete purpose.' }));
      setPurposeDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
      return;
    }
    setPurposes((prev) => prev.filter((p) => p.id !== id));
    setPurposeDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  // ── Tags CRUD ─────────────────────────────────────────────────────────────

  async function loadTags() {
    setTagsLoading(true);
    const { data, error } = await getTags();
    setTagsLoading(false);
    if (!error) setTags((data as InventoryTag[]) ?? []);
  }

  useEffect(() => {
    if (tagEditing) tagEditInputRef.current?.focus();
  }, [tagEditing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredTags = tags.filter((t) =>
    t.name.toLowerCase().includes(tagSearch.trim().toLowerCase())
  );

  async function handleCreateTag() {
    const trimmed = tagCreateName.trim();
    if (!trimmed) { setTagCreateError('Name is required.'); return; }
    const dup = tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
    if (dup) { setTagCreateError('A tag with this name already exists.'); return; }
    setTagCreating(true);
    setTagCreateError(null);
    const { data, error } = await createTag(trimmed);
    setTagCreating(false);
    if (error) { setTagCreateError((error as { message?: string })?.message || 'Could not create tag.'); return; }
    setTags((prev) => [...prev, data as InventoryTag].sort((a, b) => a.name.localeCompare(b.name)));
    setTagCreateName('');
  }

  function startTagEdit(tag: InventoryTag) { setTagEditing({ id: tag.id, name: tag.name }); setTagEditError(null); }
  function cancelTagEdit() { setTagEditing(null); setTagEditError(null); }

  async function saveTagEdit() {
    if (!tagEditing) return;
    const trimmed = tagEditing.name.trim();
    if (!trimmed) { setTagEditError('Name is required.'); return; }
    const dup = tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase() && t.id !== tagEditing.id);
    if (dup) { setTagEditError('A tag with this name already exists.'); return; }
    setTagEditSaving(true);
    setTagEditError(null);
    const { error } = await updateTag(tagEditing.id, { name: trimmed });
    setTagEditSaving(false);
    if (error) { setTagEditError((error as { message?: string })?.message || 'Could not update tag.'); return; }
    setTags((prev) => prev.map((t) => t.id === tagEditing.id ? { ...t, name: trimmed } : t));
    setTagEditing(null);
  }

  async function toggleTagActive(tag: InventoryTag) {
    setTagToggling((s) => new Set(s).add(tag.id));
    const { error } = await updateTag(tag.id, { is_active: !tag.is_active });
    setTagToggling((s) => { const n = new Set(s); n.delete(tag.id); return n; });
    if (!error) setTags((prev) => prev.map((t) => t.id === tag.id ? { ...t, is_active: !tag.is_active } : t));
  }

  async function startTagDelete(tag: InventoryTag) {
    setTagDelPhase((prev) => ({ ...prev, [tag.id]: 'checking' }));
    const { count, error } = await getTagUsageCount(tag.id);
    if (error) {
      setTagDelMsg((prev) => ({ ...prev, [tag.id]: 'Could not check usage.' }));
      setTagDelPhase((prev) => { const n = { ...prev }; delete n[tag.id]; return n; });
      return;
    }
    if ((count ?? 0) > 0) {
      setTagDelMsg((prev) => ({
        ...prev,
        [tag.id]: `"${tag.name}" is used by ${count} item${count !== 1 ? 's' : ''} and cannot be deleted. Deactivate it instead.`,
      }));
      setTagDelPhase((prev) => { const n = { ...prev }; delete n[tag.id]; return n; });
      return;
    }
    setTagDelPhase((prev) => ({ ...prev, [tag.id]: 'confirm' }));
  }

  function cancelTagDelete(id: number) {
    setTagDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setTagDelMsg((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function confirmTagDelete(id: number) {
    setTagDelPhase((prev) => ({ ...prev, [id]: 'deleting' }));
    const { error } = await deleteTag(id);
    if (error) {
      setTagDelMsg((prev) => ({ ...prev, [id]: 'Could not delete tag.' }));
      setTagDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
      return;
    }
    setTags((prev) => prev.filter((t) => t.id !== id));
    setTagDelPhase((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function moveSubtype(sub: ItemSubtype, newCatId: number) {
    setSubMovingId(sub.id);
    const { error } = await updateItemSubtype(sub.id, { category_id: newCatId });
    setSubMovingId(null);
    if (!error) setSubtypes((prev) => prev.map((s) => s.id === sub.id ? { ...s, category_id: newCatId } : s));
  }

  // ── Render guards ─────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading...</p>
      </div>
    );
  }

  if (!user) return null;

  if (!user.admin) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 dark:border-rose-800/50 dark:bg-rose-900/20">
          <p className="text-lg font-semibold text-rose-700 dark:text-rose-400">Access denied</p>
          <p className="mt-2 text-sm text-rose-600 dark:text-rose-500">You do not have admin privileges.</p>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-6 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Shared styles ─────────────────────────────────────────────────────────

  const inputClass  = 'h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-100 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600';
  const btnPrimary  = 'inline-flex h-8 items-center justify-center rounded-lg bg-slate-950 px-3 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400';
  const btnSecondary= 'inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';
  const btnAction   = 'inline-flex h-7 items-center justify-center rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600';
  const btnDanger   = 'inline-flex h-7 items-center justify-center rounded-md border border-rose-200 bg-rose-50 px-2.5 text-xs font-medium text-rose-700 transition hover:bg-rose-100 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400 dark:hover:bg-rose-900/40';
  const btnDangerSolid = 'inline-flex h-7 items-center justify-center rounded-md bg-rose-600 px-3 text-xs font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300 dark:disabled:bg-rose-800';

  return (
    <div className="space-y-6">

      <CompactPageHeader
        overline="Admin"
        summary={
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Signed in as {user.email ?? user.display_name}
          </p>
        }
      />

      {/* ── Brands ────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">Brands</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{brands.length} total</p>
          </div>
          <button
            type="button"
            onClick={() => { setShowAddBrand((v) => !v); setNewBrandName(''); setNewBrandError(null); }}
            className={btnSecondary}
          >
            {showAddBrand ? 'Cancel' : '+ Add brand'}
          </button>
        </div>

        {/* Add brand row */}
        {showAddBrand && (
          <div className="mt-3 space-y-1.5">
            <div className="flex gap-2">
              <input
                ref={newBrandInputRef}
                value={newBrandName}
                onChange={(e) => setNewBrandName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddBrand(); if (e.key === 'Escape') setShowAddBrand(false); }}
                placeholder="Brand name…"
                disabled={newBrandSaving}
                className={inputClass}
              />
              <button type="button" onClick={handleAddBrand} disabled={newBrandSaving || !newBrandName.trim()} className={btnPrimary}>
                {newBrandSaving ? 'Adding…' : 'Add'}
              </button>
            </div>
            {newBrandError && <p className="text-xs text-rose-600 dark:text-rose-400">{newBrandError}</p>}
          </div>
        )}

        {/* Search */}
        <div className="relative mt-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search brands…"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-3 pr-8 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>

        {/* Delete conflict banner */}
        {deleteError && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300">
            {deleteError}
          </div>
        )}

        {/* Brand list */}
        {brandsLoading ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Loading brands…</p>
        ) : filteredBrands.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
            {search ? 'No brands match your search.' : 'No brands yet.'}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-700/50">
            {visibleBrands.map((brand) => {
              const isEditing  = editing?.id  === brand.id;
              const isDeleting = deleting?.id === brand.id;
              return (
                <li key={brand.id} className="py-2">
                  {isEditing ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          ref={editInputRef}
                          value={editing.name}
                          onChange={(e) => setEditing((s) => s && { ...s, name: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                          disabled={editSaving}
                          className={inputClass}
                        />
                        <button type="button" onClick={saveEdit} disabled={editSaving} className={btnPrimary}>
                          {editSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" onClick={cancelEdit} disabled={editSaving} className={btnSecondary}>Cancel</button>
                      </div>
                      {editError && <p className="text-xs text-rose-600 dark:text-rose-400">{editError}</p>}
                    </div>
                  ) : isDeleting ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">
                        Delete <span className="font-semibold">{brand.name}</span>?
                      </p>
                      <button type="button" onClick={confirmDelete} disabled={deleting.checking} className={btnDangerSolid}>
                        {deleting.checking ? 'Deleting…' : 'Delete'}
                      </button>
                      <button type="button" onClick={cancelDelete} disabled={deleting.checking} className={btnSecondary}>Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-white">{brand.name}</span>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => startEdit(brand)} className={btnAction}>Edit</button>
                        <button type="button" onClick={() => startDelete(brand)} className={btnDanger}>Delete</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Show more / less */}
        {!brandExpanded && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setBrandExpanded(true)}
            className="mt-2 text-xs text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
          >
            Show {hiddenCount} more…
          </button>
        )}
        {brandExpanded && filteredBrands.length > BRAND_PAGE_SIZE && (
          <button
            type="button"
            onClick={() => setBrandExpanded(false)}
            className="mt-2 text-xs text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
          >
            Show less
          </button>
        )}
      </div>

      {/* ── Item Categories & Subtypes ────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        {/* Header */}
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Item Categories</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {categories.length} categor{categories.length !== 1 ? 'ies' : 'y'} · {subtypes.length} type{subtypes.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Add category */}
        <div className="mb-4 space-y-1.5">
          <div className="flex gap-2">
            <input
              value={catCreateName}
              onChange={(e) => setCatCreateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateCategory(); }}
              placeholder="New category name…"
              disabled={catCreating}
              className={inputClass}
            />
            <button type="button" onClick={handleCreateCategory} disabled={catCreating || !catCreateName.trim()} className={btnPrimary}>
              {catCreating ? 'Creating…' : 'Add'}
            </button>
          </div>
          {catCreateError && <p className="text-xs text-rose-600 dark:text-rose-400">{catCreateError}</p>}
        </div>

        {/* Category list */}
        {catsLoading || subsLoading ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">Loading…</p>
        ) : categories.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">No categories yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-700/50">
            {categories.map((cat) => {
              const catSubs     = subtypes.filter((s) => s.category_id === cat.id);
              const isExpanded  = expandedCats.has(cat.id);
              const isEditingCat = catEditing?.id === cat.id;
              const delPhase    = catDelPhase[cat.id];
              const delMsg      = catDelMsg[cat.id];

              return (
                <div key={cat.id} className="py-2">

                  {/* ── Category row ──────────────────────────────────── */}
                  <div className="flex items-center gap-1.5">

                    {/* Expand chevron */}
                    <button
                      type="button"
                      onClick={() => toggleCatExpand(cat.id)}
                      aria-label={isExpanded ? 'Collapse' : 'Expand'}
                      className="shrink-0 rounded p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                      >
                        <polyline points="9 18 15 12 9 6"/>
                      </svg>
                    </button>

                    {isEditingCat ? (
                      <div className="flex flex-1 flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <input
                            ref={catEditInputRef}
                            value={catEditing.name}
                            onChange={(e) => setCatEditing((s) => s && { ...s, name: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveCatEdit(); if (e.key === 'Escape') cancelCatEdit(); }}
                            disabled={catEditSaving}
                            className={inputClass}
                          />
                          <button type="button" onClick={saveCatEdit} disabled={catEditSaving} className={btnPrimary}>
                            {catEditSaving ? 'Saving…' : 'Save'}
                          </button>
                          <button type="button" onClick={cancelCatEdit} disabled={catEditSaving} className={btnSecondary}>Cancel</button>
                        </div>
                        {catEditError && <p className="text-xs text-rose-600 dark:text-rose-400">{catEditError}</p>}
                      </div>
                    ) : delPhase === 'confirm' ? (
                      <div className="flex flex-1 flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">
                          Delete <span className="font-semibold">{cat.name}</span>?
                        </span>
                        <button type="button" onClick={() => confirmCatDelete(cat.id)} className={btnDangerSolid}>Delete</button>
                        <button type="button" onClick={() => cancelCatDelete(cat.id)} className={btnSecondary}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <span className={`min-w-0 flex-1 truncate text-sm font-medium ${cat.is_active ? 'text-slate-900 dark:text-white' : 'text-slate-400 line-through dark:text-slate-500'}`}>
                          {cat.name}
                        </span>
                        {!cat.is_active && (
                          <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-400">inactive</span>
                        )}
                        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                          {catSubs.length}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <button type="button" onClick={() => startCatEdit(cat)} className={btnAction}>Edit</button>
                          <button
                            type="button"
                            onClick={() => toggleCatActive(cat)}
                            disabled={catToggling.has(cat.id)}
                            className={`${btnAction} disabled:opacity-50`}
                          >
                            {catToggling.has(cat.id) ? '…' : cat.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button type="button" onClick={() => startCatDelete(cat)} className={btnDanger}>Delete</button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Category blocked / error message */}
                  {delMsg && !delPhase && (
                    <div className="mt-1.5 ml-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300">
                      <span className="flex-1">{delMsg}</span>
                      <button type="button" onClick={() => cancelCatDelete(cat.id)} aria-label="Dismiss" className="shrink-0 text-amber-500 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-200">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  )}

                  {/* ── Expanded subtypes ───────────────────────────── */}
                  {isExpanded && (
                    <div className="ml-5 mt-1.5 rounded-lg border border-slate-100 dark:border-slate-700/50">

                      {catSubs.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">No types yet.</p>
                      ) : (
                        <ul className="divide-y divide-slate-100 dark:divide-slate-700/50">
                          {catSubs.map((sub) => {
                            const isEditingSub = subEditing?.id === sub.id;
                            const sDelPhase    = subDelPhase[sub.id];
                            const sDelMsg      = subDelMsg[sub.id];
                            const isMoving     = subMovingId === sub.id;

                            return (
                              <li key={sub.id} className="px-3 py-2">
                                {isEditingSub ? (
                                  <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                      <input
                                        ref={subEditInputRef}
                                        value={subEditing.name}
                                        onChange={(e) => setSubEditing((s) => s && { ...s, name: e.target.value })}
                                        onKeyDown={(e) => { if (e.key === 'Enter') saveSubEdit(); if (e.key === 'Escape') cancelSubEdit(); }}
                                        disabled={subEditSaving}
                                        className={inputClass}
                                      />
                                      <button type="button" onClick={saveSubEdit} disabled={subEditSaving} className={btnPrimary}>
                                        {subEditSaving ? 'Saving…' : 'Save'}
                                      </button>
                                      <button type="button" onClick={cancelSubEdit} disabled={subEditSaving} className={btnSecondary}>Cancel</button>
                                    </div>
                                    {subEditError && <p className="text-xs text-rose-600 dark:text-rose-400">{subEditError}</p>}
                                  </div>
                                ) : sDelPhase === 'checking' ? (
                                  <span className="text-xs text-slate-400 dark:text-slate-500">Checking…</span>
                                ) : sDelPhase === 'confirm' || sDelPhase === 'deleting' ? (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="min-w-0 flex-1 text-xs text-slate-700 dark:text-slate-200">
                                      Delete <span className="font-semibold">{sub.name}</span>?
                                    </span>
                                    <button type="button" onClick={() => confirmSubDelete(sub.id)} disabled={sDelPhase === 'deleting'} className={btnDangerSolid}>
                                      {sDelPhase === 'deleting' ? 'Deleting…' : 'Delete'}
                                    </button>
                                    <button type="button" onClick={() => cancelSubDelete(sub.id)} disabled={sDelPhase === 'deleting'} className={btnSecondary}>Cancel</button>
                                  </div>
                                ) : (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className={`min-w-0 flex-1 truncate text-sm ${sub.is_active ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 line-through dark:text-slate-500'}`}>
                                      {sub.name}
                                    </span>
                                    {!sub.is_active && (
                                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-400">inactive</span>
                                    )}
                                    <button type="button" onClick={() => startSubEdit(sub)} className={btnAction}>Edit</button>
                                    <button
                                      type="button"
                                      onClick={() => toggleSubActive(sub)}
                                      disabled={subToggling.has(sub.id)}
                                      className={`${btnAction} disabled:opacity-50`}
                                    >
                                      {subToggling.has(sub.id) ? '…' : sub.is_active ? 'Deactivate' : 'Activate'}
                                    </button>
                                    {/* Move to another category */}
                                    <select
                                      value=""
                                      onChange={(e) => { if (e.target.value) moveSubtype(sub, Number(e.target.value)); }}
                                      disabled={isMoving}
                                      className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs text-slate-600 outline-none transition hover:border-slate-300 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                                    >
                                      <option value="">{isMoving ? 'Moving…' : 'Move to…'}</option>
                                      {categories.filter((c) => c.id !== cat.id).map((c) => (
                                        <option key={c.id} value={c.id}>{c.name}</option>
                                      ))}
                                    </select>
                                    <button type="button" onClick={() => startSubDelete(sub)} className={btnDanger}>Delete</button>
                                  </div>
                                )}

                                {/* Subtype blocked message */}
                                {sDelMsg && !sDelPhase && (
                                  <div className="mt-1 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300">
                                    <span className="flex-1">{sDelMsg}</span>
                                    <button type="button" onClick={() => cancelSubDelete(sub.id)} aria-label="Dismiss" className="shrink-0 text-amber-500 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-200">
                                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                      </svg>
                                    </button>
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      {/* Add subtype */}
                      <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-700/50">
                        <div className="flex gap-2">
                          <input
                            value={subCreateNames[cat.id] ?? ''}
                            onChange={(e) => setSubCreateNames((prev) => ({ ...prev, [cat.id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateSubtype(cat.id); }}
                            placeholder="Add type…"
                            disabled={subCreatingCatId === cat.id}
                            className={inputClass}
                          />
                          <button
                            type="button"
                            onClick={() => handleCreateSubtype(cat.id)}
                            disabled={subCreatingCatId === cat.id || !(subCreateNames[cat.id] ?? '').trim()}
                            className={btnPrimary}
                          >
                            {subCreatingCatId === cat.id ? 'Adding…' : 'Add'}
                          </button>
                        </div>
                        {subCreateErrors[cat.id] && (
                          <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{subCreateErrors[cat.id]}</p>
                        )}
                      </div>

                    </div>
                  )}

                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Purposes ──────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Purposes</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {purposes.length} purpose{purposes.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Create purpose */}
        <div className="mb-4 space-y-1.5">
          <div className="flex gap-2">
            <input
              value={purposeCreateName}
              onChange={(e) => setPurposeCreateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreatePurpose(); }}
              placeholder="New purpose name…"
              disabled={purposeCreating}
              className={inputClass}
            />
            <button type="button" onClick={handleCreatePurpose} disabled={purposeCreating || !purposeCreateName.trim()} className={btnPrimary}>
              {purposeCreating ? 'Creating…' : 'Add'}
            </button>
          </div>
          {purposeCreateError && <p className="text-xs text-rose-600 dark:text-rose-400">{purposeCreateError}</p>}
        </div>

        {/* Search */}
        <div className="mb-3">
          <input
            value={purposeSearch}
            onChange={(e) => setPurposeSearch(e.target.value)}
            placeholder="Search purposes…"
            className={inputClass}
          />
        </div>

        {/* Purpose list */}
        {purposesLoading ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">Loading…</p>
        ) : filteredPurposes.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
            {purposeSearch ? 'No matching purposes.' : 'No purposes yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700/50">
            {filteredPurposes.map((purpose) => {
              const delPhase = purposeDelPhase[purpose.id];
              const delMsg   = purposeDelMsg[purpose.id];
              const isEditingPurpose = purposeEditing?.id === purpose.id;

              return (
                <li key={purpose.id} className="py-2">
                  {isEditingPurpose ? (
                    <div className="space-y-1.5">
                      <div className="flex gap-2">
                        <input
                          ref={purposeEditInputRef}
                          value={purposeEditing.name}
                          onChange={(e) => setPurposeEditing({ ...purposeEditing, name: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') savePurposeEdit(); if (e.key === 'Escape') cancelPurposeEdit(); }}
                          disabled={purposeEditSaving}
                          className={inputClass}
                        />
                        <button type="button" onClick={savePurposeEdit} disabled={purposeEditSaving || !purposeEditing.name.trim()} className={btnPrimary}>
                          {purposeEditSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" onClick={cancelPurposeEdit} disabled={purposeEditSaving} className={btnSecondary}>Cancel</button>
                      </div>
                      {purposeEditError && <p className="text-xs text-rose-600 dark:text-rose-400">{purposeEditError}</p>}
                    </div>
                  ) : delPhase === 'checking' ? (
                    <span className="text-xs text-slate-400 dark:text-slate-500">Checking…</span>
                  ) : delPhase === 'confirm' || delPhase === 'deleting' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-xs text-slate-700 dark:text-slate-200">
                        Delete <span className="font-semibold">{purpose.name}</span>?
                      </span>
                      <button type="button" onClick={() => confirmPurposeDelete(purpose.id)} disabled={delPhase === 'deleting'} className={btnDangerSolid}>
                        {delPhase === 'deleting' ? 'Deleting…' : 'Delete'}
                      </button>
                      <button type="button" onClick={() => cancelPurposeDelete(purpose.id)} disabled={delPhase === 'deleting'} className={btnSecondary}>Cancel</button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`min-w-0 flex-1 truncate text-sm ${purpose.is_active ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 line-through dark:text-slate-500'}`}>
                        {purpose.name}
                      </span>
                      {!purpose.is_active && (
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-400">inactive</span>
                      )}
                      <button type="button" onClick={() => startPurposeEdit(purpose)} className={btnAction}>Edit</button>
                      <button
                        type="button"
                        onClick={() => togglePurposeActive(purpose)}
                        disabled={purposeToggling.has(purpose.id)}
                        className={`${btnAction} disabled:opacity-50`}
                      >
                        {purposeToggling.has(purpose.id) ? '…' : purpose.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button type="button" onClick={() => startPurposeDelete(purpose)} className={btnDanger}>Delete</button>
                    </div>
                  )}

                  {delMsg && !delPhase && (
                    <div className="mt-1 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300">
                      <span className="flex-1">{delMsg}</span>
                      <button type="button" onClick={() => cancelPurposeDelete(purpose.id)} aria-label="Dismiss" className="shrink-0 text-amber-500 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-200">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── Tags ──────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Tags</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {tags.length} tag{tags.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Create tag */}
        <div className="mb-4 space-y-1.5">
          <div className="flex gap-2">
            <input
              value={tagCreateName}
              onChange={(e) => setTagCreateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTag(); }}
              placeholder="New tag name…"
              disabled={tagCreating}
              className={inputClass}
            />
            <button type="button" onClick={handleCreateTag} disabled={tagCreating || !tagCreateName.trim()} className={btnPrimary}>
              {tagCreating ? 'Creating…' : 'Add'}
            </button>
          </div>
          {tagCreateError && <p className="text-xs text-rose-600 dark:text-rose-400">{tagCreateError}</p>}
        </div>

        {/* Search */}
        <div className="mb-3">
          <input
            value={tagSearch}
            onChange={(e) => setTagSearch(e.target.value)}
            placeholder="Search tags…"
            className={inputClass}
          />
        </div>

        {/* Tag list */}
        {tagsLoading ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">Loading…</p>
        ) : filteredTags.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
            {tagSearch ? 'No matching tags.' : 'No tags yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700/50">
            {filteredTags.map((tag) => {
              const delPhase = tagDelPhase[tag.id];
              const delMsg   = tagDelMsg[tag.id];
              const isEditingTag = tagEditing?.id === tag.id;

              return (
                <li key={tag.id} className="py-2">
                  {isEditingTag ? (
                    <div className="space-y-1.5">
                      <div className="flex gap-2">
                        <input
                          ref={tagEditInputRef}
                          value={tagEditing.name}
                          onChange={(e) => setTagEditing({ ...tagEditing, name: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveTagEdit(); if (e.key === 'Escape') cancelTagEdit(); }}
                          disabled={tagEditSaving}
                          className={inputClass}
                        />
                        <button type="button" onClick={saveTagEdit} disabled={tagEditSaving || !tagEditing.name.trim()} className={btnPrimary}>
                          {tagEditSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" onClick={cancelTagEdit} disabled={tagEditSaving} className={btnSecondary}>Cancel</button>
                      </div>
                      {tagEditError && <p className="text-xs text-rose-600 dark:text-rose-400">{tagEditError}</p>}
                    </div>
                  ) : delPhase === 'checking' ? (
                    <span className="text-xs text-slate-400 dark:text-slate-500">Checking…</span>
                  ) : delPhase === 'confirm' || delPhase === 'deleting' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-xs text-slate-700 dark:text-slate-200">
                        Delete <span className="font-semibold">{tag.name}</span>?
                      </span>
                      <button type="button" onClick={() => confirmTagDelete(tag.id)} disabled={delPhase === 'deleting'} className={btnDangerSolid}>
                        {delPhase === 'deleting' ? 'Deleting…' : 'Delete'}
                      </button>
                      <button type="button" onClick={() => cancelTagDelete(tag.id)} disabled={delPhase === 'deleting'} className={btnSecondary}>Cancel</button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`min-w-0 flex-1 truncate text-sm ${tag.is_active ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 line-through dark:text-slate-500'}`}>
                        {tag.name}
                      </span>
                      {!tag.is_active && (
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-400">inactive</span>
                      )}
                      <button type="button" onClick={() => startTagEdit(tag)} className={btnAction}>Edit</button>
                      <button
                        type="button"
                        onClick={() => toggleTagActive(tag)}
                        disabled={tagToggling.has(tag.id)}
                        className={`${btnAction} disabled:opacity-50`}
                      >
                        {tagToggling.has(tag.id) ? '…' : tag.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button type="button" onClick={() => startTagDelete(tag)} className={btnDanger}>Delete</button>
                    </div>
                  )}

                  {delMsg && !delPhase && (
                    <div className="mt-1 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300">
                      <span className="flex-1">{delMsg}</span>
                      <button type="button" onClick={() => cancelTagDelete(tag.id)} aria-label="Dismiss" className="shrink-0 text-amber-500 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-200">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── AI Prompts ────────────────────────────────────────────────── */}
      <AiPromptsCard />

    </div>
  );
}
