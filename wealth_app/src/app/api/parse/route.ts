import { NextRequest, NextResponse } from 'next/server'
import { parseGrowwStocks } from '@/lib/parsers/groww-stocks'
import { parseGrowwMF } from '@/lib/parsers/groww-mf'
import { buildParsedPortfolio } from '@/lib/portfolio'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const stocksFile = formData.get('stocks') as File | null
    const mfFile = formData.get('mf') as File | null

    if (!stocksFile && !mfFile) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 })
    }

    let stocks: any[] = []
    let mutualFunds: any[] = []
    let statementDate = ''
    let clientName = ''

    // Parse stocks file
    if (stocksFile) {
      const buffer = await stocksFile.arrayBuffer()
      const result = parseGrowwStocks(buffer)
      stocks = result.holdings
      statementDate = result.statementDate
      clientName = result.clientName
    }

    // Parse MF file
    if (mfFile) {
      const buffer = await mfFile.arrayBuffer()
      const result = parseGrowwMF(buffer)
      mutualFunds = result.holdings
      if (!statementDate) statementDate = result.statementDate
      if (!clientName) clientName = result.clientName
    }

    const portfolio = buildParsedPortfolio(stocks, mutualFunds, statementDate)

    return NextResponse.json({ portfolio, clientName })
  } catch (err: any) {
    console.error('Parse error:', err)
    return NextResponse.json(
      { error: err.message || 'Failed to parse files' },
      { status: 500 }
    )
  }
}
