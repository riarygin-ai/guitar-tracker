'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import InventoryForm from '@/components/InventoryForm'
import { createTradeOperation, getBrands, searchInventoryItems } from '@/lib/supabase'
import type { Brand, InventoryItem } from '@/types'

type TradeItem = {
    item: InventoryItem
    value: string
}

const channelOptions = [
    'Kijiji',
    'Marketplace',
    'Reverb',
    'Regular Buyer / Seller',
]

export default function TradeOperationForm() {
    const router = useRouter()
    const [brands, setBrands] = useState<Brand[]>([])

    const [outgoingItems, setOutgoingItems] = useState<TradeItem[]>([])
    const [showOutgoingForm, setShowOutgoingForm] = useState(false)

    const [incomingItems, setIncomingItems] = useState<TradeItem[]>([])
    const [showIncomingForm, setShowIncomingForm] = useState(false)

    const [incomingSearchQuery, setIncomingSearchQuery] = useState('')
    const [incomingSearchResults, setIncomingSearchResults] = useState<InventoryItem[]>([])
    const [incomingSearching, setIncomingSearching] = useState(false)
    const [incomingHasSearched, setIncomingHasSearched] = useState(false)

    const incomingSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const [searchQuery, setSearchQuery] = useState('')
    const [searchResults, setSearchResults] = useState<InventoryItem[]>([])
    const [searching, setSearching] = useState(false)
    const [hasSearched, setHasSearched] = useState(false)

    const [dealDate, setDealDate] = useState('')
    const [channel, setChannel] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [successMessage, setSuccessMessage] = useState<string | null>(null)

    const [saving, setSaving] = useState(false)

    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const [cashOut, setCashOut] = useState('')
    const [cashIn, setCashIn] = useState('')

    const brandMap = useMemo(
        () => Object.fromEntries(brands.map((brand) => [brand.id, brand.name])),
        [brands]
    )

    const formatItemLabel = (item: InventoryItem) => {
        const parts: string[] = []
        if (item.year) parts.push(String(item.year))
        const brandName = brandMap[item.brand_id]
        if (brandName) parts.push(brandName)
        if (item.model) parts.push(item.model)

        const label = parts.join(' ')
        return item.color ? `${label} — ${item.color}` : label
    }

    const outgoingTotal = outgoingItems.reduce((sum, tradeItem) => sum + Number(tradeItem.value || 0), 0)
    const incomingTotal = incomingItems.reduce((sum, tradeItem) => sum + Number(tradeItem.value || 0), 0)
    const cashOutTotal = Number(cashOut || 0)
    const cashInTotal = Number(cashIn || 0)

    const totalGiven = outgoingTotal + cashOutTotal
    const totalReceived = incomingTotal + cashInTotal
    const difference = totalReceived - totalGiven

    const isBalanced = difference === 0

    useEffect(() => {
        async function loadData() {
            const brandResult = await getBrands()

            if (brandResult.error) {
                setError('Could not load brands. Please try again.')
                return
            }

            setBrands(brandResult.data || [])
        }

        loadData()
    }, [])

    const handleSearchChange = (value: string) => {
        setSearchQuery(value)

        if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

        if (!value.trim()) {
            setSearchResults([])
            setHasSearched(false)
            return
        }

        searchTimerRef.current = setTimeout(async () => {
            setSearching(true)

            const result = await searchInventoryItems(value)
            const excludedIds = new Set([
                ...outgoingItems.map((t) => t.item.id),
                ...incomingItems.map((t) => t.item.id),
            ])
            const items = (result.data ?? []).filter((item) => !excludedIds.has(item.id))

            setSearchResults(items)
            setHasSearched(true)
            setSearching(false)
        }, 300)
    }

    const handleOutgoingItemCreated = async (item: InventoryItem) => {
        const brandResult = await getBrands()
        if (!brandResult.error) setBrands(brandResult.data || [])

        setOutgoingItems((current) => [
            ...current,
            {
                item,
                value: item.estimated_sold_value != null ? String(item.estimated_sold_value) : '',
            },
        ])
        setShowOutgoingForm(false)
        setSuccessMessage('Outgoing item created and selected.')
        setError(null)
    }

    const handleIncomingItemCreated = async (item: InventoryItem) => {
        const brandResult = await getBrands()

        if (!brandResult.error) {
            setBrands(brandResult.data || [])
        }

        setIncomingItems((current) => [
            ...current,
            {
                item,
                value:
                    item.estimated_sold_value != null
                        ? String(item.estimated_sold_value)
                        : '',
            },])

        setShowIncomingForm(false)
        setSuccessMessage('Incoming item created and selected.')
        setError(null)
    }

    const handleIncomingSearchChange = (value: string) => {
        setIncomingSearchQuery(value)

        if (incomingSearchTimerRef.current) {
            clearTimeout(incomingSearchTimerRef.current)
        }

        if (!value.trim()) {
            setIncomingSearchResults([])
            setIncomingHasSearched(false)
            return
        }

        incomingSearchTimerRef.current = setTimeout(async () => {
            setIncomingSearching(true)

            const result = await searchInventoryItems(value)
            const excludedIds = new Set([
                ...outgoingItems.map((t) => t.item.id),
                ...incomingItems.map((t) => t.item.id),
            ])
            const items = (result.data ?? []).filter((item) => !excludedIds.has(item.id))

            setIncomingSearchResults(items)
            setIncomingHasSearched(true)
            setIncomingSearching(false)
        }, 300)
    }

    async function handleSubmit() {
        setError(null)
        setSuccessMessage(null)

        if (outgoingItems.length === 0) {
            setError('Add at least one item you are giving.')
            return
        }

        if (incomingItems.length === 0) {
            setError('Add at least one item you received.')
            return
        }

        if (!channel) {
            setError('Select a channel.')
            return
        }

        for (const tradeItem of outgoingItems) {
            const parsedValue = Number(tradeItem.value || 0)

            if (Number.isNaN(parsedValue) || parsedValue <= 0) {
                setError('All outgoing item values must be greater than 0.')
                return
            }
        }

        const parsedCashOut = Number(cashOut || 0)
        const parsedCashIn = Number(cashIn || 0)

        if (Number.isNaN(parsedCashOut) || parsedCashOut < 0) {
            setError('Cash out must be 0 or greater.')
            return
        }

        if (Number.isNaN(parsedCashIn) || parsedCashIn < 0) {
            setError('Cash in must be 0 or greater.')
            return
        }

        const totalGiven = outgoingTotal + parsedCashOut
        // const totalReceived = incomingTotal   + parsedCashIn

        if (totalGiven !== totalReceived) {
            setError(
                'Trade must balance: value out + cash out must equal value in + cash in.'
            )
            return
        }

        setSaving(true)

        const dealDateValue = dealDate || new Date().toISOString().slice(0, 10)

        const describeItem = (item: InventoryItem) => {
            const brand = brandMap[item.brand_id]
            return brand ? `${brand} ${item.model}` : item.model
        }

        const firstOutgoingItem = outgoingItems[0]
        const firstIncomingItem = incomingItems[0]
        const cfDescription =
            firstOutgoingItem && firstIncomingItem
                ? `Trade: ${describeItem(firstOutgoingItem.item)} → ${describeItem(firstIncomingItem.item)}`
                : firstOutgoingItem
                    ? `Trade: ${describeItem(firstOutgoingItem.item)}`
                    : 'Trade cash adjustment'

        const result = await createTradeOperation({
            dealDate: dealDateValue,
            channel: channel || null,
            cashPaid: parsedCashOut,
            cashReceived: parsedCashIn,
            outgoingItems: outgoingItems.map((ti) => ({
                item_id: ti.item.id,
                total_value: Number(ti.value || 0),
            })),
            incomingItems: incomingItems.map((ti) => ({
                item_id: ti.item.id,
                total_value: Number(ti.value || 0),
            })),
            cfDescription: parsedCashOut > 0 || parsedCashIn > 0 ? cfDescription : null,
        })

        setSaving(false)

        if (result.error) {
            setError('Could not save trade.')
            return
        }

        router.push('/operations')
    }

    return (
        <div className="space-y-6">
            <div className="grid gap-6">
                {/* What I give */}
                <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                    <h3 className="text-lg font-semibold text-slate-900 dark:text-white">What I give</h3>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                        Search existing inventory items going out.
                    </p>

                    <div className="mt-5 space-y-4">
                        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Search inventory</label>

                        <div className="relative">
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(event) => handleSearchChange(event.target.value)}
                                placeholder="Search by brand, model, year, or color..."
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

                        {hasSearched && searchResults.length === 0 && (
                            <p className="text-sm text-slate-500 dark:text-slate-400">No items found.</p>
                        )}

                        {searchResults.length > 0 && (
                            <div className="max-h-64 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-600 dark:bg-slate-700">
                                {searchResults.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => {
                                            setOutgoingItems((current) => [
                                                ...current,
                                                {
                                                    item,
                                                    value:
                                                        item.estimated_sold_value != null
                                                            ? String(item.estimated_sold_value)
                                                            : '',
                                                },
                                            ])

                                            setSearchQuery('')
                                            setSearchResults([])
                                            setHasSearched(false)
                                        }}
                                        className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-500 dark:bg-slate-600 dark:hover:bg-slate-500"
                                    >
                                        <p className="text-sm font-medium text-slate-900 dark:text-white">
                                            {formatItemLabel(item)}
                                        </p>

                                        <div className="mt-1 flex flex-wrap gap-2">
                                            {item.condition && (
                                                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                    {item.condition}
                                                </span>
                                            )}

                                            <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                {item.item_type}
                                            </span>

                                            <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                {item.status}
                                            </span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}

                        {outgoingItems.length > 0 && (
                            <div className="space-y-3">
                                {outgoingItems.map((tradeItem, index) => (
                                    <div
                                        key={`${tradeItem.item.id}-${index}`}
                                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-700"
                                    >
                                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                                                    {formatItemLabel(tradeItem.item)}
                                                </p>

                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300">
                                                        {tradeItem.item.status}
                                                    </span>

                                                    {tradeItem.item.condition && (
                                                        <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-600 dark:text-slate-300">
                                                            {tradeItem.item.condition}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex w-full gap-2 sm:w-48">
                                                <div className="flex-1">
                                                    <label className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                                                        Value out
                                                    </label>

                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        min="0"
                                                        value={tradeItem.value}
                                                        onChange={(event) => {
                                                            const value = event.target.value

                                                            setOutgoingItems((current) =>
                                                                current.map((entry, entryIndex) =>
                                                                    entryIndex === index ? { ...entry, value } : entry
                                                                )
                                                            )
                                                        }}
                                                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-600"
                                                        placeholder="0.00"
                                                    />
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setOutgoingItems((current) =>
                                                            current.filter((_, entryIndex) => entryIndex !== index)
                                                        )
                                                    }}
                                                    className="mt-7 h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-500 dark:bg-slate-600 dark:text-slate-300 dark:hover:bg-slate-500"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {showOutgoingForm ? (
                            <>
                                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-600 dark:bg-slate-700">
                                    <InventoryForm
                                        onCreated={handleOutgoingItemCreated}
                                        hideHeader
                                        hideSidebar
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setShowOutgoingForm(false)}
                                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setShowOutgoingForm(true)}
                                className="rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
                            >
                                Add item
                            </button>
                        )}

                        <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Cash out</label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={cashOut}
                                onChange={(event) => setCashOut(event.target.value)}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                                placeholder="0.00"
                            />
                        </div>
                    </div>
                </section>

                {/* What I receive */}
                <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                    <h3 className="text-lg font-semibold text-slate-900 dark:text-white">What I receive</h3>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                        Search existing received items or create new ones.
                    </p>

                    <div className="mt-5 space-y-4">
                        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                            Search existing received item
                        </label>

                        <div className="relative">
                            <input
                                type="text"
                                value={incomingSearchQuery}
                                onChange={(event) => handleIncomingSearchChange(event.target.value)}
                                placeholder="Search existing item..."
                                className={`w-full rounded-2xl border border-slate-200 bg-white pl-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 ${incomingSearchQuery || incomingSearching ? 'pr-9' : 'pr-4'}`}
                            />
                            {incomingSearching ? (
                                <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                                </div>
                            ) : incomingSearchQuery ? (
                                <button
                                    type="button"
                                    onClick={() => handleIncomingSearchChange('')}
                                    aria-label="Clear search"
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                    </svg>
                                </button>
                            ) : null}
                        </div>

                        {incomingHasSearched && incomingSearchResults.length === 0 && (
                            <p className="text-sm text-slate-500 dark:text-slate-400">No existing items found.</p>
                        )}

                        {incomingSearchResults.length > 0 && (
                            <div className="max-h-64 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-600 dark:bg-slate-700">
                                {incomingSearchResults.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => {
                                            setIncomingItems((current) => [
                                                ...current,
                                                {
                                                    item,
                                                    value:
                                                        item.estimated_sold_value != null
                                                            ? String(item.estimated_sold_value)
                                                            : '',
                                                },
                                            ])

                                            setIncomingSearchQuery('')
                                            setIncomingSearchResults([])
                                            setIncomingHasSearched(false)
                                        }}
                                        className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-500 dark:bg-slate-600 dark:hover:bg-slate-500"
                                    >
                                        <p className="text-sm font-medium text-slate-900 dark:text-white">
                                            {formatItemLabel(item)}
                                        </p>
                                        <div className="mt-1 flex flex-wrap gap-2">
                                            {item.condition && (
                                                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                    {item.condition}
                                                </span>
                                            )}
                                            <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                {item.item_type}
                                            </span>
                                            <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                                {item.status}
                                            </span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}

                        {showIncomingForm ? (
                            <>
                                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-600 dark:bg-slate-700">
                                    <InventoryForm
                                        onCreated={handleIncomingItemCreated}
                                        hideHeader
                                        hideSidebar
                                    />
                                </div>

                                <button
                                    type="button"
                                    onClick={() => setShowIncomingForm(false)}
                                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setShowIncomingForm(true)}
                                className="rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
                            >
                                Add item
                            </button>
                        )}

                        {incomingItems.length > 0 && (
                            <div className="space-y-3">
                                {incomingItems.map((tradeItem, index) => (
                                    <div
                                        key={`${tradeItem.item.id}-${index}`}
                                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-700"
                                    >
                                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                            <div>
                                                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                                                    {formatItemLabel(tradeItem.item)}
                                                </p>

                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300">
                                                        {tradeItem.item.status}
                                                    </span>

                                                    {tradeItem.item.condition && (
                                                        <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-600 dark:text-slate-300">
                                                            {tradeItem.item.condition}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex w-full gap-2 sm:w-48">
                                                <div className="flex-1">
                                                    <label className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                                                        Value in
                                                    </label>

                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        min="0"
                                                        value={tradeItem.value}
                                                        onChange={(event) => {
                                                            const value = event.target.value

                                                            setIncomingItems((current) =>
                                                                current.map((entry, entryIndex) =>
                                                                    entryIndex === index ? { ...entry, value } : entry
                                                                )
                                                            )
                                                        }}
                                                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-600"
                                                        placeholder="0.00"
                                                    />
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setIncomingItems((current) =>
                                                            current.filter((_, entryIndex) => entryIndex !== index)
                                                        )
                                                    }}
                                                    className="mt-7 h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-500 dark:bg-slate-600 dark:text-slate-300 dark:hover:bg-slate-500"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Cash in</label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={cashIn}
                                onChange={(event) => setCashIn(event.target.value)}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                                placeholder="0.00"
                            />
                        </div>
                    </div>
                </section>
            </div>

            <form className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                <div className="grid gap-6 lg:grid-cols-3">
                    <div className="space-y-6 lg:col-span-2">
                        <div className="space-y-3">
                            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Deal date</label>
                            <input
                                type="date"
                                value={dealDate}
                                onChange={(event) => setDealDate(event.target.value)}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                            />
                            <p className="text-xs text-slate-500 dark:text-slate-400">Optional. If empty, today&apos;s date will be used.</p>
                        </div>

                        <div className="space-y-3">
                            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Channel</label>
                            <select
                                value={channel}
                                onChange={(event) => setChannel(event.target.value)}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                            >
                                <option value="">Select channel</option>
                                {channelOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="space-y-5 rounded-3xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-600 dark:bg-slate-700">
                        <p className="text-sm font-semibold text-slate-900 dark:text-white">Trade summary</p>

                        <div className="grid gap-3 text-sm text-slate-600">
                            <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Total given</p>
                                <p className="mt-2 font-semibold text-slate-900 dark:text-white">${totalGiven.toFixed(2)}</p>
                            </div>

                            <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Total received</p>
                                <p className="mt-2 font-semibold text-slate-900 dark:text-white">${totalReceived.toFixed(2)}</p>
                            </div>

                            <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Trade balance</p>
                                <p className={`mt-2 font-semibold ${isBalanced ? 'text-emerald-700' : 'text-rose-700'}`}>
                                    {isBalanced ? 'Balanced' : `Off by $${Math.abs(difference).toFixed(2)}`}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {error && (
                    <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                        {error}
                    </div>
                )}

                {successMessage && (
                    <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
                        {successMessage}
                    </div>
                )}

                {!isBalanced && (outgoingItems.length > 0 || incomingItems.length > 0) && (
                    <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                        Trade must be balanced before saving.
                    </div>
                )}

                <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                    <button
                        type="button"
                        onClick={() => {
                            setOutgoingItems([])
                            setIncomingItems([])
                            setIncomingSearchQuery('')
                            setIncomingSearchResults([])
                            setIncomingHasSearched(false)
                            setShowIncomingForm(false)
                            setShowOutgoingForm(false)
                            setSearchQuery('')
                            setSearchResults([])
                            setHasSearched(false)
                            setDealDate('')
                            setChannel('')
                            setError(null)
                            setSuccessMessage(null)
                            setCashOut('')
                            setCashIn('')
                        }}
                        className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 text-sm font-medium text-slate-900 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
                    >
                        Reset
                    </button>

                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={saving || !isBalanced}
                        className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
                    >
                        {saving ? 'Saving...' : 'Save trade'}
                    </button>
                </div>
            </form>
        </div>
    )
}
