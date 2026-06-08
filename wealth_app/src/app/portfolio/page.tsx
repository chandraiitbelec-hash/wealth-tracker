'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ParsedPortfolio } from '@/types/portfolio'
import SummaryCards from '@/components/SummaryCards'
import AllocationChart from '@/components/AllocationChart'
import { StocksTable, MFTable } from '@/components/HoldingsTable'
import InsightsPanel from '@/components/InsightsPanel'
import ExitsPanel from '@/components/ExitsPanel'
import TaxPanel from '@/components/TaxPanel'
import LookThroughPanel from '@/components/LookThroughPanel'
import NewsPanel from '@/components/NewsPanel'
import {
  applyEnrichment,
  buildPortfolioSummary,
  buildAssetAllocation,
  buildMFCategoryAllocation,
  buildSectorAllocation,
  fmtCurrency,
} from '@/lib/portfolio'
import { InsightsReport } from '@/lib/insights'
import { ArrowLeft, RefreshCw, Sparkles, AlertTriangle } from 'lucide-react'

export default function PortfolioPage() {
  const [portfolio, setPortfolio] = useState<ParsedPortfolio | null>(null)
  const [clientName, setClientName] = useState('')
  const [activeTab, setActiveTab] = useState<'overview' | 'stocks' | 'mf' | 'insights' | 'exits' | 'tax' | 'lookahead' | 'news'>('overview')
  const [enriching, setEnriching] = useState(false)
  const [enriched, setEnriched] = useState(false)
  const [enrichError, setEnrichError] = useState<string | null>(null)
  const [insights, setInsights] = useState<InsightsReport | null>(null)
  const [unresolvedStocks, setUnresolvedStocks] = useState<string[]>([])
  const router = useRouter()

  useEffect(() => {
    const raw = sessionStorage.getItem('portfolio')
    const name = sessionStorage.getItem('clientName')
    const fyRaw = sessionStorage.getItem('fyData')
    if (!raw) { router.push('/'); return }
    const p = JSON.parse(raw) as ParsedPortfolio
    const fy = fyRaw ? JSON.parse(fyRaw) : null
    setPortfolio(p)
    setClientName(name || '')
    // Auto-enrich on load
    enrichPortfolio(p, fy)
  }, [])

  const enrichPortfolio = async (p: ParsedPortfolio, fy?: any) => {
    setEnriching(true)
    setEnrichError(null)
    try {
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stockIsins:    p.stocks.map((s) => s.isin).filter(Boolean),
          stockSymbols:  p.stocks.filter(s => !s.isin).map(s => s.symbol ?? s.stockName),
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

      // Detect stocks that failed enrichment (no symbol assigned after enrichment).
      // Exclude non-equity instruments (NCDs, bonds, debentures, SGBs, etc.) —
      // these appear in Groww's stock export but are not listed equities and
      // will never match equity_master. Showing them as "unmatched" is misleading.
      const NON_EQUITY_KEYWORDS = /\b(ncd|bond|debenture|sgb|t-bill|tbill|gsec|g-sec|etf\s+fd|fd\s+etf|sec\s+red)\b/i
      const unresolved = stocks
        .filter(s => !s.symbol && !s.companyName)
        .map(s => s.stockName || s.isin || 'Unknown')
        .filter(name => !NON_EQUITY_KEYWORDS.test(name))
      setUnresolvedStocks(unresolved)

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

      // Save snapshot for weekly digest (fire-and-forget — non-blocking)
      const broker = sessionStorage.getItem('broker') ?? 'unknown'
      const clientId = sessionStorage.getItem('clientId') ?? broker
      if (clientId) {
        fetch('/api/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIdentifier: clientId, portfolio: enrichedPortfolio }),
        }).catch(() => {/* best-effort */})
      }

      // Compute insights from enriched portfolio
      fetchInsights(enrichedPortfolio, fy)
    } catch (err: any) {
      setEnrichError(err.message)
      // Still compute insights from file data
      fetchInsights(p, fy)
    } finally {
      setEnriching(false)
    }
  }

  const fetchInsights = async (p: ParsedPortfolio, fy?: any) => {
    try {
      const res = await fetch('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolio: p, fyData: fy ?? null }),
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
    { key: 'exits',     label: '↗ Exits' },
    { key: 'tax',       label: '💰 Tax' },
    { key: 'lookahead', label: '🔍 True Exposure' },
    { key: 'news',      label: '📰 Market Pulse' },
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

        {/* Unresolved symbol warning */}
        {unresolvedStocks.length > 0 && (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm">
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-amber-800">
                {unresolvedStocks.length} stock{unresolvedStocks.length > 1 ? 's' : ''} couldn't be matched in our database
              </p>
              <p className="text-xs text-amber-600 mt-0.5">
                These may be delisted, renamed after a corporate action, or use an old ticker. Their values are included in your totals but sector/price enrichment is unavailable:{' '}
                <span className="font-medium">{unresolvedStocks.join(', ')}</span>
              </p>
            </div>
          </div>
        )}

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
                  <h3 className="font-semibold text-gray-800 mb-3">Top Stock Holdings</h3>
                  {/* Column headers */}
                  <div className="flex items-center gap-3 mb-2 px-0">
                    <span className="w-4" />
                    <span className="flex-1 text-xs text-gray-400">Stock</span>
                    <span className="text-xs text-gray-400 text-right w-28">Current Value · P&L</span>
                  </div>
                  <div className="space-y-3">
                    {[...portfolio.stocks]
                      .sort((a, b) => b.closingValue - a.closingValue)
                      .slice(0, 5)
                      .map((h, i) => {
                        const pct = (h.closingValue / portfolio.summary.stocksCurrentValue) * 100
                        return (
                        <div key={i} className="flex items-start gap-3">
                          <span className="text-xs font-bold text-gray-400 w-4 pt-1">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-800 truncate">
                                  {h.companyName || h.stockName}
                                </p>
                                {h.sector && h.sector !== 'Unknown' && (
                                  <p className="text-xs text-gray-400">{h.sector}</p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm font-semibold text-gray-900">{fmtCurrency(h.closingValue)}</p>
                                <p className={`text-xs font-medium ${h.unrealisedPnL >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                  {h.pnlPercent >= 0 ? '+' : ''}{h.pnlPercent.toFixed(1)}% P&L
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mt-1.5">
                              <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                                <div className="h-full bg-violet-400 rounded-full" style={{ width: `${Math.min(100, pct)}%` }} />
                              </div>
                              <span className="text-xs text-gray-400 shrink-0 w-16 text-right">{pct.toFixed(1)}% of stocks</span>
                            </div>
                          </div>
                        </div>
                        )
                      })}
                  </div>
                </div>
              )}

              {portfolio.mutualFunds.length > 0 && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                  <h3 className="font-semibold text-gray-800 mb-3">Top MF Holdings</h3>
                  {/* Column headers */}
                  <div className="flex items-center gap-3 mb-2">
                    <span className="w-4" />
                    <span className="flex-1 text-xs text-gray-400">Fund</span>
                    <span className="text-xs text-gray-400 text-right w-28">Current Value · Returns</span>
                  </div>
                  <div className="space-y-3">
                    {[...portfolio.mutualFunds]
                      .sort((a, b) => b.currentValue - a.currentValue)
                      .slice(0, 5)
                      .map((h, i) => {
                        const pct = (h.currentValue / portfolio.summary.mfCurrentValue) * 100
                        const returns = typeof h.returns === 'number' ? h.returns : parseFloat(h.returns) || 0
                        return (
                        <div key={i} className="flex items-start gap-3">
                          <span className="text-xs font-bold text-gray-400 w-4 pt-1">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-800 truncate">{h.schemeName}</p>
                                {h.plan && (
                                  <p className={`text-xs font-medium ${h.plan === 'Direct' ? 'text-emerald-600' : 'text-amber-500'}`}>
                                    {h.plan}
                                  </p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm font-semibold text-gray-900">{fmtCurrency(h.currentValue)}</p>
                                <p className={`text-xs font-medium ${returns >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                  {h.xirr ? `${h.xirr} XIRR` : `${returns >= 0 ? '+' : ''}${returns.toFixed(1)}% returns`}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mt-1.5">
                              <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                                <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${Math.min(100, pct)}%` }} />
                              </div>
                              <span className="text-xs text-gray-400 shrink-0 w-16 text-right">{pct.toFixed(1)}% of MFs</span>
                            </div>
                          </div>
                        </div>
                        )
                      })}
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
        {activeTab === 'exits' && (
          <ExitsPanel />
        )}
        {activeTab === 'tax' && (
          <TaxPanel holdings={portfolio.stocks} />
        )}
        {activeTab === 'lookahead' && (
          <LookThroughPanel stocks={portfolio.stocks} mf={portfolio.mutualFunds} />
        )}
        {activeTab === 'news' && (
          <NewsPanel stocks={portfolio.stocks} mf={portfolio.mutualFunds} />
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
