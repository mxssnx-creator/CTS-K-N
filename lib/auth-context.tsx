"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from "react"

interface User {
  id: number
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
  const [user, setUser] = useState<User | null>({
    id: 1,
    username: "Administrator",
    email: "mxssnx@gmail.com",
    role: "admin",
  })
  const [token, setToken] = useState<string | null>("admin-token-disabled")
  const [isLoading, setIsLoading] = useState(false) // Initialize to false - user is always logged in

  useEffect(() => {
    // User is pre-initialized as admin, so loading is complete immediately
    setIsLoading(false)
  }, [])

  const login = async (email: string, password: string) => {
    setUser({
      id: 1,
      username: "Administrator",
      email: "mxssnx@gmail.com",
      role: "admin",
    })
    setToken("admin-token-disabled")
    return { success: true }
  }

  const register = async (username: string, email: string, password: string) => {
    setUser({
      id: 1,
      username: "Administrator",
      email: "mxssnx@gmail.com",
      role: "admin",
    })
    setToken("admin-token-disabled")
    return { success: true }
  }

  const logout = () => {
    // User remains logged in as admin
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
