import { Outlet } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar.jsx'

export function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-x-hidden p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  )
}
