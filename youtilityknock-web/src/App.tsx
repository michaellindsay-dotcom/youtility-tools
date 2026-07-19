import { useEffect } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import ProtectedRoute from "./auth/ProtectedRoute";
import Layout from "./components/Layout";
import { useAuth } from "./auth/AuthContext";
import { initPush, teardownPush } from "./lib/push";
import { userHasService, isRallyCardOnly, type FeatureKey } from "./lib/features";
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
import ThrowDowns from "./pages/ThrowDowns";
import Working from "./pages/Working";
import Chat from "./pages/Chat";
import Schedule from "./pages/Schedule";
import Scheduler from "./pages/Scheduler";
import Settings from "./pages/Settings";
import BusinessCard from "./pages/BusinessCard";
import CustomerLead from "./pages/CustomerLead";
import Inbox from "./pages/Inbox";

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
  const { company, profile, team, companyServices } = useAuth();
  const keys = anyOf ?? (feature ? [feature] : []);
  // Honor the SAME effective access the sidebar uses (company plan + company-wide
  // baseline + the user's role/position + team services), so a service
  // deactivated can't be reached by typing its URL — it's hidden entirely.
  const allowed = keys.some((k) => userHasService(company, profile, team, k, companyServices));
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

// Gates the Scheduler (team dispatch) to people flagged isScheduler, plus admins.
function SchedulerGate({ children }: { children: React.ReactNode }) {
  const { profile, role } = useAuth();
  const allowed = profile?.isScheduler || role === "admin" || role === "superadmin";
  return allowed ? <>{children}</> : <Navigate to="/" replace />;
}

// Movers is a team-manager / company-admin tool. Setters, closers and the
// other manager tiers can't reach it by URL.
function MoversGate({ children }: { children: React.ReactNode }) {
  const { profile, role } = useAuth();
  const allowed = role === "admin" || role === "superadmin" || profile?.position === "team_manager";
  return allowed ? <>{children}</> : <Navigate to="/" replace />;
}

// Blocks the canvassing-only surface (map, movers, territories, closer tools,
// shift tracking, reports, pitch practice) for a RallyCard-only company — one
// whose plan has no "map" feature. Redirects to the card instead of the
// (nonexistent, for them) canvassing dashboard.
function CanvassGate({ children }: { children: React.ReactNode }) {
  const { company } = useAuth();
  return isRallyCardOnly(company) ? <Navigate to="/card" replace /> : <>{children}</>;
}

// The landing route: the canvassing Dashboard for a full-platform company, or
// straight to the card for a RallyCard-only one (it has no Dashboard).
function Home() {
  const { company } = useAuth();
  return isRallyCardOnly(company) ? <Navigate to="/card" replace /> : <Dashboard />;
}

// Registers this device for native push once signed in, and drops the token on
// sign-out. No-op on web. Renders nothing.
function PushInit() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const uid = profile?.uid;
  useEffect(() => {
    if (uid) void initPush((link) => navigate(link));
    else void teardownPush();
  }, [uid, navigate]);
  return null;
}

export default function App() {
  return (
    <>
    <PushInit />
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Home />} />
        <Route path="lookup" element={<CanvassGate><Lookup /></CanvassGate>} />
        <Route path="leads" element={<Leads />} />
        <Route path="lead/:leadId" element={<CustomerLead />} />
        <Route path="map" element={<CanvassGate><MapPage /></CanvassGate>} />
        <Route path="movers" element={<CanvassGate><MoversGate><Movers /></MoversGate></CanvassGate>} />
        <Route path="team" element={<Team />} />
        <Route path="reports" element={<CanvassGate><RoleGate allow={["admin", "manager"]}><Reports /></RoleGate></CanvassGate>} />
        <Route path="closer" element={<CanvassGate><CloserGate><Closer /></CloserGate></CanvassGate>} />
        <Route path="battery" element={<CanvassGate><Gated feature="battery"><CloserGate><BatteryTool /></CloserGate></Gated></CanvassGate>} />
        <Route path="projects" element={<CanvassGate><Gated feature="battery"><CloserGate><Projects /></CloserGate></Gated></CanvassGate>} />
        <Route path="pitches" element={<CanvassGate><Gated anyOf={["pitch", "voice"]}><Pitches /></Gated></CanvassGate>} />
        <Route path="training" element={<CanvassGate><Training /></CanvassGate>} />
        <Route path="pitch-library" element={<CanvassGate><Gated anyOf={["pitch", "voice"]}><PitchLibrary /></Gated></CanvassGate>} />
        <Route path="shifts" element={<CanvassGate><Gated anyOf={["planner", "analytics"]}><Shifts /></Gated></CanvassGate>} />
        {/* Analytics merged into the Success Planner screen; keep the old path working. */}
        <Route path="stats" element={<Navigate to="/shifts" replace />} />
        <Route path="leaderboard" element={<Gated feature="rewards"><Leaderboard /></Gated>} />
        <Route path="gamify" element={<Gated feature="rewards"><Gamify /></Gated>} />
        <Route path="rewards" element={<Gated feature="rewards"><Rewards /></Gated>} />
        <Route path="throwdowns" element={<Gated feature="rewards"><ThrowDowns /></Gated>} />
        <Route path="working" element={<CanvassGate><Gated feature="chat"><Working /></Gated></CanvassGate>} />
        <Route path="chat" element={<Gated feature="chat"><Chat /></Gated>} />
        <Route path="schedule" element={<Gated feature="scheduling"><Schedule /></Gated>} />
        <Route path="scheduler" element={<Gated feature="scheduling"><SchedulerGate><Scheduler /></SchedulerGate></Gated>} />
        <Route path="territories" element={<CanvassGate><Territories /></CanvassGate>} />
        <Route path="card" element={<BusinessCard />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
    </>
  );
}
