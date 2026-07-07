import { TestDashboard } from '@/components/test-dashboard'

export const metadata = {
  title: 'Autotest & Debug',
  description: '20-Symbol Intense Retest Dashboard — live pipeline metrics and debug controls',
}

export default function TestPage() {
  return (
    <div className='flex flex-col flex-1 overflow-auto'>
      <div className='p-6'>
        <div className='mb-6'>
          <h1 className='text-3xl font-bold'>Autotest &amp; Debug</h1>
          <p className='text-muted-foreground mt-1 text-sm'>
            Intense retest — 20 symbols, raised caps (axis 10 000, real 20 000, live 750).
            Live metrics poll every 2 s.
          </p>
        </div>

        <TestDashboard />
      </div>
    </div>
  )
}
