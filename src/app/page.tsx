'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getBrands, getCashFlows, getInventoryItemsWithValue, getDeals, getDealItems, getInventoryExpenses, getItemCategories, getItemSubtypes } from '@/lib/supabase'

export default function HomePage() {
  const router = useRouter()
  const [cashFlows, setCashFlows] = useState<any[]>([])
  const [inventoryItems, setInventoryItems] = useState<any[]>([])
  const [deals, setDeals] = useState<any[]>([])
  const [dealItems, setDealItems] = useState<any[]>([])
  const [inventoryExpenses, setInventoryExpenses] = useState<any[]>([])
  const [brands, setBrands] = useState<any[]>([])
  const [itemSubtypes, setItemSubtypes] = useState<any[]>([])
  const [itemCategoriesData, setItemCategoriesData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear())

  useEffect(() => {
    async function loadData() {
      setLoading(true)

      const [cashFlowResult, inventoryResult, dealsResult, dealItemsResult, inventoryExpensesResult, brandsResult, catsResult, subsResult] = await Promise.all([
        getCashFlows(),
        getInventoryItemsWithValue(),
        getDeals(),
        getDealItems(),
        getInventoryExpenses(),
        getBrands(),
        getItemCategories(),
        getItemSubtypes(),
      ])

      if (cashFlowResult.error || inventoryResult.error || dealsResult.error || dealItemsResult.error || inventoryExpensesResult.error || brandsResult.error) {
        setError('Could not load dashboard data.')
        setLoading(false)
        return
      }

      setCashFlows(cashFlowResult.data || [])
      setInventoryItems(inventoryResult.data || [])
      setDeals(dealsResult.data || [])
      setDealItems(dealItemsResult.data || [])
      setInventoryExpenses(inventoryExpensesResult.data || [])
      setBrands(brandsResult.data || [])
      setItemCategoriesData(catsResult.data || [])
      setItemSubtypes(subsResult.data || [])
      setLoading(false)
    }

    loadData()
  }, [])

  const activeInventory = inventoryItems.filter((item) => item.status === 'owned' || item.status === 'listed')
  const businessInventory = inventoryItems.filter((item) => item.collection_type === 'Business' || item.collection_type === 'Hybrid')

  const latestCashFlow = [...cashFlows].sort((a, b) => {
    const dateDiff = b.transaction_date.localeCompare(a.transaction_date)
    if (dateDiff !== 0) return dateDiff
    return b.id - a.id
  })[0]
  const currentCash = latestCashFlow ? Number(latestCashFlow.closing_balance ?? 0) : 0

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

  const availableYears = useMemo(() => {
    const yearSet = new Set(monthlyRows.map((row) => parseInt(row.month.slice(0, 4))))
    yearSet.add(new Date().getFullYear())
    return Array.from(yearSet).sort((a, b) => b - a)
  }, [monthlyRows])

  const filteredMonthlyRows = useMemo(
    () => monthlyRows.filter((row) => row.month.startsWith(String(selectedYear))),
    [monthlyRows, selectedYear]
  )

  const monthlyTotals = useMemo(
    () => ({
      cashReceived: filteredMonthlyRows.reduce((sum, r) => sum + r.cashReceived, 0),
      dealsCount: filteredMonthlyRows.reduce((sum, r) => sum + r.dealsCount, 0),
      profit: filteredMonthlyRows.reduce((sum, r) => sum + r.profit, 0),
    }),
    [filteredMonthlyRows]
  )

  const navigateToMonthOperations = (month: string) => {
    const [year, monthNumber] = month.split('-').map(Number)
    const lastDay = new Date(year, monthNumber, 0).getDate()
    router.push(`/operations?from=${month}-01&to=${month}-${String(lastDay).padStart(2, '0')}&dealTypes=sale,trade,purchase`)
  }

  const legacyTypeToCategory: Record<string, string> = {
    guitar: 'Guitars', bass: 'Guitars', 'acoustic guitar': 'Guitars',
    amp: 'Amps', cab: 'Amps', processor: 'Amps',
    pedal: 'Pedals',
    parts: 'Parts', pickups: 'Parts',
  }

  const categoryNameBySubtypeId = useMemo(() => {
    const catById: Record<number, string> = Object.fromEntries(
      itemCategoriesData.map((c: any) => [c.id, c.name])
    )
    return Object.fromEntries(
      itemSubtypes.map((s: any) => [s.id, catById[s.category_id] ?? ''])
    )
  }, [itemCategoriesData, itemSubtypes])

  const getItemCategoryName = (item: any): string => {
    if (item.item_subtype_id != null) {
      return categoryNameBySubtypeId[item.item_subtype_id] ?? legacyTypeToCategory[item.item_type?.toLowerCase()] ?? 'Other'
    }
    return legacyTypeToCategory[item.item_type?.toLowerCase()] ?? 'Other'
  }

  const inventoryCountByType = useMemo(() => {
    const counts: Record<string, number> = {}
    activeInventory.forEach((item) => {
      const cat = getItemCategoryName(item)
      counts[cat] = (counts[cat] ?? 0) + 1
    })
    return counts
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInventory, categoryNameBySubtypeId])

  const inventoryValueByType = useMemo(() => {
    const values: Record<string, { count: number; costBasis: number; estimatedValue: number }> = {}
    activeInventory.forEach((item) => {
      const cat = getItemCategoryName(item)
      if (!values[cat]) values[cat] = { count: 0, costBasis: 0, estimatedValue: 0 }
      values[cat].count += 1
      values[cat].costBasis += Number(item.value_in ?? 0)
      values[cat].estimatedValue += Number(item.estimated_sold_value ?? 0)
    })
    return values
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInventory, categoryNameBySubtypeId])

  const businessInventoryByType = useMemo(() => {
    const counts: Record<string, { listed: number; unlisted: number }> = {}
    businessInventory.forEach((item) => {
      const cat = getItemCategoryName(item)
      if (!counts[cat]) counts[cat] = { listed: 0, unlisted: 0 }
      if (item.status === 'listed') counts[cat].listed += 1
      else counts[cat].unlisted += 1
    })
    return counts
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessInventory, categoryNameBySubtypeId])

  const inventoryCountTypes = Object.keys(inventoryCountByType).sort()
  const inventoryValueTypes = Object.keys(inventoryValueByType).sort()
  const businessInventoryTypes = Object.keys(businessInventoryByType).sort()

  const totalInventoryCount = Object.values(inventoryCountByType).reduce((a, b) => a + b, 0)
  const totalCostBasis = Object.values(inventoryValueByType).reduce((sum, v) => sum + v.costBasis, 0)
  const totalEstimatedValue = Object.values(inventoryValueByType).reduce((sum, v) => sum + v.estimatedValue, 0)
  const totalBusinessListed = Object.values(businessInventoryByType).reduce((sum, v) => sum + v.listed, 0)
  const totalBusinessUnlisted = Object.values(businessInventoryByType).reduce((sum, v) => sum + v.unlisted, 0)

  const brandPerformance = useMemo(() => {
    const brandNameById: Record<number, string> = Object.fromEntries(
      brands.map((b: any) => [b.id, b.name])
    )

    // Most recent direction='in' deal_item per item (by deal_id)
    const inDealItemByItemId: Record<number, any> = {}
    dealItems.forEach((di) => {
      if (di.direction !== 'in') return
      const existing = inDealItemByItemId[di.item_id]
      if (!existing || di.deal_id > existing.deal_id) inDealItemByItemId[di.item_id] = di
    })

    // Most recent direction='out' deal_item per item (by deal_id)
    const outDealItemByItemId: Record<number, any> = {}
    dealItems.forEach((di) => {
      if (di.direction !== 'out') return
      const existing = outDealItemByItemId[di.item_id]
      if (!existing || di.deal_id > existing.deal_id) outDealItemByItemId[di.item_id] = di
    })

    const dealById: Record<number, any> = Object.fromEntries(deals.map((d) => [d.id, d]))

    const brandData: Record<number, {
      name: string
      items: { roi: number; profit: number; daysHeld: number }[]
    }> = {}

    inventoryItems.forEach((item) => {
      if (item.status !== 'sold' && item.status !== 'traded') return

      const valueIn = Number(item.value_in ?? 0)
      if (valueIn <= 0) return

      const outDi = outDealItemByItemId[item.id]
      if (!outDi) return
      const valueOut = Number(outDi.total_value ?? 0)

      const inDi = inDealItemByItemId[item.id]
      if (!inDi) return
      const acquisitionDeal = dealById[inDi.deal_id]
      if (!acquisitionDeal?.deal_date) return

      if (!item.sold_date) return

      const daysHeld = Math.round(
        (new Date(item.sold_date).getTime() - new Date(acquisitionDeal.deal_date).getTime()) /
        (1000 * 60 * 60 * 24)
      )
      if (daysHeld < 0) return

      const roi = ((valueOut - valueIn) / valueIn) * 100
      const profit = valueOut - valueIn
      const brandId = item.brand_id

      if (!brandData[brandId]) {
        brandData[brandId] = { name: brandNameById[brandId] ?? `Brand ${brandId}`, items: [] }
      }
      brandData[brandId].items.push({ roi, profit, daysHeld })
    })

    return Object.values(brandData)
      .filter((b) => b.items.length >= 2)
      .map((b) => {
        const soldQty = b.items.length
        const avgRoi = b.items.reduce((sum, i) => sum + i.roi, 0) / soldQty
        const avgProfit = b.items.reduce((sum, i) => sum + i.profit, 0) / soldQty
        const avgDaysHeld = Math.round(b.items.reduce((sum, i) => sum + i.daysHeld, 0) / soldQty)
        return { name: b.name, soldQty, avgRoi, avgProfit, avgDaysHeld }
      })
      .sort((a, b) => b.avgRoi - a.avgRoi)
      .slice(0, 15)
  }, [inventoryItems, dealItems, deals, brands])

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">Business overview</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          Track cash, inventory, and business performance.
        </p>
      </section>

      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">Loading dashboard...</div>
      ) : error ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-rose-700 shadow-sm">{error}</div>
      ) : (
        <>
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Current Inventory</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">By category</h2>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Cash Balance</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">{formatMoney(currentCash)}</p>
              </div>
            </div>
            <div className="mt-5 hidden overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3 text-right">Count</th>
                    <th className="px-4 py-3 text-right">Cost Basis</th>
                    <th className="px-4 py-3 text-right">Estimated Value</th>
                    <th className="px-4 py-3 text-right">Equity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {inventoryValueTypes.map((type) => {
                    const v = inventoryValueByType[type]
                    const equity = v.estimatedValue - v.costBasis
                    return (
                      <tr key={type}>
                        <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{type}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{v.count}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{formatMoney(v.costBasis)}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{formatMoney(v.estimatedValue)}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{formatMoney(equity)}</td>
                      </tr>
                    )
                  })}
                  <tr className="bg-slate-50 font-semibold dark:bg-slate-700">
                    <td className="px-4 py-3 text-slate-900 dark:text-white">Total</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{totalInventoryCount}</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{formatMoney(totalCostBasis)}</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{formatMoney(totalEstimatedValue)}</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{formatMoney(totalEstimatedValue - totalCostBasis)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-5 space-y-3 md:hidden">
              {inventoryValueTypes.map((type) => {
                const v = inventoryValueByType[type]
                const equity = v.estimatedValue - v.costBasis
                return (
                  <div key={type} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-semibold text-slate-900 dark:text-white">{type}</span>
                      <span className="text-sm text-slate-500 dark:text-slate-400">{v.count} items</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div>
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Cost Basis</span>
                        <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(v.costBasis)}</span>
                      </div>
                      <div>
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Est. Value</span>
                        <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(v.estimatedValue)}</span>
                      </div>
                      <div>
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Equity</span>
                        <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(equity)}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-slate-900 dark:text-white">Total</span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">{totalInventoryCount} items</span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Cost Basis</span>
                    <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(totalCostBasis)}</span>
                  </div>
                  <div>
                    <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Est. Value</span>
                    <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(totalEstimatedValue)}</span>
                  </div>
                  <div>
                    <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Equity</span>
                    <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(totalEstimatedValue - totalCostBasis)}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Monthly performance</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">Monthly performance</h2>
              </div>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              >
                {availableYears.map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </div>
            <div className="mt-5 hidden overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Month</th>
                    <th className="px-4 py-3 text-right">Cash Received</th>
                    <th className="px-4 py-3 text-right">Deals Count</th>
                    <th className="px-4 py-3 text-right">Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {filteredMonthlyRows.map((row) => (
                    <tr
                      key={row.month}
                      role="button"
                      tabIndex={0}
                      className="cursor-pointer transition hover:bg-slate-50 dark:hover:bg-slate-700"
                      onClick={() => navigateToMonthOperations(row.month)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          navigateToMonthOperations(row.month)
                        }
                      }}
                    >
                      <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{row.month}</td>
                      <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{formatMoney(row.cashReceived)}</td>
                      <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{row.dealsCount}</td>
                      <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{formatMoney(row.profit)}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold dark:bg-slate-700">
                    <td className="px-4 py-3 text-slate-900 dark:text-white">Total</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{formatMoney(monthlyTotals.cashReceived)}</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{monthlyTotals.dealsCount}</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{formatMoney(monthlyTotals.profit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-5 space-y-3 md:hidden">
              {filteredMonthlyRows.map((row) => (
                <button
                  key={row.month}
                  type="button"
                  onClick={() => navigateToMonthOperations(row.month)}
                  className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-semibold text-slate-900 dark:text-white">{row.month}</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-white">{formatMoney(row.profit)}</span>
                  </div>
                  <div className="flex gap-4 text-sm text-slate-500 dark:text-slate-400">
                    <span>Cash in: {formatMoney(row.cashReceived)}</span>
                    <span>Deals: {row.dealsCount}</span>
                  </div>
                </button>
              ))}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-semibold text-slate-900 dark:text-white">Total</span>
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">{formatMoney(monthlyTotals.profit)}</span>
                </div>
                <div className="flex gap-4 text-sm text-slate-500 dark:text-slate-400">
                  <span>Cash in: {formatMoney(monthlyTotals.cashReceived)}</span>
                  <span>Deals: {monthlyTotals.dealsCount}</span>
                </div>
              </div>
            </div>
          </section>
          {brandPerformance.length > 0 && (
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Brand Performance</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">Top brands by ROI</h2>
              </div>
              <div className="mt-5 hidden overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 md:block">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Brand</th>
                      <th className="px-4 py-3 text-right">Sold Qty</th>
                      <th className="px-4 py-3 text-right">Avg ROI</th>
                      <th className="px-4 py-3 text-right">Avg Profit</th>
                      <th className="px-4 py-3 text-right">Avg Days Held</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {brandPerformance.map((row) => (
                      <tr key={row.name}>
                        <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{row.name}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{row.soldQty}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{row.avgRoi.toFixed(1)}%</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{formatMoney(row.avgProfit)}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{row.avgDaysHeld}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-5 space-y-3 md:hidden">
                {brandPerformance.map((row) => (
                  <div key={row.name} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-semibold text-slate-900 dark:text-white">{row.name}</span>
                      <span className="text-sm text-slate-500 dark:text-slate-400">{row.soldQty} sold</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div>
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Avg ROI</span>
                        <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{row.avgRoi.toFixed(1)}%</span>
                      </div>
                      <div>
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Avg Profit</span>
                        <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(row.avgProfit)}</span>
                      </div>
                      <div>
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Avg Days</span>
                        <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{row.avgDaysHeld}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {businessInventoryTypes.length > 0 && (
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Business Inventory</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">Status by category</h2>
              </div>
              <div className="mt-5 hidden overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 md:block">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3 text-right">Listed</th>
                      <th className="px-4 py-3 text-right">Unlisted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {businessInventoryTypes.map((type) => {
                      const v = businessInventoryByType[type]
                      return (
                        <tr key={type}>
                          <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{type}</td>
                          <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{v.listed}</td>
                          <td className={`px-4 py-3 text-right font-semibold ${v.unlisted > 0 ? 'text-red-600' : 'text-slate-900 dark:text-slate-100'}`}>
                            {v.unlisted}
                          </td>
                        </tr>
                      )
                    })}
                    <tr className="bg-slate-50 font-semibold dark:bg-slate-700">
                      <td className="px-4 py-3 text-slate-900 dark:text-white">Total</td>
                      <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{totalBusinessListed}</td>
                      <td className={`px-4 py-3 text-right ${totalBusinessUnlisted > 0 ? 'text-red-600' : 'text-slate-900 dark:text-white'}`}>
                        {totalBusinessUnlisted}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="mt-5 space-y-3 md:hidden">
                {businessInventoryTypes.map((type) => {
                  const v = businessInventoryByType[type]
                  return (
                    <div key={type} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-900 dark:text-white">{type}</span>
                        <div className="flex gap-3 text-sm">
                          <span className="text-slate-500 dark:text-slate-400">Listed: <span className="font-semibold text-slate-900 dark:text-white">{v.listed}</span></span>
                          <span className={`font-semibold ${v.unlisted > 0 ? 'text-red-600' : 'text-slate-900 dark:text-white'}`}>Unlisted: {v.unlisted}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900 dark:text-white">Total</span>
                    <div className="flex gap-3 text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Listed: <span className="font-semibold text-slate-900 dark:text-white">{totalBusinessListed}</span></span>
                      <span className={`font-semibold ${totalBusinessUnlisted > 0 ? 'text-red-600' : 'text-slate-900 dark:text-white'}`}>Unlisted: {totalBusinessUnlisted}</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}