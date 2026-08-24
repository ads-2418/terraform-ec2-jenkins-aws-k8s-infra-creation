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

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/appointments" element={<AppointmentsPage />} />
        <Route path="/clinics" element={<ClinicsPage />} />
        <Route path="/doctors" element={<DoctorsPage />} />
        <Route path="/services" element={<ServicesPage />} />
        <Route path="/staff" element={<StaffPage />} />
        <Route path="/holidays" element={<HolidaysPage />} />
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
