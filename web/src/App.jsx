import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Simulador from './pages/Simulador';
import Hallazgos from './pages/Hallazgos';
import Productos from './pages/Productos';
import Competencia from './pages/Competencia';
import Cadenas from './pages/Cadenas';
import Usuarios from './pages/Usuarios';
import Layout from './components/Layout';
import { ToastProvider, useToast } from './context/ToastContext';
import { DataProvider } from './context/DataContext';

function emailToDocId(email) {
  return email.toLowerCase().replace('@', '_at_').replaceAll('.', '_');
}

function AppContent() {
  const [user, setUser] = useState(null);
  const [userDoc, setUserDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const docId = emailToDocId(firebaseUser.email);
          const snap = await getDoc(doc(db, 'usuarios', docId));
          if (snap.exists()) {
            const data = snap.data();
            const isActive = data.activo === true || data.activo === 'si' || data.activo === 'sí';
            if (isActive) {
              setUser(firebaseUser);
              setUserDoc(data);
            } else {
              await signOut(auth);
              addToast('Tu usuario está inactivo. Contacta a un administrador.', 'error');
            }
          } else {
            await signOut(auth);
            addToast('Tu usuario no está registrado en el sistema.', 'error');
          }
        } catch (err) {
          console.error('Error:', err?.message || String(err));
          await signOut(auth);
          addToast('Error de autenticación: ' + err.message, 'error');
        }
      } else {
        setUser(null);
        setUserDoc(null);
      }
      setLoading(false);
    });
    return unsub;
  }, [addToast]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-mono font-bold text-primary mt-4 animate-pulse">Cargando TrackFlow...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    );
  }

  const isAdmin = userDoc?.rol === 'administrador';

  return (
    <DataProvider user={user}>
      <Layout user={user} userDoc={userDoc}>
        <Routes>
          <Route path="/" element={<Dashboard user={user} userDoc={userDoc} />} />
          <Route path="/simulador" element={<Simulador user={user} userDoc={userDoc} />} />
          <Route path="/hallazgos" element={<Hallazgos user={user} userDoc={userDoc} />} />
          <Route path="/productos" element={isAdmin ? <Productos /> : <Navigate to="/" />} />
          <Route path="/competencia" element={isAdmin ? <Competencia /> : <Navigate to="/" />} />
          <Route path="/cadenas" element={isAdmin ? <Cadenas /> : <Navigate to="/" />} />
          <Route path="/usuarios" element={isAdmin ? <Usuarios userDoc={userDoc} /> : <Navigate to="/" />} />
          <Route path="/login" element={<Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Layout>
    </DataProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

