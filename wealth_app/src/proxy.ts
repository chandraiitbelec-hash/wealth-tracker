import { NextResponse, type NextRequest } from 'next/server'

/**
 * Optimistic auth check — reads the Supabase session cookie directly
 * without making a network call to Supabase (as recommended by Next.js 16 docs).
 * Full session verification happens inside each page/API route.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Check for Supabase session cookie (optimistic — not cryptographically verified here)
  const hasSession = request.cookies.getAll().some(c =>
    c.name.startsWith('sb-') && c.name.endsWith('-auth-token')
  )

  // Protect /portfolio and /dashboard
  const protectedRoutes = ['/portfolio', '/dashboard']
  const isProtected = protectedRoutes.some(r => pathname.startsWith(r))

  if (isProtected && !hasSession) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Already logged in — redirect away from auth pages
  if (hasSession && (pathname === '/login' || pathname === '/signup')) {
    const dashUrl = request.nextUrl.clone()
    dashUrl.pathname = '/dashboard'
    return NextResponse.redirect(dashUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/|auth/).*)',
  ],
}
