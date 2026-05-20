'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function checkUser() {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session && pathname !== '/login') {
        router.push('/login')
        return
      }

      setLoading(false)
    }

    checkUser()
  }, [pathname, router])

  if (loading && pathname !== '/login') {
    return <div className="p-6">Loading...</div>
  }

  return <>{children}</>
}