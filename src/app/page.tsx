'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase, getBrands, getCashFlows, getInventoryItemsWithValue, getDeals, getDealItems, getInventoryExpenses, getItemCategories, getItemPurposes, getItemSubtypes, getAllListedDates, getLatestCompletedAnalyticsRun, getLatestAdviceForRun } from '@/lib/supabase'
import type { AnalyticsRunMeta } from '@/types'
import type { AnalyticsRunAdviceRow } from '@/lib/analytics/advice/types'
import { formatConfidence, formatDateTime as formatAdviceDateTime, formatPriority, humanizeCode } from '@/lib/analytics/advice/presentation'

export default function HomePage() {
  const router = useRouter()
  const [cashFlows, setCashFlows] = useState<any[]>([])
  const [inventoryItems, setInventoryItems] = useState<any[]>([])
  const [deals, setDeals] = useState<any[]>([])
  const [dealItems, setDealItems] = useState<any[]>([])
  const [inventoryExpenses, setInventoryExpenses] = useState<any[]>([])
  // Earliest platform listing date per item, across all deal_channels — id -> 'YYYY-MM-DD'
  const [earliestListedById, setEarliestListedById] = useState<Record<number, string>>({})
  const [brands, setBrands] = useState<any[]>([])
  const [itemSubtypes, setItemSubtypes] = useState<any[]>([])
  const [itemCategoriesData, setItemCategoriesData] = useState<any[]>([])
  const [itemPurposes, setItemPurposes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear())
  const [inventoryGroupView, setInventoryGroupView] = useState<'category' | 'type' | 'purpose'>('category')

  // ── Latest Analytics Advice (Auditable AI Advice v1.0) ──────────────────
  // Deliberately its own independent fetch, separate from the main
  // Promise.all above — the rest of the Dashboard must never wait on (or
  // fail because of) analytics/advice availability.
  const [latestRun, setLatestRun] = useState<AnalyticsRunMeta | null>(null)
  const [latestAdvice, setLatestAdvice] = useState<AnalyticsRunAdviceRow | null>(null)
  const [adviceLoading, setAdviceLoading] = useState(true)
  const [adviceActionBusy, setAdviceActionBusy] = useState(false)
  const [adviceActionError, setAdviceActionError] = useState<string | null>(null)

  async function loadLatestAdvice() {
    setAdviceLoading(true)
    const { data: run } = await getLatestCompletedAnalyticsRun()
    const runMeta = (run as AnalyticsRunMeta | null) ?? null
    setLatestRun(runMeta)
    if (runMeta) {
      const { data: advice } = await getLatestAdviceForRun(runMeta.id)
      setLatestAdvice((advice as unknown as AnalyticsRunAdviceRow | null) ?? null)
    } else {
      setLatestAdvice(null)
    }
    setAdviceLoading(false)
  }

  useEffect(() => {
    loadLatestAdvice()
  }, [])

  async function handleDashboardAdviceAction() {
    if (!latestRun) return
    setAdviceActionBusy(true)
    setAdviceActionError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Not authenticated — please sign in again.')
      const res = await fetch(`/api/analytics/runs/${latestRun.id}/advice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      await loadLatestAdvice()
      if (!res.ok && res.status !== 502) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(typeof payload.error === 'string' ? payload.error : `Server error (${res.status})`)
      }
    } catch (err) {
      setAdviceActionError(err instanceof Error ? err.message : 'Could not generate advice.')
    } finally {
      setAdviceActionBusy(false)
    }
  }

  useEffect(() => {
    async function loadData() {
      setLoading(true)

      // ── DIAGNOSTICS (temporary) ──────────────────────────────────────────────
      // Remove once the multi-user data leak is confirmed fixed.
      const { data: { user: authUser } } = await supabase.auth.getUser()
      const { data: dbCtx } = await supabase.rpc('debug_auth_context')
      console.group('[Dashboard] Auth + RLS diagnostics')
      console.log('auth.email       :', authUser?.email ?? '(none)')
      console.log('auth.id (JWT uid):', authUser?.id ?? '(none)')
      console.log('DB context       :', dbCtx)
      console.groupEnd()
      // ────────────────────────────────────────────────────────────────────────

      const [cashFlowResult, inventoryResult, dealsResult, dealItemsResult, inventoryExpensesResult, brandsResult, catsResult, subsResult, purposesResult, listedDatesResult] = await Promise.all([
        getCashFlows(),
        getInventoryItemsWithValue(),
        getDeals(),
        getDealItems(),
        getInventoryExpenses(),
        getBrands(),
        getItemCategories(),
        getItemSubtypes(),
        getItemPurposes(),
        getAllListedDates(),
      ])

      // ── DIAGNOSTICS (temporary) ──────────────────────────────────────────────
      console.group('[Dashboard] Query row counts')
      console.log('inventory_items_with_value :', inventoryResult.data?.length ?? 'error', inventoryResult.error?.message ?? '')
      console.log('deals                      :', dealsResult.data?.length ?? 'error', dealsResult.error?.message ?? '')
      console.log('deal_items                 :', dealItemsResult.data?.length ?? 'error', dealItemsResult.error?.message ?? '')
      console.log('cash_flow                  :', cashFlowResult.data?.length ?? 'error', cashFlowResult.error?.message ?? '')
      console.log('inventory_expenses         :', inventoryExpensesResult.data?.length ?? 'error', inventoryExpensesResult.error?.message ?? '')
      const activeRows = (inventoryResult.data ?? []).filter((i: any) => i.status === 'owned' || i.status === 'listed')
      const estValue = activeRows.reduce((s: number, i: any) => s + Number(i.estimated_sold_value ?? 0), 0)
      const costBasis = activeRows.reduce((s: number, i: any) => s + Number(i.value_in ?? 0), 0)
      console.log('active items               :', activeRows.length, '→ est_value', estValue, 'cost_basis', costBasis)
      console.groupEnd()
      // ────────────────────────────────────────────────────────────────────────

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
      if (!purposesResult.error) setItemPurposes(purposesResult.data || [])
      if (!listedDatesResult.error) {
        const earliest: Record<number, string> = {}
        for (const row of listedDatesResult.data || []) {
          const itemId = row.inventory_item_id as number
          const listedAt = row.listed_at as string
          if (!earliest[itemId] || listedAt < earliest[itemId]) earliest[itemId] = listedAt
        }
        setEarliestListedById(earliest)
      }
      setLoading(false)
    }

    loadData()
  }, [])

  const activeInventory = inventoryItems.filter((item) => item.status === 'owned' || item.status === 'listed')
  const businessInventory = inventoryItems.filter((item) => item.purpose_name === 'Business' || item.purpose_name === 'Hybrid')

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

  const formatMonthLabel = (month: string) => {
    const [year, m] = month.split('-')
    return new Date(Number(year), Number(m) - 1, 1).toLocaleDateString('en-US', {
      month: 'short', year: 'numeric',
    })
  }

  const valueInByItemId = Object.fromEntries(
    inventoryItems.map((item) => [item.id, Number(item.value_in ?? 0)])
  )

  const expensesByItemId: Record<number, number> = {}
  for (const exp of inventoryExpenses) {
    if (exp.item_id != null) expensesByItemId[exp.item_id] = (expensesByItemId[exp.item_id] ?? 0) + Number(exp.amount ?? 0)
  }

  const dealItemsByDealId = dealItems.reduce<Record<number, any[]>>((map, item) => {
    map[item.deal_id] ??= []
    map[item.deal_id].push(item)
    return map
  }, {})

  const monthlyRowsMap: Record<string, { month: string; cashReceived: number; profit: number; dealsCount: number }> = {}

  const getMonthRow = (month: string) => {
    monthlyRowsMap[month] ??= { month, cashReceived: 0, profit: 0, dealsCount: 0 }
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
    const outgoingExpenses = outgoingItems.reduce((sum, item) => sum + (expensesByItemId[item.item_id] ?? 0), 0)

    getMonthRow(month).profit += outgoingValue - outgoingCost - outgoingExpenses
  })

  const monthlyRows = Object.values(monthlyRowsMap)
    .filter((row) => row.profit !== 0)
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

  const bestMonthRow = useMemo(
    () =>
      filteredMonthlyRows.length > 0
        ? filteredMonthlyRows.reduce((best, row) => (row.profit > best.profit ? row : best))
        : null,
    [filteredMonthlyRows],
  )

  const navigateToMonthOperations = (month: string) => {
    const [year, monthNumber] = month.split('-').map(Number)
    const lastDay = new Date(year, monthNumber, 0).getDate()
    router.push(`/operations?from=${month}-01&to=${month}-${String(lastDay).padStart(2, '0')}&dealTypes=sale,trade,purchase`)
  }

  const navigateToBrandOperations = (brandId: number) => {
    router.push(`/operations?brand_id=${brandId}`)
  }

  const navigateToInventory = (key: string) => {
    const params = new URLSearchParams({ status: 'owned,listed' })
    if (inventoryGroupView === 'category') params.set('category', key)
    else if (inventoryGroupView === 'type') params.set('type', key)
    else if (inventoryGroupView === 'purpose') {
      const purposeId = purposeIdByName[key]
      if (purposeId) params.set('purpose_id', String(purposeId))
    }
    router.push(`/inventory?${params.toString()}`)
  }

  const categoryNameBySubtypeId = useMemo(() => {
    const catById: Record<number, string> = Object.fromEntries(
      itemCategoriesData.map((c: any) => [c.id, c.name])
    )
    return Object.fromEntries(
      itemSubtypes.map((s: any) => [s.id, catById[s.category_id] ?? ''])
    )
  }, [itemCategoriesData, itemSubtypes])

  const subtypeNameById = useMemo(
    () => Object.fromEntries(itemSubtypes.map((s: any) => [s.id, s.name])),
    [itemSubtypes],
  )

  const getItemSubtypeName = (item: any): string => {
    return subtypeNameById[item.item_subtype_id] ?? 'Unknown Type'
  }

  const getItemCategoryName = (item: any): string => {
    return categoryNameBySubtypeId[item.item_subtype_id] ?? 'Other'
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

  const inventoryBySubtype = useMemo(() => {
    const values: Record<string, { count: number; costBasis: number; estimatedValue: number }> = {}
    activeInventory.forEach((item) => {
      const key = getItemSubtypeName(item)
      if (!values[key]) values[key] = { count: 0, costBasis: 0, estimatedValue: 0 }
      values[key].count += 1
      values[key].costBasis += Number(item.value_in ?? 0)
      values[key].estimatedValue += Number(item.estimated_sold_value ?? 0)
    })
    return values
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInventory, subtypeNameById])

  const purposeIdByName = useMemo(
    () => Object.fromEntries(itemPurposes.map((p: any) => [p.name, p.id as number])),
    [itemPurposes],
  )

  const inventoryByPurpose = useMemo(() => {
    const values: Record<string, { count: number; costBasis: number; estimatedValue: number }> = {}
    activeInventory.forEach((item) => {
      const key = (item.purpose_name as string | null) ?? 'Unassigned'
      if (!values[key]) values[key] = { count: 0, costBasis: 0, estimatedValue: 0 }
      values[key].count += 1
      values[key].costBasis += Number(item.value_in ?? 0)
      values[key].estimatedValue += Number(item.estimated_sold_value ?? 0)
    })
    return values
  }, [activeInventory])

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

  // Active group data for the segmented inventory table
  const activeGroupData =
    inventoryGroupView === 'type'    ? inventoryBySubtype :
    inventoryGroupView === 'purpose' ? inventoryByPurpose :
    inventoryValueByType
  const activeGroupLabel =
    inventoryGroupView === 'type'    ? 'Type' :
    inventoryGroupView === 'purpose' ? 'Purpose' :
    'Category'
  const activeGroupRows  = Object.keys(activeGroupData).sort()
  const activeGroupTotal = Object.values(activeGroupData).reduce(
    (acc, v) => ({ count: acc.count + v.count, costBasis: acc.costBasis + v.costBasis, estimatedValue: acc.estimatedValue + v.estimatedValue }),
    { count: 0, costBasis: 0, estimatedValue: 0 },
  )

  const brandPerformance = useMemo(() => {
    const brandNameById: Record<number, string> = Object.fromEntries(
      brands.map((b: any) => [b.id, b.name])
    )

    const inDealItemByItemId: Record<number, any> = {}
    dealItems.forEach((di) => {
      if (di.direction !== 'in') return
      const existing = inDealItemByItemId[di.item_id]
      if (!existing || di.deal_id > existing.deal_id) inDealItemByItemId[di.item_id] = di
    })

    const outDealItemByItemId: Record<number, any> = {}
    dealItems.forEach((di) => {
      if (di.direction !== 'out') return
      const existing = outDealItemByItemId[di.item_id]
      if (!existing || di.deal_id > existing.deal_id) outDealItemByItemId[di.item_id] = di
    })

    const dealById: Record<number, any> = Object.fromEntries(deals.map((d) => [d.id, d]))

    const brandData: Record<number, {
      id: number
      name: string
      items: { roi: number; profit: number; daysOnMarket: number | null }[]
    }> = {}

    inventoryItems.forEach((item) => {
      if (item.status !== 'sold' && item.status !== 'traded') return

      const valueIn = Number(item.value_in ?? 0)

      const outDi = outDealItemByItemId[item.id]
      if (!outDi) return
      const valueOut = Number(outDi.total_value ?? 0)

      const inDi = inDealItemByItemId[item.id]
      if (!inDi) return

      if (!item.sold_date) return

      // days on market = sold_date - earliest platform listed_at; null when no platform date exists
      const listedAt = earliestListedById[item.id]
      const daysOnMarket = listedAt
        ? Math.round(
            (new Date(item.sold_date).getTime() - new Date(listedAt).getTime()) /
            (1000 * 60 * 60 * 24)
          )
        : null
      if (daysOnMarket !== null && daysOnMarket < 0) return

      const itemExpenses = expensesByItemId[item.id] ?? 0
      const profit = valueOut - valueIn - itemExpenses
      const roi = valueIn === 0 ? (profit > 0 ? 100 : 0) : (profit / valueIn) * 100
      const brandId = item.brand_id

      if (!brandData[brandId]) {
        brandData[brandId] = { id: brandId, name: brandNameById[brandId] ?? `Brand ${brandId}`, items: [] }
      }
      brandData[brandId].items.push({ roi, profit, daysOnMarket })
    })

    return Object.values(brandData)
      .filter((b) => b.items.length >= 2)
      .map((b) => {
        const soldQty = b.items.length
        const avgRoi = b.items.reduce((sum, i) => sum + i.roi, 0) / soldQty
        const avgProfit = b.items.reduce((sum, i) => sum + i.profit, 0) / soldQty
        // Only average items that have a listed_date; items without are excluded entirely
        const marketItems = b.items.filter((i) => i.daysOnMarket !== null)
        const avgDaysOnMarket = marketItems.length > 0
          ? Math.round(marketItems.reduce((sum, i) => sum + i.daysOnMarket!, 0) / marketItems.length)
          : null
        return { id: b.id, name: b.name, soldQty, avgRoi, avgProfit, avgDaysOnMarket }
      })
      .sort((a, b) => b.avgRoi - a.avgRoi)
      .slice(0, 15)
  }, [inventoryItems, dealItems, deals, brands, inventoryExpenses, earliestListedById])

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <p className="page-overline">Dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">Business overview</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          Track cash, inventory, and business performance.
        </p>
      </section>

      {/* ── Latest Analytics Advice (Auditable AI Advice v1.0) ─────────── */}
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="page-overline">Latest Analytics Advice</p>
            {latestRun && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                From the run generated {formatAdviceDateTime(latestRun.completed_at ?? latestRun.created_at)}
              </p>
            )}
          </div>
          <Link href="/analytics" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            View Analytics History
          </Link>
        </div>

        {adviceActionError && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400">
            {adviceActionError}
          </div>
        )}

        <div className="mt-3">
          {adviceLoading ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
          ) : !latestRun ? (
            // No completed run
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-slate-500 dark:text-slate-400">No completed Analytics Run yet.</p>
              <Link
                href="/analytics"
                className="inline-flex h-9 items-center justify-center rounded-xl bg-slate-950 px-3.5 text-xs font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
              >
                Run Analytics
              </Link>
            </div>
          ) : !latestAdvice ? (
            // Completed run, no advice
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-slate-500 dark:text-slate-400">Your latest Analytics Run is ready, but AI Advice hasn&apos;t been generated for it yet.</p>
              <button
                type="button"
                onClick={handleDashboardAdviceAction}
                disabled={adviceActionBusy}
                className="inline-flex h-9 items-center justify-center rounded-xl bg-slate-950 px-3.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
              >
                {adviceActionBusy ? 'Generating…' : 'Generate Advice'}
              </button>
            </div>
          ) : latestAdvice.status === 'pending' || latestAdvice.status === 'generating' ? (
            // Pending/generating
            <div className="flex items-center gap-2">
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600 dark:border-slate-600 dark:border-t-slate-300" />
              <p className="text-sm text-slate-600 dark:text-slate-300">Advice is being generated…</p>
            </div>
          ) : latestAdvice.status === 'failed' ? (
            // Failed — deterministic run remains available; never imply Analytics itself failed
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                AI Advice generation did not complete for the latest run — your Analytics data itself is available and up to date.
              </p>
              <button
                type="button"
                onClick={handleDashboardAdviceAction}
                disabled={adviceActionBusy}
                className="inline-flex h-9 items-center justify-center rounded-xl border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
              >
                {adviceActionBusy ? 'Retrying…' : 'Retry Advice'}
              </button>
            </div>
          ) : (
            // Completed
            (() => {
              const cards = latestAdvice.advice?.advice_cards ?? []
              const primary = cards[0]
              const secondary = cards.slice(1, 3)
              if (!primary) {
                return (
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">{latestAdvice.advice?.run_summary.headline}</p>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{latestAdvice.advice?.run_summary.summary}</p>
                  </div>
                )
              }
              const primaryEvidenceHref = `/analytics?runId=${latestRun.id}&sourceIds=${primary.source_ids.map((s) => encodeURIComponent(s)).join(',')}`
              return (
                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700/30 lg:col-span-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                        {formatPriority(primary.priority)}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-400">
                        Confidence: {formatConfidence(primary.confidence_label)}
                      </span>
                    </div>
                    <h3 className="mt-2 text-base font-semibold text-slate-900 dark:text-white">{primary.headline}</h3>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{primary.advice}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-3">
                      <Link href={primaryEvidenceHref} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                        View Evidence ({primary.source_ids.length})
                      </Link>
                      <span className="text-[11px] text-slate-400 dark:text-slate-500">{primary.source_ids.length} source{primary.source_ids.length === 1 ? '' : 's'}</span>
                    </div>
                  </div>

                  {/* Up to two secondary cards on desktop only — mobile shows the primary card and keeps the section compact. */}
                  {secondary.length > 0 && (
                    <div className="hidden gap-3 lg:col-span-3 lg:grid lg:grid-cols-2">
                      {secondary.map((card) => (
                        <div key={card.advice_code} className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-700 dark:bg-slate-800/60">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{humanizeCode(card.advice_type)}</span>
                          <h4 className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{card.headline}</h4>
                          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{card.advice}</p>
                          <Link
                            href={`/analytics?runId=${latestRun.id}&sourceIds=${card.source_ids.map((s) => encodeURIComponent(s)).join(',')}`}
                            className="mt-1.5 inline-block text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            View Evidence ({card.source_ids.length})
                          </Link>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()
          )}
        </div>
      </section>

      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">Loading dashboard...</div>
      ) : error ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-rose-700 shadow-sm">{error}</div>
      ) : (
        <>
          {/* ── Inventory section ──────────────────────────────────────── */}
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="page-overline">Current Inventory</p>
                <h2 className="mt-2 section-title">
                  {inventoryGroupView === 'type' ? 'By type' : inventoryGroupView === 'purpose' ? 'By purpose' : 'By category'}
                </h2>
              </div>
              {/* Grouping segmented control */}
              <div className="flex rounded-xl border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-700/60">
                {(['category', 'type', 'purpose'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => setInventoryGroupView(view)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition ${
                      inventoryGroupView === view
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-600 dark:text-white'
                        : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                    }`}
                  >
                    {view.charAt(0).toUpperCase() + view.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Inventory summary cards */}
            <div className="mt-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">

              {/* Inventory Value */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5">
                <div className="inline-flex rounded-xl bg-blue-50 p-2.5 dark:bg-blue-900/20">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-blue-500 dark:text-blue-400">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
                  </svg>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Inventory Value</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white sm:text-2xl">{formatMoney(inventoryEstimatedValue)}</p>
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{totalInventoryCount} items in stock</p>
              </div>

              {/* Cost Basis */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5">
                <div className="inline-flex rounded-xl bg-violet-50 p-2.5 dark:bg-violet-900/20">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-violet-500 dark:text-violet-400">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                    <line x1="7" y1="7" x2="7.01" y2="7"/>
                  </svg>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Cost Basis</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white sm:text-2xl">{formatMoney(inventoryCostBasis)}</p>
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">total acquisition cost</p>
              </div>

              {/* Inventory Equity */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5">
                <div className={`inline-flex rounded-xl p-2.5 ${inventoryEquity >= 0 ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-rose-50 dark:bg-rose-900/20'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 ${inventoryEquity >= 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                    <polyline points="17 6 23 6 23 12"/>
                  </svg>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Inventory Equity</p>
                <p className={`mt-1 text-xl font-bold tabular-nums sm:text-2xl ${inventoryEquity >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {inventoryEquity >= 0 ? '+' : '−'}{formatMoney(Math.abs(inventoryEquity))}
                </p>
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">estimated − cost</p>
              </div>

              {/* Cash Balance */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5">
                <div className="inline-flex rounded-xl bg-sky-50 p-2.5 dark:bg-sky-900/20">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-sky-500 dark:text-sky-400">
                    <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
                  </svg>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Cash Balance</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-sky-700 dark:text-sky-300 sm:text-2xl">{formatMoney(currentCash)}</p>
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">available business cash</p>
              </div>

            </div>

            {/* Desktop table */}
            <div className="mt-5 hidden overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3">{activeGroupLabel}</th>
                    <th className="px-4 py-3 text-right">Count</th>
                    <th className="px-4 py-3 text-right">Cost Basis</th>
                    <th className="px-4 py-3 text-right">Est. Value</th>
                    <th className="px-4 py-3 text-right">Equity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {activeGroupRows.map((key) => {
                    const v = activeGroupData[key]
                    const equity = v.estimatedValue - v.costBasis
                    return (
                      <tr
                        key={key}
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer transition hover:bg-slate-50 dark:hover:bg-slate-700/60"
                        onClick={() => navigateToInventory(key)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateToInventory(key) }
                        }}
                      >
                        <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">
                          <span className="flex items-center gap-1.5">
                            {key}
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400 dark:text-slate-500">
                              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                            </svg>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{v.count}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{formatMoney(v.costBasis)}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{formatMoney(v.estimatedValue)}</td>
                        <td className={`px-4 py-3 text-right font-medium tabular-nums ${equity >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          {equity >= 0 ? '+' : '−'}{formatMoney(Math.abs(equity))}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="bg-slate-50 font-semibold dark:bg-slate-700">
                    <td className="px-4 py-3 text-slate-900 dark:text-white">Total</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{activeGroupTotal.count}</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{formatMoney(activeGroupTotal.costBasis)}</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{formatMoney(activeGroupTotal.estimatedValue)}</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${(activeGroupTotal.estimatedValue - activeGroupTotal.costBasis) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {(activeGroupTotal.estimatedValue - activeGroupTotal.costBasis) >= 0 ? '+' : '−'}{formatMoney(Math.abs(activeGroupTotal.estimatedValue - activeGroupTotal.costBasis))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="mt-5 space-y-3 md:hidden">
              {activeGroupRows.map((key) => {
                const v = activeGroupData[key]
                const equity = v.estimatedValue - v.costBasis
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => navigateToInventory(key)}
                    className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700/60"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-white">
                        {key}
                        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400 dark:text-slate-500">
                          <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                        </svg>
                      </span>
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
                        <span className={`mt-0.5 block font-medium tabular-nums ${equity >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          {equity >= 0 ? '+' : '−'}{formatMoney(Math.abs(equity))}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              })}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-slate-900 dark:text-white">Total</span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">{activeGroupTotal.count} items</span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Cost Basis</span>
                    <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(activeGroupTotal.costBasis)}</span>
                  </div>
                  <div>
                    <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Est. Value</span>
                    <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(activeGroupTotal.estimatedValue)}</span>
                  </div>
                  <div>
                    <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Equity</span>
                    <span className={`mt-0.5 block font-medium tabular-nums ${(activeGroupTotal.estimatedValue - activeGroupTotal.costBasis) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {(activeGroupTotal.estimatedValue - activeGroupTotal.costBasis) >= 0 ? '+' : '−'}{formatMoney(Math.abs(activeGroupTotal.estimatedValue - activeGroupTotal.costBasis))}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ── Monthly Performance section ─────────────────────────────── */}
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <div className="flex items-start justify-between">
              <div>
                <p className="page-overline">Monthly performance</p>
                <h2 className="mt-2 section-title">Monthly performance</h2>
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

            {/* Monthly summary cards */}
            <div className="mt-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">

              {/* Total Cash Received */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5">
                <div className="inline-flex rounded-xl bg-emerald-50 p-2.5 dark:bg-emerald-900/20">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-emerald-500 dark:text-emerald-400">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="8 12 12 16 16 12"/><line x1="12" y1="8" x2="12" y2="16"/>
                  </svg>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Cash Received</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white sm:text-2xl">{formatMoney(monthlyTotals.cashReceived)}</p>
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">for {selectedYear}</p>
              </div>

              {/* Total Deals */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5">
                <div className="inline-flex rounded-xl bg-slate-100 p-2.5 dark:bg-slate-700">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-slate-500 dark:text-slate-400">
                    <line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/>
                    <line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>
                  </svg>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Total Deals</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white sm:text-2xl">{monthlyTotals.dealsCount}</p>
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">buy / sell / trade</p>
              </div>

              {/* Total Profit */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5">
                <div className={`inline-flex rounded-xl p-2.5 ${monthlyTotals.profit >= 0 ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-rose-50 dark:bg-rose-900/20'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 ${monthlyTotals.profit >= 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                    <line x1="12" y1="1" x2="12" y2="23"/>
                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                  </svg>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Total Profit</p>
                <p className={`mt-1 text-xl font-bold tabular-nums sm:text-2xl ${monthlyTotals.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {monthlyTotals.profit >= 0 ? '+' : '−'}{formatMoney(Math.abs(monthlyTotals.profit))}
                </p>
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">realized gain</p>
              </div>

              {/* Best Month */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5">
                <div className="inline-flex rounded-xl bg-amber-50 p-2.5 dark:bg-amber-900/20">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-amber-500 dark:text-amber-400">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Best Month</p>
                {bestMonthRow ? (
                  <>
                    <p className="mt-1 text-xl font-bold text-slate-900 dark:text-white sm:text-2xl">{formatMonthLabel(bestMonthRow.month)}</p>
                    <p className="mt-0.5 text-xs font-medium tabular-nums text-emerald-600 dark:text-emerald-400">+{formatMoney(bestMonthRow.profit)} profit</p>
                  </>
                ) : (
                  <p className="mt-1 text-xl font-bold text-slate-400 dark:text-slate-500">—</p>
                )}
              </div>

            </div>

            {/* Desktop table */}
            <div className="mt-5 hidden overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Month</th>
                    <th className="px-4 py-3 text-right">Cash Received</th>
                    <th className="px-4 py-3 text-right">Deals</th>
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
                      <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{formatMonthLabel(row.month)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">{formatMoney(row.cashReceived)}</td>
                      <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">{row.dealsCount}</td>
                      <td className={`px-4 py-3 text-right font-medium tabular-nums ${row.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                        {row.profit >= 0 ? '+' : '−'}{formatMoney(Math.abs(row.profit))}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold dark:bg-slate-700">
                    <td className="px-4 py-3 text-slate-900 dark:text-white">Total</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-white">{formatMoney(monthlyTotals.cashReceived)}</td>
                    <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{monthlyTotals.dealsCount}</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${monthlyTotals.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {monthlyTotals.profit >= 0 ? '+' : '−'}{formatMoney(Math.abs(monthlyTotals.profit))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Mobile */}
            <div className="mt-5 space-y-3 md:hidden">
              {filteredMonthlyRows.map((row) => (
                <button
                  key={row.month}
                  type="button"
                  onClick={() => navigateToMonthOperations(row.month)}
                  className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-semibold text-slate-900 dark:text-white">{formatMonthLabel(row.month)}</span>
                    <span className={`text-sm font-medium tabular-nums ${row.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {row.profit >= 0 ? '+' : '−'}{formatMoney(Math.abs(row.profit))}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-3 text-sm text-slate-500 dark:text-slate-400">
                    <span>Cash Received: {formatMoney(row.cashReceived)}</span>
                    <span>Deals: {row.dealsCount}</span>
                  </div>
                </button>
              ))}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-semibold text-slate-900 dark:text-white">Total</span>
                  <span className={`text-sm font-semibold tabular-nums ${monthlyTotals.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {monthlyTotals.profit >= 0 ? '+' : '−'}{formatMoney(Math.abs(monthlyTotals.profit))}
                  </span>
                </div>
                <div className="flex flex-wrap gap-3 text-sm text-slate-500 dark:text-slate-400">
                  <span>Cash Received: {formatMoney(monthlyTotals.cashReceived)}</span>
                  <span>Deals: {monthlyTotals.dealsCount}</span>
                </div>
              </div>
            </div>
          </section>

          {/* ── Brand Performance section ───────────────────────────────── */}
          {brandPerformance.length > 0 && (
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div>
                <p className="page-overline">Brand Performance</p>
                <h2 className="mt-2 section-title">Top brands by ROI</h2>
              </div>

              {/* Desktop table */}
              <div className="mt-5 hidden overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 md:block">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Brand</th>
                      <th className="px-4 py-3 text-center">Sold</th>
                      <th className="px-4 py-3 text-right">Avg ROI</th>
                      <th className="px-4 py-3 text-right">Avg Profit</th>
                      <th className="px-4 py-3 text-right" title="Average number of days between listing and sale.">Avg Days on Market</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {brandPerformance.map((row, index) => (
                      <tr
                        key={row.name}
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer transition hover:bg-slate-50 dark:hover:bg-slate-700/60"
                        onClick={() => navigateToBrandOperations(row.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateToBrandOperations(row.id) }
                        }}
                      >
                        <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">
                          <span className="flex items-center gap-1.5">
                            <span className="mr-1 text-xs font-normal text-slate-400 dark:text-slate-500">#{index + 1}</span>
                            {row.name}
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400 dark:text-slate-500">
                              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                            </svg>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                            {row.soldQty}
                          </span>
                        </td>
                        <td className={`px-4 py-3 text-right font-semibold tabular-nums ${row.avgRoi >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          {row.avgRoi >= 0 ? '+' : ''}{row.avgRoi.toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">{formatMoney(row.avgProfit)}</td>
                        <td className="px-4 py-3 text-right text-slate-900 dark:text-slate-100">
                          {row.avgDaysOnMarket !== null ? row.avgDaysOnMarket : <span className="text-slate-400 dark:text-slate-500">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile */}
              <div className="mt-5 space-y-3 md:hidden">
                {brandPerformance.map((row, index) => (
                  <button
                    key={row.name}
                    type="button"
                    onClick={() => navigateToBrandOperations(row.id)}
                    className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700/60"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400 dark:text-slate-500">#{index + 1}</span>
                        <span className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-white">
                          {row.name}
                          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400 dark:text-slate-500">
                            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                          </svg>
                        </span>
                      </div>
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        {row.soldQty} sold
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div>
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Avg ROI</span>
                        <span className={`mt-0.5 block font-semibold tabular-nums ${row.avgRoi >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          {row.avgRoi >= 0 ? '+' : ''}{row.avgRoi.toFixed(1)}%
                        </span>
                      </div>
                      <div>
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Avg Profit</span>
                        <span className="mt-0.5 block font-medium tabular-nums text-slate-700 dark:text-slate-300">{formatMoney(row.avgProfit)}</span>
                      </div>
                      <div title="Average number of days between listing and sale.">
                        <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Avg Days on Mkt</span>
                        <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">
                          {row.avgDaysOnMarket !== null ? row.avgDaysOnMarket : <span className="text-slate-400 dark:text-slate-500">—</span>}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ── Business Inventory section ──────────────────────────────── */}
          {businessInventoryTypes.length > 0 && (
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div>
                <p className="page-overline">Business Inventory</p>
                <h2 className="mt-2 section-title">Status by category</h2>
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
                          <td className={`px-4 py-3 text-right font-semibold ${v.unlisted > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-slate-100'}`}>
                            {v.unlisted}
                          </td>
                        </tr>
                      )
                    })}
                    <tr className="bg-slate-50 font-semibold dark:bg-slate-700">
                      <td className="px-4 py-3 text-slate-900 dark:text-white">Total</td>
                      <td className="px-4 py-3 text-right text-slate-900 dark:text-white">{totalBusinessListed}</td>
                      <td className={`px-4 py-3 text-right ${totalBusinessUnlisted > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>
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
                          <span className={`font-semibold ${v.unlisted > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>Unlisted: {v.unlisted}</span>
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
                      <span className={`font-semibold ${totalBusinessUnlisted > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>Unlisted: {totalBusinessUnlisted}</span>
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
