"use client"

import { Tabs, TabsContent } from "@/components/ui/tabs"
import { ReactNode } from "react"

interface IndicationTabWrapperProps {
  children: ReactNode
}

export function IndicationTabWrapper({ children }: IndicationTabWrapperProps) {
  return (
    <Tabs defaultValue="indication">
      <TabsContent value="indication" className="space-y-4">
        {children}
      </TabsContent>
    </Tabs>
  )
}
