'use client'

// OAuth 2.1 consent page — the application-side screen Supabase's OAuth
// server redirects to so the signed-in Guitar Tracker user can approve or
// deny an MCP client's (ChatGPT/Claude/etc.) request for access. This is
// NOT a custom OAuth implementation: Supabase Auth's own OAuth 2.1 server
// issues the authorization_id and the eventual tokens — this page only
// calls supabase.auth.oauth.getAuthorizationDetails/approveAuthorization/
// denyAuthorization and redirects to whatever URL Supabase returns. See
// supabase.com/docs/guides/auth/oauth-server/getting-started.
//
// Deliberately uses the SAME browser Supabase client (localStorage
// session) every other page in this app already uses — no server-side
// cookie session, no @supabase/ssr usage, no new auth infrastructure.
// auth.oauth.* is a plain method on the regular client; the only reason
// it needs an authenticated user at all is that Supabase itself requires
// a valid user access token to call it, exactly like any other
// `supabase.auth.*` call made from the browser today.

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

type OAuthAuthorizationClient = { id: string; name: string; uri: string; logo_uri: string }
type ConsentState =
  | { status: 'loading' }
  | { status: 'no_authorization_id' }
  | { status: 'error'; message: string }
  | { status: 'ready' | 'deciding'; client: OAuthAuthorizationClient; scopes: string[] }
  | { status: 'redirecting' }

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Confirm your identity',
  profile: 'View your basic profile',
  email: 'View your email address',
  phone: 'View your phone number',
  offline_access: 'Stay connected (refresh access without you signing in again)',
}

export default function OAuthConsentPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const authorizationId = searchParams.get('authorization_id')

  const [state, setState] = useState<ConsentState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function run() {
      if (!authorizationId) {
        setState({ status: 'no_authorization_id' })
        return
      }

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        const target = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`
        router.replace(`/login?redirect_to=${encodeURIComponent(target)}`)
        return
      }

      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
      if (cancelled) return

      if (error || !data) {
        setState({ status: 'error', message: 'This authorization link is invalid or has expired. Please return to the app you were connecting and try again.' })
        return
      }

      if ('redirect_url' in data) {
        // Already consented to these exact scopes — redirect immediately, per Supabase's own documented behavior.
        setState({ status: 'redirecting' })
        window.location.href = data.redirect_url
        return
      }

      setState({ status: 'ready', client: data.client, scopes: data.scope.split(' ').filter(Boolean) })
    }

    run().catch(() => { if (!cancelled) setState({ status: 'error', message: 'Something went wrong loading this authorization request.' }) })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorizationId])

  async function decide(decision: 'approve' | 'deny') {
    if (!authorizationId || state.status !== 'ready') return
    const { client, scopes } = state
    setState({ status: 'deciding', client, scopes })
    try {
      const { data, error } = decision === 'approve'
        ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })

      if (error || !data) {
        setState({ status: 'error', message: 'Could not record your decision. Please try again.' })
        return
      }
      setState({ status: 'redirecting' })
      window.location.href = data.redirect_url
    } catch {
      setState({ status: 'error', message: 'Could not record your decision. Please try again.' })
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-900">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Authorize access</h1>

        {(state.status === 'loading' || state.status === 'redirecting') && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {state.status === 'redirecting' ? 'Redirecting…' : 'Loading…'}
          </p>
        )}

        {state.status === 'no_authorization_id' && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            There is nothing to authorize here. Start this connection from the app you want to connect to Guitar Tracker.
          </p>
        )}

        {state.status === 'error' && (
          <p className="text-sm text-rose-600 dark:text-rose-400">{state.message}</p>
        )}

        {(state.status === 'ready' || state.status === 'deciding') && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              <span className="font-semibold text-slate-900 dark:text-white">{state.client.name}</span>{' '}
              wants to access your Guitar Tracker data.
            </p>

            {state.scopes.length > 0 && (
              <ul className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-700/50 dark:text-slate-200">
                {state.scopes.map((scope) => (
                  <li key={scope} className="flex items-start gap-2">
                    <span aria-hidden className="mt-0.5 text-slate-400">•</span>
                    <span>{SCOPE_LABELS[scope] ?? scope}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                disabled={state.status === 'deciding'}
                onClick={() => decide('deny')}
                className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
              >
                Deny
              </button>
              <button
                type="button"
                disabled={state.status === 'deciding'}
                onClick={() => decide('approve')}
                className="flex-1 rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
              >
                {state.status === 'deciding' ? 'Please wait…' : 'Approve'}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
