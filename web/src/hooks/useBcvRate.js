import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

export function useBcvRate() {
  const [rate, setRate] = useState(null);
  const [source, setSource] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadFromFirestore = async () => {
    try {
      const q = query(collection(db, 'bcv_rates'), orderBy('updated_at', 'desc'), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) {
        const data = snap.docs[0].data();
        setRate(data.value);
        setSource(data.source);
        setUpdatedAt(data.updated_at?.toDate?.() || null);
        return data;
      }
      return null;
    } catch (err) {
      console.error('[useBcvRate] error leyendo Firestore:', err?.message || String(err));
      setError('No se pudo leer la tasa BCV: ' + err.message);
      return null;
    }
  };

  const fetchFromPyDolar = async () => {
    try {
      const res = await fetch('https://pydolarve.org/api/v2/dollar?page=bcv');
      if (!res.ok) return null;
      const json = await res.json();
      const value = json?.monitors?.usd?.price || json?.price;
      if (typeof value === 'number' && value > 0) return value;
      return null;
    } catch {
      // CORS o red caida - es esperado, no logueamos como error
      return null;
    }
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const existing = await loadFromFirestore();
      const today = new Date().toDateString();
      const existingDate = existing?.updated_at?.toDate?.()?.toDateString?.();
      if (existing && existingDate === today) {
        setLoading(false);
        return;
      }

      const auto = await fetchFromPyDolar();
      if (auto) {
        try {
          await addDoc(collection(db, 'bcv_rates'), {
            value: auto,
            source: 'auto',
            updated_at: serverTimestamp(),
          });
          await loadFromFirestore();
        } catch (err) {
          console.warn('[useBcvRate] no pude guardar tasa auto:', err?.message || String(err));
        }
      }
    } catch (err) {
      console.error('[useBcvRate] error en refresh:', err?.message || String(err));
      setError(err.message);
    }
    setLoading(false);
  };

  const setManual = async (value) => {
    setError(null);
    const num = parseFloat(String(value).replace(',', '.'));
    if (!num || isNaN(num) || num <= 0) {
      setError('La tasa debe ser un número positivo (usa punto, no coma)');
      return false;
    }
    try {
      await addDoc(collection(db, 'bcv_rates'), {
        value: num,
        source: 'manual',
        updated_at: serverTimestamp(),
      });
      await loadFromFirestore();
      return true;
    } catch (err) {
      console.error('[useBcvRate] error guardando manual:', err?.message || String(err));
      setError('No se pudo guardar: ' + err.message);
      return false;
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { rate, source, updatedAt, loading, error, refresh, setManual };
}
