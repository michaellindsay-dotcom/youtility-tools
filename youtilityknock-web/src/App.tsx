import { Routes, Route, Navigate } from "react-router-dom";
import ProtectedRoute from "./auth/ProtectedRoute";
import Layout from "./components/Layout";
import { useAuth } from "./auth/AuthContext";
import { userHasService, type FeatureKey } from "./lib/features";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Lookup from "./pages/Lookup";
import Leads from "./pages/Leads";
import Territories from "./pages/Territories";
import MapPage from "./pages/Map";
import Movers from "./pages/Movers";
import Team from "./pages/Team";
import Reports from "./pages/Reports";
import Closer from "./pages/Closer";
import BatteryTool from "./pages/BatteryTool";
import Projects from "./pages/Projects";
import Pitches from "./pages/Pitches";
import Training from "./pages/Training";
import PitchLibrary from "./pages/PitchLibrary";
import Shifts from "./pages/Shifts";
import Leaderboard from "./pages/Leaderboard";
import Gamify from "./pages/Gamify";
import Rewards from "./pages/Rewards";
import Working from "./pages/Working";
import Chat from "./pages/Chat";
import Schedule from "./pages/Schedule";
import Settings from "./pages/Settings";
import BusinessCard from "./pages/BusinessCard";

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
  const { company, profile, team } = useAuth();
  const keys = anyOf ?? (feature ? [feature] : []);
  // Honor the SAME effective access the sidebar uses (company plan + the user's
  // role/position + team services), so a service deactivated for this role can't
  // be reached by typing its URL — it's hidden entirely, not just from the nav.
  const allowed = keys.some((k) => userHasService(company, profile, team, k));
  return allowed ? <>{children}</> : <Navigate to="/" replace />;
}

// Gates a route to specific roles (e.g. managers + admins only).
function RoleGate({ allow, children }: { allow: ("admin" | "manager")[]; children: React.ReactNode }) {
  const { role } = useAuth();
  return role && allow.includes(role as "admin" | "manager") ? <>{children}</> : <Navigate to="/" replace />;
}

// Gates a route to closers (closers, closer managers, team managers — all carry
// isCloser — plus admins). A SETTER manager is intentionally excluded so closer
// tools/data stay hidden from the setter org.
function CloserGate({ children }: { children: React.ReactNode }) {
  const { profile, role } = useAuth();
  const allowed = profile?.isCloser || role === "admin";
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
        <Route path="reports" element={<RoleGate allow={["admin", "manager"]}><Reports /></RoleGate>} />
        <Route path="closer" element={<CloserGate><Closer /></CloserGate>} />
        <Route path="battery" element={<CloserGate><BatteryTool /></CloserGate>} />
        <Route path="projects" element={<CloserGate><Projects /></CloserGate>} />
        <Route path="pitches" element={<Gated feature="pitch"><Pitches /></Gated>} />
        <Route path="training" element={<Training />} />
        <Route path="pitch-library" element={<Gated feature="pitch"><RoleGate allow={["admin", "manager"]}><PitchLibrary /></RoleGate></Gated>} />
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
        <Route path="card" element={<BusinessCard />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
