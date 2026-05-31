import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";
import type { Role } from "../types";

interface Props {
  children: ReactNode;
  /** If set, only these roles may view the route. */
  roles?: Role[];
}

export default function ProtectedRoute({ children, roles }: Props) {
  const { user, role, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="centered-loader">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (roles && role && !roles.includes(role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
