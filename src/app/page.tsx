'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCashFlows, getInventoryItemsWithValue, getDeals, getDealItems, getInventoryExpenses } from '@/lib/supabase'

export default function HomePage() {
  const router = useRouter()
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
        getInventoryExpenses(),
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

  const activeInventory = inventoryItems.filter((item) => item.status === 'owned' || item.status === 'listed')
  const businessInventory = inventoryItems.filter((item) => item.collection_type === 'Business' || item.collection_type === 'Hybrid')

  const currentCash = cashFlows.length > 0 ? Number(cashFlows[0].closing_balance ?? 0) : 0

  const inventoryCostBasis = activeInventory.reduce((sum, item) => sum + Number(item.value_in ?? 0), 0)
  const inventoryEstimatedValue = activeInventory.reduce((sum, item) => sum + Number(item.estimated_sold_value ?? 0), 0)
  const inventoryEquity = inventoryEstimatedValue - inventoryCostBasis

  const formatMoney = (value: number) =>
    `$${value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`

  const valueInByItemId = Object.fromEntries(
    inventoryItems.map((item) => [item.id, Number(item.value_in ?? 0)])
  )

  const dealItemsByDealId = dealItems.reduce<Record<number, any[]>>((map, item) => {
    map[item.deal_id] ??= []
    map[item.deal_id].push(item)
    return map
  }, {})

  const monthlyRowsMap: Record<string, { month: string; cashReceived: number; profit: number; expenses: number; dealsCount: number }> = {}

  const getMonthRow = (month: string) => {
    monthlyRowsMap[month] ??= { month, cashReceived: 0, profit: 0, expenses: 0, dealsCount: 0 }
    return monthlyRowsMap[month]
  }

  cashFlows.forEach((row) => {
    const month = row.transaction_date?.slice(0, 7)
    if (!month) return
    getMonthRow(month).cashReceived += Number(row.cash_in ?? 0)
  })

  deals.forEach((deal) => {
    const month = deal.deal_date?.slice(0, 7)
    if (!month) return
    if (!['sale', 'purchase', 'trade'].includes(deal.deal_type)) return

    getMonthRow(month).dealsCount += 1
    if (deal.deal_type !== 'sale' && deal.deal_type !== 'trade') return

    const items = dealItemsByDealId[deal.id] ?? []
    const outgoingItems = items.filter((item) => item.direction === 'out')
    const outgoingValue = outgoingItems.reduce((sum, item) => sum + Number(item.total_value ?? 0), 0)
    const outgoingCost = outgoingItems.reduce((sum, item) => sum + Number(valueInByItemId[item.item_id] ?? 0), 0)

    getMonthRow(month).profit += outgoingValue - outgoingCost
  })

  inventoryExpenses.forEach((expense) => {
    const month = expense.expense_date?.slice(0, 7)
    if (!month) return
    getMonthRow(month).expenses += Number(expense.amount ?? 0)
  })

  const monthlyRows = Object.values(monthlyRowsMap)
    .filter((row) => row.profit !== 0 || row.expenses !== 0)
    .sort((a, b) => b.month.localeCompare(a.month))

  const navigateToMonthOperations = (month: string) => {
    const [year, monthNumber] = month.split('-').map(Number)
    const lastDay = new Date(year, monthNumber, 0).getDate()
    router.push(`/operations?from=${month}-01&to=${month}-${String(lastDay).padStart(2, '0')}&dealTypes=sale,trade,purchase`)
  }

  const inventoryCountByType = useMemo(() => {
    const counts: Record<string, number> = {}
    activeInventory.forEach((item) => {
      counts[item.item_type] = (counts[item.item_type] ?? 0) + 1
    })
    return counts
  }, [activeInventory])

  const inventoryValueByType = useMemo(() => {
    const values: Record<string, { count: number; costBasis: number; estimatedValue: number }> = {}
    activeInventory.forEach((item) => {
      if (!values[item.item_type]) {
        values[item.item_type] = { count: 0, costBasis: 0, estimatedValue: 0 }
      }
      values[item.item_type].count += 1
      values[item.item_type].costBasis += Number(item.value_in ?? 0)
      values[item.item_type].estimatedValue += Number(item.estimated_sold_value ?? 0)
    })
    return values
  }, [activeInventory])

  const businessInventoryByType = useMemo(() => {
    const counts: Record<string, { listed: number; unlisted: number }> = {}
    businessInventory.forEach((item) => {
      if (!counts[item.item_type]) {
        counts[item.item_type] = { listed: 0, unlisted: 0 }
      }
      if (item.status === 'listed') {
        counts[item.item_type].listed += 1
      } else {
        counts[item.item_type].unlisted += 1
      }
    })
    return counts
  }, [businessInventory])

  const inventoryCountTypes = Object.keys(inventoryCountByType).sort()
  const inventoryValueTypes = Object.keys(inventoryValueByType).sort()
  const businessInventoryTypes = Object.keys(businessInventoryByType).sort()

  const totalInventoryCount = Object.values(inventoryCountByType).reduce((a, b) => a + b, 0)
  const totalCostBasis = Object.values(inventoryValueByType).reduce((sum, v) => sum + v.costBasis, 0)
  const totalEstimatedValue = Object.values(inventoryValueByType).reduce((sum, v) => sum + v.estimatedValue, 0)
  const totalBusinessListed = Object.values(businessInventoryByType).reduce((sum, v) => sum + v.listed, 0)
  const totalBusinessUnlisted = Object.values(businessInventoryByType).reduce((sum, v) => sum + v.unlisted, 0)

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900">Business overview</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Track cash, inventory, and business performance.
        </p>
      </section>

      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 text-slate-600 shadow-sm">Loading dashboard...</div>
      ) : error ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-rose-700 shadow-sm">{error}</div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Inventory Count</p>
              <p className="mt-3 text-2xl font-semibold text-slate-900">{activeInventory.length}</p>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Cash Balance</p>
              <p className="mt-3 text-2xl font-semibold text-slate-900">{formatMoney(currentCash)}</p>
            </div>
          </div>

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Inventory Count</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900">By item type</h2>
            </div>
            <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Item Type</th>
                    <th className="px-4 py-3 text-right">Count</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inventoryCountTypes.map((type) => (
                    <tr key={type}>
                      <td className="px-4 py-3 font-medium text-slate-900">{type}</td>
                      <td className="px-4 py-3 text-right text-slate-900">{inventoryCountByType[type]}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold">
                    <td className="px-4 py-3 text-slate-900">Total</td>
                    <td className="px-4 py-3 text-right text-slate-900">{totalInventoryCount}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Inventory Value</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900">By item type</h2>
            </div>
            <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Item Type</th>
                    <th className="px-4 py-3 text-right">Count</th>
                    <th className="px-4 py-3 text-right">Cost Basis</th>
                    <th className="px-4 py-3 text-right">Estimated Value</th>
                    <th className="px-4 py-3 text-right">Equity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inventoryValueTypes.map((type) => {
                    const v = inventoryValueByType[type]
                    const equity = v.estimatedValue - v.costBasis
                    return (
                      <tr key={type}>
                        <td className="px-4 py-3 font-medium text-slate-900">{type}</td>
                        <td className="px-4 py-3 text-right text-slate-900">{v.count}</td>
                        <td className="px-4 py-3 text-right text-slate-900">{formatMoney(v.costBasis)}</td>
                        <td className="px-4 py-3 text-right text-slate-900">{formatMoney(v.estimatedValue)}</td>
                        <td className="px-4 py-3 text-right text-slate-900">{formatMoney(equity)}</td>
                      </tr>
                    )
                  })}
                  <tr className="bg-slate-50 font-semibold">
                    <td className="px-4 py-3 text-slate-900">Total</td>
                    <td className="px-4 py-3 text-right text-slate-900">{Object.keys(inventoryValueByType).length}</td>
                    <td className="px-4 py-3 text-right text-slate-900">{formatMoney(totalCostBasis)}</td>
                    <td className="px-4 py-3 text-right text-slate-900">{formatMoney(totalEstimatedValue)}</td>
                    <td className="px-4 py-3 text-right text-slate-900">{formatMoney(totalEstimatedValue - totalCostBasis)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {businessInventoryTypes.length > 0 && (
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Business Inventory</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900">Status by item type</h2>
              </div>
              <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Item Type</th>
                      <th className="px-4 py-3 text-right">Listed</th>
                      <th className="px-4 py-3 text-right">Unlisted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {businessInventoryTypes.map((type) => {
                      const v = businessInventoryByType[type]
                      return (
                        <tr key={type}>
                          <td className="px-4 py-3 font-medium text-slate-900">{type}</td>
                          <td className="px-4 py-3 text-right text-slate-900">{v.listed}</td>
                          <td className={`px-4 py-3 text-right font-semibold ${v.unlisted > 0 ? 'text-red-600' : 'text-slate-900'}`}>
                            {v.unlisted}
                          </td>
                        </tr>
                      )
                    })}
                    <tr className="bg-slate-50 font-semibold">
                      <td className="px-4 py-3 text-slate-900">Total</td>
                      <td className="px-4 py-3 text-right text-slate-900">{totalBusinessListed}</td>
                      <td className={`px-4 py-3 text-right ${totalBusinessUnlisted > 0 ? 'text-red-600' : 'text-slate-900'}`}>
                        {totalBusinessUnlisted}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Monthly performance</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900">Monthly performance</h2>
            </div>
            <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Month</th>
                    <th className="px-4 py-3 text-right">Cash Received</th>
                    <th className="px-4 py-3 text-right">Deals Count</th>
                    <th className="px-4 py-3 text-right">Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {monthlyRows.map((row) => (
                    <tr
                    key={row.month}
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer transition hover:bg-slate-50"
                    onClick={() => navigateToMonthOperations(row.month)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        navigateToMonthOperations(row.month)
                      }
                    }}
                  >
                      <td className="px-4 py-3 font-medium text-slate-900">{row.month}</td>
                      <td className="px-4 py-3 text-right text-slate-900">{formatMoney(row.cashReceived)}</td>
                      <td className="px-4 py-3 text-right text-slate-900">{row.dealsCount}</td>
                      <td className="px-4 py-3 text-right text-slate-900">{formatMoney(row.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}