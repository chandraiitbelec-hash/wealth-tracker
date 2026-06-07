'use client'

import React from 'react'
import { AlertTriangle, TrendingUp, TrendingDown, Minus, Info } from 'lucide-react'
import { fmt } from '@/lib/portfolio'

interface SubScores {
  delivery: number
  disclosure: number
  institutional: number
  derivatives: number
}

export interface SentimentData {
  blendedScore: number
  subScores: SubScores
  deliveryPct5d: number | null
  deliveryPct20d: number | null
  deliveryTrend: string | null
  mfSharesChangePct: number | null
  pcr: number | null
  ivSkew: number | null
  latestDisclosure: string | null
  latestDisclosureScore: number | null
  signal: string   // ACCUMULATION | DISTRIBUTION | FROTH | NEUTRAL
  signalReason: string | null
  updatedAt: string | null
}

// ── Signal config ─────────────────────────────────────────────────────────────

const SIGNAL_CONFIG: Record<string, {
  bg: string; border: string; icon: React.ReactElement; label: string; textColor: string
}> = {
  ACCUMULATION: {
    bg: 'bg-emerald-50', border: 'border-emerald-200',
    textColor: 'text-emerald-800',
    label: 'Smart Money Accumulation',
    icon: <TrendingUp className="w-5 h-5 text-emerald-600" />,
  },
  DISTRIBUTION: {
    bg: 'bg-red-50', border: 'border-red-200',
    textColor: 'text-red-800',
    label: 'Distribution Signal',
    icon: <TrendingDown className="w-5 h-5 text-red-500" />,
  },
  FROTH: {
    bg: 'bg-amber-50', border: 'border-amber-200',
    textColor: 'text-amber-800',
    label: '⚠️ Behavioral Divergence Warning',
    icon: <AlertTriangle className="w-5 h-5 text-amber-500" />,
  },
  NEUTRAL: {
    bg: 'bg-gray-50', border: 'border-gray-200',
    textColor: 'text-gray-700',
    label: 'Neutral — No Strong Signal',
    icon: <Minus className="w-5 h-5 text-gray-400" />,
  },
}

// ── Score dial ────────────────────────────────────────────────────────────────
// Maps -5…+5 to a visual gauge.

function ScoreDial({ score, size = 'md' }: { score: number; size?: 'sm' | 'md' }) {
  const pct = ((score + 5) / 10) * 100
  const isPos = score > 0
  const isNeg = score < 0
  const color = isPos ? '#10b981' : isNeg ? '#ef4444' : '#6b7280'
  const r = size === 'sm' ? 22 : 30
  const cx = r + 4
  const circumference = 2 * Math.PI * r

  return (
    <div className="flex flex-col items-center gap-0.5">
      <svg width={cx * 2} height={cx * 2} className="-rotate-90">
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="#f3f4f6" strokeWidth="5" />
        <circle
          cx={cx} cy={cx} r={r} fill="none"
          stroke={color} strokeWidth="5"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          strokeLinecap="round"
        />
      </svg>
      <span className={`text-xs font-bold -mt-1 ${isPos ? 'text-emerald-600' : isNeg ? 'text-red-500' : 'text-gray-500'}`}>
        {score > 0 ? '+' : ''}{score}
      </span>
    </div>
  )
}

// ── Sub-score breakdown ───────────────────────────────────────────────────────

const SUB_LABELS: Record<keyof SubScores, { label: string; description: string }> = {
  delivery:     { label: 'Delivery',    description: 'Institutional conviction vs. speculative trading' },
  disclosure:   { label: 'Disclosures', description: 'LLM-parsed NSE exchange filings sentiment' },
  institutional:{ label: 'MF Flow',    description: 'Month-on-month mutual fund ownership change' },
  derivatives:  { label: 'Options',     description: 'Put-call ratio and IV skew from F&O market' },
}

function SubScoreRow({
  name, score, description
}: { name: string; score: number; description: string }) {
  const isPos = score > 0
  const isNeg = score < 0
  const widthPct = Math.abs(score / 5) * 50

  return (
    <div className="flex items-center gap-3">
      <div className="w-24 shrink-0">
        <p className="text-xs font-medium text-gray-700">{name}</p>
        <p className="text-xs text-gray-400 leading-tight">{description}</p>
      </div>
      {/* Centered bar: negative extends left, positive extends right */}
      <div className="flex-1 flex items-center gap-1">
        <div className="w-1/2 flex justify-end">
          {isNeg && (
            <div
              className="h-2 bg-red-400 rounded-l-full"
              style={{ width: `${widthPct * 2}%` }}
            />
          )}
        </div>
        <div className="w-px h-4 bg-gray-300 shrink-0" />
        <div className="w-1/2">
          {isPos && (
            <div
              className="h-2 bg-emerald-400 rounded-r-full"
              style={{ width: `${widthPct * 2}%` }}
            />
          )}
        </div>
      </div>
      <span className={`text-xs font-bold w-6 text-right shrink-0 ${
        isPos ? 'text-emerald-600' : isNeg ? 'text-red-500' : 'text-gray-400'
      }`}>
        {score > 0 ? '+' : ''}{score}
      </span>
    </div>
  )
}

// ── Raw data pills ────────────────────────────────────────────────────────────

function DataPill({ label, value, highlight }: { label: string; value: string; highlight?: 'pos' | 'neg' | 'warn' }) {
  const bg = highlight === 'pos' ? 'bg-emerald-50 text-emerald-700'
           : highlight === 'neg' ? 'bg-red-50 text-red-600'
           : highlight === 'warn'? 'bg-amber-50 text-amber-700'
           : 'bg-gray-50 text-gray-700'
  return (
    <div className={`rounded-xl px-3 py-2 text-center ${bg}`}>
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlternativeSentiment({ data }: { data: SentimentData }) {
  const cfg = SIGNAL_CONFIG[data.signal] ?? SIGNAL_CONFIG.NEUTRAL
  const score = data.blendedScore

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Alternative Sentiment Engine</h2>
        {data.updatedAt && (
          <span className="text-xs text-gray-400">
            Updated {new Date(data.updatedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
          </span>
        )}
      </div>

      {/* Signal banner */}
      <div className={`rounded-2xl border ${cfg.bg} ${cfg.border} px-4 py-3 flex items-start gap-3`}>
        <div className="mt-0.5 shrink-0">{cfg.icon}</div>
        <div>
          <p className={`text-sm font-semibold ${cfg.textColor}`}>{cfg.label}</p>
          {data.signalReason && (
            <p className={`text-xs mt-0.5 ${cfg.textColor} opacity-80`}>{data.signalReason}</p>
          )}
        </div>
        <div className="ml-auto shrink-0">
          <ScoreDial score={score} />
        </div>
      </div>

      {/* Sub-score breakdown */}
      <div className="space-y-3">
        <p className="text-xs font-medium text-gray-500 flex items-center gap-1">
          Signal breakdown
          <span className="text-gray-300">·</span>
          <span className="text-gray-400 font-normal">delivery 30% · disclosures 30% · MF flow 25% · options 15%</span>
        </p>
        {(Object.entries(data.subScores) as [keyof SubScores, number][]).map(([key, score]) => (
          <SubScoreRow
            key={key}
            name={SUB_LABELS[key].label}
            score={score}
            description={SUB_LABELS[key].description}
          />
        ))}
      </div>

      {/* Raw data grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {data.deliveryPct5d !== null && (
          <DataPill
            label="Delivery 5D avg"
            value={`${fmt(data.deliveryPct5d, 1)}%`}
            highlight={data.deliveryPct5d > 50 ? 'pos' : data.deliveryPct5d < 30 ? 'warn' : undefined}
          />
        )}
        {data.deliveryPct20d !== null && (
          <DataPill
            label="Delivery 20D avg"
            value={`${fmt(data.deliveryPct20d, 1)}%`}
          />
        )}
        {data.mfSharesChangePct !== null && (
          <DataPill
            label="MF Ownership MoM"
            value={`${data.mfSharesChangePct >= 0 ? '+' : ''}${fmt(data.mfSharesChangePct, 2)}%`}
            highlight={data.mfSharesChangePct > 0.5 ? 'pos' : data.mfSharesChangePct < -0.5 ? 'neg' : undefined}
          />
        )}
        {data.pcr !== null && (
          <DataPill
            label="Options PCR"
            value={fmt(data.pcr, 2)}
            highlight={data.pcr < 0.7 ? 'pos' : data.pcr > 1.2 ? 'neg' : undefined}
          />
        )}
        {data.ivSkew !== null && (
          <DataPill
            label="IV Skew (P-C)"
            value={`${data.ivSkew >= 0 ? '+' : ''}${fmt(data.ivSkew, 2)}%`}
            highlight={data.ivSkew > 2 ? 'neg' : data.ivSkew < -2 ? 'pos' : undefined}
          />
        )}
      </div>

      {/* Latest disclosure */}
      {data.latestDisclosure && (
        <div className="bg-gray-50 rounded-xl px-4 py-3 text-xs">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="font-medium text-gray-600">Latest NSE Filing</span>
            {data.latestDisclosureScore !== null && (
              <span className={`px-2 py-0.5 rounded-full font-semibold text-xs ${
                data.latestDisclosureScore > 0 ? 'bg-emerald-100 text-emerald-700'
                : data.latestDisclosureScore < 0 ? 'bg-red-100 text-red-600'
                : 'bg-gray-200 text-gray-500'
              }`}>
                {data.latestDisclosureScore > 0 ? '+' : ''}{data.latestDisclosureScore}
              </span>
            )}
          </div>
          <p className="text-gray-500 leading-snug">{data.latestDisclosure}</p>
        </div>
      )}

      {/* Methodology note */}
      <div className="flex items-start gap-2 text-xs text-gray-400">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          Scores derived from NSE exchange filings, delivery data, AMFI portfolio disclosures,
          and F&O open interest — not from news headlines. By the time news is published, the market has already priced it in.
        </span>
      </div>
    </div>
  )
}
