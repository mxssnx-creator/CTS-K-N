"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-2 group-[.toaster]:border-border group-[.toaster]:shadow-2xl opacity-100 backdrop-blur-sm backdrop-saturate-150",
          description: "group-[.toast]:text-muted-foreground opacity-100",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground opacity-100",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground opacity-100",
          error:
            "group toast group-[.toaster]:bg-red-600 group-[.toaster]:text-white opacity-100 group-[.toaster]:border-2 group-[.toaster]:border-red-700 group-[.toaster]:shadow-2xl backdrop-blur-sm backdrop-saturate-150",
          success:
            "group toast group-[.toaster]:bg-green-600 group-[.toaster]:text-white opacity-100 group-[.toaster]:border-2 group-[.toaster]:border-green-700 group-[.toaster]:shadow-2xl backdrop-blur-sm backdrop-saturate-150",
          warning:
            "group toast group-[.toaster]:bg-yellow-600 group-[.toaster]:text-white opacity-100 group-[.toaster]:border-2 group-[.toaster]:border-yellow-700 group-[.toaster]:shadow-2xl backdrop-blur-sm backdrop-saturate-150",
          info: "group toast group-[.toaster]:bg-blue-600 group-[.toaster]:text-white opacity-100 group-[.toaster]:border-2 group-[.toaster]:border-blue-700 group-[.toaster]:shadow-2xl backdrop-blur-sm backdrop-saturate-150",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
