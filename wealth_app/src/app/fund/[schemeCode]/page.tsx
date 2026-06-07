'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import AssetChart from '@/components/AssetChart'
import { fmtCurrency, fmt } from '@/lib/portfolio'
import { ArrowLeft } from 'lucide-react'

interface FundData {
  meta: {
    schemeCode: string
    schemeName: string
    amcName: string | null
    schemeCategory: string | null
    schemeType: string | null
    plan: string | null
    option: string | null
    isinGrowth: string | null
    benchmark: string | null
  }
  currentNav: number | null
  returns: Record<string, number | null>
  navHistory: { date: string; nav: number }[]
}

const PERIOD_LABELS: [string, string][] = [
  ['1W', '1 Week'], ['1M', '1 Month'], ['3M', '3 Months'],
  ['6M', '6 Months'], ['1Y', '1 Year (abs)'], ['2Y', '2 Year CAGR'], ['3Y', '3 Year CAGR'],
]

export default function FundPage() {
  const { schemeCode } = useParams<{ schemeCode: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [data, setData] = useState<FundData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/asset/fund/${schemeCode}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [schemeCode])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
    </div>
  )

  if (error || !data) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-500">
      {error || 'No data available'}
    </div>
  )

  const { meta, currentNav, returns, navHistory } = data

  // Holding context from query params
  const units   = searchParams.get('units')   ? parseFloat(searchParams.get('units')!)   : null
  const invested = searchParams.get('invested') ? parseFloat(searchParams.get('invested')!) : null
  const currentValue = units !== null && currentNav !== null ? units * currentNav : null
  const holdingPnl   = currentValue !== null && invested !== null ? currentValue - invested : null
  const holdingPnlPct = holdingPnl !== null && invested ? (holdingPnl / invested) * 100 : null

  // NAV history normalised for chart (date + close)
  const chartData = navHistory.map(d => ({ date: d.date, close: d.nav }))

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-start gap-4">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition pt-0.5"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="h-5 w-px bg-gray-200 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-gray-900 text-base leading-tight">{meta.schemeName}</h1>
            <div className="flex items-center gap-2 flex-wrap mt-0.5 text-xs text-gray-400">
              {meta.amcName && <span>{meta.amcName}</span>}
              {meta.plan && (
                <span className={`px-2 py-0.5 rounded-full font-medium ${
                  meta.plan === 'Direct' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                }`}>{meta.plan}</span>
              )}
              {meta.option && <span className="bg-gray-100 px-2 py-0.5 rounded-full">{meta.option}</span>}
              {meta.schemeCategory && <span className="text-gray-400 truncate max-w-xs">{meta.schemeCategory}</span>}
            </div>
          </div>
          {currentNav !== null && (
            <div className="text-right shrink-0">
              <p className="text-xs text-gray-400 mb-0.5">Current NAV</p>
              <p className="text-lg font-bold text-gray-900">₹{fmt(currentNav, 4)}</p>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* Holding context */}
        {units !== null && invested !== null && (
          <div className={`rounded-2xl border px-5 py-4 flex flex-wrap gap-6 items-center ${
            (holdingPnl ?? 0) >= 0 ? 'bg-emerald-50 border-emerald-100' : 'bg-red-50 border-red-100'
          }`}>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Your units</p>
              <p className="font-semibold text-gray-900">{fmt(units, 3)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Invested</p>
              <p className="font-semibold text-gray-900">{fmtCurrency(invested)}</p>
            </div>
            {currentValue !== null && (
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Current value</p>
                <p className="font-semibold text-gray-900">{fmtCurrency(currentValue)}</p>
              </div>
            )}
            {holdingPnl !== null && holdingPnlPct !== null && (
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Unrealised P&L</p>
                <p className={`font-bold text-base ${holdingPnl >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {holdingPnl >= 0 ? '+' : ''}{fmtCurrency(holdingPnl)}
                  <span className="text-xs ml-1">({holdingPnl >= 0 ? '+' : ''}{fmt(holdingPnlPct, 2)}%)</span>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Returns table */}
        {Object.keys(returns).length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Returns</h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {PERIOD_LABELS.map(([key, label]) => {
                const val = returns[key]
                if (val === undefined) return null
                const up = val !== null && val > 0
                const down = val !== null && val < 0
                return (
                  <div key={key} className={`rounded-xl px-3 py-3 text-center ${
                    up ? 'bg-emerald-50' : down ? 'bg-red-50' : 'bg-gray-50'
                  }`}>
                    <p className="text-xs text-gray-400 mb-1">{key}</p>
                    {val !== null ? (
                      <p className={`text-sm font-bold ${up ? 'text-emerald-600' : down ? 'text-red-500' : 'text-gray-500'}`}>
                        {up ? '+' : ''}{fmt(val, 2)}%
                      </p>
                    ) : (
                      <p className="text-sm text-gray-300">—</p>
                    )}
                    <p className="text-xs text-gray-300 mt-0.5">
                      {['2Y', '3Y'].includes(key) ? 'CAGR' : key === '1Y' ? 'abs' : ''}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* NAV Chart */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">NAV History</h2>
          {chartData.length > 0 ? (
            <AssetChart data={chartData} label="NAV" />
          ) : (
            <p className="text-sm text-gray-400 py-8 text-center">No NAV history available</p>
          )}
        </div>

        {/* Fund info */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Fund Details</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            {[
              { label: 'Scheme Code',  value: meta.schemeCode },
              { label: 'AMC',          value: meta.amcName },
              { label: 'Category',     value: meta.schemeCategory },
              { label: 'Fund Type',    value: meta.schemeType },
              { label: 'Plan',         value: meta.plan },
              { label: 'Option',       value: meta.option },
              { label: 'ISIN (Growth)',value: meta.isinGrowth },
              { label: 'Benchmark',    value: meta.benchmark },
            ].filter(r => r.value).map(({ label, value }) => (
              <div key={label} className="bg-gray-50 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-400 mb-1">{label}</p>
                <p className="text-sm font-medium text-gray-900 break-words">{value}</p>
              </div>
            ))}
          </div>
        </div>

      </main>
    </div>
  )
}
