import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout.jsx'
import { HomePage } from '@/pages/HomePage.jsx'
import { ModelsPage } from '@/pages/ModelsPage.jsx'
import { RunningModelsPage } from '@/pages/RunningModelsPage.jsx'
import { ModelfilePage } from '@/pages/ModelfilePage.jsx'
import { PlaceholderPage } from '@/pages/PlaceholderPage.jsx'

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
          <Route
            path="/import"
            element={<PlaceholderPage title="Import Model" phase="Phase 4" />}
          />
          <Route
            path="/personas"
            element={<PlaceholderPage title="Personas" phase="Phase 3" />}
          />
          <Route path="/gpu" element={<PlaceholderPage title="Multi-GPU" phase="Phase 5" />} />
          <Route path="/rag" element={<PlaceholderPage title="RAG" phase="Phase 6" />} />
          <Route path="/agents" element={<PlaceholderPage title="Agents" phase="Phase 7" />} />
          <Route path="/agents/new" element={<PlaceholderPage title="New Agent" phase="Phase 7" />} />
          <Route path="/agents/:id" element={<PlaceholderPage title="Agent" phase="Phase 7" />} />
          <Route path="/flows" element={<PlaceholderPage title="Flows" phase="Phase 8" />} />
          <Route path="/flows/new" element={<PlaceholderPage title="New Flow" phase="Phase 8" />} />
          <Route path="/flows/:id" element={<PlaceholderPage title="Flow" phase="Phase 8" />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
