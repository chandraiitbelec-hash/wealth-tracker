'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ParsedPortfolio } from '@/types/portfolio'
import SummaryCards from '@/components/SummaryCards'
import AllocationChart from '@/components/AllocationChart'
import { StocksTable, MFTable } from '@/components/HoldingsTable'
import InsightsPanel from '@/components/InsightsPanel'
import {
  applyEnrichment,
  buildPortfolioSummary,
  buildAssetAllocation,
  buildMFCategoryAllocation,
  buildSectorAllocation,
} from '@/lib/portfolio'
import { InsightsReport } from '@/lib/insights'
import { ArrowLeft, RefreshCw, Sparkles } from 'lucide-react'

export default function PortfolioPage() {
  const [portfolio, setPortfolio] = useState<ParsedPortfolio | null>(null)
  const [clientName, setClientName] = useState('')
  const [activeTab, setActiveTab] = useState<'overview' | 'stocks' | 'mf' | 'insights'>('overview')
  const [enriching, setEnriching] = useState(false)
  const [enriched, setEnriched] = useState(false)
  const [enrichError, setEnrichError] = useState<string | null>(null)
  const [insights, setInsights] = useState<InsightsReport | null>(null)
  const router = useRouter()

  useEffect(() => {
    const raw = sessionStorage.getItem('portfolio')
    const name = sessionStorage.getItem('clientName')
    if (!raw) { router.push('/'); return }
    const p = JSON.parse(raw) as ParsedPortfolio
    setPortfolio(p)
    setClientName(name || '')
    // Auto-enrich on load
    enrichPortfolio(p)
  }, [])

  const enrichPortfolio = async (p: ParsedPortfolio) => {
    setEnriching(true)
    setEnrichError(null)
    try {
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stockIsins:    p.stocks.map((s) => s.isin),
          mfSchemeNames: p.mutualFunds.map((m) => m.schemeName),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      const { stocks, mf } = applyEnrichment(
        p.stocks,
        p.mutualFunds,
        data.stockEnrichment,
        data.mfEnrichment
      )

      // Rebuild derived data with enriched holdings
      const enrichedPortfolio: ParsedPortfolio = {
        ...p,
        stocks,
        mutualFunds: mf,
        summary:              buildPortfolioSummary(stocks, mf),
        assetAllocation:      buildAssetAllocation(stocks, mf),
        mfCategoryAllocation: buildMFCategoryAllocation(mf),
      }

      setPortfolio(enrichedPortfolio)
      setEnriched(true)

      // Compute insights from enriched portfolio
      fetchInsights(enrichedPortfolio)
    } catch (err: any) {
      setEnrichError(err.message)
      // Still compute insights from file data
      fetchInsights(p)
    } finally {
      setEnriching(false)
    }
  }

  const fetchInsights = async (p: ParsedPortfolio) => {
    try {
      const res = await fetch('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      })
      const data = await res.json()
      if (res.ok) setInsights(data)
    } catch {
      // insights are best-effort
    }
  }

  if (!portfolio) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  const sectorAllocation = buildSectorAllocation(portfolio.stocks)
  const hasSectors = sectorAllocation.some((s) => s.name !== 'Unknown')

  const tabs = [
    { key: 'overview',  label: 'Overview' },
    { key: 'insights',  label: '✦ Insights' },
    { key: 'stocks',    label: `Stocks (${portfolio.stocks.length})` },
    { key: 'mf',        label: `Mutual Funds (${portfolio.mutualFunds.length})` },
  ] as const

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push('/')}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition"
            >
              <ArrowLeft className="w-4 h-4" />
              Upload new
            </button>
            <div className="h-5 w-px bg-gray-200" />
            <div>
              <h1 className="font-semibold text-gray-900 text-sm">{clientName || 'Portfolio'}</h1>
              {portfolio.statementDate && (
                <p className="text-xs text-gray-400">As on {portfolio.statementDate}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Enrichment status badge */}
            {enriching && (
              <span className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg">
                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Enriching with live data...
              </span>
            )}
            {enriched && !enriching && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-lg font-medium">
                <Sparkles className="w-3.5 h-3.5" />
                Live data applied
              </span>
            )}
            {enrichError && (
              <span className="text-xs text-red-500 bg-red-50 px-3 py-1.5 rounded-lg">
                DB unavailable — showing file data
              </span>
            )}

            <button
              onClick={() => router.push('/')}
              className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition font-medium"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        <SummaryCards summary={portfolio.summary} />

        {activeTab === 'overview' && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <AllocationChart
                data={portfolio.assetAllocation}
                title="Asset Allocation"
              />
              <AllocationChart
                data={portfolio.mfCategoryAllocation}
                title="Mutual Fund Breakdown"
              />
            </div>

            {/* Sector allocation — only shown if enrichment gave us sector data */}
            {hasSectors && (
              <AllocationChart
                data={sectorAllocation}
                title="Equity — Sector Breakdown"
              />
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {portfolio.stocks.length > 0 && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                  <h3 className="font-semibold text-gray-800 mb-4">Top Stock Holdings</h3>
                  <div className="space-y-3">
                    {[...portfolio.stocks]
                      .sort((a, b) => b.closingValue - a.closingValue)
                      .slice(0, 5)
                      .map((h, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <span className="text-xs font-bold text-gray-400 w-4">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {h.companyName || h.stockName}
                            </p>
                            {h.sector && (
                              <p className="text-xs text-gray-400">{h.sector}</p>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-violet-400 rounded-full"
                                  style={{ width: `${Math.min(100, (h.closingValue / portfolio.summary.stocksCurrentValue) * 100)}%` }}
                                />
                              </div>
                              <span className="text-xs text-gray-500 shrink-0">
                                {((h.closingValue / portfolio.summary.stocksCurrentValue) * 100).toFixed(1)}%
                              </span>
                            </div>
                          </div>
                          <span className={`text-xs font-semibold shrink-0 ${h.unrealisedPnL >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                            {h.pnlPercent >= 0 ? '+' : ''}{h.pnlPercent.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {portfolio.mutualFunds.length > 0 && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                  <h3 className="font-semibold text-gray-800 mb-4">Top MF Holdings</h3>
                  <div className="space-y-3">
                    {[...portfolio.mutualFunds]
                      .sort((a, b) => b.currentValue - a.currentValue)
                      .slice(0, 5)
                      .map((h, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <span className="text-xs font-bold text-gray-400 w-4">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{h.schemeName}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-indigo-400 rounded-full"
                                  style={{ width: `${Math.min(100, (h.currentValue / portfolio.summary.mfCurrentValue) * 100)}%` }}
                                />
                              </div>
                              <span className="text-xs text-gray-500 shrink-0">
                                {((h.currentValue / portfolio.summary.mfCurrentValue) * 100).toFixed(1)}%
                              </span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-xs font-semibold text-indigo-600">{h.xirr}</p>
                            {h.plan && (
                              <p className={`text-xs font-medium ${h.plan === 'Direct' ? 'text-emerald-600' : 'text-amber-500'}`}>
                                {h.plan}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'insights' && (
          <InsightsPanel report={insights} loading={enriching} />
        )}

        {activeTab === 'stocks' && portfolio.stocks.length > 0 && (
          <StocksTable holdings={portfolio.stocks} />
        )}
        {activeTab === 'mf' && portfolio.mutualFunds.length > 0 && (
          <MFTable holdings={portfolio.mutualFunds} />
        )}
        {activeTab === 'stocks' && portfolio.stocks.length === 0 && (
          <div className="bg-white rounded-2xl p-12 text-center text-gray-400 border border-gray-100">
            No stock holdings uploaded.
          </div>
        )}
        {activeTab === 'mf' && portfolio.mutualFunds.length === 0 && (
          <div className="bg-white rounded-2xl p-12 text-center text-gray-400 border border-gray-100">
            No mutual fund holdings uploaded.
          </div>
        )}
      </main>
    </div>
  )
}
