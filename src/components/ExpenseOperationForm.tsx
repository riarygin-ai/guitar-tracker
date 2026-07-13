'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createExpenseOperation, searchInventoryItems, getDisplayPhotosForItems } from '@/lib/supabase';
import type { InventorySearchItem } from '@/types';
import { todayLocalDate } from '@/lib/dateUtils';

export default function ExpenseOperationForm() {
    const router = useRouter();
    const [expenseDate, setExpenseDate] = useState('');
    const [amount, setAmount] = useState('');
    const [notes, setNotes] = useState('');

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});

    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [selectedItem, setSelectedItem] = useState<InventorySearchItem | null>(null)

    const [searchQuery, setSearchQuery] = useState('')
    const [searchResults, setSearchResults] = useState<InventorySearchItem[]>([])
    const [searching, setSearching] = useState(false)
    const [hasSearched, setHasSearched] = useState(false)



    const handleSearchChange = (value: string) => {
        setSearchQuery(value)

        if (searchTimerRef.current) {
            clearTimeout(searchTimerRef.current)
        }

        if (!value.trim()) {
            setSearchResults([])
            setHasSearched(false)
            return
        }

        searchTimerRef.current = setTimeout(async () => {
            setSearching(true)

            const result = await searchInventoryItems(value)

            setSearchResults(result.data ?? [])
            setHasSearched(true)
            setSearching(false)
            const found = result.data ?? [];
            if (found.length > 0) {
                getDisplayPhotosForItems(found.map((i: { id: number }) => i.id)).then((photos) =>
                    setPhotoByItemId((prev) => ({ ...prev, ...photos }))
                );
            }
        }, 300)
    }

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        setError(null);
        setSuccessMessage(null);

        if (!amount || Number(amount) <= 0) {
            setError('Amount must be greater than 0.');
            return;
        }

        if (!notes.trim()) {
            setError('Description is required.');
            return;
        }

        const today = todayLocalDate();
        if (expenseDate && expenseDate > today) {
            setError('Date cannot be in the future.');
            return;
        }

        setSaving(true);

        const parsedAmount = Number(amount)
        const expenseDateValue = expenseDate || today

        const result = await createExpenseOperation({
            expenseDate: expenseDateValue,
            amount: parsedAmount,
            notes: notes.trim(),
            itemId: selectedItem?.id ?? null,
            cfDescription: `Expense: ${notes.trim()}`,
        })

        setSaving(false);

        if (result.error) {
            setError('Could not save expense.');
            return;
        }

        setAmount('')
        setNotes('');
        setExpenseDate('');

        router.push('/operations');
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
                    Expense
                </h2>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                            Expense Date
                        </span>

                        <input
                            type="date"
                            value={expenseDate}
                            max={todayLocalDate()}
                            onChange={(e) => setExpenseDate(e.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                        />
                    </label>

                    <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                            Amount
                        </span>

                        <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                            placeholder="0.00"
                        />
                    </label>
                </div>
                {!selectedItem && (
                    <>
                        <div className="mt-4 space-y-2">
                            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                                Inventory Item (Optional)
                            </label>

                            <div className="relative">
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(event) => handleSearchChange(event.target.value)}
                                    placeholder="Search inventory..."
                                    className={`w-full rounded-2xl border border-slate-200 bg-white pl-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 ${searchQuery || searching ? 'pr-9' : 'pr-4'}`}
                                />
                                {searching ? (
                                    <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                                    </div>
                                ) : searchQuery ? (
                                    <button
                                        type="button"
                                        onClick={() => handleSearchChange('')}
                                        aria-label="Clear search"
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                        </svg>
                                    </button>
                                ) : null}
                            </div>
                        </div>

                        {hasSearched && searchResults.length > 0 && (
                            <div className="max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2 dark:border-slate-600 dark:bg-slate-700">
                                {searchResults.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedItem(item)
                                            setSearchQuery('')
                                            setSearchResults([])
                                            setHasSearched(false)
                                        }}
                                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-500 dark:bg-slate-600 dark:hover:bg-slate-500"
                                    >
                                        <div className="flex items-center gap-3">
                                            {photoByItemId[item.id] && (
                                                <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-600">
                                                    <Image src={photoByItemId[item.id]} alt={[item.year, item.brand_name, item.model].filter(Boolean).join(' ')} fill className="object-cover" unoptimized sizes="48px" />
                                                </div>
                                            )}
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-slate-900 dark:text-white">
                                                    {[item.year, item.brand_name, item.model].filter(Boolean).join(' ')}
                                                </p>

                                                <div className="mt-1 flex gap-2">
                                                    {item.condition && (
                                                        <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                            {item.condition}
                                                        </span>
                                                    )}

                                                    <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                        {item.item_subtype_name ?? ''}
                                                    </span>

                                                    <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                        {item.status}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {selectedItem && (
                    <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-700 dark:bg-red-900/20">
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex gap-4 min-w-0">
                                {photoByItemId[selectedItem.id] && (
                                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700">
                                        <Image src={photoByItemId[selectedItem.id]} alt={[selectedItem.year, selectedItem.brand_name, selectedItem.model].filter(Boolean).join(' ')} fill className="object-cover" unoptimized sizes="80px" />
                                    </div>
                                )}
                                <div className="min-w-0">
                                    <p className="text-xs uppercase tracking-[0.25em] text-emerald-700 dark:text-emerald-400">
                                        Selected item
                                    </p>

                                    <p className="mt-2 font-semibold text-slate-900 dark:text-white">
                                        {[selectedItem.year, selectedItem.brand_name, selectedItem.model]
                                            .filter(Boolean)
                                            .join(' ')}
                                    </p>

                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {selectedItem.condition && (
                                            <span className="rounded-lg bg-white px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                                                {selectedItem.condition}
                                            </span>
                                        )}

                                        <span className="rounded-lg bg-white px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                                            {selectedItem.item_subtype_name ?? ''}
                                        </span>

                                        <span className="rounded-lg bg-white px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                                            {selectedItem.status}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={() => {
                                    setSelectedItem(null)
                                    setSearchQuery('')
                                    setSearchResults([])
                                    setHasSearched(false)
                                }}
                                className="rounded-xl border border-emerald-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                            >
                                Change
                            </button>
                        </div>
                    </div>
                )}
                <div className="mt-4">
                    <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                            Description
                        </span>

                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={4}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                            placeholder="Tube replacement, owner withdrawal, amp repair..."
                        />
                    </label>
                </div>

                {error && (
                    <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                        {error}
                    </div>
                )}

                {successMessage && (
                    <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
                        {successMessage}
                    </div>
                )}

                <div className="mt-6 flex gap-3">
                    <button
                        type="submit"
                        disabled={saving}
                        className="rounded-2xl bg-slate-950 px-5 py-3 font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
                    >
                        {saving ? 'Saving...' : 'Save Expense'}
                    </button>
                </div>
            </section>
        </form>
    );
}
