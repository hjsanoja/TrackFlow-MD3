import { NavLink } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';

export default function Layout({ user, userDoc, children }) {
  const isAdmin = userDoc?.rol === 'administrador';
  const handleLogout = () => signOut(auth);

  const navItems = [
    { to: '/', label: 'Dashboard', icon: 'dashboard', adminOnly: false },
    { to: '/productos', label: 'Productos', icon: 'medication', adminOnly: true },
    { to: '/competencia', label: 'Competencia', icon: 'link', adminOnly: true },
    { to: '/cadenas', label: 'Cadenas', icon: 'storefront', adminOnly: true },
    { to: '/usuarios', label: 'Usuarios', icon: 'group', adminOnly: true },
  ];

  return (
    <div className="min-h-screen bg-background flex font-sans text-on-background">
      {/* Sidebar - Material Design 3 Navigation Drawer */}
      <aside className="w-72 bg-white border-r border-surface-variant flex flex-col justify-between py-6 px-4 shrink-0">
        <div>
          {/* Logo & Brand */}
          <div className="px-4 mb-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center text-on-primary shadow-sm">
                <span className="material-symbols-outlined select-none text-2xl font-bold">monitoring</span>
              </div>
              <div>
                <h1 className="text-xl font-display font-extrabold tracking-tight text-on-background flex items-center gap-0.5">
                  Track<span className="text-secondary font-display font-extrabold">Flow</span>
                </h1>
                <p className="text-[10px] text-on-surface-variant font-mono tracking-wider uppercase font-semibold">Monitor de Precios</p>
              </div>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1">
            <div className="px-4 py-2 text-[11px] font-mono font-bold tracking-wider text-on-surface-variant uppercase">
              Menú Principal
            </div>
            {navItems
              .filter(item => !item.adminOnly || isAdmin)
              .map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-4 px-4 py-3 rounded-full text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? 'bg-primary-container text-on-primary-container font-bold shadow-sm'
                        : 'text-on-surface-variant hover:bg-on-surface/5 hover:text-on-surface'
                    }`
                  }
                >
                  <span className="material-symbols-outlined select-none text-[22px] leading-none">
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </NavLink>
              ))}
          </nav>
        </div>

        {/* User profile footer - MD3 Style */}
        <div className="space-y-4">
          <div className="bg-surface-low rounded-2xl p-4 border border-outline-variant/30">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary text-on-primary font-bold flex items-center justify-center text-sm font-display">
                {userDoc?.nombre ? userDoc.nombre.charAt(0).toUpperCase() : 'U'}
              </div>
              <div className="truncate flex-1">
                <div className="text-sm font-bold text-on-surface truncate font-display">{userDoc?.nombre || 'Usuario'}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="h-2 w-2 rounded-full bg-secondary animate-pulse"></span>
                  <span className="text-[10px] text-on-surface-variant uppercase font-mono font-semibold tracking-wider">{userDoc?.rol || 'Rol'}</span>
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 text-xs font-bold text-error bg-error-container hover:bg-error-container/85 border border-error/20 rounded-full transition-all"
          >
            <span className="material-symbols-outlined select-none text-base">logout</span>
            <span>Cerrar Sesión</span>
          </button>

          {/* Developer attribution & Version */}
          <div className="pt-3 text-center border-t border-outline-variant/30 flex flex-col items-center gap-0.5">
            <span className="text-[10px] text-on-surface-variant font-mono tracking-wide">
              Desarrollador: <span className="font-bold text-primary">Hernando Sanoja</span>
            </span>
            <span className="text-[9px] text-on-surface-variant/70 font-mono">
              Versión V7.0.0.1
            </span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-x-auto min-h-screen flex flex-col">
        <div className="flex-1 p-8 max-w-[1440px] w-full mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
