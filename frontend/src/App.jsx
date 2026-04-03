import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout.jsx'
import { HomePage } from '@/pages/HomePage.jsx'
import { ModelsPage } from '@/pages/ModelsPage.jsx'
import { RunningModelsPage } from '@/pages/RunningModelsPage.jsx'
import { ModelfilePage } from '@/pages/ModelfilePage.jsx'
import { ImportPage } from '@/pages/ImportPage.jsx'
import { PersonasPage } from '@/pages/PersonasPage.jsx'
import { PlaceholderPage } from '@/pages/PlaceholderPage.jsx'
import { GpuPage } from '@/pages/GpuPage.jsx'
import { MachinesPage } from '@/pages/MachinesPage.jsx'
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
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/running" element={<RunningModelsPage />} />
          <Route path="/models/create" element={<ModelfilePage />} />
          <Route path="/models/:name" element={<ModelfilePage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/personas" element={<PersonasPage />} />
          <Route path="/gpu" element={<GpuPage />} />
          <Route path="/machines" element={<MachinesPage />} />
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
