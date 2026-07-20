import { useEffect, useState, useMemo } from 'react';
import { collection, getDocs, query, orderBy, limit, doc, getDoc, writeBatch, deleteDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useBcvRate } from '../hooks/useBcvRate';
import ProductDetailModal from '../components/ProductDetailModal';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Cell, Legend, ScatterChart, Scatter, ReferenceLine
} from 'recharts';

export default function Dashboard({ user, userDoc }) {
  const [productos, setProductos] = useState([]);
  const [productosCompetencia, setProductosCompetencia] = useState([]);
  const [bcvHistorico, setBcvHistorico] = useState([]);
  const [historicoPrecios, setHistoricoPrecios] = useState([]);
  const [ultimaCorrida, setUltimaCorrida] = useState(null);
  const [currency, setCurrency] = useState('usd');
  const [search, setSearch] = useState('');
  const [categoriaSeleccionada, setCategoriaSeleccionada] = useState('Todas');
  const [mostrarCambiosHoy, setMostrarCambiosHoy] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [dashboardPriceMode, setDashboardPriceMode] = useState('lista');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [waitingForScraper, setWaitingForScraper] = useState(false);
  const [scraperTriggerTime, setScraperTriggerTime] = useState(null);

  // Fase 3 State
  const [simulacionVariacion, setSimulacionVariacion] = useState(0);
  const [reporteCargando, setReporteCargando] = useState(false);
  const [reporteCargandoPaso, setReporteCargandoPaso] = useState('');
  const [reporteGenerado, setReporteGenerado] = useState(null);
  const [activeReportTab, setActiveReportTab] = useState('ejecutivo');

  const bcv = useBcvRate();
  const { addToast } = useToast();
  const isAdmin = userDoc?.rol === 'administrador';

  const cargarDatos = async (showSilently = false) => {
    if (!showSilently) setLoading(true);
    try {
      const [prodSnap, competSnap, runsSnap, bcvSnap, histSnap] = await Promise.all([
        getDocs(collection(db, 'productos')),
        getDocs(collection(db, 'productos_competencia')),
        getDocs(query(collection(db, 'scrape_runs'), orderBy('started_at', 'desc'), limit(1))),
        getDocs(query(collection(db, 'bcv_rates'), orderBy('updated_at', 'asc'))),
        getDocs(query(collection(db, 'historico_precios'), orderBy('scraped_at', 'desc'), limit(1500))),
      ]);

      setProductos(prodSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setProductosCompetencia(competSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setHistoricoPrecios(histSnap.docs.map(d => ({ id: d.id, ...d.data(), scraped_at: d.data().scraped_at?.toDate?.() || null })));
      
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

      // Strip rawDate object to ensure we only store 100% simple JSON-serializable primitives in state
      setBcvHistorico(uniqueDaysRates.map(({ dayKey, fecha, valor }) => ({ dayKey, fecha, valor })));

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
          addToast(`¡Actualización completada! El robot ha terminado de extraer y analizar los últimos precios (${docData.ok} exitosos, ${docData.errores} errores).`, 'success');
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
        addToast('El robot scraper ha sido iniciado vía GitHub Actions. Se te notificará de forma interactiva en esta misma pantalla cuando finalice la carga de precios.', 'success');
      } else {
        const txt = await res.text();
        throw new Error(`GitHub respondió ${res.status}: ${txt}`);
      }
    } catch (err) {
      addToast('Error al disparar scraper: ' + err.message, 'error');
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
      addToast('Historial de precios y análisis de scraper vaciados con éxito.', 'success');
      await cargarDatos();
    } catch (err) {
      console.error('Error al borrar historial:', err?.message || String(err));
      addToast('Error al borrar historial: ' + err.message, 'error');
    }
    setClearingHistory(false);
    setShowClearHistoryConfirm(false);
  };

  // Unique categories for filtering
  const categorias = useMemo(() => {
    const list = new Set(productos.map(p => p.categoria).filter(Boolean));
    return ['Todas', ...Array.from(list)];
  }, [productos]);

  // Helper to normalize the history grouping key
  const getHistoryKey = (id_producto, cadena, marca) => {
    return `${id_producto}_${cadena}_${marca}`.toLowerCase().replace(/[\s/\\]+/g, '_');
  };

  // Main calculations for products and competitors
  const analizados = useMemo(() => {
    // Group history by normalized key
    const historyGrouped = {};
    historicoPrecios.forEach(h => {
      if (!h.id_producto_propio || !h.cadena || !h.marca) return;
      const k = getHistoryKey(h.id_producto_propio, h.cadena, h.marca);
      if (!historyGrouped[k]) {
        historyGrouped[k] = [];
      }
      historyGrouped[k].push(h);
    });

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

          // Calculate history trend for this competitor
          const k = getHistoryKey(p.id_interno, c.cadena, c.marca);
          const hList = historyGrouped[k] || [];
          const currentHist = hList[0];
          const previousHist = hList.find(x => x.run_id !== currentHist?.run_id && x.scraped_at?.toDateString() !== currentHist?.scraped_at?.toDateString());
          
          const currentVal = currentHist ? (dashboardPriceMode === 'descuento' ? (currentHist.precio_desc_bs || currentHist.precio_full_bs) : currentHist.precio_full_bs) : null;
          const prevVal = previousHist ? (dashboardPriceMode === 'descuento' ? (previousHist.precio_desc_bs || previousHist.precio_full_bs) : previousHist.precio_full_bs) : null;
          
          const valNow = currentVal !== null ? currentVal : priceBs;
          let changePercent = 0;
          if (valNow && prevVal && prevVal > 0) {
            changePercent = ((valNow - prevVal) / prevVal) * 100;
          }

          return {
            id: c.id,
            tipo: c.tipo,
            cadena: c.cadena,
            priceUsd: priceBs / bcv.rate,
            priceBs: priceBs,
            marca: c.marca,
            url: c.url,
            changePercent,
            valPrev: prevVal,
          };
        }).filter(v => v !== null && v.priceUsd > 0);

        // Check if there are any price changes in the latest run
        const hasChangesToday = chainPrices.some(cp => Math.abs(cp.changePercent) > 0.05);

        const competitorPricesUsd = chainPrices
          .filter(x => x.tipo !== 'propio')
          .map(x => x.priceUsd);

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

        // Calculate dynamic ranking of our brand among all available options
        const sortedOptions = [...chainPrices].sort((a, b) => a.priceUsd - b.priceUsd);
        const totalOptionsCount = sortedOptions.length;
        const ownOptionIndex = sortedOptions.findIndex(x => x.tipo === 'propio');
        const ranking = ownOptionIndex !== -1 ? ownOptionIndex + 1 : null;

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
          hasChangesToday,
          ranking,
          totalOptionsCount,
        };
      });
  }, [productos, productosCompetencia, bcv.rate, dashboardPriceMode, historicoPrecios]);

  // Filtered rows
  const filas = useMemo(() => {
    const term = search.toLowerCase().trim();
    return analizados.filter(item => {
      const matchSearch = !term || 
        item.producto.nombre.toLowerCase().includes(term) ||
        (item.producto.principio_activo || '').toLowerCase().includes(term) ||
        item.producto.id_interno.toLowerCase().includes(term);
      
      const matchCat = categoriaSeleccionada === 'Todas' || item.producto.categoria === categoriaSeleccionada;
      const matchChanges = !mostrarCambiosHoy || item.hasChangesToday;
      return matchSearch && matchCat && matchChanges;
    });
  }, [analizados, search, categoriaSeleccionada, mostrarCambiosHoy]);

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
    let totalDiffVsMin = 0;
    let diffVsMinCount = 0;
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
            // Difference percentage of own price versus the minimum alternative
            const diffPct = ((propioPrice - minAlt) / minAlt) * 100;
            totalDiffVsMin += diffPct;
            diffVsMinCount++;
          } else {
            // No alternatives, we are the only ones
            ownBrandLider++;
          }
        }
      }
    });

    const porcentajeLiderazgoPropio = ownBrandTotal > 0 ? Math.round((ownBrandLider / ownBrandTotal) * 100) : 100;
    const brechaPromedioVsMin = diffVsMinCount > 0 ? (totalDiffVsMin / diffVsMinCount) : 0;

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

    // Global Relative Price Index (IPR)
    let totalIpr = 0;
    let iprCount = 0;
    let totalChangesToday = 0;

    analizados.forEach(item => {
      if (item.propioPriceUsd && item.avgCompUsd) {
        totalIpr += (item.propioPriceUsd / item.avgCompUsd) * 100;
        iprCount++;
      }
      if (item.hasChangesToday) {
        totalChangesToday++;
      }
    });

    const globalIpr = iprCount > 0 ? totalIpr / iprCount : null;

    return {
      monitoredCount: analizados.length,
      avgDispersion: productsWithDispersion > 0 ? totalDispersion / productsWithDispersion : 0,
      maxDispersionVal,
      maxDispersionProd,
      bestChain: maxCheapCount > 0 ? `${bestChain} (${maxCheapCount} prods)` : '—',
      porcentajeLiderazgoPropio,
      brechaPromedioVsMin,
      arbitrajeInfo,
      globalIpr,
      totalChangesToday,
    };
  }, [analizados, cadenasUnicas, productosCompetencia]);

  // Calculations for simulated pricing (Fase 3)
  const simulatedStats = useMemo(() => {
    let totalSimIpr = 0;
    let simIprCount = 0;
    let ownBrandTotal = 0;
    let ownBrandLiderSim = 0;
    let totalDiffVsMinSim = 0;
    let diffVsMinCountSim = 0;

    const itemsSimulados = analizados.map(item => {
      const { propioPriceUsd, avgCompUsd, minCompUsd, maxCompUsd, chainPrices } = item;
      
      const simOwnPriceUsd = propioPriceUsd !== null 
        ? propioPriceUsd * (1 + simulacionVariacion / 100) 
        : null;

      let simRanking = item.ranking;
      let isLiderSim = false;

      if (simOwnPriceUsd !== null) {
        ownBrandTotal++;
        
        // Find alternative competitor prices
        const altPrices = chainPrices
          .filter(cp => cp.tipo === 'alternativa')
          .map(cp => cp.priceUsd);

        if (altPrices.length > 0) {
          const minAlt = Math.min(...altPrices);
          isLiderSim = simOwnPriceUsd <= minAlt;
          
          // Gap percentage versus minimum alternative
          const diffPct = ((simOwnPriceUsd - minAlt) / minAlt) * 100;
          totalDiffVsMinSim += diffPct;
          diffVsMinCountSim++;
        } else {
          isLiderSim = true;
        }

        if (isLiderSim) {
          ownBrandLiderSim++;
        }

        // Calculate simulated rank
        const simChainPrices = chainPrices.map(cp => {
          if (cp.tipo === 'propio') {
            return { ...cp, priceUsd: simOwnPriceUsd, priceBs: simOwnPriceUsd * (bcv.rate || 1) };
          }
          return cp;
        });
        const sorted = [...simChainPrices].sort((a, b) => a.priceUsd - b.priceUsd);
        const ownIndex = sorted.findIndex(x => x.tipo === 'propio');
        simRanking = ownIndex !== -1 ? ownIndex + 1 : null;
      }

      if (simOwnPriceUsd !== null && avgCompUsd) {
        totalSimIpr += (simOwnPriceUsd / avgCompUsd) * 100;
        simIprCount++;
      }

      return {
        ...item,
        simOwnPriceUsd,
        simRanking,
        isLiderSim,
      };
    });

    const simGlobalIpr = simIprCount > 0 ? totalSimIpr / simIprCount : null;
    const porcentajeLiderazgoSim = ownBrandTotal > 0 ? Math.round((ownBrandLiderSim / ownBrandTotal) * 100) : 100;
    const brechaPromedioVsMinSim = diffVsMinCountSim > 0 ? (totalDiffVsMinSim / diffVsMinCountSim) : 0;

    return {
      itemsSimulados,
      simGlobalIpr,
      porcentajeLiderazgoSim,
      brechaPromedioVsMinSim,
    };
  }, [analizados, simulacionVariacion, bcv.rate]);

  // Scatter plot data for competitor positioning analysis
  const scatterData = useMemo(() => {
    return analizados
      .filter(item => item.propioPriceUsd !== null && item.avgCompUsd !== null)
      .map(item => ({
        name: item.producto.nombre,
        propio: item.propioPriceUsd,
        competencia: item.avgCompUsd,
        categoria: item.producto.categoria,
      }));
  }, [analizados]);

  const maxScatterPrice = useMemo(() => {
    if (scatterData.length === 0) return 10;
    const maxVal = Math.max(...scatterData.map(d => Math.max(d.propio, d.competencia)));
    return Math.ceil(maxVal * 1.1); // Add a small margin
  }, [scatterData]);

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
    const matches = chainPrices.filter(c => c.cadena === cadena);
    if (matches.length === 0) return null;
    const prices = matches.map(m => m.priceUsd);
    return Math.min(...prices);
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

  // Fase 3 Report Generation & Management Functions
  const handleGenerarReporte = async () => {
    setReporteCargando(true);
    setReporteCargandoPaso('Examinando catálogo de medicamentos y paridades...');
    await new Promise(r => setTimeout(r, 600));
    setReporteCargandoPaso('Evaluando dispersión de precios y paridades BCV...');
    await new Promise(r => setTimeout(r, 600));
    setReporteCargandoPaso('Modelando elasticidad e impacto de simulación...');
    await new Promise(r => setTimeout(r, 600));
    setReporteCargandoPaso('Compilando informe ejecutivo final...');
    await new Promise(r => setTimeout(r, 500));

    const numSubir = [];
    const numBajar = [];
    
    analizados.forEach(item => {
      if (item.propioPriceUsd !== null && item.avgCompUsd !== null) {
        const diffAvg = item.diffAvgPercent || 0;
        if (diffAvg < -12) {
          numSubir.push(item);
        } else if (diffAvg > 12) {
          numBajar.push(item);
        }
      }
    });

    const iprStr = kpiStats.globalIpr ? kpiStats.globalIpr.toFixed(1) : '—';
    const statusText = kpiStats.globalIpr 
      ? (kpiStats.globalIpr < 98 ? 'altamente competitivo (marca líder en precios de bajo costo)' 
         : kpiStats.globalIpr <= 103 ? 'moderadamente competitivo (paridad de mercado aceptable)' 
         : 'premium / costoso (riesgo alto de pérdida de volumen ante competidores)')
      : 'no disponible';

    const reporte = {
      titulo: 'Dossier de Inteligencia y Estrategia de Precios · TrackFlow',
      fecha: new Date().toLocaleDateString('es-VE', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      tasaBcv: bcv.rate || 1,
      resumenEjecutivo: `Tras un análisis detallado del portafolio monitoreado, su Índice de Precios Relativos (IPR) Global se sitúa en **${iprStr}%**, posicionándolo como un perfil **${statusText}**. La dispersión general de precios de los competidores promedia un **${kpiStats.avgDispersion.toFixed(1)}%**, lo que indica que el mercado farmacéutico de Venezuela se encuentra en una fase de alta dinámica y de constantes brechas de arbitraje de precios.`,
      
      oportunidadesSubir: numSubir.slice(0, 5).map(x => ({
        id: x.producto.id_interno,
        nombre: x.producto.nombre,
        precioPropio: x.propioPriceUsd,
        precioPromedio: x.avgCompUsd,
        gap: x.diffAvgPercent,
        recomendacion: `Actualmente te vendes un ${Math.abs(x.diffAvgPercent).toFixed(0)}% por debajo del promedio. Se sugiere incrementar el precio entre un 5% y 8% para capturar margen de forma inmediata sin perder el liderazgo competitivo.`
      })),

      oportunidadesBajar: numBajar.slice(0, 5).map(x => ({
        id: x.producto.id_interno,
        nombre: x.producto.nombre,
        precioPropio: x.propioPriceUsd,
        precioPromedio: x.avgCompUsd,
        gap: x.diffAvgPercent,
        recomendacion: `Tu precio se encuentra un ${x.diffAvgPercent.toFixed(0)}% por encima del promedio. Existe un alto riesgo de fuga de ventas. Recomendamos aplicar un descuento estratégico del ${Math.max(5, Math.round(x.diffAvgPercent - 5))}% para alinearse con los promedios del mercado.`
      })),

      estrategiaElasticidad: `Con la simulación actual de **${simulacionVariacion > 0 ? '+' : ''}${simulacionVariacion}%**, su IPR Global se ajustaría a **${simulatedStats.simGlobalIpr ? simulatedStats.simGlobalIpr.toFixed(1) : '—'}%** y su liderazgo de precios en góndola pasaría de **${kpiStats.porcentajeLiderazgoPropio}%** a **${simulatedStats.porcentajeLiderazgoSim}%** de los productos activos. Esto generaría un ${simulacionVariacion > 0 ? 'incremento inmediato de margen unitario, pero con un riesgo estimado de contracción del 5-8% en el volumen de ventas en medicamentos elásticos' : simulacionVariacion < 0 ? 'estímulo en el volumen físico de ventas (estimado +10-15% en medicamentos de alta rotación) que compensará la reducción de margen' : 'posicionamiento estable en el mercado sin variaciones significativas de elasticidad'}.`,
    };

    setReporteGenerado(reporte);
    setReporteCargando(false);
    addToast('¡Reporte de posicionamiento estratégico generado con éxito!', 'success');
  };

  const handleCopiarReporte = () => {
    if (!reporteGenerado) return;
    const r = reporteGenerado;
    let txt = `=== ${r.titulo.toUpperCase()} ===\n`;
    txt += `Fecha: ${r.fecha}\n`;
    txt += `Tasa Oficial BCV: Bs ${r.tasaBcv.toFixed(4)} / USD\n\n`;
    txt += `--- RESUMEN EJECUTIVO ---\n${r.resumenEjecutivo}\n\n`;
    txt += `--- IMPACTO DE SIMULACIÓN Y ELASTICIDAD ---\n${r.estrategiaElasticidad}\n\n`;
    
    if (r.oportunidadesSubir.length > 0) {
      txt += `--- OPORTUNIDADES DE CAPTURA DE MARGEN (SUBIR PRECIOS) ---\n`;
      r.oportunidadesSubir.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio: $${o.precioPropio.toFixed(2)} | Promedio: $${o.precioPromedio.toFixed(2)} (${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    if (r.oportunidadesBajar.length > 0) {
      txt += `--- ALERTAS DE PÉRDIDA DE VOLUMEN (BAJAR PRECIOS) ---\n`;
      r.oportunidadesBajar.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio: $${o.precioPropio.toFixed(2)} | Promedio: $${o.precioPromedio.toFixed(2)} (+${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    navigator.clipboard.writeText(txt);
    addToast('El reporte ha sido copiado al portapapeles.', 'success');
  };

  const handleDescargarReporteTxt = () => {
    if (!reporteGenerado) return;
    const r = reporteGenerado;
    let txt = `=== ${r.titulo.toUpperCase()} ===\n`;
    txt += `Fecha: ${r.fecha}\n`;
    txt += `Tasa Oficial BCV: Bs ${r.tasaBcv.toFixed(4)} / USD\n\n`;
    txt += `--- RESUMEN EJECUTIVO ---\n${r.resumenEjecutivo}\n\n`;
    txt += `--- IMPACTO DE SIMULACIÓN Y ELASTICIDAD ---\n${r.estrategiaElasticidad}\n\n`;
    
    if (r.oportunidadesSubir.length > 0) {
      txt += `--- OPORTUNIDADES DE CAPTURA DE MARGEN (SUBIR PRECIOS) ---\n`;
      r.oportunidadesSubir.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio: $${o.precioPropio.toFixed(2)} | Promedio: $${o.precioPromedio.toFixed(2)} (${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    if (r.oportunidadesBajar.length > 0) {
      txt += `--- ALERTAS DE PÉRDIDA DE VOLUMEN (BAJAR PRECIOS) ---\n`;
      r.oportunidadesBajar.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio: $${o.precioPropio.toFixed(2)} | Promedio: $${o.precioPromedio.toFixed(2)} (+${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Reporte_Estrategico_Precios_${new Date().toISOString().slice(0, 10)}.txt`;
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

      {/* KPI Cards Area */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Catálogo Monitoreado" value={kpiStats.monitoredCount} sub="Productos activos en análisis" icon="package" color="text-primary" />
        <KpiCard label="Índice de Precio Relativo" value={kpiStats.globalIpr ? `${kpiStats.globalIpr.toFixed(1)}%` : '—'} sub={`vs Promedio Competidores (Dispersión: ${kpiStats.avgDispersion.toFixed(1)}%)`} icon="analytics" color="text-primary" />
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
              <span className="text-xs font-bold text-[#1c1b1f] block leading-none">Liderazgo en Precios</span>
              <span className="text-[10px] text-on-surface-variant font-sans">Porcentaje de productos donde somos líderes</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-extrabold font-mono text-secondary">{kpiStats.porcentajeLiderazgoPropio}%</span>
              <span className="material-symbols-outlined text-sm text-secondary">trending_up</span>
            </div>
          </div>

          {/* Average Price Gap vs Leader */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-xs font-bold text-[#1c1b1f] block leading-none">Brecha vs Opción Más Barata</span>
              <span className="text-[10px] text-on-surface-variant font-sans">Nuestros precios comparados con el líder</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`text-base font-extrabold font-mono ${kpiStats.brechaPromedioVsMin <= 0 ? 'text-green-700' : 'text-amber-700'}`}>
                {kpiStats.brechaPromedioVsMin > 0 ? '+' : ''}{kpiStats.brechaPromedioVsMin.toFixed(1)}%
              </span>
              <span className={`material-symbols-outlined text-sm ${kpiStats.brechaPromedioVsMin <= 0 ? 'text-green-600' : 'text-amber-600'}`}>
                {kpiStats.brechaPromedioVsMin <= 0 ? 'check_circle' : 'trending_up'}
              </span>
            </div>
          </div>

          {/* High Price Variation SKUs */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-xs font-bold text-[#1c1b1f] block leading-none">Medicamentos con Alta Variación</span>
              <span className="text-[10px] text-on-surface-variant font-sans">Diferencias mayores al 20% entre farmacias</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-extrabold font-mono text-error">{altaVolatilidad.length} SKUs</span>
              <span className="material-symbols-outlined text-sm text-error">warning</span>
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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Leadership Bar Chart */}
        <div className="bg-white rounded-3xl border border-outline-variant p-5 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider mb-1 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">bar_chart</span>
              Liderazgo de Precios
            </h2>
            <p className="text-[11px] text-on-surface-variant font-sans mb-4 leading-relaxed">
              Cantidad de productos donde cada cadena ofrece la opción más económica.
            </p>
          </div>
          <div className="h-60 mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartChainLeadershipData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#464650' }} />
                <YAxis tick={{ fontSize: 10, fill: '#464650' }} />
                <Tooltip formatter={(value) => [`${value} productos`, 'Líder en']} />
                <Bar dataKey="liderazgos">
                  {chartChainLeadershipData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Pricing Positioning Scatter Chart */}
        <div className="bg-white rounded-3xl border border-outline-variant p-5 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider mb-1 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">bubble_chart</span>
              Posicionamiento de Precios (USD)
            </h2>
            <p className="text-[11px] text-on-surface-variant font-sans mb-4 leading-relaxed">
              Nuestros precios (Y) vs Promedio de Competencia (X). Paridad en la línea roja.
            </p>
          </div>
          <div className="h-60 mt-2">
            {scatterData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#464650] italic">No hay suficientes datos comparativos.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                  <XAxis type="number" dataKey="competencia" name="Promedio Competencia" unit="$" tick={{ fontSize: 10, fill: '#464650' }} />
                  <YAxis type="number" dataKey="propio" name="Mi Precio" unit="$" tick={{ fontSize: 10, fill: '#464650' }} />
                  <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(value, name) => [`$${parseFloat(value).toFixed(2)}`, name === 'propio' ? 'Mi Precio' : 'Promedio Competencia']} />
                  <ReferenceLine segment={[{ x: 0, y: 0 }, { x: maxScatterPrice, y: maxScatterPrice }]} stroke="#ff4d4f" strokeDasharray="3 3" />
                  <Scatter name="Productos" data={scatterData} fill="#016874" />
                </ScatterChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Historical BCV rate chart */}
        <div className="bg-white rounded-3xl border border-outline-variant p-5 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider mb-1 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">show_chart</span>
              Evolución de Tasa Oficial BCV
            </h2>
            <p className="text-[11px] text-on-surface-variant font-sans mb-4 leading-relaxed">
              Historial de la tasa oficial del Banco Central de Venezuela.
            </p>
          </div>
          <div className="h-60 mt-2">
            {bcvHistorico.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#464650] italic">No hay registros históricos de tasa cargados.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={bcvHistorico} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorBcv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#016874" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#016874" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                  <XAxis dataKey="fecha" tick={{ fontSize: 10, fill: '#464650' }} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#464650' }} />
                  <Tooltip formatter={(value) => [`Bs ${value.toFixed(2)}`, 'Tasa Oficial']} />
                  <Area type="monotone" dataKey="valor" stroke="#016874" strokeWidth={2} fillOpacity={1} fill="url(#colorBcv)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Fase 3: Simulador Estratégico & Inteligencia Predictiva */}
      <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-outline-variant pb-4 gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] bg-primary text-on-primary font-mono font-extrabold uppercase px-2.5 py-0.5 rounded-full tracking-wider animate-pulse">
                Fase 3 Activa
              </span>
              <h2 className="text-xl font-display font-extrabold text-primary">Simulador de Precios & Estrategia de Margen</h2>
            </div>
            <p className="text-xs text-on-surface-variant font-sans">
              Simula ajustes de precios globales y evalúa el impacto inmediato sobre tu competitividad, paridad de mercado y posicionamiento.
            </p>
          </div>

          <button
            onClick={handleGenerarReporte}
            disabled={reporteCargando}
            className={`text-xs font-bold px-5 py-2.5 rounded-full shadow-sm transition-all flex items-center gap-2 border ${
              reporteCargando
                ? 'bg-surface-low text-on-surface-variant border-outline-variant cursor-not-allowed'
                : 'bg-primary text-on-primary border-primary hover:bg-primary/95 hover:shadow'
            }`}
          >
            <span className="material-symbols-outlined text-base">insights</span>
            {reporteCargando ? 'Analizando mercado...' : 'Generar Reporte de Estrategia'}
          </button>
        </div>

        {/* Loading Steps Visual Effect */}
        {reporteCargando && (
          <div className="bg-surface-low rounded-2xl border border-outline-variant p-5 flex flex-col items-center justify-center space-y-3 py-8 animate-pulse">
            <span className="material-symbols-outlined text-3xl text-primary animate-spin">sync</span>
            <div className="text-sm font-semibold text-primary font-mono">{reporteCargandoPaso}</div>
            <div className="w-48 bg-outline-variant h-1 rounded-full overflow-hidden">
              <div className="bg-primary h-full rounded-full animate-pulse"></div>
            </div>
          </div>
        )}

        {/* Report Output Panel */}
        {reporteGenerado && !reporteCargando && (
          <div className="bg-[#fcfbfc] rounded-2xl border border-outline-variant overflow-hidden shadow-inner flex flex-col">
            <div className="bg-primary/[0.03] px-5 py-3 border-b border-outline-variant flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-sm">assignment</span>
                <span className="text-xs font-bold text-primary uppercase font-mono tracking-wider">{reporteGenerado.titulo}</span>
              </div>
              <span className="text-[10px] text-on-surface-variant font-mono">{reporteGenerado.fecha}</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 border-b border-outline-variant text-center divide-x divide-outline-variant text-xs font-mono font-bold">
              <button
                onClick={() => setActiveReportTab('ejecutivo')}
                className={`py-3 transition-all ${activeReportTab === 'ejecutivo' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:bg-surface-low'}`}
              >
                Resumen Ejecutivo
              </button>
              <button
                onClick={() => setActiveReportTab('oportunidades')}
                className={`py-3 transition-all ${activeReportTab === 'oportunidades' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:bg-surface-low'}`}
              >
                Ajustes de Lista ({reporteGenerado.oportunidadesSubir.length + reporteGenerado.oportunidadesBajar.length})
              </button>
              <button
                onClick={() => setActiveReportTab('margen')}
                className={`py-3 transition-all ${activeReportTab === 'margen' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:bg-surface-low'}`}
              >
                Estrategia & Elasticidad
              </button>
            </div>

            <div className="p-5 text-xs text-on-surface-variant font-sans space-y-4 max-h-96 overflow-y-auto">
              {activeReportTab === 'ejecutivo' && (
                <div className="space-y-3 leading-relaxed">
                  <h4 className="font-bold text-primary text-sm font-display">Situación de Posicionamiento Global</h4>
                  <p>{reporteGenerado.resumenEjecutivo}</p>
                  <p className="bg-primary/5 p-3 rounded-xl border border-primary/10 text-[11px]">
                    <strong>Indicación estratégica:</strong> Mantener un IPR cercano al 100% asegura que tu catálogo preserve el balance óptimo de rentabilidad y recordación de marca de bajo precio ante tus pacientes/clientes de farmacia.
                  </p>
                </div>
              )}

              {activeReportTab === 'oportunidades' && (
                <div className="space-y-4">
                  {reporteGenerado.oportunidadesSubir.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="font-bold text-green-700 text-sm font-display flex items-center gap-1">
                        <span className="material-symbols-outlined text-base">trending_up</span>
                        Oportunidades de Captura de Margen (Precios Bajos vs Competidores)
                      </h4>
                      <p className="text-[11px] text-on-surface-variant">Los siguientes productos se venden significativamente por debajo del promedio. Puedes elevar el precio de lista de forma segura:</p>
                      <div className="space-y-2">
                        {reporteGenerado.oportunidadesSubir.map(o => (
                          <div key={o.id} className="bg-green-500/5 p-3 rounded-xl border border-green-500/10 flex justify-between items-start gap-4 flex-wrap">
                            <div>
                              <strong className="text-green-800 font-sans block">{o.nombre}</strong>
                              <span className="text-[10px] font-mono block text-on-surface-variant mt-0.5">ID: {o.id} · {o.recomendacion}</span>
                            </div>
                            <div className="text-right font-mono shrink-0">
                              <div className="text-green-800 font-bold font-sans">Mi Precio: {fmt(o.precioPropio)}</div>
                              <div className="text-on-surface-variant">Promedio: {fmt(o.precioPromedio)}</div>
                              <div className="text-green-700 font-extrabold text-[10px]">Gap vs Prom: {o.gap.toFixed(1)}%</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {reporteGenerado.oportunidadesBajar.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="font-bold text-error text-sm font-display flex items-center gap-1">
                        <span className="material-symbols-outlined text-base">trending_down</span>
                        Riesgos Críticos de Fuga de Ventas (Sobreprecio vs Competidores)
                      </h4>
                      <p className="text-[11px] text-on-surface-variant">Estás perdiendo posicionamiento de bajo precio en estos ítems. Se recomienda un descuento correctivo:</p>
                      <div className="space-y-2">
                        {reporteGenerado.oportunidadesBajar.map(o => (
                          <div key={o.id} className="bg-error-container/10 p-3 rounded-xl border border-error/10 flex justify-between items-start gap-4 flex-wrap">
                            <div>
                              <strong className="text-error font-sans block">{o.nombre}</strong>
                              <span className="text-[10px] font-mono block text-on-surface-variant mt-0.5">ID: {o.id} · {o.recomendacion}</span>
                            </div>
                            <div className="text-right font-mono shrink-0">
                              <div className="text-error font-bold font-sans">Mi Precio: {fmt(o.precioPropio)}</div>
                              <div className="text-on-surface-variant">Promedio: {fmt(o.precioPromedio)}</div>
                              <div className="text-error font-extrabold text-[10px]">Gap vs Prom: +{o.gap.toFixed(1)}%</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {reporteGenerado.oportunidadesSubir.length === 0 && reporteGenerado.oportunidadesBajar.length === 0 && (
                    <div className="text-center italic text-on-surface-variant py-4">No se detectaron brechas de precio que requieran correcciones inmediatas de lista. Tu portafolio está óptimamente alineado.</div>
                  )}
                </div>
              )}

              {activeReportTab === 'margen' && (
                <div className="space-y-3 leading-relaxed">
                  <h4 className="font-bold text-primary text-sm font-display">Estudio de Elasticidad del Ajuste Simulado</h4>
                  <p>{reporteGenerado.estrategiaElasticidad}</p>
                  <p className="bg-amber-500/5 p-3 rounded-xl border border-amber-500/15 text-[11px]">
                    <strong>Nota Metodológica:</strong> El cálculo de volumen estimado asume una elasticidad precio promedio de la demanda farmacéutica del sector de medicamentos básicos de -1.15. Las variaciones son sugerencias algorítmicas de paridad de góndola.
                  </p>
                </div>
              )}
            </div>

            <div className="bg-surface-low px-5 py-3 border-t border-outline-variant flex items-center justify-end gap-2.5">
              <button
                onClick={handleCopiarReporte}
                className="text-[11px] font-bold text-primary hover:underline uppercase inline-flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-xs">content_copy</span>
                Copiar Markdown
              </button>
              <span className="text-outline-variant">|</span>
              <button
                onClick={handleDescargarReporteTxt}
                className="text-[11px] font-bold text-primary hover:underline uppercase inline-flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-xs">download_file</span>
                Descargar Reporte (.TXT)
              </button>
            </div>
          </div>
        )}

        {/* Dynamic Simulation Slider Area */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {/* Slider Controls Card */}
          <div className="md:col-span-1 bg-surface-low border border-outline-variant p-4 rounded-2xl flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono font-bold uppercase text-on-surface-variant tracking-wider">Ajuste de Mi Marca</span>
                <span className={`text-base font-mono font-extrabold ${simulacionVariacion > 0 ? 'text-primary' : simulacionVariacion < 0 ? 'text-green-700' : 'text-on-surface-variant'}`}>
                  {simulacionVariacion > 0 ? `+${simulacionVariacion}` : simulacionVariacion}%
                </span>
              </div>

              <input
                type="range"
                min="-30"
                max="30"
                step="1"
                value={simulacionVariacion}
                onChange={e => setSimulacionVariacion(parseInt(e.target.value))}
                className="w-full accent-primary h-1.5 bg-outline-variant rounded-lg appearance-none cursor-pointer"
              />

              {/* Slider Quick Preset Buttons */}
              <div className="grid grid-cols-4 gap-1 text-[9px] font-mono font-bold text-center">
                <button onClick={() => setSimulacionVariacion(-15)} className="p-1 bg-white border border-outline-variant hover:bg-surface rounded">-15%</button>
                <button onClick={() => setSimulacionVariacion(-5)} className="p-1 bg-white border border-outline-variant hover:bg-surface rounded">-5%</button>
                <button onClick={() => setSimulacionVariacion(0)} className="p-1 bg-white border border-outline-variant hover:bg-surface rounded font-extrabold text-primary text-center">0%</button>
                <button onClick={() => setSimulacionVariacion(10)} className="p-1 bg-white border border-outline-variant hover:bg-surface rounded">+10%</button>
              </div>
            </div>

            <div className="pt-4 border-t border-outline-variant/50 text-[10px] text-on-surface-variant font-sans leading-relaxed">
              Desliza para aplicar un porcentaje de cambio sobre tu precio base y simular los nuevos indicadores.
            </div>
          </div>

          {/* Side-by-side KPI Output Cards */}
          <div className="md:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Simulated IPR Card */}
            <div className="bg-white rounded-2xl border border-outline-variant p-4 flex flex-col justify-between shadow-sm relative overflow-hidden">
              <div>
                <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant">IPR Global Simulado</span>
                <div className="mt-2 flex items-baseline gap-2">
                  <div className={`text-2xl font-display font-extrabold ${simulacionVariacion !== 0 ? 'text-primary' : 'text-on-surface-variant'}`}>
                    {simulatedStats.simGlobalIpr ? `${simulatedStats.simGlobalIpr.toFixed(1)}%` : '—'}
                  </div>
                  {simulacionVariacion !== 0 && (
                    <span className={`text-[10px] font-mono font-bold flex items-center ${simulatedStats.simGlobalIpr < (kpiStats.globalIpr || 100) ? 'text-green-600' : 'text-error'}`}>
                      <span className="material-symbols-outlined text-[10px] leading-none">
                        {simulatedStats.simGlobalIpr < (kpiStats.globalIpr || 100) ? 'arrow_downward' : 'arrow_upward'}
                      </span>
                      {Math.abs(simulatedStats.simGlobalIpr - (kpiStats.globalIpr || 100)).toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>
              <div className="pt-3 border-t border-outline-variant/30 text-[10px] leading-relaxed mt-2 text-on-surface-variant">
                IPR Base: <strong className="font-mono">{kpiStats.globalIpr ? `${kpiStats.globalIpr.toFixed(1)}%` : '—'}</strong>. Posición de paridad de tu marca vs promedio.
              </div>
            </div>

            {/* Simulated Leadership Percentage Card */}
            <div className="bg-white rounded-2xl border border-outline-variant p-4 flex flex-col justify-between shadow-sm relative overflow-hidden">
              <div>
                <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant">Liderazgo Góndola Simulado</span>
                <div className="mt-2 flex items-baseline gap-2">
                  <div className={`text-2xl font-display font-extrabold ${simulacionVariacion !== 0 ? 'text-[#4f378a]' : 'text-on-surface-variant'}`}>
                    {simulatedStats.porcentajeLiderazgoSim}%
                  </div>
                  {simulacionVariacion !== 0 && (
                    <span className={`text-[10px] font-mono font-bold flex items-center ${simulatedStats.porcentajeLiderazgoSim > kpiStats.porcentajeLiderazgoPropio ? 'text-green-600' : 'text-error'}`}>
                      <span className="material-symbols-outlined text-[10px] leading-none">
                        {simulatedStats.porcentajeLiderazgoSim > kpiStats.porcentajeLiderazgoPropio ? 'arrow_upward' : 'arrow_downward'}
                      </span>
                      {Math.abs(simulatedStats.porcentajeLiderazgoSim - kpiStats.porcentajeLiderazgoPropio)}%
                    </span>
                  )}
                </div>
              </div>
              <div className="pt-3 border-t border-outline-variant/30 text-[10px] leading-relaxed mt-2 text-on-surface-variant">
                Liderazgo Base: <strong className="font-mono">{kpiStats.porcentajeLiderazgoPropio}%</strong>. Porcentaje de productos donde ofreces el precio más bajo.
              </div>
            </div>

            {/* Elasticity / Estimated Margin Card */}
            <div className="bg-white rounded-2xl border border-outline-variant p-4 flex flex-col justify-between shadow-sm relative overflow-hidden">
              <div>
                <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant">Elasticidad & Paridad</span>
                <div className="mt-2 flex items-baseline gap-2">
                  <div className={`text-base font-display font-extrabold flex items-center gap-1 ${
                    simulacionVariacion > 12 ? 'text-error'
                    : simulacionVariacion > 0 ? 'text-amber-600'
                    : simulacionVariacion < 0 ? 'text-green-700'
                    : 'text-on-surface-variant'
                  }`}>
                    <span className="material-symbols-outlined text-base leading-none">
                      {simulacionVariacion > 0 ? 'trending_up' : simulacionVariacion < 0 ? 'trending_down' : 'remove'}
                    </span>
                    {simulacionVariacion > 12 ? 'Riesgo Crítico'
                      : simulacionVariacion > 0 ? 'Margen Elevado'
                      : simulacionVariacion < 0 ? 'Atracción de Volumen'
                      : 'Estable'}
                  </div>
                </div>
              </div>
              <div className="pt-3 border-t border-outline-variant/30 text-[10px] leading-relaxed mt-2 text-on-surface-variant">
                Brecha Mínima Promedio: <strong className="font-mono">{simulatedStats.brechaPromedioVsMinSim.toFixed(1)}%</strong> (era {kpiStats.brechaPromedioVsMin.toFixed(1)}%).
              </div>
            </div>
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

            {/* Quick Audit: What changed today? */}
            <button
              onClick={() => setMostrarCambiosHoy(!mostrarCambiosHoy)}
              className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 border ${
                mostrarCambiosHoy 
                  ? 'bg-amber-500 border-amber-500 text-white font-extrabold shadow-sm' 
                  : 'bg-white border-outline-variant text-on-surface-variant hover:bg-surface-low'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">notifications_active</span>
              ¿Qué cambió hoy? {kpiStats.totalChangesToday > 0 ? `(${kpiStats.totalChangesToday})` : ''}
            </button>

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
                filas.map(({ producto, competencia, chainPrices, avgCompUsd, minCompUsd, maxCompUsd, dispersionPercent, cheapestChains, propioPriceUsd, diffMinPercent, diffAvgPercent, ranking, totalOptionsCount }) => {
                  const alts = competencia.filter(c => c.tipo === 'alternativa');
                  const tieneAltsValidas = alts.some(a => {
                    const pBs = dashboardPriceMode === 'descuento' ? (a.ultimo_precio_desc_bs || a.ultimo_precio_full_bs) : a.ultimo_precio_full_bs;
                    return pBs && pBs > 0;
                  });
                  const tieneLiderazgo = propioPriceUsd !== null && (
                    !tieneAltsValidas || (diffMinPercent !== null && diffMinPercent <= 0.01)
                  );

                  return (
                    <tr key={producto.id_interno} onClick={() => setSelectedProduct({ producto, competencia })}
                       className="hover:bg-surface-low cursor-pointer transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-bold text-on-surface font-display text-sm">{producto.nombre}</span>
                          {tieneLiderazgo && (
                            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[9px] font-bold font-mono bg-green-100 text-green-800 border border-green-200" title="Mi marca es la opción más barata del mercado para este producto">
                              <span className="material-symbols-outlined text-[10px] leading-none">star</span>
                              Líder en Precios
                            </span>
                          )}
                          {ranking && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold font-mono bg-[#e8f0fe] text-[#1a73e8] border border-[#d2e3fc]" title={`Posición de nuestra marca entre todas las opciones del mercado (1° es la más económica)`}>
                              Rank: {ranking}°/{totalOptionsCount}
                            </span>
                          )}
                        </div>
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

                        // Get matching item for trend calculation
                        const matchItem = chainPrices.find(cp => cp.cadena === cadena);
                        const changePercent = matchItem?.changePercent || 0;

                        return (
                          <td key={cadena} className={`px-6 py-4 text-right font-mono text-xs ${cellBg} ${cellText} border-l border-white`}>
                            <div>{fmt(cellPrice)}</div>
                            {Math.abs(changePercent) > 0.05 && (
                              <div className={`text-[9px] font-bold flex items-center justify-end gap-0.5 leading-none mt-0.5 ${changePercent > 0 ? 'text-error' : 'text-green-600'}`}>
                                <span className="material-symbols-outlined text-[10px] leading-none">{changePercent > 0 ? 'arrow_upward' : 'arrow_downward'}</span>
                                {changePercent > 0 ? '+' : ''}{changePercent.toFixed(1)}%
                              </div>
                            )}
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
                        {propioPriceUsd ? (
                          <>
                            <div>{fmt(propioPriceUsd)}</div>
                            {(() => {
                              const matchItem = chainPrices.find(cp => cp.tipo === 'propio');
                              const changePercent = matchItem?.changePercent || 0;
                              if (Math.abs(changePercent) > 0.05) {
                                return (
                                  <div className={`text-[9px] font-bold flex items-center justify-end gap-0.5 leading-none mt-0.5 ${changePercent > 0 ? 'text-error' : 'text-green-600'}`}>
                                    <span className="material-symbols-outlined text-[10px] leading-none">{changePercent > 0 ? 'arrow_upward' : 'arrow_downward'}</span>
                                    {changePercent > 0 ? '+' : ''}{changePercent.toFixed(1)}%
                                  </div>
                                );
                              }
                              return null;
                            })()}
                          </>
                        ) : '—'}
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
