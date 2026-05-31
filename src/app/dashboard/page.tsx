'use client'

import { useEffect, useState } from 'react'
import { getCashFlows, getInventoryItemsWithValue, getDeals, getDealItems, getInventoryExpenses, } from '@/lib/supabase'

export default function DashboardPage() {
    const [cashFlows, setCashFlows] = useState<any[]>([])
    const [inventoryItems, setInventoryItems] = useState<any[]>([])
    const [deals, setDeals] = useState<any[]>([])
    const [dealItems, setDealItems] = useState<any[]>([])
    const [inventoryExpenses, setInventoryExpenses] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        async function loadData() {
            setLoading(true)

            const [cashFlowResult, inventoryResult, dealsResult, dealItemsResult, inventoryExpensesResult] = await Promise.all([
                getCashFlows(),
                getInventoryItemsWithValue(),
                getDeals(),
                getDealItems(),
                getInventoryExpenses()
            ])

            if (cashFlowResult.error || inventoryResult.error || dealsResult.error || dealItemsResult.error || inventoryExpensesResult.error) {
                setError('Could not load dashboard data.')
                setLoading(false)
                return
            }

            setCashFlows(cashFlowResult.data || [])
            setInventoryItems(inventoryResult.data || [])
            setDeals(dealsResult.data || [])
            setDealItems(dealItemsResult.data || [])
            setInventoryExpenses(inventoryExpensesResult.data || [])
            setLoading(false)
        }

        loadData()
    }, [])

    const activeInventory = inventoryItems.filter(
        (item) => item.status === 'owned' || item.status === 'listed'
    )

    const currentCash =
        cashFlows.length > 0 ? Number(cashFlows[0].closing_balance ?? 0) : 0

    const inventoryCostBasis = activeInventory.reduce(
        (sum, item) => sum + Number(item.value_in ?? 0),
        0
    )

    const inventoryEstimatedValue = activeInventory.reduce(
        (sum, item) => sum + Number(item.estimated_sold_value ?? 0),
        0
    )

    const inventoryEquity = inventoryEstimatedValue - inventoryCostBasis

    const formatMoney = (value: number) =>
        `$${value.toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
        })}`

    const valueInByItemId = Object.fromEntries(
        inventoryItems.map((item) => [item.id, Number(item.value_in ?? 0)])
    )

    const dealById = Object.fromEntries(
        deals.map((deal) => [deal.id, deal])
    )

    const monthlyRowsMap: Record<
        string,
        {
            month: string
            cashReceived: number
            profit: number
            expenses: number
        }
    > = {}

    cashFlows.forEach((row) => {
        const month = row.transaction_date?.slice(0, 7)
        if (!month) return

        monthlyRowsMap[month] ??= {
            month,
            cashReceived: 0,
            profit: 0,
            expenses: 0,
        }

        monthlyRowsMap[month].cashReceived += Number(row.cash_in ?? 0)
    })

    dealItems
        .filter((item) => item.direction === 'out')
        .forEach((item) => {
            const deal = dealById[item.deal_id]
            const month = deal?.deal_date?.slice(0, 7)
            if (!month) return

            monthlyRowsMap[month] ??= {
                month,
                cashReceived: 0,
                profit: 0,
                expenses: 0,
            }

            const soldValue = Number(item.total_value ?? 0)
            const valueIn = valueInByItemId[item.item_id] ?? 0

            monthlyRowsMap[month].profit += soldValue - valueIn
        })

    inventoryExpenses.forEach((expense) => {
        const month = expense.expense_date?.slice(0, 7)
        if (!month) return

        monthlyRowsMap[month] ??= {
            month,
            cashReceived: 0,
            profit: 0,
            expenses: 0,
        }

        monthlyRowsMap[month].expenses += Number(expense.amount ?? 0)
    })

    const monthlyRows = Object.values(monthlyRowsMap)
        .map((row) => ({
            ...row,
            netProfit: row.profit - row.expenses,
        }))
        .sort((a, b) => b.month.localeCompare(a.month))

    const monthlyCashReceived = cashFlows.reduce<Record<string, number>>(
        (months, row) => {
            const month = row.transaction_date?.slice(0, 7) ?? 'Unknown'

            months[month] = (months[month] ?? 0) + Number(row.cash_in ?? 0)

            return months
        },
        {}
    )

    const monthlyCashRows = Object.entries(monthlyCashReceived)
        .map(([month, cashReceived]) => ({
            month,
            cashReceived,
        }))
        .sort((a, b) => b.month.localeCompare(a.month))

    return (
        <div className="space-y-6">
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <p className="text-sm uppercase tracking-[0.3em] text-slate-500">
                    Dashboard
                </p>

                <h1 className="mt-2 text-3xl font-semibold text-slate-900">
                    Business overview
                </h1>

                <p className="mt-3 text-sm leading-6 text-slate-600">
                    Track cash, active inventory, estimated value, and inventory equity.
                </p>
            </section>

            {loading ? (
                <div className="rounded-3xl border border-slate-200 bg-white p-6 text-slate-600 shadow-sm">
                    Loading dashboard...
                </div>
            ) : error ? (
                <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-rose-700 shadow-sm">
                    {error}
                </div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
                            Cash Balance
                        </p>
                        <p className="mt-3 text-2xl font-semibold text-slate-900">
                            {formatMoney(currentCash)}
                        </p>
                    </div>

                    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
                            Active Inventory
                        </p>
                        <p className="mt-3 text-2xl font-semibold text-slate-900">
                            {activeInventory.length}
                        </p>
                    </div>

                    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
                            Cost Basis
                        </p>
                        <p className="mt-3 text-2xl font-semibold text-slate-900">
                            {formatMoney(inventoryCostBasis)}
                        </p>
                    </div>

                    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
                            Inventory Equity
                        </p>
                        <p className="mt-3 text-2xl font-semibold text-slate-900">
                            {formatMoney(inventoryEquity)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                            Est. value: {formatMoney(inventoryEstimatedValue)}
                        </p>
                    </div>
                </div>
            )}
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div>
                    <p className="text-sm uppercase tracking-[0.3em] text-slate-500">
                        Monthly performance
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-slate-900">
                        Monthly performance
                    </h2>
                </div>

                <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500">
                            <tr>
                                <th className="px-4 py-3">Month</th>
                                <th className="px-4 py-3 text-right">Cash Received</th>
                                <th className="px-4 py-3 text-right">Profit</th>
                                <th className="px-4 py-3 text-right">Expenses</th>
                                <th className="px-4 py-3 text-right">Net Profit</th>
                            </tr>
                        </thead>

                        <tbody className="divide-y divide-slate-100">
                           {monthlyRows.map((row) => (
                                <tr key={row.month}>
                                    <td className="px-4 py-3 font-medium text-slate-900">
                                        {row.month}
                                    </td>
                                    <td className="px-4 py-3 text-right text-slate-900">
                                        {formatMoney(row.cashReceived)}
                                    </td>
                                    <td className="px-4 py-3 text-right text-slate-900">
                                        {formatMoney(row.profit)}
                                    </td>
                                    <td className="px-4 py-3 text-right text-slate-900">
                                        {formatMoney(row.expenses)}
                                    </td>
                                    <td className="px-4 py-3 text-right text-slate-900">
                                        {formatMoney(row.netProfit)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>

    )
}