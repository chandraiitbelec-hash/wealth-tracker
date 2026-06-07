'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import UploadZone from '@/components/UploadZone'
import { createClient } from '@/lib/supabase/client'

export default function Home() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)
  const [savingSnapshot, setSavingSnapshot] = useState(false)
  const router = useRouter()

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setLoggedIn(!!data.user))
  }, [])

  const handleAnalyse = async (stocks: File | null, mf: File | null, transactions: File | null) => {
    setLoading(true)
    setError(null)
    try {
      const form = new FormData()
      if (stocks) form.append('stocks', stocks)
      if (mf) form.append('mf', mf)
      if (transactions) form.append('transactions', transactions)

      const res = await fetch('/api/parse', { method: 'POST', body: form })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Failed to parse')

      sessionStorage.setItem('portfolio', JSON.stringify(data.portfolio))
      sessionStorage.setItem('clientName', data.clientName || '')
      if (data.fyData) sessionStorage.setItem('fyData', JSON.stringify(data.fyData))
      else sessionStorage.removeItem('fyData')

      // If logged in, auto-save snapshot in background
      const { data: { user } } = await createClient().auth.getUser()
      if (user) {
        setSavingSnapshot(true)
        try {
          await fetch('/api/snapshots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: data.clientName || `Upload ${new Date().toLocaleDateString('en-IN')}`,
              broker: data.broker || 'Groww',
              portfolio: data.portfolio,
            }),
          })
        } catch { /* best-effort */ } finally {
          setSavingSnapshot(false)
        }
      }

      router.push('/portfolio')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 flex flex-col items-center justify-center px-4 py-16">
      <div className="text-center mb-12">
        <div className="inline-flex items-center gap-2 bg-indigo-50 text-indigo-600 text-xs font-semibold px-3 py-1.5 rounded-full mb-6">
          <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse" />
          Early Access
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4 leading-tight">
          Your wealth,<br />
          <span className="text-indigo-600">one clear picture.</span>
        </h1>
        <p className="text-gray-500 max-w-md mx-auto text-base leading-relaxed">
          Upload your Groww or Zerodha holdings statements to get a unified view of your
          stocks and mutual funds — no account linking needed.
        </p>
      </div>

      <UploadZone onAnalyse={handleAnalyse} loading={loading} />

      {error && (
        <div className="mt-6 bg-red-50 text-red-600 border border-red-200 rounded-xl px-4 py-3 text-sm max-w-md w-full text-center">
          {error}
        </div>
      )}

      {/* Auth link */}
      <div className="mt-6 text-sm text-gray-500">
        {loggedIn ? (
          <Link href="/dashboard" className="text-indigo-600 font-medium hover:underline">
            ← Back to dashboard
          </Link>
        ) : (
          <span>
            Have an account?{' '}
            <Link href="/login" className="text-indigo-600 font-medium hover:underline">Sign in</Link>
            {' '}to save your portfolio.
          </span>
        )}
      </div>

      <div className="mt-12 text-center">
        <p className="text-xs text-gray-400 mb-3">Supported brokers</p>
        <div className="flex items-center gap-3 justify-center flex-wrap">
          <span className="bg-white border border-gray-200 text-gray-600 text-xs font-medium px-3 py-1.5 rounded-lg shadow-sm">
            Groww ✓
          </span>
          <span className="bg-white border border-gray-200 text-gray-600 text-xs font-medium px-3 py-1.5 rounded-lg shadow-sm">
            Zerodha ✓
          </span>
          <span className="bg-gray-100 text-gray-400 text-xs font-medium px-3 py-1.5 rounded-lg">
            Kuvera — coming soon
          </span>
        </div>
      </div>
    </main>
  )
}
