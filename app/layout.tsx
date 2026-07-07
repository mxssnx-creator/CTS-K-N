import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "@/components/providers"
import { IndicationGeneratorProvider } from "@/components/indication-generator-hook"
import { EngineAutoInitializer } from "@/components/engine-auto-initializer"

// Build timestamp: 2026-04-10T13:07
export const metadata: Metadata = {
  title: "CTS v3.2 Dashboard",
  description: "Crypto Trading System Dashboard",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <EngineAutoInitializer />
        <Providers>
          <IndicationGeneratorProvider>
            {children}
          </IndicationGeneratorProvider>
        </Providers>
      </body>
    </html>
  )
}
