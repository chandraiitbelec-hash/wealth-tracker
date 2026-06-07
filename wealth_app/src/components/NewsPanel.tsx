'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { Newspaper, TrendingUp, Globe, Building2, PieChart, RefreshCw, ExternalLink, Clock, AlertCircle } from 'lucide-react'
import { StockHolding, MFHolding } from '@/types/portfolio'
import { Article } from '@/app/api/news/route'

// ── Time formatting ───────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins < 2)   return 'just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

// ── Category config ───────────────────────────────────────────────────────────

type Tab = 'portfolio' | 'market' | 'economy' | 'stocks' | 'mf'

const TAB_CONFIG: Record<Tab, {
  label: string
  icon: React.ReactNode
  emptyMsg: string
  accentBg: string
  accentText: string
  badgeBg: string
}> = {
  portfolio: {
    label: 'Your Portfolio',
    icon: <Building2 className="w-3.5 h-3.5" />,
    emptyMsg: 'No recent news about your holdings. Upload order history to see portfolio-specific news.',
    accentBg:   'bg-violet-50',
    accentText: 'text-violet-700',
    badgeBg:    'bg-violet-100 text-violet-700',
  },
  market: {
    label: 'Market',
    icon: <TrendingUp className="w-3.5 h-3.5" />,
    emptyMsg: 'No market news yet.',
    accentBg:   'bg-indigo-50',
    accentText: 'text-indigo-700',
    badgeBg:    'bg-indigo-100 text-indigo-700',
  },
  economy: {
    label: 'Economy',
    icon: <Globe className="w-3.5 h-3.5" />,
    emptyMsg: 'No economy news yet.',
    accentBg:   'bg-blue-50',
    accentText: 'text-blue-700',
    badgeBg:    'bg-blue-100 text-blue-700',
  },
  stocks: {
    label: 'Companies',
    icon: <Newspaper className="w-3.5 h-3.5" />,
    emptyMsg: 'No company news yet.',
    accentBg:   'bg-emerald-50',
    accentText: 'text-emerald-700',
    badgeBg:    'bg-emerald-100 text-emerald-700',
  },
  mf: {
    label: 'Mutual Funds',
    icon: <PieChart className="w-3.5 h-3.5" />,
    emptyMsg: 'No mutual fund news yet.',
    accentBg:   'bg-amber-50',
    accentText: 'text-amber-700',
    badgeBg:    'bg-amber-100 text-amber-700',
  },
}

// ── Article card ──────────────────────────────────────────────────────────────

function ArticleCard({ article, tab }: { article: Article; tab: Tab }) {
  const cfg = TAB_CONFIG[tab]

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group block bg-white rounded-2xl border border-gray-100 shadow-sm p-4 hover:border-indigo-200 hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Source badge */}
          <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium shrink-0">
            {article.source}
          </span>
          {/* Holding badge — shown for portfolio tab */}
          {article.relevantHolding && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ${cfg.badgeBg}`}>
              {article.relevantHolding}
            </span>
          )}
          {/* Extra tagged symbols */}
          {article.taggedSymbols
            .filter(s => s !== article.relevantHolding)
            .slice(0, 2)
            .map(s => (
              <span key={s} className="text-xs bg-gray-50 text-gray-500 px-2 py-0.5 rounded-full">
                {s}
              </span>
            ))
          }
        </div>
        <div className="flex items-center gap-1 text-gray-400 shrink-0">
          <Clock className="w-3 h-3" />
          <span className="text-xs">{timeAgo(article.publishedAt)}</span>
          <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity ml-0.5" />
        </div>
      </div>

      <p className="text-sm font-semibold text-gray-900 leading-snug group-hover:text-indigo-700 transition-colors line-clamp-2">
        {article.title}
      </p>

      {article.summary && (
        <p className="text-xs text-gray-500 mt-1.5 line-clamp-2 leading-relaxed">
          {article.summary}
        </p>
      )}
    </a>
  )
}

// ── Tab content ───────────────────────────────────────────────────────────────

function TabContent({ articles, tab, loading }: { articles: Article[]; tab: Tab; loading: boolean }) {
  const cfg = TAB_CONFIG[tab]

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 animate-pulse">
            <div className="h-3 bg-gray-100 rounded w-1/4 mb-3" />
            <div className="h-4 bg-gray-100 rounded w-full mb-2" />
            <div className="h-4 bg-gray-100 rounded w-3/4" />
          </div>
        ))}
      </div>
    )
  }

  if (articles.length === 0) {
    return (
      <div className={`rounded-2xl ${cfg.accentBg} border border-gray-100 p-10 text-center`}>
        <p className={`text-sm ${cfg.accentText}`}>{cfg.emptyMsg}</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {articles.map((a, i) => (
        <ArticleCard key={a.url ?? i} article={a} tab={tab} />
      ))}
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface Props {
  stocks: StockHolding[]
  mf: MFHolding[]
}

interface NewsData {
  portfolio: Article[]
  market:    Article[]
  economy:   Article[]
  stocks:    Article[]
  mf:        Article[]
  source:    string
  fetchedAt: string
}

export default function NewsPanel({ stocks, mf }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('portfolio')
  const [data, setData]           = useState<NewsData | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Build symbol list from current portfolio holdings.
  // Memoised so it only recomputes when the stocks array reference changes.
  const portfolioSymbols = useMemo(
    () => stocks.map((h) => h.symbol).filter((s): s is string => Boolean(s)),
    [stocks]
  )

  // Stable comma-joined string used as the useCallback dependency.
  // Avoids the anti-pattern of calling .join() directly inside the deps array,
  // which would create a new string reference on every render even if the
  // underlying symbol list hasn't changed.
  const symbolsParam = useMemo(() => portfolioSymbols.join(','), [portfolioSymbols])

  const fetchNews = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({ limit: '20' })
      if (symbolsParam) {
        params.set('symbols', symbolsParam)
      }
      const res = await fetch(`/api/news?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      setData(json)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [symbolsParam])

  useEffect(() => { fetchNews() }, [fetchNews])

  const tabs = Object.entries(TAB_CONFIG) as [Tab, typeof TAB_CONFIG[Tab]][]

  // Count badge for portfolio tab
  const portfolioCount = data?.portfolio.length ?? 0

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-semibold text-gray-800">Market Pulse</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Economy → Market → Your portfolio — three zoom levels, one view.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.source === 'rss_fallback' && (
            <span className="text-xs bg-amber-50 text-amber-600 border border-amber-100 px-2 py-1 rounded-lg flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              Live RSS — pipeline adds tagging
            </span>
          )}
          {data?.fetchedAt && (
            <span className="text-xs text-gray-400">
              Updated {timeAgo(data.fetchedAt)}
            </span>
          )}
          <button
            onClick={() => fetchNews(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 text-xs text-indigo-500 hover:text-indigo-700 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 overflow-x-auto">
        {tabs.map(([key, cfg]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              activeTab === key
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {cfg.icon}
            {cfg.label}
            {key === 'portfolio' && portfolioCount > 0 && (
              <span className="ml-0.5 bg-violet-100 text-violet-700 text-xs px-1.5 py-0.5 rounded-full font-bold">
                {portfolioCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {!error && (
        <TabContent
          articles={data?.[activeTab] ?? []}
          tab={activeTab}
          loading={loading}
        />
      )}

      <p className="text-xs text-gray-400 text-center">
        Sources: Economic Times · Moneycontrol · Business Standard · Mint · RBI · SEBI
        {data?.source === 'db' ? ' · Articles stored and portfolio-tagged by pipeline' : ''}
      </p>
    </div>
  )
}
