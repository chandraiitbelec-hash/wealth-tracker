'use client'

import { useState, useRef } from 'react'
import { Upload, TrendingUp, TrendingDown, AlertCircle, CheckCircle2, FileSpreadsheet, X } from 'lucide-react'
import { fmtCurrency, fmt } from '@/lib/portfolio'
import { ExitAnalysis, ExitRecord } from '@/app/api/exits/route'

// ── Upload prompt ─────────────────────────────────────────────────────────────

function UploadPrompt({ onFile }: { onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div
        className={`w-full max-w-md border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all
          ${dragging ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50'}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
        onClick={() => ref.current?.click()}
      >
        <input ref={ref} type="file" accept=".xlsx,.xls,.csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-indigo-100 rounded-xl">
            <FileSpreadsheet className="w-8 h-8 text-indigo-500" />
          </div>
        </div>
        <p className="font-semibold text-gray-800 mb-1">Upload stock order history</p>
        <p className="text-xs text-gray-400 mb-4">Groww order history or Zerodha equity tradebook (.xlsx)</p>
        <p className="text-xs text-indigo-500 font-medium">
          <Upload className="inline w-3 h-3 mr-1" />Click or drag & drop
        </p>
      </div>
      <div className="mt-6 text-xs text-gray-400 space-y-1 text-center">
        <p><span className="font-medium text-gray-500">Groww:</span> Account → Statements → Order History → Stocks</p>
        <p><span className="font-medium text-gray-500">Zerodha:</span> Console → Reports → Tradebook → Equity</p>
      </div>
    </div>
  )
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryStrip({ analysis }: { analysis: ExitAnalysis }) {
  const netImpact = analysis.totalSavedLosses - analysis.totalMissedGains
  const netPositive = netImpact >= 0

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {[
        { label: 'Exits in last 12 mo.', value: String(analysis.totalExits), sub: 'unique stocks', neutral: true },
        { label: 'Total realised', value: fmtCurrency(analysis.totalRealised), sub: 'exit proceeds', neutral: true },
        { label: 'Missed gains', value: fmtCurrency(analysis.totalMissedGains), sub: 'stocks rose after exit', positive: false },
        { label: 'Saved losses', value: fmtCurrency(analysis.totalSavedLosses), sub: 'stocks fell after exit', positive: true },
      ].map((c, i) => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-400 mb-1">{c.label}</p>
          <p className={`text-xl font-bold ${
            c.neutral ? 'text-gray-900' : c.positive ? 'text-emerald-600' : 'text-red-500'
          }`}>{c.value}</p>
          <p className="text-xs text-gray-400 mt-0.5">{c.sub}</p>
        </div>
      ))}
    </div>
  )
}

// ── Exit row ──────────────────────────────────────────────────────────────────

function ExitRow({ exit, expanded, onToggle }: {
  exit: ExitRecord
  expanded: boolean
  onToggle: () => void
}) {
  const missed  = exit.verdict === 'missed_gains'
  const good    = exit.verdict === 'good_exit'
  const unknown = exit.verdict === 'unknown'

  const impactColor = missed ? 'text-red-500' : good ? 'text-emerald-600' : 'text-gray-400'
  const impactBg    = missed ? 'bg-red-50'    : good ? 'bg-emerald-50'    : 'bg-gray-50'
  const impactBorder= missed ? 'border-red-100': good ? 'border-emerald-100': 'border-gray-100'

  return (
    <div className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all ${impactBorder}`}>
      {/* Main row */}
      <button
        className="w-full text-left px-5 py-4 flex items-center gap-4"
        onClick={onToggle}
      >
        {/* Verdict icon */}
        <div className={`shrink-0 p-2 rounded-xl ${impactBg}`}>
          {missed  && <TrendingUp   className="w-4 h-4 text-red-500" />}
          {good    && <TrendingDown className="w-4 h-4 text-emerald-600" />}
          {unknown && <AlertCircle  className="w-4 h-4 text-gray-400" />}
        </div>

        {/* Stock info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-gray-900 text-sm">{exit.stockName || exit.symbol}</p>
            <span className="text-xs text-gray-400 font-mono">{exit.symbol}</span>
            {exit.sector && (
              <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{exit.sector}</span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {exit.totalSoldQty} shares · avg exit ₹{fmt(exit.avgExitPrice, 2)} ·
            {exit.sells.length > 1 ? ` ${exit.sells.length} trades` : ` ${exit.latestSell}`}
          </p>
        </div>

        {/* Impact */}
        <div className="text-right shrink-0">
          {exit.gainLossSinceExit !== null ? (
            <>
              <p className={`text-base font-bold ${impactColor}`}>
                {missed ? '+' : ''}{fmtCurrency(Math.abs(exit.gainLossSinceExit))}
              </p>
              <p className={`text-xs font-medium ${impactColor}`}>
                {missed ? 'missed gain' : 'saved loss'}
                {exit.gainLossPct !== null && ` · ${fmt(Math.abs(exit.gainLossPct))}%`}
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-400">No price data</p>
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className={`px-5 pb-4 pt-0 border-t ${impactBorder}`}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 text-sm">
            <div>
              <p className="text-xs text-gray-400 mb-1">Avg exit price</p>
              <p className="font-semibold text-gray-900">₹{fmt(exit.avgExitPrice, 2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Current price</p>
              <p className="font-semibold text-gray-900">
                {exit.currentPrice !== null ? `₹${fmt(exit.currentPrice, 2)}` : '—'}
              </p>
              {exit.priceDate && <p className="text-xs text-gray-400">{exit.priceDate}</p>}
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Total exit value</p>
              <p className="font-semibold text-gray-900">{fmtCurrency(exit.totalExitValue)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Value if held today</p>
              <p className={`font-semibold ${impactColor}`}>
                {exit.currentValueIfHeld !== null ? fmtCurrency(exit.currentValueIfHeld) : '—'}
              </p>
            </div>
          </div>

          {/* Individual sell trades */}
          {exit.sells.length > 1 && (
            <div className="mt-4">
              <p className="text-xs text-gray-400 mb-2">Individual sell trades</p>
              <div className="space-y-1.5">
                {exit.sells.map((s, i) => (
                  <div key={i} className="flex justify-between text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
                    <span>{s.date}</span>
                    <span>{s.quantity} shares @ ₹{fmt(s.price, 2)}</span>
                    <span className="font-medium">{fmtCurrency(s.totalValue)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Narrative */}
          <p className={`mt-4 text-xs leading-relaxed rounded-xl px-3 py-2 ${impactBg} ${impactColor}`}>
            {missed && exit.gainLossSinceExit !== null &&
              `You sold at ₹${fmt(exit.avgExitPrice, 2)}. The stock is now at ₹${fmt(exit.currentPrice!, 2)} — ` +
              `had you held, your ${exit.totalSoldQty} shares would be worth ${fmtCurrency(exit.currentValueIfHeld!)} ` +
              `(${fmtCurrency(exit.gainLossSinceExit)} more than your exit value).`
            }
            {good && exit.gainLossSinceExit !== null &&
              `Good exit. You sold at ₹${fmt(exit.avgExitPrice, 2)}. The stock is now at ₹${fmt(exit.currentPrice!, 2)} — ` +
              `you saved ${fmtCurrency(Math.abs(exit.gainLossSinceExit))} by exiting when you did.`
            }
          </p>
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ExitsPanel() {
  const [analysis, setAnalysis]   = useState<ExitAnalysis | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [fileName, setFileName]   = useState<string | null>(null)

  const handleFile = async (file: File) => {
    setLoading(true)
    setError(null)
    setFileName(file.name)
    try {
      const form = new FormData()
      form.append('orders', file)
      const res  = await fetch('/api/exits', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to analyse exits')
      setAnalysis(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const reset = () => { setAnalysis(null); setFileName(null); setError(null) }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
        <p className="text-sm text-gray-500">Analysing your exits…</p>
      </div>
    )
  }

  if (!analysis) {
    return (
      <>
        {error && (
          <div className="mb-4 bg-red-50 text-red-600 border border-red-200 rounded-xl px-4 py-3 text-sm">
            {error}
          </div>
        )}
        <UploadPrompt onFile={handleFile} />
      </>
    )
  }

  const missed = analysis.exits.filter(e => e.verdict === 'missed_gains')
  const good   = analysis.exits.filter(e => e.verdict === 'good_exit')
  const unknown = analysis.exits.filter(e => e.verdict === 'unknown')

  return (
    <div className="space-y-6">
      {/* File info + reset */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span className="font-medium truncate max-w-xs">{fileName}</span>
          <span className="text-gray-400">· last 12 months</span>
        </div>
        <button onClick={reset} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition">
          <X className="w-3.5 h-3.5" /> Change file
        </button>
      </div>

      {analysis.totalExits === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center text-gray-400">
          No sell transactions found in the last 12 months.
        </div>
      ) : (
        <>
          <SummaryStrip analysis={analysis} />

          {/* Missed gains */}
          {missed.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-red-400" />
                Exited too early — stock rose after your sale ({missed.length})
              </h3>
              <div className="space-y-3">
                {missed.map(e => (
                  <ExitRow key={e.symbol}
                    exit={e}
                    expanded={expandedId === e.symbol}
                    onToggle={() => setExpandedId(expandedId === e.symbol ? null : e.symbol)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Good exits */}
          {good.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-emerald-500" />
                Well-timed exits — stock fell after your sale ({good.length})
              </h3>
              <div className="space-y-3">
                {good.map(e => (
                  <ExitRow key={e.symbol}
                    exit={e}
                    expanded={expandedId === e.symbol}
                    onToggle={() => setExpandedId(expandedId === e.symbol ? null : e.symbol)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Unknown (no price data) */}
          {unknown.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-gray-400 mb-3 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                No current price data ({unknown.length})
              </h3>
              <div className="space-y-3">
                {unknown.map(e => (
                  <ExitRow key={e.symbol}
                    exit={e}
                    expanded={expandedId === e.symbol}
                    onToggle={() => setExpandedId(expandedId === e.symbol ? null : e.symbol)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
