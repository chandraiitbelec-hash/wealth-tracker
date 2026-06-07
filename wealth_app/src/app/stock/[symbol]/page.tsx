'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import AssetChart from '@/components/AssetChart'
import AlternativeSentiment, { SentimentData } from '@/components/AlternativeSentiment'
import { fmtCurrency, fmt } from '@/lib/portfolio'
import { ArrowLeft, TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface StockData {
  meta: {
    symbol: string
    companyName: string
    isin: string
    sector: string | null
    industry: string | null
    faceValue: number | null
    listingDate: string | null
    marketCapCategory: string | null
    series: string | null
  }
  currentPrice: number | null
  change: number | null
  changePct: number | null
  isLive: boolean
  priceHistory: { date: string; close: number }[]
}

// ── Holding context from query params ─────────────────────────────────────────

interface HoldingCtx {
  qty: number
  avgBuy: number
  currentVal: number
  pnl: number
  pnlPct: number
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, highlight }: {
  label: string; value: string; sub?: string; highlight?: 'up' | 'down' | null
}) {
  return (
    <div className="bg-gray-50 rounded-xl px-4 py-3">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-sm font-semibold ${
        highlight === 'up' ? 'text-emerald-600' : highlight === 'down' ? 'text-red-500' : 'text-gray-900'
      }`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StockPage() {
  const { symbol } = useParams<{ symbol: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [data, setData] = useState<StockData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Optional holding context passed as query params from portfolio page
  const holdingCtx: HoldingCtx | null = (() => {
    const qty    = searchParams.get('qty')
    const avgBuy = searchParams.get('avgBuy')
    if (!qty || !avgBuy) return null
    const q = parseFloat(qty), b = parseFloat(avgBuy)
    const price = data?.currentPrice ?? 0
    const val   = price * q
    const pnl   = val - b * q
    return { qty: q, avgBuy: b, currentVal: val, pnl, pnlPct: b > 0 ? (pnl / (b * q)) * 100 : 0 }
  })()

  useEffect(() => {
    fetch(`/api/asset/stock/${symbol}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [symbol])

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

  const { meta, currentPrice, change, changePct, isLive, priceHistory, sentiment } = data as any
  const priceUp   = (change ?? 0) > 0
  const priceDown = (change ?? 0) < 0

  const capLabel: Record<string, string> = {
    LARGECAP: 'Large Cap', MIDCAP: 'Mid Cap', SMALLCAP: 'Small Cap', UNKNOWN: 'Unknown',
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="h-5 w-px bg-gray-200" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-bold text-gray-900 text-base truncate">{meta.companyName}</h1>
              <span className="text-xs font-mono bg-gray-100 text-gray-500 px-2 py-0.5 rounded">{meta.symbol}</span>
              {meta.series && meta.series !== 'EQ' && (
                <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">{meta.series}</span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap text-xs text-gray-400">
              {meta.sector && <span>{meta.sector}</span>}
              {meta.sector && meta.industry && <span>·</span>}
              {meta.industry && <span>{meta.industry}</span>}
              {meta.marketCapCategory && (
                <span className="bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium">
                  {capLabel[meta.marketCapCategory] ?? meta.marketCapCategory}
                </span>
              )}
            </div>
          </div>
          {/* Current price */}
          {currentPrice !== null && (
            <div className="text-right shrink-0">
              <p className="text-lg font-bold text-gray-900">₹{fmt(currentPrice, 2)}</p>
              {change !== null && changePct !== null && (
                <div className={`flex items-center justify-end gap-1 text-xs font-medium ${
                  priceUp ? 'text-emerald-600' : priceDown ? 'text-red-500' : 'text-gray-400'
                }`}>
                  {priceUp ? <TrendingUp className="w-3 h-3" /> : priceDown ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                  {priceUp ? '+' : ''}{fmt(change, 2)} ({priceUp ? '+' : ''}{fmt(changePct, 2)}%)
                  {isLive && <span className="ml-1 text-xs text-emerald-500">● Live</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* Holding context banner — shown only when linked from portfolio */}
        {holdingCtx && (
          <div className={`rounded-2xl border px-5 py-4 flex flex-wrap gap-6 items-center ${
            holdingCtx.pnl >= 0 ? 'bg-emerald-50 border-emerald-100' : 'bg-red-50 border-red-100'
          }`}>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Your holding</p>
              <p className="font-semibold text-gray-900">{holdingCtx.qty} shares</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Avg buy price</p>
              <p className="font-semibold text-gray-900">₹{fmt(holdingCtx.avgBuy, 2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Current value</p>
              <p className="font-semibold text-gray-900">{fmtCurrency(holdingCtx.currentVal)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Unrealised P&L</p>
              <p className={`font-bold text-base ${holdingCtx.pnl >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                {holdingCtx.pnl >= 0 ? '+' : ''}{fmtCurrency(holdingCtx.pnl)}
                <span className="text-xs ml-1">({holdingCtx.pnl >= 0 ? '+' : ''}{fmt(holdingCtx.pnlPct, 2)}%)</span>
              </p>
            </div>
          </div>
        )}

        {/* Chart */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Price History</h2>
          {priceHistory.length > 0 ? (
            <AssetChart data={priceHistory} label="Price" />
          ) : (
            <p className="text-sm text-gray-400 py-8 text-center">No price history available</p>
          )}
        </div>

        {/* Alternative Sentiment */}
        {sentiment && <AlternativeSentiment data={sentiment as SentimentData} />}

        {/* Fundamentals */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Company Info</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <StatCard label="ISIN" value={meta.isin ?? '—'} />
            <StatCard label="Sector" value={meta.sector ?? '—'} />
            <StatCard label="Industry" value={meta.industry ?? '—'} />
            <StatCard label="Market Cap" value={meta.marketCapCategory ? capLabel[meta.marketCapCategory] : '—'} />
            <StatCard label="Face Value" value={meta.faceValue ? `₹${meta.faceValue}` : '—'} />
            <StatCard label="Listed Since" value={meta.listingDate
              ? new Date(meta.listingDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
              : '—'} />
            <StatCard label="Series" value={meta.series ?? '—'} />
            {priceHistory.length > 0 && (() => {
              const year = priceHistory.slice(-252)
              const hi = Math.max(...year.map((d: any) => d.close))
              const lo = Math.min(...year.map((d: any) => d.close))
              return (
                <>
                  <StatCard label="52W High" value={`₹${fmt(hi, 2)}`}
                    highlight={currentPrice !== null && currentPrice >= hi * 0.95 ? 'up' : null} />
                  <StatCard label="52W Low"  value={`₹${fmt(lo, 2)}`}
                    highlight={currentPrice !== null && currentPrice <= lo * 1.05 ? 'down' : null} />
                </>
              )
            })()}
          </div>
        </div>

      </main>
    </div>
  )
}
