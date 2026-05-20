'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function LoginPage() {
  const router = useRouter()

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

    router.push('/')
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={handleLogin} className="w-full max-w-sm space-y-4 rounded border p-6">
        <h1 className="text-2xl font-bold">Login</h1>

        <input
          className="w-full rounded border px-3 py-2"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          className="w-full rounded border px-3 py-2"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

        <button className="w-full rounded bg-black px-4 py-2 text-white" type="submit">
          Login
        </button>
      </form>
    </main>
  )
}