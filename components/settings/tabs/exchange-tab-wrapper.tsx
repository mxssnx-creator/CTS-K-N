"use client"

import { Tabs, TabsContent } from "@/components/ui/tabs"
import { ReactNode } from "react"

interface ExchangeTabWrapperProps {
  children: ReactNode
}

export function ExchangeTabWrapper({ children }: ExchangeTabWrapperProps) {
  return (
    <Tabs defaultValue="exchange">
      <TabsContent value="exchange" className="space-y-4">
        {children}
      </TabsContent>
    </Tabs>
  )
}
