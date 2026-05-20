'use client'

import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function LogoutButton() {
  const router = useRouter()

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <button
      onClick={handleLogout}
      className="text-sm text-slate-600 hover:text-slate-900"
    >
      Logout
    </button>
  )
}