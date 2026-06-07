'use client'

import { useState, useRef } from 'react'
import { Upload, FileSpreadsheet, X, CheckCircle2 } from 'lucide-react'

interface FileUploadProps {
  label: string
  description: string
  accept?: string
  file: File | null
  onFile: (f: File | null) => void
}

function FileUpload({ label, description, accept = '.xlsx,.xls,.csv', file, onFile }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) onFile(dropped)
  }

  return (
    <div
      className={`relative border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all duration-200
        ${dragging ? 'border-indigo-400 bg-indigo-50' : file ? 'border-green-400 bg-green-50' : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50'}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />

      {file ? (
        <div className="flex items-center justify-center gap-3">
          <CheckCircle2 className="text-green-500 w-6 h-6 shrink-0" />
          <div className="text-left">
            <p className="font-medium text-green-700 text-sm">{file.name}</p>
            <p className="text-xs text-green-500">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
          <button
            className="ml-auto p-1 rounded-full hover:bg-green-200 transition"
            onClick={(e) => { e.stopPropagation(); onFile(null) }}
          >
            <X className="w-4 h-4 text-green-600" />
          </button>
        </div>
      ) : (
        <>
          <div className="flex justify-center mb-3">
            <div className="p-3 rounded-xl bg-indigo-100">
              <FileSpreadsheet className="w-7 h-7 text-indigo-500" />
            </div>
          </div>
          <p className="font-semibold text-gray-700 mb-1">{label}</p>
          <p className="text-xs text-gray-400">{description}</p>
          <p className="mt-3 text-xs text-indigo-500 font-medium">
            <Upload className="inline w-3 h-3 mr-1" />
            Click or drag & drop
          </p>
        </>
      )}
    </div>
  )
}

interface UploadZoneProps {
  onAnalyse: (stocks: File | null, mf: File | null) => void
  loading: boolean
}

export default function UploadZone({ onAnalyse, loading }: UploadZoneProps) {
  const [stocksFile, setStocksFile] = useState<File | null>(null)
  const [mfFile, setMfFile] = useState<File | null>(null)

  const canAnalyse = stocksFile || mfFile

  return (
    <div className="w-full max-w-3xl mx-auto space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FileUpload
          label="Stocks Holdings"
          description="Groww equity holdings statement (.xlsx)"
          file={stocksFile}
          onFile={setStocksFile}
        />
        <FileUpload
          label="Mutual Funds Holdings"
          description="Groww MF holdings statement (.xlsx)"
          file={mfFile}
          onFile={setMfFile}
        />
      </div>

      <button
        disabled={!canAnalyse || loading}
        onClick={() => onAnalyse(stocksFile, mfFile)}
        className={`w-full py-4 rounded-2xl font-semibold text-white text-sm tracking-wide transition-all duration-200
          ${canAnalyse && !loading
            ? 'bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 hover:shadow-indigo-300'
            : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Analysing your portfolio...
          </span>
        ) : (
          'Analyse Portfolio →'
        )}
      </button>

      <p className="text-center text-xs text-gray-400">
        Your files are parsed locally and never stored. Upload either or both files.
      </p>
    </div>
  )
}
