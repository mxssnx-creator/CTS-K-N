"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from "react"

interface User {
  id: number | string
  username: string
  email: string
  role: string
}

interface AuthContextType {
  user: User | null
  token: string | null
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  register: (username: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>
  logout: () => void
  isLoading: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  // The server keeps the JWT in an HTTP-only cookie. This state is only a
  // response token for compatibility with existing consumers; it is never
  // used as a browser credential or treated as proof of authentication.
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void fetch("/api/auth/me", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!cancelled && response.ok && payload?.success && payload?.data?.user) {
          setUser(payload.data.user)
        }
      })
      .catch(() => {
        // An unavailable session endpoint is treated as signed out. Protected
        // mutations still enforce authentication on the server.
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const login = async (email: string, password: string) => {
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload?.success || !payload?.data?.user) {
        return { success: false, error: payload?.error || "Login failed" }
      }
      setUser(payload.data.user)
      setToken(typeof payload.data.token === "string" ? payload.data.token : null)
      return { success: true }
    } catch {
      return { success: false, error: "Login service unavailable" }
    }
  }

  const register = async (username: string, email: string, password: string) => {
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload?.success || !payload?.data?.user) {
        return { success: false, error: payload?.error || "Registration failed" }
      }
      setUser(payload.data.user)
      setToken(typeof payload.data.token === "string" ? payload.data.token : null)
      return { success: true }
    } catch {
      return { success: false, error: "Registration service unavailable" }
    }
  }

  const logout = () => {
    void fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined)
    setUser(null)
    setToken(null)
  }

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, isLoading }}>{children}</AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
