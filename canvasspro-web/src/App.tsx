import { Routes, Route, Navigate } from "react-router-dom";
import ProtectedRoute from "./auth/ProtectedRoute";
import Layout from "./components/Layout";
import { useAuth } from "./auth/AuthContext";
import { hasFeature, type FeatureKey } from "./lib/features";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Lookup from "./pages/Lookup";
import Leads from "./pages/Leads";
import Territories from "./pages/Territories";
import MapPage from "./pages/Map";
import Movers from "./pages/Movers";
import Team from "./pages/Team";
import Shifts from "./pages/Shifts";
import Leaderboard from "./pages/Leaderboard";
import Gamify from "./pages/Gamify";
import Rewards from "./pages/Rewards";
import Working from "./pages/Working";
import Chat from "./pages/Chat";
import Schedule from "./pages/Schedule";
import Settings from "./pages/Settings";

// Blocks a route (by direct URL) when the company's plan doesn't include it.
// Pass one feature, or `anyOf` to allow access when the plan has any of them.
function Gated({
  feature,
  anyOf,
  children,
}: {
  feature?: FeatureKey;
  anyOf?: FeatureKey[];
  children: React.ReactNode;
}) {
  const { company } = useAuth();
  const keys = anyOf ?? (feature ? [feature] : []);
  const allowed = keys.some((k) => hasFeature(company, k));
  return allowed ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="lookup" element={<Lookup />} />
        <Route path="leads" element={<Leads />} />
        <Route path="map" element={<MapPage />} />
        <Route path="movers" element={<Movers />} />
        <Route path="team" element={<Team />} />
        <Route path="shifts" element={<Gated anyOf={["planner", "analytics"]}><Shifts /></Gated>} />
        {/* Analytics merged into the Success Planner screen; keep the old path working. */}
        <Route path="stats" element={<Navigate to="/shifts" replace />} />
        <Route path="leaderboard" element={<Gated feature="rewards"><Leaderboard /></Gated>} />
        <Route path="gamify" element={<Gated feature="rewards"><Gamify /></Gated>} />
        <Route path="rewards" element={<Gated feature="rewards"><Rewards /></Gated>} />
        <Route path="working" element={<Gated feature="chat"><Working /></Gated>} />
        <Route path="chat" element={<Gated feature="chat"><Chat /></Gated>} />
        <Route path="schedule" element={<Gated feature="scheduling"><Schedule /></Gated>} />
        <Route path="territories" element={<Territories />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
