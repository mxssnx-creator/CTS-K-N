"use client"

import { Tabs, TabsContent } from "@/components/ui/tabs"
import { ReactNode } from "react"

interface SystemTabWrapperProps {
  children: ReactNode
}

export function SystemTabWrapper({ children }: SystemTabWrapperProps) {
  return (
    <Tabs defaultValue="system">
      <TabsContent value="system" className="space-y-4">
        {children}
      </TabsContent>
    </Tabs>
  )
}
