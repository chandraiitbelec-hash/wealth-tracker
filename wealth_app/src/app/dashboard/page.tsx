'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { TrendingUp, Upload, LogOut, Trash2, ChevronRight, Plus } from 'lucide-react'
import { fmtCurrency } from '@/lib/portfolio'

interface SnapshotMeta {
  id: string
  name: string
  broker: string
  snapshot_date: string
  created_at: string
}

export default function DashboardPage() {
  const [user, setUser]           = useState<any>(null)
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [loading, setLoading]     = useState(true)
  const [deleting, setDeleting]   = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) { router.push('/login'); return }
      setUser(data.user)
    })

    fetch('/api/snapshots')
      .then(r => r.json())
      .then(d => setSnapshots(d.snapshots || []))
      .finally(() => setLoading(false))
  }, [])

  const handleSignOut = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const loadSnapshot = async (id: string) => {
    const res = await fetch(`/api/snapshots/${id}`)
    const { snapshot } = await res.json()
    sessionStorage.setItem('portfolio', JSON.stringify(snapshot.portfolio))
    sessionStorage.setItem('clientName', snapshot.name)
    router.push('/portfolio')
  }

  const deleteSnapshot = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this snapshot?')) return
    setDeleting(id)
    await fetch(`/api/snapshots/${id}`, { method: 'DELETE' })
    setSnapshots(s => s.filter(x => x.id !== id))
    setDeleting(null)
  }

  const displayName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'there'

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-gray-900">Wealth Tracker</span>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-8">
        {/* Greeting */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Hey, {displayName} 👋</h1>
          <p className="text-gray-500 mt-1 text-sm">Your saved portfolios are below. Upload a new one or pick up where you left off.</p>
        </div>

        {/* Upload CTA */}
        <button
          onClick={() => router.push('/')}
          className="w-full flex items-center justify-between bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl px-6 py-5 transition group"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
              <Plus className="w-5 h-5" />
            </div>
            <div className="text-left">
              <p className="font-semibold">Upload new statement</p>
              <p className="text-indigo-200 text-xs mt-0.5">Groww stocks + MF Excel files</p>
            </div>
          </div>
          <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
        </button>

        {/* Saved snapshots */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Saved Portfolios
          </h2>

          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full" />
            </div>
          )}

          {!loading && snapshots.length === 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-gray-400">
              <Upload className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No saved portfolios yet. Upload your first statement above.</p>
            </div>
          )}

          {!loading && snapshots.length > 0 && (
            <div className="space-y-3">
              {snapshots.map((s) => (
                <div
                  key={s.id}
                  onClick={() => loadSnapshot(s.id)}
                  className="bg-white rounded-2xl border border-gray-100 px-5 py-4 flex items-center gap-4 cursor-pointer hover:shadow-sm hover:border-indigo-200 transition group"
                >
                  <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center shrink-0">
                    <TrendingUp className="w-5 h-5 text-indigo-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {s.broker} · {new Date(s.snapshot_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={(e) => deleteSnapshot(s.id, e)}
                      disabled={deleting === s.id}
                      className="p-2 text-gray-300 hover:text-red-400 transition rounded-lg"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
