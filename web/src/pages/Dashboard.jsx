import { useEffect, useState, useMemo } from 'react';
import { collection, query, orderBy, limit, doc, getDoc, writeBatch, deleteDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useBcvRate } from '../hooks/useBcvRate';
import ProductDetailModal from '../components/ProductDetailModal';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Cell, Legend, ScatterChart, Scatter, ReferenceLine
} from 'recharts';

export default function Dashboard({ user, userDoc }) {
  const {
    productos,
    productosCompetencia,
    bcvRates: bcvHistorico,
    historicoPrecios,
    ultimaCorrida: globalUltimaCorrida,
    loadingInitial: loading,
    refreshData
  } = useData();

  const [localUltimaCorrida, setLocalUltimaCorrida] = useState(null);
  const ultimaCorrida = localUltimaCorrida || globalUltimaCorrida;

  const [currency, setCurrency] = useState('usd');
  const [search, setSearch] = useState('');
  const [categoriaSeleccionada, setCategoriaSeleccionada] = useState('Todas');
  const [tipoMercadoSeleccionado, setTipoMercadoSeleccionado] = useState('Todos');
  const [unSeleccionada, setUnSeleccionada] = useState('Todas');
  const [paginaActual, setPaginaActual] = useState(1);
  const [mostrarCambiosHoy, setMostrarCambiosHoy] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [dashboardPriceMode, setDashboardPriceMode] = useState('lista');
  const [refreshing, setRefreshing] = useState(false);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [waitingForScraper, setWaitingForScraper] = useState(false);
  const [scraperTriggerTime, setScraperTriggerTime] = useState(null);

  const bcv = useBcvRate();
  const { addToast } = useToast();
  const isAdmin = userDoc?.rol === 'administrador';

  const cargarDatos = async (showSilently = false) => {
    await refreshData(showSilently);
  };

  // Listener en tiempo real para detectar cuándo termina el scraper
  useEffect(() => {
    const q = query(collection(db, 'scrape_runs'), orderBy('started_at', 'desc'), limit(1));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const docData = snapshot.docs[0].data();
        const runDate = docData.started_at?.toDate?.() || null;
        setLocalUltimaCorrida({ ...docData, started_at: runDate });
        
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

  // Reset pagination when filters change
  useEffect(() => {
    setPaginaActual(1);
  }, [search, categoriaSeleccionada, mostrarCambiosHoy, tipoMercadoSeleccionado, unSeleccionada]);

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
      
      const pTipo = (item.producto.market_type || 'GENERICO').toUpperCase();
      const matchTipo = tipoMercadoSeleccionado === 'Todos' || pTipo === tipoMercadoSeleccionado.toUpperCase();

      const pUn = (item.producto.unidad_negocio || 'La Sante').toUpperCase();
      const matchUn = unSeleccionada === 'Todas' || pUn === unSeleccionada.toUpperCase();

      return matchSearch && matchCat && matchChanges && matchTipo && matchUn;
    });
  }, [analizados, search, categoriaSeleccionada, mostrarCambiosHoy, tipoMercadoSeleccionado, unSeleccionada]);

  const itemsPorPagina = 10;
  const totalPaginas = Math.ceil(filas.length / itemsPorPagina);
  const filasPaginadas = useMemo(() => {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    return filas.slice(inicio, inicio + itemsPorPagina);
  }, [filas, paginaActual]);

  // All active chains represented
  const cadenasUnicas = useMemo(() => {
    const set = new Set(productosCompetencia.map(pc => pc.cadena));
    return Array.from(set).sort();
  }, [productosCompetencia]);

  // Group by active ingredient to compare Generic vs Brand of the same molecule
  const analisisMoleculaParidad = useMemo(() => {
    // Group active analyzed products by active ingredient + presentation
    const grouped = {};
    filas.forEach(item => {
      const principio = (item.producto.principio_activo || '').trim().toLowerCase();
      if (!principio) return;
      
      const concentracion = (item.producto.concentracion || '').trim().toLowerCase();
      const tamano = (item.producto.tamano || '').trim().toLowerCase();
      const key = `${principio} | ${concentracion} | ${tamano}`;
      
      if (!grouped[key]) {
        grouped[key] = {
          principio_activo: item.producto.principio_activo,
          concentracion: item.producto.concentracion,
          tamano: item.producto.tamano,
          genericos: [],
          marcas: []
        };
      }
      
      const pTipo = (item.producto.market_type || 'GENERICO').toUpperCase();
      if (pTipo === 'MARCA') {
        grouped[key].marcas.push(item);
      } else {
        grouped[key].genericos.push(item);
      }
    });

    const comparacionesValidas = [];
    Object.entries(grouped).forEach(([key, g]) => {
      if (g.genericos.length > 0 && g.marcas.length > 0) {
        const miGenerico = g.genericos.find(x => x.propioPriceUsd !== null);
        const miMarca = g.marcas.find(x => x.propioPriceUsd !== null);
        
        const precioPropioGen = miGenerico ? miGenerico.propioPriceUsd : null;
        const precioPropioMarca = miMarca ? miMarca.propioPriceUsd : null;

        // Gap calculation: How much more expensive is my Brand than my Generic?
        let gapPercent = null;
        if (precioPropioGen && precioPropioMarca && precioPropioGen > 0) {
          gapPercent = ((precioPropioMarca - precioPropioGen) / precioPropioGen) * 100;
        }

        // Market average calculation
        const avgGenTotal = g.genericos.map(x => x.propioPriceUsd || x.avgCompUsd).filter(v => v !== null);
        const avgMarcaTotal = g.marcas.map(x => x.propioPriceUsd || x.avgCompUsd).filter(v => v !== null);
        const totalAvgGen = avgGenTotal.length > 0 ? avgGenTotal.reduce((a,b)=>a+b, 0) / avgGenTotal.length : null;
        const totalAvgMarca = avgMarcaTotal.length > 0 ? avgMarcaTotal.reduce((a,b)=>a+b, 0) / avgMarcaTotal.length : null;
        
        let marketGapPercent = null;
        if (totalAvgGen && totalAvgMarca && totalAvgGen > 0) {
          marketGapPercent = ((totalAvgMarca - totalAvgGen) / totalAvgGen) * 100;
        }

        // Diagnostics
        let diagnostico = '';
        let nivelSeveridad = 'normal'; // 'normal', 'alerta', 'critico', 'oportunidad'
        
        if (precioPropioGen && precioPropioMarca) {
          if (gapPercent < 0) {
            diagnostico = 'Inversión de Precio Crítica: Tu genérico cuesta más que tu marca propia.';
            nivelSeveridad = 'critico';
          } else if (gapPercent < 15) {
            diagnostico = 'Riesgo de Canibalización: Brecha < 15%. Genérico demasiado caro o marca muy barata.';
            nivelSeveridad = 'alerta';
          } else if (gapPercent > 70) {
            diagnostico = 'Oportunidad de Margen: Brecha > 70%. Tu genérico tiene margen de subida sin afectar liderazgo.';
            nivelSeveridad = 'oportunidad';
          } else {
            diagnostico = `Alineación Óptima: Brecha saludable del ${gapPercent.toFixed(0)}% entre marca y genérico.`;
            nivelSeveridad = 'normal';
          }
        } else if (precioPropioGen && !precioPropioMarca) {
          diagnostico = 'Solo tienes precio para el Genérico. Monitoreando paridad contra competidores.';
          nivelSeveridad = 'normal';
        } else if (!precioPropioGen && precioPropioMarca) {
          diagnostico = 'Solo tienes precio para la Marca. Monitoreando paridad contra competidores.';
          nivelSeveridad = 'normal';
        }

        comparacionesValidas.push({
          key,
          principio: g.principio_activo,
          concentracion: g.concentracion,
          tamano: g.tamano,
          miGenerico,
          miMarca,
          precioPropioGen,
          precioPropioMarca,
          gapPercent,
          marketGapPercent,
          diagnostico,
          nivelSeveridad,
          totalAvgGen,
          totalAvgMarca
        });
      }
    });

    return comparacionesValidas;
  }, [filas]);

  // Aggregate leadership chart data: how many times each chain is cheapest
  const chartChainLeadershipData = useMemo(() => {
    const counts = {};
    cadenasUnicas.forEach(c => { counts[c] = 0; });

    filas.forEach(item => {
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
  }, [filas, cadenasUnicas]);

  // Indicator: In which pharmacy chain are our products most expensive on average?
  const cadenaComparacionCostos = useMemo(() => {
    if (!filas || filas.length === 0 || cadenasUnicas.length === 0) return null;

    const statsPorCadena = cadenasUnicas.map(cName => {
      let sumDiffPct = 0;
      let count = 0;
      let masCostososCount = 0;
      let masBaratosCount = 0;

      filas.forEach(item => {
        if (!item.propioPriceUsd || item.propioPriceUsd <= 0) return;
        
        const compInChain = item.chainPrices.find(x => x.cadena.toLowerCase().trim() === cName.toLowerCase().trim() && x.tipo !== 'propio');
        if (compInChain && compInChain.priceUsd > 0) {
          const diffPct = ((item.propioPriceUsd - compInChain.priceUsd) / compInChain.priceUsd) * 100;
          sumDiffPct += diffPct;
          count++;
          if (diffPct > 1) masCostososCount++;
          if (diffPct < -1) masBaratosCount++;
        }
      });

      const avgDiff = count > 0 ? sumDiffPct / count : null;
      return {
        cadena: cName,
        avgDiff,
        count,
        masCostososCount,
        masBaratosCount
      };
    }).filter(s => s.count > 0 && s.avgDiff !== null);

    if (statsPorCadena.length === 0) return null;

    // Sort from highest average diff (most expensive) to lowest (most competitive)
    statsPorCadena.sort((a, b) => b.avgDiff - a.avgDiff);

    const cadenaMasCostosa = statsPorCadena[0];
    const cadenaMasBarata = statsPorCadena[statsPorCadena.length - 1];

    return {
      ranking: statsPorCadena,
      cadenaMasCostosa,
      cadenaMasBarata
    };
  }, [filas, cadenasUnicas]);

  // Indicator: Share of Voice (SoV) de Precios y Cobertura de Competidores
  const shareOfVoiceData = useMemo(() => {
    if (!filas || filas.length === 0 || cadenasUnicas.length === 0) return [];

    const totalProductos = filas.length;

    return cadenasUnicas.map(cName => {
      let skusMonitoreados = 0;
      let lowestCount = 0;
      let highestCount = 0;
      let totalComparados = 0;

      filas.forEach(item => {
        const hasChain = item.chainPrices.some(x => x.cadena.toLowerCase().trim() === cName.toLowerCase().trim());
        if (hasChain) skusMonitoreados++;

        if (item.minCompUsd && item.chainPrices.some(x => x.cadena.toLowerCase().trim() === cName.toLowerCase().trim() && x.tipo !== 'propio')) {
          totalComparados++;
          if (item.cheapestChains.some(ch => ch.toLowerCase().trim() === cName.toLowerCase().trim())) {
            lowestCount++;
          }
          if (item.mostExpensiveChains.some(ch => ch.toLowerCase().trim() === cName.toLowerCase().trim())) {
            highestCount++;
          }
        }
      });

      const coveragePct = totalProductos > 0 ? (skusMonitoreados / totalProductos) * 100 : 0;
      const cheapestSoVPct = totalComparados > 0 ? (lowestCount / totalComparados) * 100 : 0;

      return {
        cadena: cName,
        skusMonitoreados,
        coveragePct,
        lowestCount,
        highestCount,
        totalComparados,
        cheapestSoVPct
      };
    }).sort((a, b) => b.cheapestSoVPct - a.cheapestSoVPct);
  }, [filas, cadenasUnicas]);

  // Indicator: Elasticidad Histórica por Molécula
  const elasticidadPorMolecula = useMemo(() => {
    if (!filas || filas.length === 0) return [];

    const grouped = {};
    filas.forEach(item => {
      const principio = (item.producto.principio_activo || '').trim();
      if (!principio) return;
      
      const key = principio.toLowerCase();
      if (!grouped[key]) {
        grouped[key] = {
          nombre: principio,
          items: [],
        };
      }
      grouped[key].items.push(item);
    });

    const moleculasList = Object.values(grouped).map(g => {
      const totalSkus = g.items.length;
      const marcasCount = g.items.filter(x => (x.producto.market_type || '').toUpperCase() === 'MARCA').length;
      const genericosCount = totalSkus - marcasCount;

      const dispersions = g.items.map(x => x.dispersionPercent).filter(d => d > 0);
      const avgDispersion = dispersions.length > 0 ? dispersions.reduce((a,b) => a+b, 0) / dispersions.length : 0;

      let totalChangeCount = 0;
      let sumAbsChanges = 0;
      g.items.forEach(x => {
        x.chainPrices.forEach(cp => {
          if (cp.changePercent && Math.abs(cp.changePercent) > 0) {
            sumAbsChanges += Math.abs(cp.changePercent);
            totalChangeCount++;
          }
        });
      });
      const avgVolatilidad = totalChangeCount > 0 ? sumAbsChanges / totalChangeCount : 0;

      const elasticityScore = (avgDispersion * 0.6) + (avgVolatilidad * 0.4);

      let tipoElasticidad = 'Moderada';
      let badgeClass = 'bg-blue-100 text-blue-800 border-blue-200';
      let recomendacion = 'Comportamiento en paridad estándar.';

      if (elasticityScore > 18 || avgDispersion > 25) {
        tipoElasticidad = 'Alta Elasticidad (Sensible)';
        badgeClass = 'bg-red-100 text-red-800 border-red-200';
        recomendacion = 'Sensibilidad alta al precio. Aumentos provocan rápida migración a genéricos u otra cadena.';
      } else if (elasticityScore < 10 && avgDispersion < 12) {
        tipoElasticidad = 'Inelástico (Oportunidad EBITDA)';
        badgeClass = 'bg-emerald-100 text-emerald-800 border-emerald-200';
        recomendacion = 'Baja sensibilidad. Oportunidad para realizar ajustes al alza y capturar margen de beneficio.';
      }

      return {
        nombre: g.nombre,
        totalSkus,
        marcasCount,
        genericosCount,
        avgDispersion,
        avgVolatilidad,
        elasticityScore,
        tipoElasticidad,
        badgeClass,
        recomendacion
      };
    });

    return moleculasList.sort((a, b) => b.elasticityScore - a.elasticityScore);
  }, [filas]);

  // High volatility/dispersion alerts: dispersion > 20%
  const altaVolatilidad = useMemo(() => {
    return filas.filter(item => item.dispersionPercent > 20).sort((a,b) => b.dispersionPercent - a.dispersionPercent);
  }, [filas]);

  // Stats for cards
  const kpiStats = useMemo(() => {
    let totalDispersion = 0;
    let productsWithDispersion = 0;
    let maxDispersionVal = 0;
    let maxDispersionProd = '—';
    let maxDispersionItem = null;

    filas.forEach(item => {
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

    filas.forEach(item => {
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
    filas.forEach(item => {
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

    filas.forEach(item => {
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
      monitoredCount: filas.length,
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
  }, [filas, cadenasUnicas, productosCompetencia]);

  // Price gap bar chart data: deviation % vs competitors
  const priceGapData = useMemo(() => {
    return filas
      .filter(item => item.propioPriceUsd !== null && item.avgCompUsd !== null && item.avgCompUsd > 0)
      .map(item => {
        const name = item.producto.nombre;
        const shortName = name.length > 20 ? name.substring(0, 18) + '...' : name;
        return {
          name: shortName,
          fullName: name,
          gap: parseFloat(item.diffAvgPercent.toFixed(1)),
          propioPrice: item.propioPriceUsd,
          avgComp: item.avgCompUsd,
        };
      })
      .sort((a, b) => a.gap - b.gap); // Sort from most competitive to least competitive
  }, [filas]);

  // Scatter Plot Positioning Matrix Data (Mi Precio USD vs. Promedio Mercado USD)
  const scatterPlotData = useMemo(() => {
    return filas
      .filter(item => item.propioPriceUsd !== null && item.avgCompUsd !== null && item.avgCompUsd > 0)
      .map(item => ({
        id: item.producto.id_interno,
        name: item.producto.nombre,
        categoria: item.producto.categoria || 'Sin Cat',
        x: parseFloat(item.avgCompUsd.toFixed(2)),
        y: parseFloat(item.propioPriceUsd.toFixed(2)),
        diffAvgPercent: item.diffAvgPercent ? parseFloat(item.diffAvgPercent.toFixed(1)) : 0,
        dispersionPercent: parseFloat(item.dispersionPercent.toFixed(1)),
        ranking: item.ranking,
        totalOptions: item.totalOptionsCount,
        producto: item.producto,
        competencia: item.competencia,
      }));
  }, [filas]);

  // Currency Formatter Helper
  const fmt = (priceUsd) => {
    if (priceUsd == null || isNaN(priceUsd)) return '—';
    if (currency === 'usd') {
      return `$${priceUsd.toFixed(2)}`;
    }
    if (!bcv.rate) return '—';
    return 'Bs ' + (priceUsd * bcv.rate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Custom tooltip for price gap bar chart
  const PriceGapTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const isCheaper = data.gap < 0;
      const gapAbs = Math.abs(data.gap).toFixed(1);
      
      return (
        <div className="bg-white/95 p-3.5 border border-outline-variant rounded-2xl shadow-lg backdrop-blur-sm max-w-xs font-sans">
          <p className="text-xs font-bold text-on-surface mb-1.5">{data.fullName}</p>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between gap-6 text-on-surface-variant">
              <span>Nuestro Precio:</span>
              <span className="font-semibold text-on-surface">{fmt(data.propioPrice)}</span>
            </div>
            <div className="flex justify-between gap-6 text-on-surface-variant">
              <span>Promedio Competencia:</span>
              <span className="font-semibold text-on-surface">{fmt(data.avgComp)}</span>
            </div>
            <div className="pt-1.5 border-t border-outline/10 flex justify-between gap-6 items-center">
              <span>Desviación:</span>
              <span className={`font-bold px-1.5 py-0.5 rounded-full text-[11px] ${isCheaper ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {isCheaper ? `-${gapAbs}%` : `+${gapAbs}%`}
              </span>
            </div>
          </div>
          <p className={`text-[10px] mt-2 font-medium ${isCheaper ? 'text-emerald-600' : 'text-red-600'}`}>
            {isCheaper 
              ? `Estás un ${gapAbs}% más barato que el promedio.` 
              : `Estás un ${gapAbs}% más caro que el promedio.`}
          </p>
        </div>
      );
    }
    return null;
  };

  // Custom scatter tooltip for positioning matrix
  const CustomScatterTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const rate = currency === 'usd' ? 1 : (bcv.rate || 1);
      const symbol = currency === 'usd' ? '$' : 'Bs ';

      return (
        <div className="bg-white border border-outline-variant p-3.5 rounded-2xl shadow-xl text-xs space-y-1.5 max-w-xs font-sans">
          <div className="font-bold text-primary font-display border-b border-outline-variant/40 pb-1">{data.name}</div>
          <div className="text-[10px] text-on-surface-variant font-mono">{data.categoria} · {data.id}</div>
          <div className="grid grid-cols-2 gap-3 pt-1 font-mono">
            <div className="bg-surface-low p-2 rounded-xl border border-outline-variant/30">
              <span className="text-[10px] text-on-surface-variant font-sans block">Mi Precio:</span>
              <span className="font-bold text-primary text-sm">{symbol}{(data.y * rate).toFixed(2)}</span>
            </div>
            <div className="bg-surface-low p-2 rounded-xl border border-outline-variant/30">
              <span className="text-[10px] text-on-surface-variant font-sans block">Prom. Mercado:</span>
              <span className="font-bold text-secondary text-sm">{symbol}{(data.x * rate).toFixed(2)}</span>
            </div>
          </div>
          <div className="text-[11px] font-mono pt-1 flex justify-between items-center">
            <span className={data.diffAvgPercent > 0 ? 'text-red-700 font-bold' : 'text-emerald-700 font-bold'}>
              Brecha: {data.diffAvgPercent > 0 ? '+' : ''}{data.diffAvgPercent}%
            </span>
            <span className="text-on-surface-variant bg-surface-low px-2 py-0.5 rounded-full text-[10px]">
              Posición: #{data.ranking || '—'} / {data.totalOptions}
            </span>
          </div>
        </div>
      );
    }
    return null;
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
    
    filas.forEach(item => {
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

        {/* Pricing Positioning (Price Gap vs Competitors) */}
        <div className="bg-white rounded-3xl border border-outline-variant p-5 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider mb-1 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">bar_chart</span>
              Brecha de Precios vs. Competencia
            </h2>
            <p className="text-[11px] text-on-surface-variant font-sans mb-4 leading-relaxed">
              Diferencia porcentual de nuestros precios frente al promedio de la competencia. El eje central (0%) indica paridad de precio.
            </p>
          </div>
          <div className="h-60 mt-2">
            {priceGapData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#464650] italic">No hay suficientes datos comparativos.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={priceGapData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                  <XAxis 
                    dataKey="name" 
                    tick={{ fontSize: 9, fill: '#464650' }} 
                    interval={0}
                  />
                  <YAxis 
                    tick={{ fontSize: 10, fill: '#464650' }} 
                    tickFormatter={(v) => `${v}%`}
                  />
                  <Tooltip content={<PriceGapTooltip />} />
                  <ReferenceLine y={0} stroke="#464650" strokeWidth={1} />
                  <Bar dataKey="gap">
                    {priceGapData.map((entry, index) => {
                      const isCheaper = entry.gap < 0;
                      return (
                        <Cell 
                          key={`cell-${index}`} 
                          fill={isCheaper ? '#10b981' : '#f43f5e'} 
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
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

      {/* Positioning Matrix (Scatter Chart: Mi Precio vs. Promedio Mercado) */}
      {scatterPlotData.length > 0 && (
        <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-outline-variant pb-3 gap-2">
            <div>
              <h2 className="font-display font-extrabold text-lg text-primary flex items-center gap-2">
                <span className="material-symbols-outlined text-xl text-primary">scatter_plot</span>
                Matriz de Posicionamiento de Precios (Mi Precio vs. Promedio de Mercado)
              </h2>
              <p className="text-xs text-on-surface-variant font-sans mt-0.5">
                Visualización bidimensional: Los puntos por debajo de la diagonal muestran productos donde tu precio es más bajo que el mercado (Verde = Líder en precio), y por encima muestran productos con mayor precio (Rojo = Riesgo de volumen).
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs font-mono font-bold">
              <span className="flex items-center gap-1 text-emerald-700">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-600"></span>
                Bajo Promedio Mercado
              </span>
              <span className="flex items-center gap-1 text-red-700">
                <span className="w-2.5 h-2.5 rounded-full bg-red-600"></span>
                Sobre Promedio Mercado
              </span>
            </div>
          </div>

          <div className="h-80 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 20, right: 30, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                <XAxis 
                  type="number" 
                  dataKey="x" 
                  name="Promedio Mercado" 
                  unit={currency === 'usd' ? ' $' : ' Bs'} 
                  tick={{ fontSize: 10, fill: '#464650' }}
                  label={{ value: `Promedio Mercado (${currency === 'usd' ? 'USD $' : 'Bs'})`, position: 'bottom', offset: 0, fontSize: 11, fill: '#016874', fontWeight: 'bold' }}
                />
                <YAxis 
                  type="number" 
                  dataKey="y" 
                  name="Mi Precio" 
                  unit={currency === 'usd' ? ' $' : ' Bs'} 
                  tick={{ fontSize: 10, fill: '#464650' }}
                  label={{ value: `Mi Precio (${currency === 'usd' ? 'USD $' : 'Bs'})`, angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: '#016874', fontWeight: 'bold' }}
                />
                <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<CustomScatterTooltip />} />
                <Scatter name="Productos Monitoreados" data={scatterPlotData} onClick={(entry) => setSelectedProduct({ producto: entry.producto, competencia: entry.competencia })}>
                  {scatterPlotData.map((entry, index) => {
                    const isCheaper = entry.y < entry.x;
                    const isEqual = Math.abs(entry.y - entry.x) < 0.05;
                    const color = isCheaper ? '#10b981' : isEqual ? '#016874' : '#f43f5e';
                    return <Cell key={`scatter-cell-${index}`} fill={color} className="cursor-pointer hover:opacity-80 transition-opacity" />;
                  })}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Dynamic Generic vs Brand Parity Analysis Card */}
      {analisisMoleculaParidad.length > 0 && (
        <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-4">
          <div>
            <h2 className="font-display font-extrabold text-lg text-primary flex items-center gap-2">
              <span className="material-symbols-outlined text-xl text-primary">balance</span>
              Análisis de Paridad de Escala Farmacéutica (Genérico vs. Marca)
            </h2>
            <p className="text-xs text-on-surface-variant font-sans mt-0.5">
              Optimización estratégica de portafolio: Verifica la consistencia de precios entre tus opciones Genéricas y de Marca para la misma molécula y presentación.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {analisisMoleculaParidad.map(item => {
              const badgeColors = {
                critico: 'bg-red-50 text-red-700 border-red-200',
                alerta: 'bg-amber-50 text-amber-700 border-amber-200',
                oportunidad: 'bg-purple-50 text-purple-700 border-purple-200',
                normal: 'bg-emerald-50 text-emerald-700 border-emerald-200'
              };
              const severityBadge = badgeColors[item.nivelSeveridad] || badgeColors.normal;

              return (
                <div key={item.key} className="p-4 rounded-2xl border border-outline-variant/60 bg-surface-low/30 hover:bg-surface-low/60 transition-all flex flex-col justify-between space-y-3">
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <h3 className="font-display font-bold text-sm text-primary uppercase tracking-wide leading-tight">
                        {item.principio}
                      </h3>
                      <p className="text-xs text-on-surface-variant font-mono mt-0.5">
                        {item.concentracion} · {item.tamano}
                      </p>
                    </div>
                    {item.gapPercent !== null && (
                      <div className="text-right">
                        <span className="text-xs text-on-surface-variant block font-sans font-medium">Brecha de Marca</span>
                        <span className="font-mono text-base font-extrabold text-primary">
                          +{item.gapPercent.toFixed(0)}%
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-2 border-t border-outline-variant/40 text-xs">
                    <div>
                      <span className="text-on-surface-variant font-sans block mb-1">Tus Precios</span>
                      <div className="space-y-0.5 font-mono">
                        <div className="flex justify-between text-on-surface">
                          <span>Genérico:</span>
                          <span className="font-bold">{fmt(item.precioPropioGen)}</span>
                        </div>
                        <div className="flex justify-between text-on-surface">
                          <span>Marca:</span>
                          <span className="font-bold">{fmt(item.precioPropioMarca)}</span>
                        </div>
                      </div>
                    </div>

                    <div>
                      <span className="text-on-surface-variant font-sans block mb-1">Referencia Mercado</span>
                      <div className="space-y-0.5 font-mono">
                        <div className="flex justify-between text-on-surface-variant">
                          <span>Genérico:</span>
                          <span className="font-semibold">{fmt(item.totalAvgGen)}</span>
                        </div>
                        <div className="flex justify-between text-on-surface-variant">
                          <span>Marca:</span>
                          <span className="font-semibold">{fmt(item.totalAvgMarca)}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={`p-2.5 rounded-xl border text-[11px] font-sans leading-relaxed flex items-start gap-2 ${severityBadge}`}>
                    <span className="material-symbols-outlined text-base select-none mt-0.5">
                      {item.nivelSeveridad === 'critico' ? 'dangerous' : item.nivelSeveridad === 'alerta' ? 'warning' : item.nivelSeveridad === 'oportunidad' ? 'rocket_launch' : 'verified_user'}
                    </span>
                    <span>{item.diagnostico}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Indicador: Cadena en que los productos son más costosos en promedio */}
      {cadenaComparacionCostos && (
        <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-outline-variant pb-3 gap-2">
            <div>
              <h2 className="font-display font-extrabold text-lg text-primary flex items-center gap-2">
                <span className="material-symbols-outlined text-xl text-primary">storefront</span>
                Nivel de Precios Promedio por Cadena Farmacéutica
              </h2>
              <p className="text-xs text-on-surface-variant font-sans mt-0.5">
                Indica en qué cadena nuestros productos resultan más costosos o más económicos en promedio comparado contra ofertas homologables.
              </p>
            </div>
            {cadenaComparacionCostos.cadenaMasCostosa && (
              <span className="px-3.5 py-1.5 rounded-full text-xs font-mono font-bold bg-amber-100 text-amber-900 border border-amber-300 flex items-center gap-1.5 self-start">
                <span className="material-symbols-outlined text-sm">trending_up</span>
                Más costosos en: <strong>{cadenaComparacionCostos.cadenaMasCostosa.cadena}</strong> (+{cadenaComparacionCostos.cadenaMasCostosa.avgDiff.toFixed(1)}%)
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {cadenaComparacionCostos.ranking.map(item => {
              const isCostly = item.avgDiff > 0;
              return (
                <div key={item.cadena} className={`p-4 rounded-2xl border ${isCostly ? 'bg-amber-50/50 border-amber-200' : 'bg-emerald-50/50 border-emerald-200'} space-y-2`}>
                  <div className="flex justify-between items-center">
                    <span className="font-display font-bold text-sm text-primary">{item.cadena}</span>
                    <span className={`text-xs font-mono font-extrabold px-2 py-0.5 rounded-full ${isCostly ? 'bg-amber-200/60 text-amber-900' : 'bg-emerald-200/60 text-emerald-900'}`}>
                      {isCostly ? `+${item.avgDiff.toFixed(1)}%` : `${item.avgDiff.toFixed(1)}%`}
                    </span>
                  </div>
                  <p className="text-xs text-on-surface-variant font-sans">
                    Nuestros productos son <strong>{isCostly ? 'más costosos' : 'más económicos'}</strong> que en {item.cadena} en promedio.
                  </p>
                  <div className="pt-2 border-t border-outline-variant/30 text-[11px] text-on-surface-variant flex justify-between font-mono">
                    <span>{item.count} SKUs comparados</span>
                    <span className={isCostly ? 'text-amber-800 font-bold' : 'text-emerald-800 font-bold'}>
                      {isCostly ? `${item.masCostososCount} arriba` : `${item.masBaratosCount} abajo`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Indicador: Share of Voice (SoV) de Precios por Cadena */}
      {shareOfVoiceData.length > 0 && (
        <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-4">
          <div>
            <h2 className="font-display font-extrabold text-lg text-primary flex items-center gap-2">
              <span className="material-symbols-outlined text-xl text-primary">pie_chart</span>
              Share of Voice (SoV) de Precios y Cobertura por Cadena
            </h2>
            <p className="text-xs text-on-surface-variant font-sans mt-0.5">
              Participación de mercado en cobertura de catálogo y porcentaje de liderazgo en precio más bajo.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {shareOfVoiceData.map(ch => (
              <div key={ch.cadena} className="p-4 rounded-2xl border border-outline-variant bg-surface-low/30 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="font-display font-extrabold text-sm text-primary">{ch.cadena}</span>
                  <span className="text-[10px] font-mono font-bold bg-primary-container text-on-primary-container px-2.5 py-0.5 rounded-full">
                    {ch.skusMonitoreados} SKUs ({ch.coveragePct.toFixed(0)}%)
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-sans">
                    <span className="text-on-surface-variant">SoV Precio Más Bajo:</span>
                    <span className="font-bold text-secondary font-mono">{ch.cheapestSoVPct.toFixed(1)}%</span>
                  </div>
                  <div className="w-full bg-surface-low rounded-full h-2 overflow-hidden border border-outline-variant/30">
                    <div className="bg-secondary h-2 rounded-full transition-all duration-500" style={{ width: `${Math.min(100, ch.cheapestSoVPct)}%` }}></div>
                  </div>
                </div>

                <div className="pt-2 border-t border-outline-variant/40 grid grid-cols-2 gap-2 text-[11px] font-mono">
                  <div className="bg-white p-2 rounded-xl text-center border border-outline-variant/30">
                    <span className="text-[10px] text-on-surface-variant font-sans block">Líder Mínimo</span>
                    <span className="font-bold text-emerald-700">{ch.lowestCount} prods</span>
                  </div>
                  <div className="bg-white p-2 rounded-xl text-center border border-outline-variant/30">
                    <span className="text-[10px] text-on-surface-variant font-sans block">Máximo Precio</span>
                    <span className="font-bold text-red-700">{ch.highestCount} prods</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Indicador: Elasticidad Histórica por Molécula */}
      {elasticidadPorMolecula.length > 0 && (
        <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-outline-variant pb-3 gap-2">
            <div>
              <h2 className="font-display font-extrabold text-lg text-primary flex items-center gap-2">
                <span className="material-symbols-outlined text-xl text-primary">query_stats</span>
                Elasticidad Histórica por Molécula (Principio Activo)
              </h2>
              <p className="text-xs text-on-surface-variant font-sans mt-0.5">
                Evaluación de sensibilidad al precio e identificación de oportunidades de alza o protección de volumen por molécula.
              </p>
            </div>
            <span className="text-xs font-mono font-bold text-on-surface-variant bg-surface-low px-3 py-1.5 rounded-full border border-outline-variant self-start">
              {elasticidadPorMolecula.length} Moléculas Analizadas
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-surface-low text-primary uppercase font-mono tracking-wider border-b border-outline-variant">
                <tr>
                  <th className="text-left px-4 py-3 font-bold">Molécula / Principio Activo</th>
                  <th className="text-center px-4 py-3 font-bold">SKUs en Catálogo</th>
                  <th className="text-center px-4 py-3 font-bold">Dispersión Mercado (%)</th>
                  <th className="text-center px-4 py-3 font-bold">Volatilidad Histórica</th>
                  <th className="text-center px-4 py-3 font-bold">Clasificación Elasticidad</th>
                  <th className="text-left px-4 py-3 font-bold">Diagnóstico Strategic EBITDA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30 font-sans">
                {elasticidadPorMolecula.map(m => (
                  <tr key={m.nombre} className="hover:bg-surface-low/50 transition-colors">
                    <td className="px-4 py-3 font-bold text-primary font-display text-sm">
                      {m.nombre}
                    </td>
                    <td className="px-4 py-3 text-center font-mono">
                      <span className="font-bold">{m.totalSkus}</span> <span className="text-[10px] text-on-surface-variant">({m.marcasCount} Marca / {m.genericosCount} Gen)</span>
                    </td>
                    <td className="px-4 py-3 text-center font-mono font-bold text-on-surface">
                      {m.avgDispersion.toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 text-center font-mono">
                      {m.avgVolatilidad > 0 ? `${m.avgVolatilidad.toFixed(1)}%` : 'Estable'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-full border ${m.badgeClass}`}>
                        {m.tipoElasticidad}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-on-surface-variant text-[11px]">
                      {m.recomendacion}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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

            {/* Market Type Selector */}
            <div className="bg-surface-low p-1 rounded-xl flex gap-1 border border-outline-variant">
              {['Todos', 'GENERICO', 'MARCA'].map(t => (
                <button
                  key={t}
                  onClick={() => setTipoMercadoSeleccionado(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    tipoMercadoSeleccionado === t 
                      ? 'bg-primary text-on-primary shadow-sm' 
                      : 'text-on-surface-variant hover:bg-surface/50'
                  }`}
                >
                  {t === 'Todos' ? 'Todos Tipo' : t === 'GENERICO' ? 'Genéricos' : 'Marca'}
                </button>
              ))}
            </div>

            {/* Business Unit Selector */}
            <div className="bg-surface-low p-1 rounded-xl flex gap-1 border border-outline-variant">
              {['Todas', 'La Sante', 'Pharmetique', 'OTC'].map(un => (
                <button
                  key={un}
                  onClick={() => setUnSeleccionada(un)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    unSeleccionada === un 
                      ? 'bg-secondary text-on-secondary shadow-sm' 
                      : 'text-on-surface-variant hover:bg-surface/50'
                  }`}
                >
                  {un === 'Todas' ? 'Todas UN' : un === 'La Sante' ? 'La Santé' : un}
                </button>
              ))}
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
                filasPaginadas.map(({ producto, competencia, chainPrices, avgCompUsd, minCompUsd, maxCompUsd, dispersionPercent, cheapestChains, propioPriceUsd, diffMinPercent, diffAvgPercent, ranking, totalOptionsCount }) => {
                  return (
                    <tr key={producto.id_interno} onClick={() => setSelectedProduct({ producto, competencia })}
                       className="hover:bg-surface-low cursor-pointer transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-bold text-on-surface font-display text-sm">{producto.nombre}</span>
                          <span className={`px-1.5 py-0.5 text-[8px] rounded font-mono font-bold tracking-wider ${
                            (producto.market_type || 'GENERICO').toUpperCase() === 'MARCA'
                              ? 'bg-purple-100 text-purple-800 border border-purple-200'
                              : 'bg-green-100 text-green-800 border border-green-200'
                          }`}>
                            {(producto.market_type || 'GENERICO').toUpperCase()}
                          </span>
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

        {/* Pagination Controls */}
        {totalPaginas > 1 && (
          <div className="px-6 py-4 bg-surface-low border-t border-surface-variant flex flex-col sm:flex-row items-center justify-between gap-4">
            <span className="text-xs text-on-surface-variant font-medium">
              Mostrando {Math.min(filas.length, (paginaActual - 1) * itemsPorPagina + 1)} - {Math.min(filas.length, paginaActual * itemsPorPagina)} de {filas.length} productos
            </span>
            <div className="flex items-center gap-1">
              <button
                disabled={paginaActual === 1}
                onClick={() => setPaginaActual(p => Math.max(1, p - 1))}
                className="p-1.5 rounded-lg border border-outline-variant disabled:opacity-40 hover:bg-surface/50 text-on-surface-variant transition-all font-bold flex items-center"
              >
                <span className="material-symbols-outlined text-sm">chevron_left</span>
              </button>
              {Array.from({ length: totalPaginas }, (_, i) => i + 1).map(num => (
                <button
                  key={num}
                  onClick={() => setPaginaActual(num)}
                  className={`w-7 h-7 rounded-lg text-xs font-bold transition-all ${
                    paginaActual === num
                      ? 'bg-primary text-on-primary shadow-sm'
                      : 'border border-outline-variant hover:bg-surface/50 text-on-surface-variant'
                  }`}
                >
                  {num}
                </button>
              ))}
              <button
                disabled={paginaActual === totalPaginas}
                onClick={() => setPaginaActual(p => Math.min(totalPaginas, p + 1))}
                className="p-1.5 rounded-lg border border-outline-variant disabled:opacity-40 hover:bg-surface/50 text-on-surface-variant transition-all font-bold flex items-center"
              >
                <span className="material-symbols-outlined text-sm">chevron_right</span>
              </button>
            </div>
          </div>
        )}
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
