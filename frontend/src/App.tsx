import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { Dashboard } from './pages/Dashboard';
import { IncidentDetailPage } from './pages/IncidentDetail';
import { useWsStore } from './store/wsStore';

export default function App() {
  const connect = useWsStore((s) => s.connect);
  useEffect(() => { connect(); }, [connect]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/incidents/:id" element={<IncidentDetailPage />} />
      </Routes>
    </BrowserRouter>
  );
}
