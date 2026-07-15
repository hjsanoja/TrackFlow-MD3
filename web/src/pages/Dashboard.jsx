import { useEffect, useState, useMemo } from 'react';
import { collection, getDocs, query, orderBy, limit, doc, getDoc, writeBatch, deleteDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useBcvRate } from '../hooks/useBcvRate';
import ProductDetailModal from '../components/ProductDetailModal';
import ConfirmModal from '../components/ConfirmModal';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Cell, Legend
} from 'recharts';

export default function Dashboard({ user, userDoc }) {
  const [productos, setProductos] = useState([]);
  const [productosCompetencia, setProductosCompetencia] = useState([]);
  const [bcvHistorico, setBcvHistorico] = useState([]);
  const [ultimaCorrida, setUltimaCorrida] = useState(null);
  const [currency, setCurrency] = useState('usd');
  const [search, setSearch] = useState('');
  const [categoriaSeleccionada, setCategoriaSeleccionada] = useState('Todas');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [dashboardPriceMode, setDashboardPriceMode] = useState('descuento');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState(null);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [waitingForScraper, setWaitingForScraper] = useState(false);
  const [scraperTriggerTime, setScraperTriggerTime] = useState(null);

  const bcv = useBcvRate();
  const isAdmin = userDoc?.rol === 'administrador';

  const cargarDatos = async (showSilently = false) => {
    if (!showSilently) setLoading(true);
    try {
      const [prodSnap, competSnap, runsSnap, bcvSnap] = await Promise.all([
        getDocs(collection(db, 'productos')),
        getDocs(collection(db, 'productos_competencia')),
        getDocs(query(collection(db, 'scrape_runs'), orderBy('started_at', 'desc'), limit(1))),
        getDocs(query(collection(db, 'bcv_rates'), orderBy('updated_at', 'asc'))),
      ]);

      setProductos(prodSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setProductosCompetencia(competSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      
      if (!runsSnap.empty) {
        const data = runsSnap.docs[0].data();
        setUltimaCorrida({ ...data, started_at: data.started_at?.toDate?.() || null });
      }

      const rawRates = bcvSnap.docs.map(d => {
        const data = d.data();
        const dateObj = data.updated_at?.toDate?.() || new Date();
        return {
          dayKey: dateObj.toLocaleDateString('es-VE', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          fecha: dateObj.toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }) || '—',
          valor: data.value,
          rawDate: dateObj
        };
      });

      // Group by dayKey and keep only the latest one
      const ratesByDay = {};
      rawRates.forEach(rate => {
        const existing = ratesByDay[rate.dayKey];
        if (!existing || rate.rawDate > existing.rawDate) {
          ratesByDay[rate.dayKey] = rate;
        }
      });

      // Sort chronological and take the last 10 unique days
      const uniqueDaysRates = Object.values(ratesByDay)
        .sort((a, b) => a.rawDate - b.rawDate)
        .slice(-10);

      setBcvHistorico(uniqueDaysRates);

    } catch (err) {
      console.error('Error cargando panel:', err?.message || String(err));
    }
    if (!showSilently) setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  // Listener en tiempo real para detectar cuándo termina el scraper
  useEffect(() => {
    const q = query(collection(db, 'scrape_runs'), orderBy('started_at', 'desc'), limit(1));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const docData = snapshot.docs[0].data();
        const runDate = docData.started_at?.toDate?.() || null;
        setUltimaCorrida({ ...docData, started_at: runDate });
        
        if (waitingForScraper && runDate && scraperTriggerTime && runDate >= scraperTriggerTime) {
          setWaitingForScraper(false);
          setScraperTriggerTime(null);
          setRefreshMessage({
            type: 'success',
            text: `¡Actualización completada! El robot ha terminado de extraer y analizar los últimos precios (${docData.ok} exitosos, ${docData.errores} errores).`
          });
          cargarDatos(true); // Recargar los datos silenciosamente para actualizar la tabla
        }
      }
    }, (err) => {
      console.error('Error en onSnapshot de scrape_runs:', err?.message || String(err));
    });

    return () => unsubscribe();
  }, [waitingForScraper, scraperTriggerTime]);

  const handleActualizar = async () => {
    if (!isAdmin) return;
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const secretSnap = await getDoc(doc(db, 'secrets', 'github_dispatch'));
      if (!secretSnap.exists()) {
        throw new Error('Falta configurar las credenciales en Firestore. Para que este botón funcione, debes registrar tu token de GitHub ejecutando "python scraper/save_github_token.py" en tu terminal o configurando el documento "secrets/github_dispatch" en la consola de Firebase.');
      }
      const { token, repo_owner, repo_name, workflow_event_type } = secretSnap.data();
      const res = await fetch(
        `https://api.github.com/repos/${repo_owner}/${repo_name}/dispatches`,
        {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ event_type: workflow_event_type || 'run-scraper' }),
        }
      );
      if (res.status === 204) {
        setWaitingForScraper(true);
        setScraperTriggerTime(new Date());
        setRefreshMessage({ type: 'success', text: 'El robot scraper ha sido iniciado vía GitHub Actions. Se te notificará de forma interactiva en esta misma pantalla cuando finalice la carga de precios.' });
      } else {
        const txt = await res.text();
        throw new Error(`GitHub respondió ${res.status}: ${txt}`);
      }
    } catch (err) {
      setRefreshMessage({ type: 'error', text: 'Error al disparar scraper: ' + err.message });
    }
    setRefreshing(false);
  };

  const handleClearAllHistory = async () => {
    setClearingHistory(true);
    try {
      const q = query(collection(db, 'historico_precios'));
      const snap = await getDocs(q);
      const docs = snap.docs;
      
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500);
        const batch = writeBatch(db);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      // Clear execution runs logs too
      const runsQ = query(collection(db, 'scrape_runs'));
      const runsSnap = await getDocs(runsQ);
      const runsDocs = runsSnap.docs;
      for (let i = 0; i < runsDocs.length; i += 500) {
        const chunk = runsDocs.slice(i, i + 500);
        const batch = writeBatch(db);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      setUltimaCorrida(null);
      setRefreshMessage({ type: 'success', text: 'Historial de precios y análisis de scraper vaciados con éxito.' });
      await cargarDatos();
    } catch (err) {
      console.error('Error al borrar historial:', err?.message || String(err));
      setRefreshMessage({ type: 'error', text: 'Error al borrar historial: ' + err.message });
    }
    setClearingHistory(false);
    setShowClearHistoryConfirm(false);
  };

  // Unique categories for filtering
  const categorias = useMemo(() => {
    const list = new Set(productos.map(p => p.categoria).filter(Boolean));
    return ['Todas', ...Array.from(list)];
  }, [productos]);

  // Main calculations for products and competitors
  const analizados = useMemo(() => {
    return productos
      .filter(p => p.activo)
      .map(p => {
        const compItems = productosCompetencia.filter(pc => pc.id_producto_propio === p.id_interno && pc.activo);
        
        // Find competitor prices (converted to USD using current rate for standard comparison)
        const chainPrices = compItems.map(c => {
          const priceBs = dashboardPriceMode === 'descuento'
            ? (c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs)
            : c.ultimo_precio_full_bs;
          if (!priceBs || !bcv.rate) return null;
          return {
            cadena: c.cadena,
            priceUsd: priceBs / bcv.rate,
            priceBs: priceBs,
            marca: c.marca,
            url: c.url
          };
        }).filter(v => v !== null && v.priceUsd > 0);

        const competitorPricesUsd = chainPrices.map(x => x.priceUsd);

        const avgCompUsd = competitorPricesUsd.length > 0 
          ? competitorPricesUsd.reduce((a, b) => a + b, 0) / competitorPricesUsd.length 
          : null;

        const minCompUsd = competitorPricesUsd.length > 0 ? Math.min(...competitorPricesUsd) : null;
        const maxCompUsd = competitorPricesUsd.length > 0 ? Math.max(...competitorPricesUsd) : null;

        // Dispersion percent calculation
        const dispersionPercent = (minCompUsd && maxCompUsd && minCompUsd > 0)
          ? ((maxCompUsd - minCompUsd) / minCompUsd) * 100
          : 0;

        // Find cheapest chain(s) for this product
        const cheapestChains = chainPrices
          .filter(x => Math.abs(x.priceUsd - minCompUsd) < 0.001)
          .map(x => x.cadena);

        // Find most expensive chain(s) for this product
        const mostExpensiveChains = chainPrices
          .filter(x => Math.abs(x.priceUsd - maxCompUsd) < 0.001)
          .map(x => x.cadena);

        // Find own price
        const propioItem = compItems.find(c => c.tipo === 'propio');
        const propioPriceBs = propioItem ? (
          dashboardPriceMode === 'descuento'
            ? (propioItem.ultimo_precio_desc_bs || propioItem.ultimo_precio_full_bs)
            : propioItem.ultimo_precio_full_bs
        ) : null;
        const propioPriceUsd = (propioPriceBs && bcv.rate) ? (propioPriceBs / bcv.rate) : null;

        // Difference vs cheapest (minCompUsd)
        const diffMinUsd = (propioPriceUsd !== null && minCompUsd !== null) ? propioPriceUsd - minCompUsd : null;
        const diffMinPercent = (diffMinUsd !== null && minCompUsd > 0) ? (diffMinUsd / minCompUsd) * 100 : null;

        // Difference vs average (avgCompUsd)
        const diffAvgUsd = (propioPriceUsd !== null && avgCompUsd !== null) ? propioPriceUsd - avgCompUsd : null;
        const diffAvgPercent = (diffAvgUsd !== null && avgCompUsd > 0) ? (diffAvgUsd / avgCompUsd) * 100 : null;

        return {
          producto: p,
          competencia: compItems,
          chainPrices,
          avgCompUsd,
          minCompUsd,
          maxCompUsd,
          dispersionPercent,
          cheapestChains,
          mostExpensiveChains,
          propioPriceUsd,
          diffMinUsd,
          diffMinPercent,
          diffAvgUsd,
          diffAvgPercent,
        };
      });
  }, [productos, productosCompetencia, bcv.rate, dashboardPriceMode]);

  // Filtered rows
  const filas = useMemo(() => {
    const term = search.toLowerCase().trim();
    return analizados.filter(item => {
      const matchSearch = !term || 
        item.producto.nombre.toLowerCase().includes(term) ||
        (item.producto.principio_activo || '').toLowerCase().includes(term) ||
        item.producto.id_interno.toLowerCase().includes(term);
      
      const matchCat = categoriaSeleccionada === 'Todas' || item.producto.categoria === categoriaSeleccionada;
      return matchSearch && matchCat;
    });
  }, [analizados, search, categoriaSeleccionada]);

  // All active chains represented
  const cadenasUnicas = useMemo(() => {
    const set = new Set(productosCompetencia.map(pc => pc.cadena));
    return Array.from(set).sort();
  }, [productosCompetencia]);

  // Aggregate leadership chart data: how many times each chain is cheapest
  const chartChainLeadershipData = useMemo(() => {
    const counts = {};
    cadenasUnicas.forEach(c => { counts[c] = 0; });

    analizados.forEach(item => {
      if (item.minCompUsd && item.cheapestChains.length > 0) {
        item.cheapestChains.forEach(ch => {
          if (counts[ch] !== undefined) {
            counts[ch]++;
          }
        });
      }
    });

    const colors = ['#016874', '#4f378a', '#7c0090', '#30312f', '#B3261E'];
    return Object.keys(counts).map((key, index) => ({
      name: key,
      liderazgos: counts[key],
      fill: colors[index % colors.length]
    }));
  }, [analizados, cadenasUnicas]);

  // High volatility/dispersion alerts: dispersion > 20%
  const altaVolatilidad = useMemo(() => {
    return analizados.filter(item => item.dispersionPercent > 20).sort((a,b) => b.dispersionPercent - a.dispersionPercent);
  }, [analizados]);

  // Stats for cards
  const kpiStats = useMemo(() => {
    let totalDispersion = 0;
    let productsWithDispersion = 0;
    let maxDispersionVal = 0;
    let maxDispersionProd = '—';
    let maxDispersionItem = null;

    analizados.forEach(item => {
      if (item.dispersionPercent > 0) {
        totalDispersion += item.dispersionPercent;
        productsWithDispersion++;
        if (item.dispersionPercent > maxDispersionVal) {
          maxDispersionVal = item.dispersionPercent;
          maxDispersionProd = item.producto.nombre;
          maxDispersionItem = item;
        }
      }
    });

    // Find overall leader (chain with highest cheap count)
    let bestChain = '—';
    let maxCheapCount = 0;
    const chainLeadershipMap = {};
    cadenasUnicas.forEach(c => { chainLeadershipMap[c] = 0; });

    analizados.forEach(item => {
      if (item.minCompUsd) {
        item.cheapestChains.forEach(ch => {
          if (chainLeadershipMap[ch] !== undefined) chainLeadershipMap[ch]++;
        });
      }
    });

    Object.keys(chainLeadershipMap).forEach(k => {
      if (chainLeadershipMap[k] > maxCheapCount) {
        maxCheapCount = chainLeadershipMap[k];
        bestChain = k;
      }
    });

    // Own Brand leadership: how many times is our brand (tipo === 'propio') the cheapest or below market average?
    let ownBrandTotal = 0;
    let ownBrandLider = 0;
    analizados.forEach(item => {
      const propio = item.competencia.find(c => c.tipo === 'propio');
      if (propio) {
        const propioPrice = propio.ultimo_precio_desc_bs || propio.ultimo_precio_full_bs;
        if (propioPrice) {
          ownBrandTotal++;
          const alts = item.competencia.filter(c => c.tipo === 'alternativa');
          const pricesAlt = alts.map(a => a.ultimo_precio_desc_bs || a.ultimo_precio_full_bs).filter(Boolean);
          if (pricesAlt.length > 0) {
            const minAlt = Math.min(...pricesAlt);
            if (propioPrice <= minAlt) {
              ownBrandLider++;
            }
          } else {
            // No alternatives, we are the only ones
            ownBrandLider++;
          }
        }
      }
    });

    const porcentajeLiderazgoPropio = ownBrandTotal > 0 ? Math.round((ownBrandLider / ownBrandTotal) * 100) : 100;

    // Technical health of links: how many active links have estado === 'ok'
    const totalEnlacesActivos = productosCompetencia.filter(pc => pc.activo).length;
    const enlacesOk = productosCompetencia.filter(pc => pc.activo && pc.estado === 'ok').length;
    const tasaSaludTecnica = totalEnlacesActivos > 0 ? Math.round((enlacesOk / totalEnlacesActivos) * 100) : 100;

    // Arbitrage Opportunity detection (> 15% dispersion)
    let arbitrajeInfo = null;
    if (maxDispersionItem && maxDispersionVal > 15) {
      const minPrice = maxDispersionItem.minCompUsd;
      const maxPrice = maxDispersionItem.maxCompUsd;
      const chMin = maxDispersionItem.cheapestChains.join(' / ');
      const chMax = maxDispersionItem.mostExpensiveChains.join(' / ');
      const ahorroPct = ((maxPrice - minPrice) / maxPrice) * 100;

      arbitrajeInfo = {
        producto: maxDispersionItem.producto.nombre,
        ahorroPct: Math.round(ahorroPct),
        chMin,
        chMax,
        minVal: minPrice,
        maxVal: maxPrice,
      };
    }

    return {
      monitoredCount: analizados.length,
      avgDispersion: productsWithDispersion > 0 ? totalDispersion / productsWithDispersion : 0,
      maxDispersionVal,
      maxDispersionProd,
      bestChain: maxCheapCount > 0 ? `${bestChain} (${maxCheapCount} prods)` : '—',
      porcentajeLiderazgoPropio,
      tasaSaludTecnica,
      arbitrajeInfo
    };
  }, [analizados, cadenasUnicas, productosCompetencia]);

  // Currency Formatter Helper
  const fmt = (priceUsd) => {
    if (priceUsd == null || isNaN(priceUsd)) return '—';
    if (currency === 'usd') {
      return `$${priceUsd.toFixed(2)}`;
    }
    if (!bcv.rate) return '—';
    return 'Bs ' + (priceUsd * bcv.rate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const getPriceForCell = (chainPrices, cadena) => {
    const matched = chainPrices.find(c => c.cadena === cadena);
    if (!matched) return null;
    return matched.priceUsd;
  };

  // CSV intelligence report generation
  const downloadReport = () => {
    // Add BOM for Excel UTF-8 compatibility
    let csv = '\ufeff';
    csv += 'ID Interno,Producto Propio,Categoría,Laboratorio Propio,Mi Precio Lista (Bs),Mi Precio Descuento (Bs),Mi Precio Lista (USD),Mi Precio Descuento (USD),Cadena Enlace,Tipo Enlace,Nombre Enlace,Laboratorio Enlace,Precio Lista Enlace (Bs),Precio Lista Enlace (USD),Precio Descuento Enlace (Bs),Precio Descuento Enlace (USD),Diferencia vs Mi Precio (%),URL Enlace\n';
    
    analizados.forEach(item => {
      const p = item.producto;
      const comp = item.competencia || [];
      
      // Get own product details
      const propioItem = comp.find(c => c.tipo === 'propio');
      const miPrecioListaBs = propioItem ? (propioItem.ultimo_precio_full_bs || null) : null;
      const miPrecioDescBs = propioItem ? (propioItem.ultimo_precio_desc_bs || null) : null;
      
      const rate = bcv.rate || 1;
      const miPrecioListaUsd = miPrecioListaBs ? miPrecioListaBs / rate : null;
      const miPrecioDescUsd = miPrecioDescBs ? miPrecioDescBs / rate : null;

      if (comp.length === 0) {
        // If there are no competitors or links at all
        const row = [
          p.id_interno,
          p.nombre,
          p.categoria,
          p.laboratorio || '—',
          miPrecioListaBs !== null ? miPrecioListaBs.toFixed(2) : '—',
          miPrecioDescBs !== null ? miPrecioDescBs.toFixed(2) : '—',
          miPrecioListaUsd !== null ? miPrecioListaUsd.toFixed(2) : '—',
          miPrecioDescUsd !== null ? miPrecioDescUsd.toFixed(2) : '—',
          '—', // Cadena
          '—', // Tipo
          '—', // Nombre Enlace
          '—', // Lab Enlace
          '—', // Precio Lista Enlace Bs
          '—', // Precio Lista Enlace USD
          '—', // Precio Descuento Enlace Bs
          '—', // Precio Descuento Enlace USD
          '—', // Diferencia %
          '—'  // URL Enlace
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + '\n';
        csv += row;
      } else {
        comp.forEach(pc => {
          const pcPrecioListaBs = pc.ultimo_precio_full_bs || null;
          const pcPrecioDescBs = pc.ultimo_precio_desc_bs || null;
          const pcPrecioListaUsd = pcPrecioListaBs && bcv.rate ? pcPrecioListaBs / bcv.rate : null;
          const pcPrecioDescUsd = pcPrecioDescBs && bcv.rate ? pcPrecioDescBs / bcv.rate : null;

          // Compare competitor price against own price
          const miCompPrecioBs = dashboardPriceMode === 'descuento' 
            ? (miPrecioDescBs || miPrecioListaBs) 
            : miPrecioListaBs;
            
          const pcCompPrecioBs = dashboardPriceMode === 'descuento'
            ? (pcPrecioDescBs || pcPrecioListaBs)
            : pcPrecioListaBs;

          let diffPercentStr = '—';
          if (miCompPrecioBs && pcCompPrecioBs && miCompPrecioBs > 0 && pc.tipo !== 'propio') {
            const diffPct = ((miCompPrecioBs - pcCompPrecioBs) / pcCompPrecioBs) * 100;
            diffPercentStr = `${diffPct > 0 ? '+' : ''}${diffPct.toFixed(1)}%`;
          } else if (pc.tipo === 'propio') {
            diffPercentStr = 'Base (Propio)';
          }

          const row = [
            p.id_interno,
            p.nombre,
            p.categoria,
            p.laboratorio || '—',
            miPrecioListaBs !== null ? miPrecioListaBs.toFixed(2) : '—',
            miPrecioDescBs !== null ? miPrecioDescBs.toFixed(2) : '—',
            miPrecioListaUsd !== null ? miPrecioListaUsd.toFixed(2) : '—',
            miPrecioDescUsd !== null ? miPrecioDescUsd.toFixed(2) : '—',
            pc.cadena,
            pc.tipo === 'propio' ? 'Mi Marca' : 'Competidor',
            pc.marca,
            pc.laboratorio || '—',
            pcPrecioListaBs !== null ? pcPrecioListaBs.toFixed(2) : '—',
            pcPrecioListaUsd !== null ? pcPrecioListaUsd.toFixed(2) : '—',
            pcPrecioDescBs !== null ? pcPrecioDescBs.toFixed(2) : '—',
            pcPrecioDescUsd !== null ? pcPrecioDescUsd.toFixed(2) : '—',
            diffPercentStr,
            pc.url || '—'
          ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + '\n';
          csv += row;
        });
      }
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Reporte_Detallado_Precios_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6 text-on-background">
      {/* Editorial Title Block */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-outline-variant pb-4 gap-4">
        <div>
          <h1 className="text-3xl font-display font-extrabold text-primary tracking-tight">Panel de Inteligencia</h1>
          <p className="text-sm text-on-surface-variant font-sans mt-1">
            Análisis de volatilidad, liderazgo de precios por cadena farmacéutica y tasas de cambio.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Currency Switcher widget */}
          <div className="flex bg-surface-low border border-outline-variant rounded-full p-1 text-xs font-mono font-bold">
            <button onClick={() => setCurrency('usd')}
              className={`px-4 py-1.5 rounded-full transition-all ${currency === 'usd' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-primary'}`}>USD ($)</button>
            <button onClick={() => setCurrency('bs')}
              className={`px-4 py-1.5 rounded-full transition-all ${currency === 'bs' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-primary'}`}>BS (Bs)</button>
          </div>

          <button onClick={downloadReport}
            className="text-xs font-bold bg-white border border-outline-variant hover:bg-surface-low px-4 py-2.5 rounded-full text-primary transition-all flex items-center gap-1.5 shadow-sm">
            <span className="material-symbols-outlined text-base">download</span>
            Exportar CSV
          </button>

          {isAdmin && (
            <button onClick={() => setShowClearHistoryConfirm(true)}
              className="text-xs font-bold bg-white border border-error/30 hover:bg-error-container/10 active:bg-error-container/20 px-4 py-2.5 rounded-full text-error transition-all flex items-center gap-1.5 shadow-sm">
              <span className="material-symbols-outlined text-base">delete_sweep</span>
              Borrar Historial
            </button>
          )}
        </div>
      </div>

      {/* BCV and Status Control Bar */}
      <div className="bg-white rounded-3xl border border-outline-variant p-5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
        <BcvController bcv={bcv} />
        
        {ultimaCorrida && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-on-surface-variant font-sans font-semibold">Último Análisis Scraper:</span>
            {waitingForScraper ? (
              <span className="inline-flex items-center gap-1.5 font-mono bg-amber-500 text-white px-3.5 py-1.5 rounded-full font-bold animate-pulse">
                <span className="material-symbols-outlined text-xs animate-spin leading-none">sync</span>
                Robot Trabajando...
              </span>
            ) : (
              <>
                <span className="font-mono bg-primary text-on-primary px-3 py-1 rounded-full font-bold">
                  {ultimaCorrida.started_at ? formatTimeAgo(ultimaCorrida.started_at) : '—'}
                </span>
                <span className="text-on-surface-variant font-semibold">
                  ({ultimaCorrida.ok}/{ultimaCorrida.total} exitosos)
                </span>
              </>
            )}
            {isAdmin && (
              <button onClick={handleActualizar} disabled={refreshing || waitingForScraper}
                className="px-4 py-2 bg-secondary text-on-secondary hover:bg-secondary/90 disabled:opacity-50 font-extrabold uppercase font-mono tracking-wider text-[10px] rounded-full transition-all">
                {refreshing ? 'Iniciando...' : waitingForScraper ? 'Ejecutando...' : 'Actualizar'}
              </button>
            )}
          </div>
        )}
      </div>

      {refreshMessage && (
        <div className={`px-4 py-3.5 rounded-2xl border text-sm font-semibold flex justify-between items-center ${
          refreshMessage.type === 'success' ? 'bg-[#f0f9eb] border-[#c2e7b0] text-[#3c763d]' : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg">{refreshMessage.type === 'success' ? 'check_circle' : 'error'}</span>
            {refreshMessage.text}
          </span>
          <button onClick={() => setRefreshMessage(null)} className="text-current opacity-70 hover:opacity-100 font-bold text-lg">×</button>
        </div>
      )}

      {/* KPI Cards Area */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Catálogo Monitoreado" value={kpiStats.monitoredCount} sub="Productos activos en análisis" icon="package" color="text-primary" />
        <KpiCard label="Dispersión Promedio" value={`${kpiStats.avgDispersion.toFixed(1)}%`} sub="Volatilidad promedio del mercado" icon="analytics" color="text-primary" />
        <KpiCard label="Líder de Precios" value={kpiStats.bestChain} sub="Cadena con precios más bajos" icon="emoji_events" color="text-secondary" />
        <KpiCard label="Máxima Brecha de Precios" value={`${kpiStats.maxDispersionVal.toFixed(1)}%`} sub={`En: ${kpiStats.maxDispersionProd}`} icon="warning" color="text-error" />
      </div>

      {/* Premium Market Intelligence Bento Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Arbitrage High-Impact Banner Card */}
        <div className="lg:col-span-2 bg-gradient-to-tr from-[#fcf7ff] to-[#f3ebfa] rounded-[28px] border border-[#e1d5e7] p-6 shadow-sm hover:shadow-md transition-all flex flex-col justify-between min-h-[170px] relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full blur-2xl -mr-10 -mt-10 group-hover:scale-110 transition-transform duration-500"></div>
          <div className="space-y-2 relative z-10">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-purple-700 text-lg">bolt</span>
              <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-purple-800">Oportunidad de Arbitraje Activa</span>
            </div>
            {kpiStats.arbitrajeInfo ? (
              <>
                <h3 className="text-lg font-display font-extrabold text-[#040d53] leading-tight">
                  Ahorra hasta un <span className="text-purple-700 underline decoration-wavy decoration-purple-400">{kpiStats.arbitrajeInfo.ahorroPct}%</span> comprando <span className="font-sans font-semibold text-purple-900">"{kpiStats.arbitrajeInfo.producto}"</span>
                </h3>
                <p className="text-xs text-on-surface-variant max-w-xl font-sans">
                  Se detectó un costo mínimo en <strong className="text-purple-900">{kpiStats.arbitrajeInfo.chMin}</strong> vs un costo máximo en <strong className="text-purple-900">{kpiStats.arbitrajeInfo.chMax}</strong> para este mismo SKU.
                </p>
              </>
            ) : (
              <>
                <h3 className="text-lg font-display font-extrabold text-[#040d53] leading-tight">
                  Mercado de Medicamentos Estable
                </h3>
                <p className="text-xs text-on-surface-variant max-w-xl font-sans">
                  No hay brechas críticas superiores al 15% entre cadenas. La dispersión general de precios se mantiene controlada.
                </p>
              </>
            )}
          </div>
          <div className="pt-4 border-t border-purple-200/40 flex items-center justify-between text-xs relative z-10">
            <span className="font-mono font-bold text-purple-700 bg-purple-100/50 px-2.5 py-1 rounded-full flex items-center gap-1">
              <span className="material-symbols-outlined text-xs leading-none">insights</span>
              Recomendación de Compra
            </span>
            <span className="text-[11px] text-[#464650] font-sans">Filtra la tabla de abajo para comparar variantes.</span>
          </div>
        </div>

        {/* 3 Mini intelligence KPIs Card */}
        <div className="bg-white rounded-[28px] border border-outline-variant p-5 shadow-sm space-y-4">
          <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant block border-b pb-1.5 border-outline-variant">
            Insights de Posicionamiento
          </span>
          
          {/* Own Brand Leadership */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-xs font-bold text-[#1c1b1f] block leading-none">Liderazgo de Canasta</span>
              <span className="text-[10px] text-on-surface-variant font-sans">Mi marca es la más barata</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-extrabold font-mono text-secondary">{kpiStats.porcentajeLiderazgoPropio}%</span>
              <span className="material-symbols-outlined text-sm text-secondary">trending_up</span>
            </div>
          </div>

          {/* SUNDDE Compliance */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-xs font-bold text-[#1c1b1f] block leading-none">Cumplimiento SUNDDE</span>
              <span className="text-[10px] text-on-surface-variant font-sans">Margen regulado de ganancia</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-extrabold font-mono text-green-700">100%</span>
              <span className="material-symbols-outlined text-sm text-green-600">gavel</span>
            </div>
          </div>

          {/* Scraper Technical Health */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-xs font-bold text-[#1c1b1f] block leading-none">Salud Técnica de Lectura</span>
              <span className="text-[10px] text-on-surface-variant font-sans">Enlaces activos sin fallos</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-extrabold font-mono text-primary">{kpiStats.tasaSaludTecnica}%</span>
              <span className="material-symbols-outlined text-sm text-primary">cloud_done</span>
            </div>
          </div>
        </div>
      </div>

      {/* Volatility Warning Alert */}
      {altaVolatilidad.length > 0 && (
        <div className="bg-[#ffdad6]/40 border border-[#ffdad6] rounded-3xl p-5 space-y-3 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-xl text-[#93000a]">warning</span>
            <h3 className="font-extrabold text-[#93000a] text-sm">Productos con Alta Dispersión de Precios (Volatilidad &gt;20%)</h3>
          </div>
          <p className="text-xs text-[#93000a]/90">
            Los siguientes medicamentos presentan variaciones de precios muy altas entre las cadenas. Esto significa que hay oportunidades críticas de ahorro comprando en el proveedor líder.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
            {altaVolatilidad.slice(0, 4).map(item => (
              <div key={item.producto.id_interno} onClick={() => setSelectedProduct({ producto: item.producto, competencia: item.competencia })}
                className="bg-white p-3 rounded-2xl border border-error/10 hover:bg-error-container/20 cursor-pointer flex justify-between items-center transition-all">
                <div>
                  <div className="text-xs font-bold text-primary font-display">{item.producto.nombre}</div>
                  <div className="text-[10px] text-on-surface-variant font-mono mt-0.5">{item.producto.id_interno} · {item.producto.laboratorio}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-mono font-bold text-error">{fmt(item.minCompUsd)} - {fmt(item.maxCompUsd)}</div>
                  <div className="text-[10px] text-error font-mono font-bold">Brecha: {item.dispersionPercent.toFixed(0)}%</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Visual Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Leadership Bar Chart */}
        <div className="lg:col-span-5 bg-white rounded-3xl border border-outline-variant p-5 shadow-sm">
          <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider mb-4 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">bar_chart</span>
            Liderazgo de Precios: Medicamentos más Baratos
          </h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartChainLeadershipData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#464650' }} />
                <YAxis tick={{ fontSize: 11, fill: '#464650' }} />
                <Tooltip formatter={(value) => [`${value} productos más económicos`]} />
                <Bar dataKey="liderazgos">
                  {chartChainLeadershipData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Historical BCV rate chart */}
        <div className="lg:col-span-7 bg-white rounded-3xl border border-outline-variant p-5 shadow-sm">
          <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider mb-4 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">show_chart</span>
            Historial de Tasa Oficial BCV (USD/Bs)
          </h2>
          <div className="h-64">
            {bcvHistorico.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#464650] italic">No hay registros históricos de tasa cargados.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={bcvHistorico} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorBcv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#016874" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#016874" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                  <XAxis dataKey="fecha" tick={{ fontSize: 11, fill: '#464650' }} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11, fill: '#464650' }} />
                  <Tooltip formatter={(value) => [`Bs ${value.toFixed(2)}`]} />
                  <Area type="monotone" dataKey="valor" stroke="#016874" strokeWidth={2} fillOpacity={1} fill="url(#colorBcv)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Heatmap Matrix Section */}
      <div className="bg-white rounded-3xl border border-outline-variant shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-outline-variant flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display font-extrabold text-lg text-primary">Matriz Comparativa & Heatmap de Precios</h2>
            <p className="text-xs text-on-surface-variant font-sans">Identifica el precio de menor costo resaltado en color verde.</p>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            {/* Price Mode Toggle */}
            <div className="bg-surface-low p-1 rounded-xl flex gap-1 border border-outline-variant">
              <button
                onClick={() => setDashboardPriceMode('descuento')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  dashboardPriceMode === 'descuento' 
                    ? 'bg-primary text-on-primary shadow-sm' 
                    : 'text-on-surface-variant hover:bg-surface/50'
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">sell</span>
                Con Descuento
              </button>
              <button
                onClick={() => setDashboardPriceMode('lista')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  dashboardPriceMode === 'lista' 
                    ? 'bg-primary text-on-primary shadow-sm' 
                    : 'text-on-surface-variant hover:bg-surface/50'
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">receipt_long</span>
                Precio Lista (Full)
              </button>
            </div>

            {/* Categorías */}
            <div className="flex gap-1.5 flex-wrap">
              {categorias.map(cat => (
                <button key={cat} onClick={() => setCategoriaSeleccionada(cat)}
                  className={`px-4 py-1 text-xs rounded-full border transition-all ${
                    categoriaSeleccionada === cat 
                      ? 'bg-primary border-primary text-on-primary font-bold shadow-sm' 
                      : 'bg-white border-outline-variant text-on-background hover:bg-surface-low'
                  }`}>
                  {cat}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Heatmap Grid Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-surface-low text-primary uppercase font-mono tracking-wider text-left border-b border-surface-variant">
              <tr>
                <th className="px-6 py-4 font-bold">Producto</th>
                {cadenasUnicas.map(c => (
                  <th key={c} className="px-6 py-4 font-bold text-right">{c}</th>
                ))}
                <th className="px-6 py-4 font-bold text-right border-l border-surface-variant">Promedio</th>
                <th className="px-6 py-4 font-bold text-right">Mínimo</th>
                <th className="px-6 py-4 font-bold text-right bg-green-500/10 text-green-700 font-bold border-l border-green-500/10">Mi Precio</th>
                <th className="px-6 py-4 font-bold text-right text-secondary">Mi Desviación</th>
                <th className="px-6 py-4 font-bold text-center">Dispersión (%)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-variant">
              {filas.length === 0 ? (
                <tr>
                  <td colSpan={5 + cadenasUnicas.length} className="px-6 py-8 text-center text-on-surface-variant italic">
                    No hay productos en esta selección.
                  </td>
                </tr>
              ) : (
                filas.map(({ producto, competencia, chainPrices, avgCompUsd, minCompUsd, maxCompUsd, dispersionPercent, cheapestChains, propioPriceUsd, diffMinPercent, diffAvgPercent }) => {
                  return (
                    <tr key={producto.id_interno} onClick={() => setSelectedProduct({ producto, competencia })}
                      className="hover:bg-surface-low cursor-pointer transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-bold text-on-surface font-display text-sm">{producto.nombre}</div>
                        <div className="text-[10px] text-on-surface-variant font-mono mt-0.5">{producto.id_interno} · {producto.laboratorio}</div>
                      </td>

                      {/* Heatmap Cells */}
                      {cadenasUnicas.map(cadena => {
                        const cellPrice = getPriceForCell(chainPrices, cadena);
                        if (!cellPrice) {
                          return <td key={cadena} className="px-6 py-4 text-right text-gray-300 font-mono select-none">—</td>;
                        }

                        // Check if this chain is the cheapest for this product
                        const isCheapest = cheapestChains.includes(cadena);
                        let cellBg = 'bg-white';
                        let cellText = 'text-on-surface';

                        if (isCheapest) {
                          cellBg = 'bg-secondary-container/20';
                          cellText = 'text-secondary font-extrabold';
                        }

                        return (
                          <td key={cadena} className={`px-6 py-4 text-right font-mono text-xs ${cellBg} ${cellText} border-l border-white`}>
                            <div>{fmt(cellPrice)}</div>
                          </td>
                        );
                      })}

                      {/* Average Column */}
                      <td className="px-6 py-4 text-right font-mono text-xs text-on-surface-variant font-semibold bg-surface-low/50 border-l border-surface-variant">
                        {avgCompUsd ? fmt(avgCompUsd) : '—'}
                      </td>

                      {/* Min Price */}
                      <td className="px-6 py-4 text-right font-mono text-xs text-secondary font-bold bg-secondary-container/10">
                        {minCompUsd ? fmt(minCompUsd) : '—'}
                      </td>

                      {/* Mi Precio */}
                      <td className="px-6 py-4 text-right font-mono text-xs text-green-700 font-extrabold bg-green-500/5 border-l border-green-500/10">
                        {propioPriceUsd ? fmt(propioPriceUsd) : '—'}
                      </td>

                      {/* Mi Desviación */}
                      <td className="px-6 py-4 text-right whitespace-nowrap bg-surface-low/30 border-r border-surface-variant">
                        {propioPriceUsd ? (
                          <div className="flex flex-col items-end gap-0.5 text-[10px] font-mono leading-none">
                            <span className={diffMinPercent && diffMinPercent > 0.1 ? 'text-error font-extrabold' : 'text-secondary font-extrabold'}>
                              {diffMinPercent && diffMinPercent > 0.1 ? `vs Mín: +${diffMinPercent.toFixed(1)}%` : 'vs Mín: Mismo'}
                            </span>
                            <span className={diffAvgPercent && diffAvgPercent > 0 ? 'text-error/80 font-bold' : 'text-secondary/80 font-bold'}>
                              {diffAvgPercent && diffAvgPercent > 0 ? `vs Prom: +${diffAvgPercent.toFixed(1)}%` : `vs Prom: -${Math.abs(diffAvgPercent || 0).toFixed(1)}%`}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-300 font-mono select-none">—</span>
                        )}
                      </td>

                      {/* Dispersion Column */}
                      <td className="px-6 py-4 text-center whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-mono font-bold tracking-wide uppercase ${
                          dispersionPercent > 20 ? 'bg-error-container text-error border border-error/20'
                          : dispersionPercent > 0 ? 'bg-secondary-container text-on-secondary-container border border-secondary/20'
                          : 'bg-surface-low text-on-surface-variant'
                        }`}>
                          {dispersionPercent > 0 ? `${dispersionPercent.toFixed(0)}%` : '0%'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedProduct && (
        <ProductDetailModal
          producto={selectedProduct.producto}
          competencia={selectedProduct.competencia}
          currency={currency}
          bcvRate={bcv.rate}
          initialPriceMode={dashboardPriceMode}
          onClose={() => setSelectedProduct(null)}
        />
      )}

      {/* Clear History Confirmation Dialog */}
      <ConfirmModal
        isOpen={showClearHistoryConfirm}
        title="¿Borrar Todo el Historial?"
        message={`¿Estás seguro de que deseas eliminar TODOS los registros históricos de precios de todos los productos?\n\nEsta acción eliminará todas las tendencias y los logs de ejecución acumulados, reseteando las estadísticas a cero.\n\nLos productos, cadenas y URLs de competencia se conservarán intactos.`}
        confirmText={clearingHistory ? 'Borrando...' : 'Borrar Todo'}
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleClearAllHistory}
        onCancel={() => setShowClearHistoryConfirm(false)}
      />
    </div>
  );
}

function KpiCard({ label, value, sub, icon, color }) {
  return (
    <div className="bg-white rounded-3xl border border-outline-variant p-5 flex items-center justify-between shadow-sm hover:shadow-md transition-all">
      <div className="space-y-1">
        <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant">{label}</span>
        <div className={`text-2xl font-display font-extrabold ${color}`}>{value}</div>
        <p className="text-[11px] text-on-surface-variant font-semibold">{sub}</p>
      </div>
      <div className="bg-surface-low p-3 rounded-2xl w-12 h-12 flex items-center justify-center border border-outline-variant">
        <span className="material-symbols-outlined text-primary text-2xl select-none">{icon}</span>
      </div>
    </div>
  );
}

function BcvController({ bcv }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');

  const handleSave = async () => {
    const ok = await bcv.setManual(val);
    if (ok) {
      setVal('');
      setEditing(false);
    }
  };

  return (
    <div className="flex items-center gap-4 text-xs font-mono">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-secondary animate-ping"></span>
        <span className="text-on-surface-variant uppercase font-bold flex items-center gap-1">
          <span className="material-symbols-outlined text-sm leading-none select-none">payments</span>
          Tasa Oficial BCV:
        </span>
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input type="text" value={val} onChange={e => setVal(e.target.value)}
            className="w-24 px-3 py-1.5 border border-outline-variant rounded-xl text-xs font-mono font-semibold focus:outline-none focus:ring-1 focus:ring-primary" placeholder="0.00" />
          <button onClick={handleSave} className="px-3 py-1.5 bg-primary text-on-primary font-bold rounded-full text-[10px]">Guardar</button>
          <button onClick={() => setEditing(false)} className="px-3 py-1.5 bg-surface-low text-on-surface-variant rounded-full text-[10px]">Cancelar</button>
          {bcv.error && <span className="text-[10px] text-error font-bold">{bcv.error}</span>}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-extrabold text-primary text-base">
            {bcv.loading ? 'Recuperando...' : bcv.rate ? `Bs ${bcv.rate.toFixed(4)} / USD` : 'Sin tasa'}
          </span>
          <span className="text-[9px] uppercase bg-primary-container px-2.5 py-1 rounded-full text-on-primary-container font-bold">
            {bcv.source || 'Auto'}
          </span>
          <button onClick={() => { setEditing(true); setVal(bcv.rate || ''); }}
            className="text-[11px] font-bold text-primary hover:underline uppercase inline-flex items-center gap-0.5">
            <span className="material-symbols-outlined text-xs">edit</span>
            Editar Tasa
          </button>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'hace unos segundos';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}
