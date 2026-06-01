import { Routes, Route } from "react-router-dom";
import ProtectedRoute from "./auth/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Lookup from "./pages/Lookup";
import Leads from "./pages/Leads";
import Territories from "./pages/Territories";
import MapPage from "./pages/Map";
import Team from "./pages/Team";
import Shifts from "./pages/Shifts";
import Stats from "./pages/Stats";
import Leaderboard from "./pages/Leaderboard";
import Gamify from "./pages/Gamify";
import Rewards from "./pages/Rewards";
import Working from "./pages/Working";
import Chat from "./pages/Chat";
import Schedule from "./pages/Schedule";
import Settings from "./pages/Settings";

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
        <Route path="team" element={<Team />} />
        <Route path="shifts" element={<Shifts />} />
        <Route path="stats" element={<Stats />} />
        <Route path="leaderboard" element={<Leaderboard />} />
        <Route path="gamify" element={<Gamify />} />
        <Route path="rewards" element={<Rewards />} />
        <Route path="working" element={<Working />} />
        <Route path="chat" element={<Chat />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="territories" element={<Territories />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
