import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      let msg = 'Error al iniciar sesión.';
      if (err.code === 'auth/invalid-credential') msg = 'Email o contraseña incorrectos.';
      else if (err.code === 'auth/too-many-requests') msg = 'Demasiados intentos. Espera unos minutos.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 text-on-background">
      <div className="w-full max-w-md bg-white rounded-[32px] border border-outline-variant p-10 shadow-sm space-y-8">
        <div className="text-center space-y-2">
          {/* Elegant Logo / Icon Header */}
          <div className="mx-auto w-16 h-16 rounded-[20px] bg-primary flex items-center justify-center shadow-inner">
            <span className="material-symbols-outlined text-secondary-container text-3xl select-none">monitoring</span>
          </div>
          <h1 className="text-3xl font-display font-extrabold text-primary tracking-tight">TrackFlow</h1>
          <p className="text-xs font-mono font-bold uppercase tracking-wider text-on-surface-variant">Inteligencia de Precios</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1">
            <label className="block text-xs font-mono font-bold uppercase tracking-wider text-primary">Correo Electrónico</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2.5 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface"
              placeholder="nombre@empresa.com"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-mono font-bold uppercase tracking-wider text-primary">Contraseña</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2.5 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="text-xs font-semibold text-error bg-error-container border border-error/20 px-4 py-2.5 rounded-xl flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm leading-none">error</span>
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-secondary hover:bg-secondary/90 text-on-secondary font-extrabold uppercase font-mono tracking-wider text-xs py-3 rounded-full shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="material-symbols-outlined text-sm leading-none animate-spin">autorenew</span>
                <span>Iniciando...</span>
              </>
            ) : (
              <>
                <span>Acceder al Sistema</span>
                <span className="material-symbols-outlined text-sm leading-none">login</span>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
