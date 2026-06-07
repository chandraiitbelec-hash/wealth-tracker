import { NextRequest, NextResponse } from 'next/server'
import { parseGrowwStocks } from '@/lib/parsers/groww-stocks'
import { parseGrowwMF } from '@/lib/parsers/groww-mf'
import { parseZerodhaStocks, isZerodhaStocksFile } from '@/lib/parsers/zerodha-stocks'
import { parseZerodhaFunds, isZerodhaFundFile } from '@/lib/parsers/zerodha-mf'
import { parseMFTransactions, summariseELSSForFY } from '@/lib/parsers/mf-transactions'
import { buildParsedPortfolio } from '@/lib/portfolio'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const stocksFile      = formData.get('stocks')       as File | null
    const mfFile          = formData.get('mf')           as File | null
    const transactionsFile = formData.get('transactions') as File | null

    if (!stocksFile && !mfFile) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 })
    }

    let stocks: any[] = []
    let mutualFunds: any[] = []
    let statementDate = ''
    let clientName = ''
    let broker = 'Groww'
    let fyData: any = null

    // Parse stocks file — auto-detect broker format
    if (stocksFile) {
      const buffer = await stocksFile.arrayBuffer()
      if (isZerodhaStocksFile(buffer)) {
        broker = 'Zerodha'
        const result = parseZerodhaStocks(buffer)
        stocks = result.holdings
        clientName = result.clientName
      } else {
        const result = parseGrowwStocks(buffer)
        stocks = result.holdings
        statementDate = result.statementDate
        clientName = result.clientName
      }
    }

    // Parse MF file — auto-detect Zerodha P&L vs Groww holdings
    if (mfFile) {
      const buffer = await mfFile.arrayBuffer()
      if (isZerodhaFundFile(buffer)) {
        broker = 'Zerodha'
        const result = parseZerodhaFunds(buffer)
        mutualFunds = result.holdings
        if (!clientName && result.clientId) clientName = result.clientId
        // Zerodha P&L file also contains FY-specific buy data for ELSS
        if (result.fyData) {
          fyData = {
            financialYear:    result.fyData.financialYear,
            elssInvestedInFY: result.fyData.elssInvestedInFY,
            elssFunds:        result.fyData.elssFunds,
            periodStart:      result.fyData.periodStart,
            periodEnd:        result.fyData.periodEnd,
            isFullFY:         result.fyData.isFullFY,
          }
        }
      } else {
        const result = parseGrowwMF(buffer)
        mutualFunds = result.holdings
        if (!statementDate) statementDate = result.statementDate
        if (!clientName) clientName = result.clientName
      }
    }

    // Optional separate transaction file (Groww CSV format) — overrides fyData from P&L if provided
    if (transactionsFile) {
      try {
        const buffer = await transactionsFile.arrayBuffer()
        const transactions = parseMFTransactions(buffer)
        const summary = summariseELSSForFY(transactions)
        const { allTransactions: _, ...rest } = summary
        fyData = rest
      } catch (txErr) {
        console.warn('Transaction parse failed (non-fatal):', txErr)
      }
    }

    const portfolio = buildParsedPortfolio(stocks, mutualFunds, statementDate)

    return NextResponse.json({ portfolio, clientName, broker, fyData })
  } catch (err: any) {
    console.error('Parse error:', err)
    return NextResponse.json(
      { error: err.message || 'Failed to parse files' },
      { status: 500 }
    )
  }
}
