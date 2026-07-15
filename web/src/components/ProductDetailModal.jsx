import { useEffect, useState, useMemo } from 'react';
import { collection, query, where, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import ConfirmModal from './ConfirmModal';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

const COLORS = ['#040d53', '#70C145', '#ba1a1a', '#004ecb', '#002f6c', '#0891b2', '#db2777'];

function InfoTooltip({ text, align = 'center' }) {
  const alignClass = align === 'left' 
    ? 'left-0 translate-x-0' 
    : align === 'right' 
      ? 'right-0 translate-x-0 animate-fade-in' 
      : 'left-1/2 -translate-x-1/2 animate-fade-in';
      
  return (
    <div className="relative group inline-block ml-1 align-middle leading-none">
      <span className="material-symbols-outlined text-[15px] text-[#464650] hover:text-[#040d53] transition-colors cursor-help select-none">
        info
      </span>
      <div className={`absolute bottom-full mb-2 w-64 p-3 bg-[#1c1b1f] text-white text-[10.5px] leading-relaxed rounded-xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all duration-200 shadow-xl z-50 font-normal normal-case tracking-normal ${alignClass}`}>
        {text}
        <div className={`absolute top-full border-4 border-transparent border-t-[#1c1b1f] ${
          align === 'left' ? 'left-3' : align === 'right' ? 'right-3' : 'left-1/2 -translate-x-1/2'
        }`}></div>
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label, propios, labMap, currency }) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-[#e1e2ec] p-3 rounded-2xl shadow-xl space-y-2 max-w-sm text-xs font-sans">
        <p className="font-bold text-[#040d53] font-mono border-b border-[#e1e2ec] pb-1">
          Fecha: {label ? label.split('-').reverse().join('/') : ''}
        </p>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {payload.map((pld) => {
            const isPropio = propios && propios.includes(pld.name);
            const isPromedio = pld.name === 'Promedio' || pld.name === 'Promedio Mercado';
            const lab = labMap && labMap[pld.name];
            
            return (
              <div key={pld.name} className="flex justify-between gap-4 items-center">
                <div className="flex flex-col">
                  <span className={`font-semibold ${isPropio ? 'text-[#2e7d32]' : isPromedio ? 'text-[#ea580c]' : 'text-[#1c1b1f]'}`}>
                    {pld.name}
                    {isPropio && ' (Mi Marca)'}
                  </span>
                  {lab && (
                    <span className="text-[10px] text-[#464650]/80 font-sans leading-none mt-0.5">
                      Lab: {lab}
                    </span>
                  )}
                </div>
                <span className={`font-mono font-bold ${isPropio ? 'text-[#2e7d32]' : isPromedio ? 'text-[#ea580c]' : 'text-[#040d53]'}`}>
                  {currency === 'usd' ? '$' : 'Bs '}{pld.value?.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return null;
}

export default function ProductDetailModal({ producto, competencia, currency, bcvRate, onClose, initialPriceMode = 'descuento' }) {
  const [historico, setHistorico] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [priceMode, setPriceMode] = useState(initialPriceMode);

  // Filters inside modal
  const [filterRelacion, setFilterRelacion] = useState('todos'); // 'todos', 'propio', 'competencia'
  const [filterCadena, setFilterCadena] = useState('todas'); // 'todas', or specific chain name

  const handleClearHistory = async () => {
    setClearing(true);
    try {
      const q = query(
        collection(db, 'historico_precios'),
        where('id_producto_propio', '==', producto.id_interno)
      );
      const snap = await getDocs(q);
      const docs = snap.docs;
      
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500);
        const batch = writeBatch(db);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      setHistorico([]);
    } catch (err) {
      console.error('Error clearing product history:', err?.message || String(err));
    }
    setClearing(false);
    setShowClearConfirm(false);
  };

  useEffect(() => {
    (async () => {
      try {
        const q = query(
          collection(db, 'historico_precios'),
          where('id_producto_propio', '==', producto.id_interno)
        );
        const snap = await getDocs(q);
        const docs = snap.docs.map(d => ({
          ...d.data(),
          scraped_at: d.data().scraped_at?.toDate?.() || null,
        }));
        docs.sort((a, b) => (a.scraped_at?.getTime() || 0) - (b.scraped_at?.getTime() || 0));
        setHistorico(docs);
      } catch (err) {
        console.error('Error cargando histórico:', err?.message || String(err));
        setError(err.message);
      }
      setLoading(false);
    })();
  }, [producto.id_interno]);

  // Pivot: convertir historico en serie por marca-cadena, agrupado por dia.
  const chartData = (() => {
    const byDate = new Map();
    const marcasVistas = new Set();
    const propios = new Set();

    for (const h of historico) {
      if (!h.scraped_at) continue;
      const dateKey = h.scraped_at.toISOString().slice(0, 10);
      const marca = `${h.marca} (${h.cadena})`;
      marcasVistas.add(marca);

      if (h.tipo === 'propio') {
        propios.add(marca);
      }

      const precioBs = priceMode === 'descuento'
        ? (h.precio_desc_bs || h.precio_full_bs)
        : h.precio_full_bs;
      if (!precioBs) continue;
      const precio = currency === 'usd' && bcvRate ? precioBs / bcvRate : precioBs;

      if (!byDate.has(dateKey)) byDate.set(dateKey, { date: dateKey });
      byDate.get(dateKey)[marca] = parseFloat(precio.toFixed(2));
    }

    const data = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    
    // Calcular el promedio por fecha y añadirlo a cada item
    data.forEach(item => {
      const keys = Object.keys(item).filter(k => k !== 'date');
      if (keys.length > 0) {
        const sum = keys.reduce((acc, k) => acc + item[k], 0);
        item['Promedio'] = parseFloat((sum / keys.length).toFixed(2));
      }
    });

    return {
      data,
      marcas: Array.from(marcasVistas),
      propios,
    };
  })();

  // Map each competitor/product key to its laboratory
  const labMap = useMemo(() => {
    const map = new Map();
    for (const c of competencia) {
      const key = `${c.marca} (${c.cadena})`;
      map.set(key, c.laboratorio || '');
    }
    return map;
  }, [competencia]);

  // Available chains for dropdown filter
  const cadenasDisponibles = useMemo(() => {
    const set = new Set(competencia.map(c => c.cadena));
    return Array.from(set).sort();
  }, [competencia]);

  // Filtered competition list for table
  const competenciaFiltrada = useMemo(() => {
    return competencia.filter(pc => {
      const matchRelacion = filterRelacion === 'todos' || pc.tipo === filterRelacion;
      const matchCadena = filterCadena === 'todas' || pc.cadena === filterCadena;
      return matchRelacion && matchCadena;
    });
  }, [competencia, filterRelacion, filterCadena]);

  // Minimum full price and minimum discount price for highlights in table
  const validFullPrices = competencia
    .map(c => c.ultimo_precio_full_bs)
    .filter(p => p && p > 0);
  const minFullPriceBs = validFullPrices.length > 0 ? Math.min(...validFullPrices) : null;

  const validDescPrices = competencia
    .map(c => c.ultimo_precio_desc_bs)
    .filter(p => p && p > 0);
  const minDescPriceBs = validDescPrices.length > 0 ? Math.min(...validDescPrices) : null;

  // Calculations for smart indicators (always calculated on full active set for robust comparisons)
  const validPrices = competencia
    .map(c => {
      const pBs = priceMode === 'descuento'
        ? (c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs)
        : c.ultimo_precio_full_bs;
      return pBs ? { cadena: c.cadena, marca: c.marca, priceBs: pBs, tipo: c.tipo } : null;
    })
    .filter(Boolean);

  const minPriceItem = validPrices.length > 0 
    ? validPrices.reduce((prev, curr) => (prev.priceBs < curr.priceBs) ? prev : curr)
    : null;

  const avgPriceBs = validPrices.length > 0
    ? validPrices.reduce((sum, item) => sum + item.priceBs, 0) / validPrices.length
    : null;

  const propioItem = competencia.find(c => c.tipo === 'propio');
  const propioPriceBs = propioItem 
    ? (priceMode === 'descuento' 
        ? (propioItem.ultimo_precio_desc_bs || propioItem.ultimo_precio_full_bs)
        : propioItem.ultimo_precio_full_bs)
    : null;

  const diffMinBs = (propioPriceBs !== null && minPriceItem !== null) ? propioPriceBs - minPriceItem.priceBs : null;
  const pctMin = (diffMinBs !== null && minPriceItem.priceBs > 0) ? (diffMinBs / minPriceItem.priceBs) * 100 : null;

  const diffAvgBs = (propioPriceBs !== null && avgPriceBs !== null) ? propioPriceBs - avgPriceBs : null;
  const pctAvg = (diffAvgBs !== null && avgPriceBs > 0) ? (diffAvgBs / avgPriceBs) * 100 : null;

  const getLineColor = (marcaName, index) => {
    if (chartData.propios.has(marcaName)) {
      return '#2e7d32'; // Green for Propio
    }
    const competitorColors = ['#040d53', '#ba1a1a', '#004ecb', '#0891b2', '#db2777', '#8b5cf6', '#ea580c', '#3b82f6'];
    return competitorColors[index % competitorColors.length];
  };

  const formatHeaderPrice = (priceBs) => {
    if (priceBs == null) return '—';
    if (currency === 'usd') {
      if (!bcvRate) return '—';
      return '$' + (priceBs / bcvRate).toFixed(2);
    }
    return 'Bs ' + priceBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in text-[#1c1b1f]" onClick={onClose}>
      <div
        className="bg-white rounded-[32px] shadow-xl max-w-4xl w-full max-h-[92vh] flex flex-col border border-[#e1e2ec]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header Block */}
        <div className="px-6 py-5 border-b border-[#e1e2ec] flex items-start justify-between">
          <div>
            <h2 className="text-xl font-display font-extrabold text-[#040d53] tracking-tight">{producto.nombre}</h2>
            <p className="text-xs text-[#464650] font-sans mt-0.5">
              {producto.principio_activo || '—'} {producto.concentracion || '—'} · {producto.presentacion || '—'} · {producto.laboratorio || '—'}
            </p>
          </div>
          <button onClick={onClose} className="text-[#464650] hover:text-black text-2xl leading-none">×</button>
        </div>

        {/* Content Area */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Price Switch Controls */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#f3f4f9] p-3 rounded-2xl border border-[#e1e2ec] animate-fade-in">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[#040d53] text-lg">payments</span>
              <span className="text-xs font-bold uppercase tracking-wider text-[#464650] font-mono">Modo de Comparación:</span>
            </div>
            <div className="bg-[#e1e2ec] p-1 rounded-xl flex gap-1 self-start sm:self-auto">
              <button
                onClick={() => setPriceMode('descuento')}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                  priceMode === 'descuento' 
                    ? 'bg-white text-[#040d53] shadow-sm' 
                    : 'text-[#464650] hover:bg-white/50'
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">sell</span>
                Con Descuento / Oferta
              </button>
              <button
                onClick={() => setPriceMode('lista')}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                  priceMode === 'lista' 
                    ? 'bg-white text-[#040d53] shadow-sm' 
                    : 'text-[#464650] hover:bg-white/50'
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">receipt_long</span>
                Precio de Lista (Full)
              </button>
            </div>
          </div>

          {/* Smart Indicators Card Grid */}
          {validPrices.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
              {/* Mas Barato Card */}
              <div className="bg-white border border-[#e1e2ec] p-4 rounded-2xl shadow-sm space-y-1 relative">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">Más Barato (Mercado)</span>
                  <InfoTooltip text="El precio mínimo detectado entre todos tus competidores en el mercado para el modo seleccionado (con descuento o de lista)." align="left" />
                </div>
                <div className="text-lg font-display font-extrabold text-[#70C145]">
                  {formatHeaderPrice(minPriceItem?.priceBs)}
                </div>
                <p className="text-[10px] text-[#464650] truncate font-semibold">
                  En: {minPriceItem?.cadena} ({minPriceItem?.marca})
                </p>
              </div>

              {/* Mi Precio Card */}
              <div className="bg-[#e8f5e9]/30 border border-[#a5d6a7]/50 p-4 rounded-2xl shadow-sm space-y-1 relative">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#2e7d32]">Mi Precio (Marca Propia)</span>
                  <InfoTooltip text="El precio actual de tu producto marca propia. Se muestra en verde para resaltar que es la referencia de tu marca." align="left" />
                </div>
                <div className="text-lg font-display font-extrabold text-[#2e7d32]">
                  {propioPriceBs ? formatHeaderPrice(propioPriceBs) : '—'}
                </div>
                <p className="text-[10px] text-[#2e7d32]/80 font-bold truncate">
                  {propioItem ? `Marca: ${propioItem.marca}` : 'No vinculado'}
                </p>
              </div>

              {/* vs Minimo Card */}
              <div className="bg-white border border-[#e1e2ec] p-4 rounded-2xl shadow-sm space-y-1 relative">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">Diferencia vs Mínimo</span>
                  <InfoTooltip text="Calculado como: ((Mi Precio - Precio Mínimo) / Precio Mínimo) * 100. Te indica qué tan por encima del precio más económico del mercado te encuentras. El valor ideal es <= 0%." align="right" />
                </div>
                {propioPriceBs && minPriceItem ? (
                  <>
                    <div className={`text-lg font-display font-extrabold ${pctMin && pctMin > 0.1 ? 'text-[#ba1a1a]' : 'text-[#70C145]'}`}>
                      {pctMin && pctMin > 0.1 ? `+${pctMin.toFixed(1)}%` : '¡Precio Mínimo!'}
                    </div>
                    <p className="text-[10px] text-[#464650] font-semibold">
                      {pctMin && pctMin > 0.1 ? `+${formatHeaderPrice(diffMinBs)} vs el más barato` : 'Líder en este producto'}
                    </p>
                  </>
                ) : (
                  <div className="text-lg font-display font-bold text-gray-300">—</div>
                )}
              </div>

              {/* Precio Promedio Card */}
              <div className="bg-white border border-[#e1e2ec] p-4 rounded-2xl shadow-sm space-y-1 relative">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">Precio Promedio (Mercado)</span>
                  <InfoTooltip text="El precio promedio aritmético calculado entre todos los competidores vigentes en el mercado." align="right" />
                </div>
                <div className="text-lg font-display font-extrabold text-[#040d53]">
                  {avgPriceBs ? formatHeaderPrice(avgPriceBs) : '—'}
                </div>
                {propioPriceBs && avgPriceBs ? (
                  <p className="text-[10.5px] leading-tight font-sans font-semibold">
                    Mi precio:{' '}
                    <span className={pctAvg && pctAvg > 0 ? 'text-[#ba1a1a]' : 'text-[#2e7d32]'}>
                      {pctAvg && pctAvg > 0 ? `+${pctAvg.toFixed(1)}%` : `${pctAvg?.toFixed(1)}%`} ({pctAvg && pctAvg > 0 ? '+' : ''}{formatHeaderPrice(diffAvgBs)})
                    </span>
                  </p>
                ) : (
                  <p className="text-[10px] text-[#464650] font-semibold">
                    Referencia del mercado
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Current Competitor Prices Table */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-[#040d53] uppercase font-mono tracking-wider flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">payments</span>
                Precios Actuales por Cadena Farmacéutica
              </h3>

              {/* Table Filters */}
              <div className="flex gap-2 flex-wrap">
                {/* Relación Filter */}
                <select
                  value={filterRelacion}
                  onChange={(e) => setFilterRelacion(e.target.value)}
                  className="bg-white border border-[#e1e2ec] rounded-xl px-2.5 py-1 text-xs font-bold focus:outline-none focus:border-[#040d53] text-[#464650]"
                >
                  <option value="todos">Todos los productos</option>
                  <option value="propio">Mi Marca (Propio)</option>
                  <option value="competencia">Competidores</option>
                </select>

                {/* Cadena Filter */}
                <select
                  value={filterCadena}
                  onChange={(e) => setFilterCadena(e.target.value)}
                  className="bg-white border border-[#e1e2ec] rounded-xl px-2.5 py-1 text-xs font-bold focus:outline-none focus:border-[#040d53] text-[#464650]"
                >
                  <option value="todas">Todas las cadenas</option>
                  {cadenasDisponibles.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="border border-[#e1e2ec] rounded-2xl overflow-hidden bg-white shadow-sm">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-[#f8f9fa] text-[#040d53] uppercase font-mono tracking-wider font-bold border-b border-[#e1e2ec]">
                  <tr>
                    <th className="text-left px-5 py-3.5">Cadena</th>
                    <th className="text-left px-5 py-3.5">Marca / Variante</th>
                    <th className="text-left px-5 py-3.5">Relación</th>
                    <th className="text-right px-5 py-3.5">Precio de Lista</th>
                    <th className="text-right px-5 py-3.5">Precio con Descuento</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e1e2ec]">
                  {competenciaFiltrada.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="px-5 py-6 text-center text-[#464650] italic bg-white">
                        Sin productos que coincidan con los filtros seleccionados.
                      </td>
                    </tr>
                  ) : (
                    competenciaFiltrada.map(pc => {
                      const isCheapestFull = pc.ultimo_precio_full_bs && pc.ultimo_precio_full_bs === minFullPriceBs;
                      const isCheapestDesc = pc.ultimo_precio_desc_bs && pc.ultimo_precio_desc_bs === minDescPriceBs;
                      
                      return (
                        <tr key={pc.id} className="hover:bg-[#f8f9fa] transition-colors">
                          <td className="px-5 py-3 font-bold text-[#040d53]">{pc.cadena}</td>
                          <td className="px-5 py-3 font-semibold text-[#1c1b1f]">
                            <div>{pc.marca} {pc.concentracion || ''} {pc.tamano || ''}</div>
                            {pc.laboratorio && (
                              <div className="text-[10px] text-[#464650] font-normal mt-0.5">Lab: {pc.laboratorio}</div>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <span className={`text-[10px] uppercase font-mono font-bold px-2 py-0.5 rounded-full ${
                              pc.tipo === 'propio' ? 'bg-[#e8f5e9] text-[#2e7d32] border border-[#a5d6a7]' : 'bg-[#f3f4f9] text-[#464650] border border-[#e1e2ec]'
                            }`}>
                              {pc.tipo === 'propio' ? 'Mi Marca' : 'Competencia'}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-right font-mono font-bold text-[#464650]">
                            <div className="flex flex-col items-end justify-center">
                              <span className={isCheapestFull ? 'text-[#2e7d32] font-extrabold' : ''}>
                                {formatHeaderPrice(pc.ultimo_precio_full_bs)}
                              </span>
                              {isCheapestFull && (
                                <span className="text-[9px] bg-[#e8f5e9] text-[#2e7d32] border border-[#a5d6a7] font-bold px-1.5 py-0.5 rounded mt-0.5 uppercase tracking-wide">
                                  Más bajo
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right font-mono font-extrabold text-[#040d53]">
                            <div className="flex flex-col items-end justify-center">
                              <span className={isCheapestDesc ? 'text-[#2e7d32] font-extrabold' : ''}>
                                {formatHeaderPrice(pc.ultimo_precio_desc_bs)}
                              </span>
                              {isCheapestDesc && (
                                <span className="text-[9px] bg-[#e8f5e9] text-[#2e7d32] border border-[#a5d6a7] font-bold px-1.5 py-0.5 rounded mt-0.5 uppercase tracking-wide">
                                  Más bajo
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Historical Trend Chart */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <h3 className="text-xs font-bold text-[#040d53] uppercase font-mono tracking-wider flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">show_chart</span>
                Historial de Tendencia de Precios ({currency === 'usd' ? 'USD $' : 'Bs'})
              </h3>
              {historico.length > 0 && (
                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="text-[10px] font-bold text-[#ba1a1a] hover:bg-red-50 px-3 py-1 rounded-full border border-red-200 transition-all flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[12px]">delete</span>
                  Borrar histórico
                </button>
              )}
            </div>
            <div className="bg-white rounded-2xl border border-[#e1e2ec] p-4 shadow-sm">
              {loading ? (
                <div className="h-64 flex flex-col items-center justify-center text-xs text-[#464650] font-semibold gap-1.5 animate-pulse">
                  <span className="material-symbols-outlined animate-spin text-2xl text-[#040d53]">autorenew</span>
                  Cargando tendencia histórica...
                </div>
              ) : error ? (
                <div className="h-64 flex items-center justify-center text-[#ba1a1a] text-xs font-mono font-bold">{error}</div>
              ) : chartData.data.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-[#464650] text-xs italic">
                  Aún no hay suficiente historial acumulado. Las corridas automáticas generarán los registros de tendencia.
                </div>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData.data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                      <XAxis 
                        dataKey="date" 
                        tickFormatter={(tick) => {
                          try {
                            const parts = tick.split('-');
                            if (parts.length === 3) {
                              return `${parts[2]}/${parts[1]}`;
                            }
                          } catch (e) {}
                          return tick;
                        }}
                        tick={{ fontSize: 11, fill: '#464650' }} 
                      />
                      <YAxis tick={{ fontSize: 11, fill: '#464650' }} />
                      <Tooltip content={<CustomTooltip propios={Array.from(chartData.propios)} labMap={Object.fromEntries(labMap)} currency={currency} />} />
                      <Legend wrapperStyle={{ fontSize: 11, marginTop: 10 }} />
                      {chartData.marcas.map((m, i) => {
                        const isPropio = chartData.propios.has(m);
                        return (
                          <Line
                            key={m}
                            type="monotone"
                            dataKey={m}
                            name={isPropio ? `${m} ⭐ (Mi Marca)` : m}
                            stroke={getLineColor(m, i)}
                            strokeWidth={isPropio ? 4.5 : 2}
                            dot={{ r: isPropio ? 5 : 3 }}
                            connectNulls
                          />
                        );
                      })}
                      {/* Línea especial para el Promedio del mercado */}
                      {chartData.data.length > 0 && (
                        <Line
                          type="monotone"
                          dataKey="Promedio"
                          name="Promedio Mercado"
                          stroke="#ea580c"
                          strokeWidth={3}
                          strokeDasharray="6 4"
                          dot={{ r: 4 }}
                          connectNulls
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#e1e2ec] flex justify-end">
          <button onClick={onClose}
            className="px-5 py-2 bg-[#f3f4f9] hover:bg-[#e1e2ec] border border-[#c6c5d2] rounded-full text-xs font-bold text-[#464650] transition-all">
            Cerrar Modal
          </button>
        </div>

        {/* Clear Product History Dialog */}
        <ConfirmModal
          isOpen={showClearConfirm}
          title="¿Borrar Historial del Producto?"
          message={`¿Estás seguro de que deseas eliminar TODOS los registros de precios históricos para "${producto.nombre}"?\n\nEsta acción no afectará la información actual del producto ni de sus competidores, pero vaciará el gráfico de tendencias.`}
          confirmText={clearing ? 'Borrando...' : 'Borrar'}
          cancelText="Cancelar"
          isDanger={true}
          onConfirm={handleClearHistory}
          onCancel={() => setShowClearConfirm(false)}
        />
      </div>
    </div>
  );
}
