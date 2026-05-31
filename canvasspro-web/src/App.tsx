import { Routes, Route } from "react-router-dom";
import ProtectedRoute from "./auth/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Lookup from "./pages/Lookup";
import Leads from "./pages/Leads";
import Territories from "./pages/Territories";
import Admin from "./pages/Admin";
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
        <Route path="territories" element={<Territories />} />
        <Route path="settings" element={<Settings />} />
        <Route
          path="admin"
          element={
            <ProtectedRoute roles={["admin", "manager"]}>
              <Admin />
            </ProtectedRoute>
          }
        />
      </Route>
    </Routes>
  );
}
