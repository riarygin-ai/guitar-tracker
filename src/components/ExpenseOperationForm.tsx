'use client';

import { useRef, useState } from 'react';
import { createInventoryExpense, searchInventoryItems, createCashFlow, getLatestCashFlow, createDeal } from '@/lib/supabase';
import type { InventorySearchItem } from '@/types';

export default function ExpenseOperationForm() {
    const [expenseDate, setExpenseDate] = useState('');
    const [amount, setAmount] = useState('');
    const [notes, setNotes] = useState('');

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

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

            // console.log('Expense search:', {
            //     value,
            //     data: result.data,
            //     error: result.error,
            // })

            setSearchResults(result.data ?? [])
            setHasSearched(true)
            setSearching(false)
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

        setSaving(true);

        const parsedAmount = Number(amount)
        const expenseDateValue = expenseDate || new Date().toISOString().slice(0, 10)

        const dealResult = await createDeal({
            deal_type: 'expense',
            deal_date: expenseDateValue,
            channel: null,
            cash_received: 0,
            cash_paid: parsedAmount,
            fees: 0,
            notes: notes.trim(),
        })

        if (dealResult.error || !dealResult.data) {
            setSaving(false)
            setError('Could not create expense deal.')
            return
        }

        const deal = dealResult.data

        const result = await createInventoryExpense({
            deal_id: deal.id,
            item_id: selectedItem?.id ?? null,
            expense_date: expenseDateValue,
            amount: parsedAmount,
            notes: notes.trim(),
        })
        setSaving(false);

        if (result.error) {
            setError('Could not save expense.');
            return;
        }

        const latestCashFlowResult = await getLatestCashFlow()

        const openingBalance =
            latestCashFlowResult.data?.closing_balance != null
                ? Number(latestCashFlowResult.data.closing_balance)
                : 0

        const cashFlowResult = await createCashFlow({
            deal_id: deal.id,
            transaction_date: expenseDateValue,
            opening_balance: openingBalance,
            cash_in: 0,
            cash_out: parsedAmount,
            closing_balance: openingBalance - parsedAmount,
            description: notes.trim(),
        })

        if (cashFlowResult.error) {
            setError('Expense saved, but cash flow entry failed.')
            return
        }

        setAmount('');
        setNotes('');
        setExpenseDate('');

        setSelectedItem(null);
        setSearchQuery('');
        setSearchResults([]);
        setHasSearched(false);

        setSuccessMessage('Expense saved successfully.');
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-xl font-semibold text-slate-900">
                    Expense
                </h2>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700">
                            Expense Date
                        </span>

                        <input
                            type="date"
                            value={expenseDate}
                            onChange={(e) => setExpenseDate(e.target.value)}
                            className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                        />
                    </label>

                    <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700">
                            Amount
                        </span>

                        <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                            placeholder="0.00"
                        />
                    </label>
                </div>
                {!selectedItem && (
                    <>
                        <div className="mt-4 space-y-2">
                            <label className="text-sm font-medium text-slate-700">
                                Inventory Item (Optional)
                            </label>

                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(event) => handleSearchChange(event.target.value)}
                                placeholder="Search inventory..."
                                className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                            />
                        </div>

                        {hasSearched && searchResults.length > 0 && (
                            <div className="max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
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
                                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-slate-300 hover:bg-slate-50"
                                    >
                                        <p className="text-sm font-medium text-slate-900">
                                            {[item.year, item.brand_name, item.model].filter(Boolean).join(' ')}
                                        </p>

                                        <div className="mt-1 flex gap-2">
                                            {item.condition && (
                                                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                                                    {item.condition}
                                                </span>
                                            )}

                                            <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                                                {item.item_type}
                                            </span>

                                            <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                                                {item.status}
                                            </span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {selectedItem && (
                    <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-xs uppercase tracking-[0.25em] text-emerald-700">
                                    Selected item
                                </p>

                                <p className="mt-2 font-semibold text-slate-900">
                                    {[selectedItem.year, selectedItem.brand_name, selectedItem.model]
                                        .filter(Boolean)
                                        .join(' ')}
                                </p>

                                <div className="mt-2 flex flex-wrap gap-2">
                                    {selectedItem.condition && (
                                        <span className="rounded-lg bg-white px-2 py-0.5 text-xs text-slate-700">
                                            {selectedItem.condition}
                                        </span>
                                    )}

                                    <span className="rounded-lg bg-white px-2 py-0.5 text-xs text-slate-700">
                                        {selectedItem.item_type}
                                    </span>

                                    <span className="rounded-lg bg-white px-2 py-0.5 text-xs text-slate-700">
                                        {selectedItem.status}
                                    </span>
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
                                className="rounded-xl border border-emerald-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-emerald-100"
                            >
                                Change
                            </button>
                        </div>
                    </div>
                )}
                <div className="mt-4">
                    <label className="space-y-2">
                        <span className="text-sm font-medium text-slate-700">
                            Description
                        </span>

                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={4}
                            className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                            placeholder="Tube replacement, owner withdrawal, amp repair..."
                        />
                    </label>
                </div>

                {error && (
                    <div className="mt-4 rounded-2xl bg-red-50 p-4 text-red-700">
                        {error}
                    </div>
                )}

                {successMessage && (
                    <div className="mt-4 rounded-2xl bg-green-50 p-4 text-green-700">
                        {successMessage}
                    </div>
                )}

                <div className="mt-6 flex gap-3">
                    <button
                        type="submit"
                        disabled={saving}
                        className="rounded-2xl bg-slate-950 px-5 py-3 font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                        {saving ? 'Saving...' : 'Save Expense'}
                    </button>
                </div>
            </section>
        </form>
    );
}