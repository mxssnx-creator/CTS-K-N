import { TestDashboard } from '@/components/test-dashboard'
import { PageHeader } from '@/components/page-header'

export const metadata = {
  title: 'Autotest & Debug',
  description: '20-Symbol Intense Retest Dashboard — live pipeline metrics and debug controls',
}

export default function TestPage() {
  return (
    <div className='flex flex-col flex-1 overflow-auto'>
      <PageHeader
        title='Autotest & Debug'
        description='20-symbol pipeline diagnostics'
      />
      <div className='page-content'>
        <TestDashboard />
      </div>
    </div>
  )
}
