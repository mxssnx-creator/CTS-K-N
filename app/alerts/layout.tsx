import type React from "react"
import { SectionShell } from "@/components/section-shell"

export default function Layout({ children }: { children: React.ReactNode }) {
  return <SectionShell>{children}</SectionShell>
}
