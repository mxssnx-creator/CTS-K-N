import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "@/components/providers"
import { IndicationGeneratorProvider } from "@/components/indication-generator-hook"
import { EngineAutoInitializer } from "@/components/engine-auto-initializer"

// Build timestamp: 2026-04-10T13:07
export const metadata: Metadata = {
  title: "CTS-K-N",
  description: "Trading control",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * Kilo/OpenNext currently transforms the inline next-themes bootstrap
         * with esbuild's `__name(...)` helper but does not always inject the
         * helper itself. Define the identity helper before Providers mounts so
         * theme startup cannot abort with `ReferenceError: __name is not
         * defined`. The tiny shim is inert on runtimes that already provide it.
         */}
        <script
          id="kilo-esbuild-name-shim"
          dangerouslySetInnerHTML={{
            __html: "globalThis.__name ||= function(target){return target}",
          }}
        />
      </head>
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
