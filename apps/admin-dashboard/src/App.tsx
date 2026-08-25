import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { ClinicsPage } from "./pages/ClinicsPage";
import { DoctorsPage } from "./pages/DoctorsPage";
import { ServicesPage } from "./pages/ServicesPage";
import { StaffPage } from "./pages/StaffPage";
import { HolidaysPage } from "./pages/HolidaysPage";
import { AvailabilityPage } from "./pages/AvailabilityPage";
import { AppointmentsPage } from "./pages/AppointmentsPage";
import { FindDoctorPage } from "./pages/FindDoctorPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { PlatformTenantsPage } from "./pages/PlatformTenantsPage";

function isPlatformAdmin(roles: string[]): boolean {
  return roles.includes("PLATFORM_ADMIN");
}

/** Tenant-scoped pages: a platform admin has no tenant data to see here, so send them to their own view instead. */
function RequireAuth({ children }: { children: React.ReactElement }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (isPlatformAdmin(user.roles)) return <Navigate to="/platform/tenants" replace />;
  return children;
}

/** The reverse: platform-only pages are meaningless for a tenant-scoped user. */
function RequirePlatformAuth({ children }: { children: React.ReactElement }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!isPlatformAdmin(user.roles)) return <Navigate to="/appointments" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/platform/tenants"
        element={
          <RequirePlatformAuth>
            <PlatformTenantsPage />
          </RequirePlatformAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/appointments" element={<AppointmentsPage />} />
        <Route path="/find-doctor" element={<FindDoctorPage />} />
        <Route path="/clinics" element={<ClinicsPage />} />
        <Route path="/doctors" element={<DoctorsPage />} />
        <Route path="/services" element={<ServicesPage />} />
        <Route path="/staff" element={<StaffPage />} />
        <Route path="/holidays" element={<HolidaysPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/availability" element={<AvailabilityPage />} />
        <Route path="/" element={<Navigate to="/appointments" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
