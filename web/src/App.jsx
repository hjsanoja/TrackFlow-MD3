import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Productos from './pages/Productos';
import Competencia from './pages/Competencia';
import Cadenas from './pages/Cadenas';
import Usuarios from './pages/Usuarios';
import Layout from './components/Layout';

function emailToDocId(email) {
  return email.toLowerCase().replace('@', '_at_').replaceAll('.', '_');
}

export default function App() {
  const [user, setUser] = useState(null);
  const [userDoc, setUserDoc] = useState(null);
  const [loading, setLoading] = useState(true);

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
              alert('Tu usuario está inactivo.');
            }
          } else {
            await signOut(auth);
            alert('Tu usuario no está registrado.');
          }
        } catch (err) {
          console.error('Error:', err);
          await signOut(auth);
        }
      } else {
        setUser(null);
        setUserDoc(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Cargando...</p>
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
    <Layout user={user} userDoc={userDoc}>
      <Routes>
        <Route path="/" element={<Dashboard user={user} userDoc={userDoc} />} />
        <Route path="/productos" element={isAdmin ? <Productos /> : <Navigate to="/" />} />
        <Route path="/competencia" element={isAdmin ? <Competencia /> : <Navigate to="/" />} />
        <Route path="/cadenas" element={isAdmin ? <Cadenas /> : <Navigate to="/" />} />
        <Route path="/usuarios" element={isAdmin ? <Usuarios userDoc={userDoc} /> : <Navigate to="/" />} />
        <Route path="/login" element={<Navigate to="/" />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}
