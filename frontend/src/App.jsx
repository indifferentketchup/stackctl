import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout.jsx'
import { HomePage } from '@/pages/HomePage.jsx'
import { PersonasPage } from '@/pages/PersonasPage.jsx'
import { PlaceholderPage } from '@/pages/PlaceholderPage.jsx'
import { MachinesPage } from '@/pages/MachinesPage.jsx'
import { BifrostPage } from '@/pages/BifrostPage.jsx'
import { LlamaSwapPage } from '@/pages/LlamaSwapPage.jsx'
import { AgentsPage } from '@/pages/AgentsPage.jsx'
import { AgentEditorPage } from '@/pages/AgentEditorPage.jsx'
import { FlowsPage } from '@/pages/FlowsPage.jsx'
import { FlowEditorPage } from '@/pages/FlowEditorPage.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/personas" element={<PersonasPage />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/bifrost" element={<BifrostPage />} />
          <Route path="/llamaswap/:machineId" element={<LlamaSwapPage />} />
          <Route path="/rag" element={<PlaceholderPage title="RAG" phase="Phase 6" />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<AgentEditorPage />} />
          <Route path="/agents/:id" element={<AgentEditorPage />} />
          <Route path="/flows" element={<FlowsPage />} />
          <Route path="/flows/new" element={<FlowEditorPage />} />
          <Route path="/flows/:id" element={<FlowEditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
