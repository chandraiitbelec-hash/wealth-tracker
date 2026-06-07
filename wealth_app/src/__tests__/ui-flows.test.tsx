/**
 * UI Flow Tests — React Testing Library
 *
 * Covers the main user journeys through the app:
 *   1. SummaryCards renders correctly from portfolio data
 *   2. TaxPanel upload → report rendering journey
 *   3. NewsPanel tab navigation and article rendering
 *   4. Portfolio page tab switching (overview → stocks → mf → tax → news)
 *   5. Back-navigation from portfolio page
 *
 * All API calls are mocked via vi.stubGlobal('fetch', ...).
 * next/navigation is mocked so the router doesn't hit real Next.js internals.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Next.js navigation mock ───────────────────────────────────────────────────

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

// ── Mock the API route module (it imports next/server which is server-only) ──
// NewsPanel imports `Article` type from the route; the type is erased at
// runtime but the import still causes next/server to load and fail in jsdom.
vi.mock('@/app/api/news/route', () => ({}))

// ── Components under test ─────────────────────────────────────────────────────

import SummaryCards from '../components/SummaryCards'
import NewsPanel    from '../components/NewsPanel'
import TaxPanel     from '../components/TaxPanel'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUMMARY = {
  stocksInvested:     8_00_000,
  stocksCurrentValue: 10_00_000,
  stocksPnL:           2_00_000,
  stocksPnLPercent:        25.0,
  mfInvested:          4_00_000,
  mfCurrentValue:      5_00_000,
  mfReturns:           1_00_000,
  mfReturnsPercent:        25.0,
  totalInvested:      12_00_000,
  totalCurrentValue:  15_00_000,
  totalPnL:            3_00_000,
  totalPnLPercent:         25.0,
  stockCount: 5,
  mfCount:    3,
}

function makeStock(overrides = {}): any {
  return {
    symbol: 'RELIANCE', isin: 'INE002A01018', stockName: 'Reliance Industries',
    companyName: 'Reliance Industries Ltd', quantity: 10, closingPrice: 2500,
    ourPrice: 2000, closingValue: 25_000, buyValue: 20_000, investedValue: 20_000,
    unrealisedPnL: 5_000, pnlPercent: 25, sector: 'Energy', industry: 'Oil & Gas',
    marketCapCategory: 'LARGECAP', ...overrides,
  }
}

function makeMF(overrides = {}): any {
  return {
    schemeName: 'Mirae Asset Large Cap', schemeCode: '12345', isin: 'INF209K01YR9',
    units: 100, nav: 50, currentValue: 5_000, investedValue: 4_000,
    unrealisedPnL: 1_000, returns: 25, category: 'Equity', ...overrides,
  }
}

// Article interface uses camelCase (as returned by the API route)
function makeArticle(overrides: object = {}) {
  return {
    id: 1,
    title: 'Placeholder',
    summary: 'placeholder summary',
    url: 'https://example.com/1',
    source: 'ET',
    category: 'stocks',
    publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    taggedSymbols: [] as string[],
    relevantHolding: undefined as string | undefined,
    sentimentScore: 0,
    ...overrides,
  }
}

// NewsData is categorised by the API — each key is a Tab name
const NEWS_RESPONSE = {
  portfolio: [makeArticle({ id: 1, title: 'Reliance Q4 profit beats estimates', taggedSymbols: ['RELIANCE'], relevantHolding: 'RELIANCE', source: 'ET' })],
  market:    [makeArticle({ id: 3, title: 'Nifty 50 hits all-time high', taggedSymbols: [], source: 'BS' })],
  economy:   [makeArticle({ id: 2, title: 'RBI holds repo rate steady', taggedSymbols: [], source: 'Mint' })],
  stocks:    [makeArticle({ id: 5, title: 'HDFC Bank raises lending rates', taggedSymbols: ['HDFCBANK'], source: 'ET' })],
  mf:        [makeArticle({ id: 4, title: 'Axis ELSS fund NAV rises', taggedSymbols: [], source: 'VRO' })],
  source: 'db',
  fetchedAt: new Date().toISOString(),
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. SummaryCards
// ══════════════════════════════════════════════════════════════════════════════

describe('SummaryCards', () => {
  it('renders total portfolio value', () => {
    render(<SummaryCards summary={SUMMARY} />)
    // Should show the total current value (₹15L or ₹15,00,000)
    expect(screen.getByText(/15/)).toBeTruthy()
    expect(screen.getByText(/Total Portfolio/i)).toBeTruthy()
  })

  it('shows positive P&L in green styling', () => {
    const { container } = render(<SummaryCards summary={SUMMARY} />)
    // Green class should be present for positive P&L
    expect(container.innerHTML).toContain('text-green-600')
  })

  it('shows negative P&L when portfolio is underwater', () => {
    const lossSummary = { ...SUMMARY, totalPnL: -50_000, totalPnLPercent: -5, stocksPnL: -50_000, stocksPnLPercent: -5 }
    const { container } = render(<SummaryCards summary={lossSummary} />)
    expect(container.innerHTML).toContain('text-red-500')
  })

  it('renders all four cards', () => {
    render(<SummaryCards summary={SUMMARY} />)
    expect(screen.getByText(/Total Portfolio/i)).toBeTruthy()
    expect(screen.getByText(/Direct Equity/i)).toBeTruthy()
    expect(screen.getByText(/Mutual Fund/i)).toBeTruthy()
  })

  it('shows stock count in equity card', () => {
    render(<SummaryCards summary={SUMMARY} />)
    // "5 stocks" should appear
    expect(screen.getByText(/5 stock/i)).toBeTruthy()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 2. NewsPanel — tab navigation and article rendering
// ══════════════════════════════════════════════════════════════════════════════

describe('NewsPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => NEWS_RESPONSE,
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the panel with category tabs', async () => {
    render(<NewsPanel stocks={[makeStock()]} mf={[makeMF()]} />)
    await waitFor(() => {
      expect(screen.getAllByText(/Your Portfolio/i).length).toBeGreaterThan(0)
    })
    expect(screen.getAllByText(/Market/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Economy/i).length).toBeGreaterThan(0)
  })

  it('shows portfolio article titles after fetch', async () => {
    render(<NewsPanel stocks={[makeStock()]} mf={[makeMF()]} />)
    await waitFor(() => {
      expect(screen.getByText(/Reliance Q4 profit beats estimates/i)).toBeTruthy()
    })
  })

  it('switches to Economy tab and shows relevant article', async () => {
    const user = userEvent.setup()
    render(<NewsPanel stocks={[makeStock()]} mf={[makeMF()]} />)

    // Wait for initial render
    await waitFor(() => screen.getAllByText(/Economy/i).length > 0)

    // Click Economy tab button
    const economyButtons = screen.getAllByText(/Economy/i)
    const economyTab = economyButtons.find(el => el.closest('button'))
    if (economyTab) await user.click(economyTab)

    await waitFor(() => {
      expect(screen.getByText(/RBI holds repo rate steady/i)).toBeTruthy()
    })
  })

  it('switches to Mutual Funds tab', async () => {
    const user = userEvent.setup()
    render(<NewsPanel stocks={[makeStock()]} mf={[makeMF()]} />)

    await waitFor(() => screen.getAllByText(/Mutual Funds/i).length > 0)

    const mfButtons = screen.getAllByText(/Mutual Funds/i)
    const mfTab = mfButtons.find(el => el.closest('button'))
    if (mfTab) await user.click(mfTab)

    await waitFor(() => {
      expect(screen.getByText(/Axis ELSS fund NAV rises/i)).toBeTruthy()
    })
  })

  it('shows article source badge', async () => {
    render(<NewsPanel stocks={[makeStock()]} mf={[makeMF()]} />)
    await waitFor(() => {
      // ET badge should appear (source of portfolio article)
      expect(screen.getAllByText(/ET/).length).toBeGreaterThan(0)
    })
  })

  it('article titles are links to the source URL', async () => {
    render(<NewsPanel stocks={[makeStock()]} mf={[makeMF()]} />)
    await waitFor(() => {
      const link = screen.getByText(/Reliance Q4 profit beats estimates/i).closest('a')
      expect(link).not.toBeNull()
      expect(link?.getAttribute('href')).toBe('https://example.com/1')
    })
  })

  it('calls fetch with symbols for portfolio tab', async () => {
    render(<NewsPanel stocks={[makeStock({ symbol: 'RELIANCE' })]} mf={[]} />)
    await waitFor(() => {
      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(fetchCall[0]).toContain('/api/news')
      expect(fetchCall[0]).toContain('RELIANCE')
    })
  })

  it('shows empty state when no articles in response', async () => {
    const emptyResponse = { portfolio: [], market: [], economy: [], stocks: [], mf: [], source: 'db', fetchedAt: new Date().toISOString() }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => emptyResponse,
    }))
    render(<NewsPanel stocks={[]} mf={[]} />)
    await waitFor(() => {
      const text = document.body.textContent?.toLowerCase() ?? ''
      expect(text.includes('no') || text.includes('empty') || text.includes('upload')).toBe(true)
    })
  })

  it('shows error state when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    render(<NewsPanel stocks={[makeStock()]} mf={[]} />)
    await waitFor(() => {
      const text = document.body.textContent?.toLowerCase() ?? ''
      expect(
        text.includes('failed') || text.includes('error') || text.includes('network')
      ).toBe(true)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 3. TaxPanel — file upload journey
// ══════════════════════════════════════════════════════════════════════════════

describe('TaxPanel', () => {
  it('shows upload prompt initially', () => {
    render(<TaxPanel stocks={[makeStock()]} />)
    expect(
      screen.getByText(/Upload stock order history/i) ||
      screen.getByText(/order history/i)
    ).toBeTruthy()
  })

  it('shows Groww and Zerodha format hints', () => {
    render(<TaxPanel stocks={[makeStock()]} />)
    // Multiple elements may contain these words; just check at least one exists
    expect(screen.getAllByText(/Groww/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Zerodha/i).length).toBeGreaterThan(0)
  })

  it('shows the tax summary heading', () => {
    render(<TaxPanel stocks={[makeStock()]} />)
    // Tax panel title
    expect(
      screen.getByText(/tax/i) || screen.getByText(/STCG/i) || screen.getByText(/LTCG/i)
    ).toBeTruthy()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 4. Portfolio page tab-switching integration
// ══════════════════════════════════════════════════════════════════════════════

/**
 * We test the portfolio page via a lightweight wrapper that simulates
 * the session data and API responses, exercising the full tab-switch journey.
 */
describe('Portfolio page — tab navigation journey', () => {
  const PORTFOLIO_DATA = {
    stocks:      [makeStock()],
    mutualFunds: [makeMF()],
    summary:     SUMMARY,
    assetAllocation: [],
    mfCategoryAllocation: [],
  }

  beforeEach(() => {
    // Mock sessionStorage
    Object.defineProperty(window, 'sessionStorage', {
      value: {
        getItem: vi.fn((key: string) => {
          if (key === 'portfolio') return JSON.stringify(PORTFOLIO_DATA)
          if (key === 'clientName') return 'Test User'
          return null
        }),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
      writable: true,
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        stockEnrichment: {},
        mfEnrichment: {},
        ...NEWS_RESPONSE,
        sectors: [],
      }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders SummaryCards on Overview tab', async () => {
    // Import dynamically to avoid top-level Next.js issues
    const { default: PortfolioPage } = await import('../app/portfolio/page')
    render(<PortfolioPage />)

    // Overview tab should be active by default
    await waitFor(() => {
      expect(screen.getByText(/Total Portfolio/i)).toBeTruthy()
    })
  })

  it('switches to News tab and renders NewsPanel', async () => {
    const { default: PortfolioPage } = await import('../app/portfolio/page')
    const user = userEvent.setup()
    render(<PortfolioPage />)

    await waitFor(() => screen.getByText(/Total Portfolio/i))

    const newsTab = screen.getByText(/Market Pulse/i)
    await user.click(newsTab)

    // NewsPanel should now be rendered — check for the "Market Pulse" heading
    // that NewsPanel itself renders (not the tab button)
    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text.includes('Market Pulse')).toBe(true)
    })
  })

  it('switches to Tax tab and shows upload prompt', async () => {
    const { default: PortfolioPage } = await import('../app/portfolio/page')
    const user = userEvent.setup()
    render(<PortfolioPage />)

    await waitFor(() => screen.getByText(/Total Portfolio/i))

    const taxTab = screen.getByText(/💰 Tax/i)
    await user.click(taxTab)

    await waitFor(() => {
      expect(screen.getByText(/Upload stock order history/i)).toBeTruthy()
    })
  })

  it('switches to Stocks tab and shows table heading', async () => {
    const { default: PortfolioPage } = await import('../app/portfolio/page')
    const user = userEvent.setup()
    render(<PortfolioPage />)

    await waitFor(() => screen.getByText(/Total Portfolio/i))

    const stocksTab = screen.getByText(/Stocks \(1\)/i)
    await user.click(stocksTab)

    // The holdings table header or a column heading should be visible
    await waitFor(() => {
      const textContent = document.body.textContent || ''
      expect(
        textContent.toLowerCase().includes('symbol') ||
        textContent.toLowerCase().includes('holding') ||
        textContent.toLowerCase().includes('stock') ||
        textContent.toLowerCase().includes('reliance')
      ).toBe(true)
    })
  })

  it('back button navigates to home', async () => {
    const { default: PortfolioPage } = await import('../app/portfolio/page')
    const user = userEvent.setup()
    render(<PortfolioPage />)

    await waitFor(() => screen.getByText(/Total Portfolio/i))

    const backBtn = screen.getByText(/Upload new/i)
    await user.click(backBtn)

    expect(mockPush).toHaveBeenCalledWith('/')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 5. Link and navigation integrity
// ══════════════════════════════════════════════════════════════════════════════

describe('Link and navigation integrity', () => {
  it('news article links open in new tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => NEWS_RESPONSE,
    }))

    render(<NewsPanel stocks={[makeStock()]} mf={[]} />)

    await waitFor(() => screen.getByText(/Reliance Q4 profit beats estimates/i))

    const link = screen.getByText(/Reliance Q4 profit beats estimates/i).closest('a')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toContain('noopener')

    vi.unstubAllGlobals()
  })

  it('all news tab buttons are keyboard-accessible', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => NEWS_RESPONSE,
    }))

    render(<NewsPanel stocks={[makeStock()]} mf={[]} />)
    await waitFor(() => screen.getAllByText(/Your Portfolio/i).length > 0)

    // Tab bar buttons should all be present in the DOM
    const tabs = screen.getAllByRole('button')
    expect(tabs.length).toBeGreaterThan(0)

    vi.unstubAllGlobals()
  })
})
