import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h2>Clinic Admin</h2>
        <nav>
          <NavLink to="/appointments">Appointments</NavLink>
          <NavLink to="/clinics">Clinics</NavLink>
          <NavLink to="/doctors">Doctors</NavLink>
          <NavLink to="/services">Services</NavLink>
          <NavLink to="/staff">Staff</NavLink>
        </nav>
        <div className="sidebar-footer">
          <span>{user?.email}</span>
          <button onClick={handleLogout}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
