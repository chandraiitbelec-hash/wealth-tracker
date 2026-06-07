'use client'

import { useState, useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Line, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from 'recharts'
import { fmt } from '@/lib/portfolio'

interface PricePoint { date: string; close: number }

interface AssetChartProps {
  data: PricePoint[]
  label?: string        // "Price" | "NAV"
  currency?: boolean
  color?: string
}

// ── SMA helper ────────────────────────────────────────────────────────────────

function computeSMA(data: PricePoint[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null
    const slice = data.slice(i - period + 1, i + 1)
    return slice.reduce((s, d) => s + d.close, 0) / period
  })
}

// ── Range filter ──────────────────────────────────────────────────────────────

type Range = '1M' | '3M' | '6M' | '1Y' | '2Y' | 'All'

const RANGE_DAYS: Record<Range, number> = {
  '1M': 30, '3M': 90, '6M': 182, '1Y': 365, '2Y': 730, 'All': Infinity,
}

function filterRange(data: PricePoint[], range: Range): PricePoint[] {
  if (range === 'All') return data
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - RANGE_DAYS[range])
  return data.filter(d => new Date(d.date) >= cutoff)
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label: date, currency }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-100 shadow-lg rounded-xl px-3 py-2 text-xs">
      <p className="text-gray-400 mb-1">{date}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }} className="font-semibold">
          {p.name}: {currency !== false ? '₹' : ''}{fmt(p.value, 2)}
        </p>
      ))}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function AssetChart({
  data,
  label = 'Price',
  currency = true,
  color = '#6366f1',
}: AssetChartProps) {
  const [range, setRange]    = useState<Range>('1Y')
  const [show50, setShow50]  = useState(false)
  const [show200, setShow200] = useState(false)

  const filtered = useMemo(() => filterRange(data, range), [data, range])

  const sma50  = useMemo(() => computeSMA(filtered, 50),  [filtered])
  const sma200 = useMemo(() => computeSMA(data, 200).slice(-filtered.length), [data, filtered])

  const chartData = useMemo(() => filtered.map((d, i) => ({
    date:  d.date,
    close: d.close,
    sma50:  show50  ? sma50[i]  : undefined,
    sma200: show200 ? sma200[i] : undefined,
  })), [filtered, sma50, sma200, show50, show200])

  const first = filtered[0]?.close
  const last  = filtered.at(-1)?.close
  const isUp  = last !== undefined && first !== undefined && last >= first
  const areaColor = isUp ? '#6366f1' : '#ef4444'
  const lineColor = isUp ? '#6366f1' : '#ef4444'

  // Y-axis domain with 3% padding
  const prices = filtered.map(d => d.close)
  const minP = Math.min(...prices)
  const maxP = Math.max(...prices)
  const pad  = (maxP - minP) * 0.03
  const yMin = Math.floor(minP - pad)
  const yMax = Math.ceil(maxP  + pad)

  const ranges: Range[] = ['1M', '3M', '6M', '1Y', '2Y', 'All']

  // X-axis tick formatter — show month/year
  const xFormatter = (date: string) => {
    const d = new Date(date)
    return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
  }

  const yFormatter = (v: number) =>
    v >= 1000 ? `₹${(v / 1000).toFixed(1)}k` : `₹${v}`

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        {/* Range selector */}
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {ranges.map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                range === r
                  ? 'bg-white text-indigo-600 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        {/* SMA toggles */}
        <div className="flex gap-2">
          <button
            onClick={() => setShow50(!show50)}
            className={`px-3 py-1 rounded-xl text-xs font-medium border transition-all ${
              show50 ? 'bg-amber-50 border-amber-200 text-amber-700' : 'border-gray-200 text-gray-400 hover:text-gray-600'
            }`}
          >
            50D MA
          </button>
          <button
            onClick={() => setShow200(!show200)}
            className={`px-3 py-1 rounded-xl text-xs font-medium border transition-all ${
              show200 ? 'bg-purple-50 border-purple-200 text-purple-700' : 'border-gray-200 text-gray-400 hover:text-gray-600'
            }`}
          >
            200D MA
          </button>
        </div>
      </div>

      {/* Chart */}
      <div className="h-72 sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={areaColor} stopOpacity={0.15} />
                <stop offset="95%" stopColor={areaColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={xFormatter}
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={60}
            />
            <YAxis
              domain={[yMin, yMax]}
              tickFormatter={yFormatter}
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={false}
              width={60}
            />
            <Tooltip content={<ChartTooltip currency={currency} />} />

            {/* Price area + line */}
            <Area
              type="monotone"
              dataKey="close"
              name={label}
              stroke={lineColor}
              strokeWidth={2}
              fill="url(#priceGrad)"
              dot={false}
              activeDot={{ r: 4, fill: lineColor, stroke: '#fff', strokeWidth: 2 }}
            />

            {/* SMAs */}
            {show50 && (
              <Line
                type="monotone"
                dataKey="sma50"
                name="50D MA"
                stroke="#f59e0b"
                strokeWidth={1.5}
                dot={false}
                strokeDasharray="4 2"
                connectNulls
              />
            )}
            {show200 && (
              <Line
                type="monotone"
                dataKey="sma200"
                name="200D MA"
                stroke="#8b5cf6"
                strokeWidth={1.5}
                dot={false}
                strokeDasharray="4 2"
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
