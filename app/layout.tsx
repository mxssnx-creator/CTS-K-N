import type { Metadata, Viewport } from "next"
import "./globals.css"
import { Providers } from "@/components/providers"
import { IndicationGeneratorProvider } from "@/components/indication-generator-hook"
import { EngineAutoInitializer } from "@/components/engine-auto-initializer"

// Build timestamp: 2026-04-10T13:07
export const metadata: Metadata = {
  title: {
    default: "CTS-K-N Control Plane",
    template: "%s · CTS-K-N",
  },
  description: "Multi-exchange trading, progression, execution, and observability control plane.",
  applicationName: "CTS-K-N",
  category: "finance",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-light-32x32.png", type: "image/png", sizes: "32x32", media: "(prefers-color-scheme: light)" },
      { url: "/icon-dark-32x32.png", type: "image/png", sizes: "32x32", media: "(prefers-color-scheme: dark)" },
    ],
    shortcut: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon.png", type: "image/png", sizes: "180x180" }],
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f7f8" },
    { media: "(prefers-color-scheme: dark)", color: "#08131f" },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning className="bg-background">
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
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
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
