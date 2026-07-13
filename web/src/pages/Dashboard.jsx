import { useEffect, useState, useMemo } from 'react';
import { collection, getDocs, query, orderBy, limit, doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useBcvRate } from '../hooks/useBcvRate';
import ProductDetailModal from '../components/ProductDetailModal';
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState(null);

  const bcv = useBcvRate();
  const isAdmin = userDoc?.rol === 'administrador';

  const cargarDatos = async () => {
    setLoading(true);
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

      setBcvHistorico(bcvSnap.docs.map(d => {
        const data = d.data();
        return {
          fecha: data.updated_at?.toDate?.().toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }) || '—',
          valor: data.value,
          rawDate: data.updated_at?.toDate?.() || new Date()
        };
      }).sort((a,b) => a.rawDate - b.rawDate).slice(-10)); // Last 10 rates

    } catch (err) {
      console.error('Error cargando panel:', err.message || err);
    }
    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

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
        setRefreshMessage({ type: 'success', text: 'Scraper disparado correctamente vía GitHub Actions. Se actualizarán los precios en 1-2 minutos.' });
      } else {
        const txt = await res.text();
        throw new Error(`GitHub respondió ${res.status}: ${txt}`);
      }
    } catch (err) {
      setRefreshMessage({ type: 'error', text: 'Error al disparar scraper: ' + err.message });
    }
    setRefreshing(false);
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
          const priceBs = c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs;
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
        };
      });
  }, [productos, productosCompetencia, bcv.rate]);

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

    analizados.forEach(item => {
      if (item.dispersionPercent > 0) {
        totalDispersion += item.dispersionPercent;
        productsWithDispersion++;
        if (item.dispersionPercent > maxDispersionVal) {
          maxDispersionVal = item.dispersionPercent;
          maxDispersionProd = item.producto.nombre;
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

    return {
      monitoredCount: analizados.length,
      avgDispersion: productsWithDispersion > 0 ? totalDispersion / productsWithDispersion : 0,
      maxDispersionVal,
      maxDispersionProd,
      bestChain: maxCheapCount > 0 ? `${bestChain} (${maxCheapCount} prods)` : '—'
    };
  }, [analizados, cadenasUnicas]);

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
    let csv = 'ID Interno,Producto,Laboratorio,Categoria,Precio Minimo (USD),Precio Maximo (USD),Precio Promedio (USD),Dispersion %,Cadenas Lideres\n';
    analizados.forEach(item => {
      const p = item.producto;
      const dev = item.dispersionPercent ? `${item.dispersionPercent.toFixed(1)}%` : '0%';
      const leaders = item.cheapestChains.join(' / ') || '—';
      const row = `"${p.id_interno}","${p.nombre}","${p.laboratorio || '—'}","${p.categoria}","${item.minCompUsd ? item.minCompUsd.toFixed(2) : '—'}","${item.maxCompUsd ? item.maxCompUsd.toFixed(2) : '—'}","${item.avgCompUsd ? item.avgCompUsd.toFixed(2) : '—'}","${dev}","${leaders}"\n`;
      csv += row;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Reporte_Dispersión_Precios_${new Date().toISOString().slice(0, 10)}.csv`);
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
        </div>
      </div>

      {/* BCV and Status Control Bar */}
      <div className="bg-white rounded-3xl border border-outline-variant p-5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
        <BcvController bcv={bcv} />
        
        {ultimaCorrida && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-on-surface-variant font-sans font-semibold">Último Análisis Scraper:</span>
            <span className="font-mono bg-primary text-on-primary px-3 py-1 rounded-full font-bold">
              {ultimaCorrida.started_at ? formatTimeAgo(ultimaCorrida.started_at) : '—'}
            </span>
            <span className="text-on-surface-variant font-semibold">
              ({ultimaCorrida.ok}/{ultimaCorrida.total} exitosos)
            </span>
            {isAdmin && (
              <button onClick={handleActualizar} disabled={refreshing}
                className="px-4 py-2 bg-secondary text-on-secondary hover:bg-secondary/90 disabled:opacity-50 font-extrabold uppercase font-mono tracking-wider text-[10px] rounded-full transition-all">
                {refreshing ? 'Procesando...' : 'Actualizar'}
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

      {/* Volatility Warning Alert */}
      {altaVolatilidad.length > 0 && (
        <div className="bg-[#ffdad6]/40 border border-[#ffdad6] rounded-3xl p-5 space-y-3 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-xl text-[#93000a]">warning</span>
            <h3 className="font-extrabold text-[#93000a] text-sm">Productos con Alta Dispersión de Precios (Volatilidad >20%)</h3>
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
                <th className="px-6 py-4 font-bold text-right">Máximo</th>
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
                filas.map(({ producto, competencia, chainPrices, avgCompUsd, minCompUsd, maxCompUsd, dispersionPercent, cheapestChains }) => {
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

                      {/* Max Price */}
                      <td className="px-6 py-4 text-right font-mono text-xs text-error font-semibold">
                        {maxCompUsd ? fmt(maxCompUsd) : '—'}
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
          onClose={() => setSelectedProduct(null)}
        />
      )}
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
