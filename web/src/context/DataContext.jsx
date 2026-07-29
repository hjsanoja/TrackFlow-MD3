import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { supabase } from '../supabase';

const DataContext = createContext(null);

export function DataProvider({ children, user }) {
  const [productos, setProductos] = useState([]);
  const [productosCompetencia, setProductosCompetencia] = useState([]);
  const [cadenas, setCadenas] = useState([]);
  const [historicoPrecios, setHistoricoPrecios] = useState([]);
  const [bcvRates, setBcvRates] = useState([]);
  const [ultimaCorrida, setUltimaCorrida] = useState(null);
  const [usuarios, setUsuarios] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadedOnce, setIsLoadedOnce] = useState(false);

  const cargarTodo = useCallback(async (showSilently = false) => {
    if (!showSilently && !isLoadedOnce) {
      setLoadingInitial(true);
    } else {
      setIsRefreshing(true);
    }

    const hasSupabase = Boolean(import.meta.env.VITE_SUPABASE_URL);

    if (hasSupabase) {
      try {
        const [
          { data: pData, error: pErr },
          { data: pcData, error: pcErr },
          { data: cData, error: cErr },
          { data: hData, error: hErr },
          { data: rData, error: rErr },
          { data: bData, error: bErr },
          { data: uData, error: uErr }
        ] = await Promise.all([
          supabase.from('productos').select('*'),
          supabase.from('productos_competencia').select('*'),
          supabase.from('cadenas').select('*'),
          supabase.from('historico_precios').select('*').order('scraped_at', { ascending: false }).limit(1500),
          supabase.from('scrape_runs').select('*').order('started_at', { ascending: false }).limit(1),
          supabase.from('bcv_rates').select('*').order('updated_at', { ascending: true }),
          supabase.from('usuarios').select('*')
        ]);

        if (!pErr && pData) {
          const prods = [...pData].sort((a, b) => (a.id_interno || '').localeCompare(b.id_interno || ''));
          setProductos(prods);

          if (pcData) setProductosCompetencia(pcData);

          if (cData) {
            const cSorted = [...cData].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
            setCadenas(cSorted);
          }

          if (hData) {
            setHistoricoPrecios(hData.map(d => ({
              ...d,
              scraped_at: d.scraped_at ? new Date(d.scraped_at) : null
            })));
          }

          if (rData && rData.length > 0) {
            setUltimaCorrida({
              ...rData[0],
              started_at: rData[0].started_at ? new Date(rData[0].started_at) : null
            });
          }

          if (bData) {
            const rawRates = bData.map(d => {
              const dateObj = d.updated_at ? new Date(d.updated_at) : new Date();
              return {
                dayKey: dateObj.toLocaleDateString('es-VE', { year: 'numeric', month: '2-digit', day: '2-digit' }),
                fecha: dateObj.toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }) || '—',
                valor: d.value || d.valor,
                rawDate: dateObj
              };
            });

            const ratesByDay = {};
            rawRates.forEach(rate => {
              const existing = ratesByDay[rate.dayKey];
              if (!existing || rate.rawDate > existing.rawDate) {
                ratesByDay[rate.dayKey] = rate;
              }
            });

            const uniqueDaysRates = Object.values(ratesByDay)
              .sort((a, b) => a.rawDate - b.rawDate)
              .slice(-10);

            setBcvRates(uniqueDaysRates.map(({ dayKey, fecha, valor }) => ({ dayKey, fecha, valor })));
          }

          if (uData) {
            const uSorted = [...uData].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
            setUsuarios(uSorted);
          }

          setIsLoadedOnce(true);
          setLoadingInitial(false);
          setIsRefreshing(false);
          return;
        }
      } catch (sbErr) {
        console.warn('Supabase no devolvió datos o no está migrado aún, cambiando a Firebase:', sbErr);
      }
    }

    // Fallback Firebase
    try {
      const [pSnap, pcSnap, cSnap, hSnap, rSnap, bSnap, uSnap] = await Promise.all([
        getDocs(collection(db, 'productos')),
        getDocs(collection(db, 'productos_competencia')),
        getDocs(collection(db, 'cadenas')),
        getDocs(query(collection(db, 'historico_precios'), orderBy('scraped_at', 'desc'), limit(1500))),
        getDocs(query(collection(db, 'scrape_runs'), orderBy('started_at', 'desc'), limit(1))),
        getDocs(query(collection(db, 'bcv_rates'), orderBy('updated_at', 'asc'))),
        getDocs(collection(db, 'usuarios')),
      ]);

      const prods = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      prods.sort((a, b) => (a.id_interno || '').localeCompare(b.id_interno || ''));
      setProductos(prods);

      setProductosCompetencia(pcSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const cDocs = cSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      cDocs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      setCadenas(cDocs);

      setHistoricoPrecios(
        hSnap.docs.map(d => ({
          id: d.id,
          ...d.data(),
          scraped_at: d.data().scraped_at?.toDate?.() || null
        }))
      );

      if (!rSnap.empty) {
        const data = rSnap.docs[0].data();
        setUltimaCorrida({ ...data, started_at: data.started_at?.toDate?.() || null });
      }

      const rawRates = bSnap.docs.map(d => {
        const data = d.data();
        const dateObj = data.updated_at?.toDate?.() || new Date();
        return {
          dayKey: dateObj.toLocaleDateString('es-VE', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          fecha: dateObj.toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }) || '—',
          valor: data.value,
          rawDate: dateObj
        };
      });

      const ratesByDay = {};
      rawRates.forEach(rate => {
        const existing = ratesByDay[rate.dayKey];
        if (!existing || rate.rawDate > existing.rawDate) {
          ratesByDay[rate.dayKey] = rate;
        }
      });

      const uniqueDaysRates = Object.values(ratesByDay)
        .sort((a, b) => a.rawDate - b.rawDate)
        .slice(-10);

      setBcvRates(uniqueDaysRates.map(({ dayKey, fecha, valor }) => ({ dayKey, fecha, valor })));

      const uDocs = uSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      uDocs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      setUsuarios(uDocs);

      setIsLoadedOnce(true);
    } catch (err) {
      console.error('Error cargando datos globales:', err);
    } finally {
      setLoadingInitial(false);
      setIsRefreshing(false);
    }
  }, [isLoadedOnce]);

  useEffect(() => {
    if (user) {
      cargarTodo(false);
    }
  }, [user, cargarTodo]);

  const refreshProductos = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'productos'));
      const prods = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      prods.sort((a, b) => (a.id_interno || '').localeCompare(b.id_interno || ''));
      setProductos(prods);
    } catch (e) {
      console.error('Error actualizando productos:', e);
    }
  }, []);

  const refreshCompetencia = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'productos_competencia'));
      setProductosCompetencia(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error('Error actualizando competencia:', e);
    }
  }, []);

  const refreshCadenas = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'cadenas'));
      const cDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      cDocs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      setCadenas(cDocs);
    } catch (e) {
      console.error('Error actualizando cadenas:', e);
    }
  }, []);

  const refreshUsuarios = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'usuarios'));
      const uDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      uDocs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      setUsuarios(uDocs);
    } catch (e) {
      console.error('Error actualizando usuarios:', e);
    }
  }, []);

  const value = useMemo(() => ({
    productos,
    productosCompetencia,
    cadenas,
    historicoPrecios,
    bcvRates,
    ultimaCorrida,
    usuarios,
    loadingInitial,
    isRefreshing,
    isLoadedOnce,
    refreshData: cargarTodo,
    refreshProductos,
    refreshCompetencia,
    refreshCadenas,
    refreshUsuarios
  }), [
    productos,
    productosCompetencia,
    cadenas,
    historicoPrecios,
    bcvRates,
    ultimaCorrida,
    usuarios,
    loadingInitial,
    isRefreshing,
    isLoadedOnce,
    cargarTodo,
    refreshProductos,
    refreshCompetencia,
    refreshCadenas,
    refreshUsuarios
  ]);

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) {
    throw new Error('useData debe ser usado dentro de un DataProvider');
  }
  return ctx;
}
