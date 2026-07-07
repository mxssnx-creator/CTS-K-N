"use client"

import { Tabs, TabsContent } from "@/components/ui/tabs"
import { ReactNode } from "react"

interface StrategyTabWrapperProps {
  children: ReactNode
}

export function StrategyTabWrapper({ children }: StrategyTabWrapperProps) {
  return (
    <Tabs defaultValue="strategy">
      <TabsContent value="strategy" className="space-y-4">
        {children}
      </TabsContent>
    </Tabs>
  )
}
