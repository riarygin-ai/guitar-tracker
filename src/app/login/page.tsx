'use client'

export const dynamic = 'force-dynamic'
import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { safeLoginRedirect } from '@/lib/oauthConsentReturn'

// useSearchParams() requires a Suspense boundary for the production build's
// prerender step (Next.js' own requirement — unrelated to this page's auth
// logic). The form below is unchanged; only split out so the boundary can
// wrap just the part that reads the query string.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErrorMessage('')

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      setErrorMessage(error.message)
      return
    }

    // Only ever honors an internal /oauth/consent target (OAuth consent
    // flow) — see oauthConsentReturn.ts. Anything else falls back to '/'.
    router.push(safeLoginRedirect(searchParams.get('redirect_to')) ?? '/')
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-900">
      <form onSubmit={handleLogin} className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Login</h1>

        <input
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

        <button className="w-full rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100" type="submit">
          Login
        </button>
      </form>
    </main>
  )
}
