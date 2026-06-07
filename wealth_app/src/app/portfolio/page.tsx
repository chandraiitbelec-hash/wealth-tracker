'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ParsedPortfolio } from '@/types/portfolio'
import SummaryCards from '@/components/SummaryCards'
import AllocationChart from '@/components/AllocationChart'
import { StocksTable, MFTable } from '@/components/HoldingsTable'
import { ArrowLeft, RefreshCw } from 'lucide-react'

export default function PortfolioPage() {
  const [portfolio, setPortfolio] = useState<ParsedPortfolio | null>(null)
  const [clientName, setClientName] = useState('')
  const [activeTab, setActiveTab] = useState<'overview' | 'stocks' | 'mf'>('overview')
  const router = useRouter()

  useEffect(() => {
    const raw = sessionStorage.getItem('portfolio')
    const name = sessionStorage.getItem('clientName')
    if (!raw) { router.push('/'); return }
    setPortfolio(JSON.parse(raw))
    setClientName(name || '')
  }, [router])

  if (!portfolio) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'stocks',   label: `Stocks (${portfolio.stocks.length})` },
    { key: 'mf',       label: `Mutual Funds (${portfolio.mutualFunds.length})` },
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

          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition font-medium"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh data
          </button>
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

        {/* Summary cards always visible */}
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

            {/* Top movers */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Top performing stocks */}
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
                            <p className="text-sm font-medium text-gray-800 truncate">{h.stockName}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-violet-400 rounded-full"
                                  style={{
                                    width: `${Math.min(100, (h.closingValue / portfolio.summary.stocksCurrentValue) * 100)}%`
                                  }}
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

              {/* Top MF by value */}
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
                            <div className="flex items-center gap-2 mt-0.5">
                              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-indigo-400 rounded-full"
                                  style={{
                                    width: `${Math.min(100, (h.currentValue / portfolio.summary.mfCurrentValue) * 100)}%`
                                  }}
                                />
                              </div>
                              <span className="text-xs text-gray-500 shrink-0">
                                {((h.currentValue / portfolio.summary.mfCurrentValue) * 100).toFixed(1)}%
                              </span>
                            </div>
                          </div>
                          <span className="text-xs font-semibold text-indigo-600 shrink-0">{h.xirr}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </>
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
