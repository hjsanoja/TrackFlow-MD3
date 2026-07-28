import { useEffect, useState, useMemo } from 'react';
import { collection, query, where, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import ConfirmModal from './ConfirmModal';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { useData } from '../context/DataContext';
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

function CustomTooltip({ active, payload, label, propios, labMap, currency, analisisMode }) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-[#e1e2ec] p-3 rounded-2xl shadow-xl space-y-2 max-w-sm text-xs font-sans">
        <p className="font-bold text-[#040d53] font-mono border-b border-[#e1e2ec] pb-1 flex justify-between items-center">
          <span>Fecha: {label ? label.split('-').reverse().join('/') : ''}</span>
          {analisisMode === 'unidosis' && (
            <span className="text-[10px] text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded font-bold">Por unidosis</span>
          )}
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
                    {isPropio && (pld.name.includes('(') ? ' (Mi Marca)' : ' (Mi Cadena)')}
                  </span>
                  {lab && (
                    <span className="text-[10px] text-[#464650]/80 font-sans leading-none mt-0.5">
                      Lab: {lab}
                    </span>
                  )}
                </div>
                <span className={`font-mono font-bold ${isPropio ? 'text-[#2e7d32]' : isPromedio ? 'text-[#ea580c]' : 'text-[#040d53]'}`}>
                  {currency === 'usd' ? '$' : 'Bs '}{pld.value?.toFixed(2)}{analisisMode === 'unidosis' ? '/u' : ''}
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

export default function ProductDetailModal({ producto, competencia, currency, bcvRate, onClose, initialPriceMode = 'descuento', initialAnalisisMode = 'empaque' }) {
  const { productos = [], productosCompetencia = [] } = useData() || {};

  const [activeProduct, setActiveProduct] = useState(producto);
  const [activeCompetencia, setActiveCompetencia] = useState(competencia);

  useEffect(() => {
    setActiveProduct(producto);
  }, [producto]);

  useEffect(() => {
    setActiveCompetencia(competencia);
  }, [competencia]);

  const [historico, setHistorico] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [priceMode, setPriceMode] = useState(initialPriceMode);
  const [analisisMode, setAnalisisMode] = useState(initialAnalisisMode);
  const [modalCurrency, setModalCurrency] = useState(currency || 'usd');
  const [chartViewType, setChartViewType] = useState('individual'); // 'individual' or 'chainAverage'

  // Dropdown selector states
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('Todas');

  // Filters inside modal
  const [filterRelacion, setFilterRelacion] = useState('todos'); // 'todos', 'propio', 'competencia'
  const [filterCadena, setFilterCadena] = useState('todas'); // 'todas', or specific chain name

  const handleSelectProduct = (newProd) => {
    setActiveProduct(newProd);
    if (productosCompetencia && productosCompetencia.length) {
      const compItems = productosCompetencia.filter(
        pc => pc.id_producto_propio === newProd.id_interno && pc.activo
      );
      setActiveCompetencia(compItems);
    } else {
      setActiveCompetencia([]);
    }
  };

  const categoriesList = useMemo(() => {
    const set = new Set(productos.map(p => p.categoria).filter(Boolean));
    return ['Todas', ...Array.from(set).sort()];
  }, [productos]);

  const filteredProducts = useMemo(() => {
    const queryStr = searchTerm.toLowerCase().trim();
    return productos.filter(p => {
      const matchCategory = categoryFilter === 'Todas' || p.categoria === categoryFilter;
      if (!matchCategory) return false;
      if (!queryStr) return true;
      
      const name = (p.nombre || '').toLowerCase();
      const code = (p.id_interno || '').toLowerCase();
      const pa = (p.principio_activo || '').toLowerCase();
      const cat = (p.categoria || '').toLowerCase();
      const pres = (p.presentacion || '').toLowerCase();
      
      return name.includes(queryStr) || code.includes(queryStr) || pa.includes(queryStr) || cat.includes(queryStr) || pres.includes(queryStr);
    });
  }, [productos, searchTerm, categoryFilter]);

  const ownProductCount = useMemo(() => {
    return parseUnidosisCount(activeProduct?.tamano || activeProduct?.presentacion, activeProduct?.nombre, activeProduct?.unidosis);
  }, [activeProduct]);

  const competenciaWithUnidosis = useMemo(() => {
    return activeCompetencia.map(pc => {
      const count = parseUnidosisCount(pc.tamano, pc.marca, pc.unidosis) || ownProductCount;
      const factor = analisisMode === 'unidosis' ? Math.max(count, 1) : 1;
      return {
        ...pc,
        unidosisCount: count,
        factor,
        adjustedFullBs: pc.ultimo_precio_full_bs ? pc.ultimo_precio_full_bs / factor : null,
        adjustedDescBs: pc.ultimo_precio_desc_bs ? pc.ultimo_precio_desc_bs / factor : null,
      };
    });
  }, [activeCompetencia, ownProductCount, analisisMode]);

  const handleClearHistory = async () => {
    setClearing(true);
    try {
      const q = query(
        collection(db, 'historico_precios'),
        where('id_producto_propio', '==', activeProduct.id_interno)
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
      setLoading(true);
      try {
        const q = query(
          collection(db, 'historico_precios'),
          where('id_producto_propio', '==', activeProduct.id_interno)
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
  }, [activeProduct.id_interno]);

  // Pivot: convertir historico en serie por marca-cadena o por promedio de cadena, agrupado por dia.
  const chartData = (() => {
    const byDate = new Map();
    const marcasVistas = new Set();
    const propios = new Set();

    const byDateChain = new Map();
    const chainsVistas = new Set();

    for (const h of historico) {
      if (!h.scraped_at) continue;

      // Apply chain and relation filters to the history to filter chart as requested
      const matchRelacion = filterRelacion === 'todos' || 
        (filterRelacion === 'propio' && h.tipo === 'propio') || 
        (filterRelacion === 'competencia' && h.tipo !== 'propio');
      const matchCadena = filterCadena === 'todas' || h.cadena === filterCadena;
      if (!matchRelacion || !matchCadena) continue;

      const dateKey = h.scraped_at.toISOString().slice(0, 10);
      const marca = `${h.marca} (${h.cadena})`;
      marcasVistas.add(marca);

      if (h.tipo === 'propio') {
        propios.add(marca);
      }

      const rawPrecioBs = priceMode === 'descuento'
        ? (h.precio_desc_bs || h.precio_full_bs)
        : h.precio_full_bs;
      if (!rawPrecioBs) continue;

      const hCount = parseUnidosisCount(h.tamano, h.marca, h.unidosis) || ownProductCount;
      const hFactor = analisisMode === 'unidosis' ? Math.max(hCount, 1) : 1;
      const precioBs = rawPrecioBs / hFactor;
      const precio = modalCurrency === 'usd' && bcvRate ? precioBs / bcvRate : precioBs;

      // 1. Individual Brand structure
      if (!byDate.has(dateKey)) byDate.set(dateKey, { date: dateKey });
      byDate.get(dateKey)[marca] = parseFloat(precio.toFixed(2));

      // 2. Chain Average structure
      if (!byDateChain.has(dateKey)) byDateChain.set(dateKey, { date: dateKey });
      if (!byDateChain.get(dateKey)[h.cadena]) {
        byDateChain.get(dateKey)[h.cadena] = { sum: 0, count: 0 };
      }
      byDateChain.get(dateKey)[h.cadena].sum += precio;
      byDateChain.get(dateKey)[h.cadena].count += 1;
      chainsVistas.add(h.cadena);
    }

    // Process individual series
    const dataIndividual = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    dataIndividual.forEach(item => {
      const keys = Object.keys(item).filter(k => k !== 'date');
      if (keys.length > 0) {
        const sum = keys.reduce((acc, k) => acc + item[k], 0);
        item['Promedio'] = parseFloat((sum / keys.length).toFixed(2));
      }
    });

    // Process chain average series
    const dataChainRaw = Array.from(byDateChain.values()).sort((a, b) => a.date.localeCompare(b.date));
    const dataChain = dataChainRaw.map(item => {
      const newItem = { date: item.date };
      const chainKeys = Object.keys(item).filter(k => k !== 'date');
      let totalSum = 0;
      let totalCount = 0;
      chainKeys.forEach(ch => {
        const avg = item[ch].sum / item[ch].count;
        newItem[ch] = parseFloat(avg.toFixed(2));
        totalSum += item[ch].sum;
        totalCount += item[ch].count;
      });
      if (totalCount > 0) {
        newItem['Promedio'] = parseFloat((totalSum / totalCount).toFixed(2));
      }
      return newItem;
    });

    return {
      individual: {
        data: dataIndividual,
        marcas: Array.from(marcasVistas),
        propios,
      },
      chainAverage: {
        data: dataChain,
        cadenas: Array.from(chainsVistas),
      }
    };
  })();

  // Map each competitor/product key to its laboratory
  const labMap = useMemo(() => {
    const map = new Map();
    for (const c of competenciaWithUnidosis) {
      const key = `${c.marca} (${c.cadena})`;
      map.set(key, c.laboratorio || '');
    }
    return map;
  }, [competenciaWithUnidosis]);

  // Available chains for dropdown filter
  const cadenasDisponibles = useMemo(() => {
    const set = new Set(competenciaWithUnidosis.map(c => c.cadena));
    return Array.from(set).sort();
  }, [competenciaWithUnidosis]);

  // Filtered competition list for table
  const competenciaFiltrada = useMemo(() => {
    return competenciaWithUnidosis.filter(pc => {
      const matchRelacion = filterRelacion === 'todos' || 
        (filterRelacion === 'propio' && pc.tipo === 'propio') || 
        (filterRelacion === 'competencia' && pc.tipo !== 'propio');
      const matchCadena = filterCadena === 'todas' || pc.cadena === filterCadena;
      return matchRelacion && matchCadena;
    });
  }, [competenciaWithUnidosis, filterRelacion, filterCadena]);

  // Minimum full price and minimum discount price for highlights in table
  const validFullPrices = competenciaWithUnidosis
    .map(c => c.adjustedFullBs)
    .filter(p => p && p > 0);
  const minFullPriceBs = validFullPrices.length > 0 ? Math.min(...validFullPrices) : null;

  const validDescPrices = competenciaWithUnidosis
    .map(c => c.adjustedDescBs)
    .filter(p => p && p > 0);
  const minDescPriceBs = validDescPrices.length > 0 ? Math.min(...validDescPrices) : null;

  // Calculations for smart indicators (always calculated on full active set for robust comparisons)
  const validPrices = competenciaWithUnidosis
    .map(c => {
      const pBs = priceMode === 'descuento'
        ? (c.adjustedDescBs || c.adjustedFullBs)
        : c.adjustedFullBs;
      return pBs ? { cadena: c.cadena, marca: c.marca, priceBs: pBs, tipo: c.tipo, count: c.unidosisCount } : null;
    })
    .filter(Boolean);

  const minPriceItem = validPrices.length > 0 
    ? validPrices.reduce((prev, curr) => (prev.priceBs < curr.priceBs) ? prev : curr)
    : null;

  const avgPriceBs = validPrices.length > 0
    ? validPrices.reduce((sum, item) => sum + item.priceBs, 0) / validPrices.length
    : null;

  const propioItem = competenciaWithUnidosis.find(c => c.tipo === 'propio');
  const propioPriceBs = propioItem 
    ? (priceMode === 'descuento' 
        ? (propioItem.adjustedDescBs || propioItem.adjustedFullBs)
        : propioItem.adjustedFullBs)
    : null;

  const diffMinBs = (propioPriceBs !== null && minPriceItem !== null) ? propioPriceBs - minPriceItem.priceBs : null;
  const pctMin = (diffMinBs !== null && minPriceItem.priceBs > 0) ? (diffMinBs / minPriceItem.priceBs) * 100 : null;

  const diffAvgBs = (propioPriceBs !== null && avgPriceBs !== null) ? propioPriceBs - avgPriceBs : null;
  const pctAvg = (diffAvgBs !== null && avgPriceBs > 0) ? (diffAvgBs / avgPriceBs) * 100 : null;

  const getLineColor = (marcaName, index, isPropioChain = false) => {
    if (isPropioChain || (chartData?.individual?.propios && chartData.individual.propios.has(marcaName))) {
      return '#2e7d32'; // Green for Propio
    }
    const competitorColors = ['#040d53', '#ba1a1a', '#004ecb', '#0891b2', '#db2777', '#8b5cf6', '#ea580c', '#3b82f6'];
    return competitorColors[index % competitorColors.length];
  };
  const formatHeaderPrice = (priceBs) => {
    if (priceBs == null) return '—';
    const suffix = analisisMode === 'unidosis' ? '/u' : '';
    if (modalCurrency === 'usd') {
      if (!bcvRate) return '—';
      return '$' + (priceBs / bcvRate).toFixed(2) + suffix;
    }
    return 'Bs ' + priceBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix;
  };

  return (
    <div className="fixed inset-0 bg-[#f8f9fa] z-50 flex flex-col overflow-hidden animate-fade-in text-[#1c1b1f]">
      {/* Header Navigation Bar */}
      <div className="bg-white border-b border-[#e1e2ec] px-4 md:px-8 py-3 flex items-center justify-between gap-4 shrink-0 shadow-sm z-30">
        {/* Left: Regresar / Volver button */}
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-2 px-3.5 py-2 bg-white border border-[#e1e2ec] hover:bg-[#f3f4f9] text-[#040d53] text-xs font-bold rounded-xl transition-all shadow-xs group"
            title="Regresar a la pantalla principal"
          >
            <span className="material-symbols-outlined text-base group-hover:-translate-x-0.5 transition-transform">
              arrow_back
            </span>
            <span className="hidden sm:inline">Volver</span>
          </button>
          <div className="h-6 w-[1px] bg-[#e1e2ec] hidden sm:block"></div>
        </div>

        {/* Center: Searchable Product Selector Dropdown */}
        <div className="flex-1 max-w-2xl relative">
          <button
            onClick={() => setDropdownOpen(prev => !prev)}
            className="w-full bg-[#f3f4f9] hover:bg-[#e8eaef] border border-[#e1e2ec] rounded-2xl px-3.5 py-2 flex items-center justify-between transition-all shadow-xs text-left group"
          >
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-8 h-8 rounded-xl bg-[#040d53] text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-xs font-mono">
                {activeProduct.id_interno || 'P'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-extrabold text-sm text-[#040d53] truncate">{activeProduct.nombre}</span>
                  {activeProduct.categoria && (
                    <span className="hidden sm:inline-block px-2 py-0.5 bg-[#e1e2ec] text-[#040d53] text-[10px] font-bold rounded-md font-mono shrink-0">
                      {activeProduct.categoria}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[#464650] truncate leading-tight">
                  {activeProduct.principio_activo || 'Sin principio activo'} · {activeProduct.concentracion || ''} {activeProduct.presentacion || ''}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[#040d53] font-bold text-xs shrink-0 pl-2">
              <span className="hidden md:inline text-[11px] font-mono text-[#464650]">Cambiar producto</span>
              <span className="material-symbols-outlined text-lg group-hover:translate-y-0.5 transition-transform">
                {dropdownOpen ? 'expand_less' : 'unfold_more'}
              </span>
            </div>
          </button>

          {/* Searchable Dropdown Popover */}
          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setDropdownOpen(false)}></div>
              <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl border border-[#e1e2ec] shadow-2xl z-40 p-3 space-y-2.5 animate-fade-in max-w-2xl w-full">
                {/* Search Bar */}
                <div className="relative flex items-center">
                  <span className="material-symbols-outlined absolute left-3 text-lg text-[#464650]">search</span>
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Buscar por nombre, id, principio activo o categoría..."
                    className="w-full pl-9 pr-8 py-2 bg-[#f3f4f9] border border-[#e1e2ec] focus:border-[#040d53] focus:bg-white rounded-xl text-xs font-medium text-[#1c1b1f] placeholder-[#464650]/60 outline-none transition-all"
                    autoFocus
                  />
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm('')}
                      className="absolute right-2.5 text-[#464650] hover:text-black"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  )}
                </div>

                {/* Categories Horizontal Scroll */}
                {categoriesList.length > 2 && (
                  <div className="flex items-center gap-1 overflow-x-auto pb-1 no-scrollbar text-[11px]">
                    {categoriesList.map(cat => (
                      <button
                        key={cat}
                        onClick={() => setCategoryFilter(cat)}
                        className={`px-2.5 py-1 rounded-lg text-[10.5px] font-bold whitespace-nowrap transition-all ${
                          categoryFilter === cat
                            ? 'bg-[#040d53] text-white shadow-xs'
                            : 'bg-[#f3f4f9] text-[#464650] hover:bg-[#e1e2ec]'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                )}

                {/* Counter */}
                <div className="flex items-center justify-between text-[11px] font-mono text-[#464650] px-1 border-b border-[#f3f4f9] pb-1.5">
                  <span>{filteredProducts.length} productos coincidentes</span>
                  <span>{productos.length} total</span>
                </div>

                {/* Product List */}
                <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                  {filteredProducts.length === 0 ? (
                    <div className="p-4 text-center text-xs text-[#464650] italic">
                      No se encontraron productos que coincidan con "{searchTerm}"
                    </div>
                  ) : (
                    filteredProducts.map(p => {
                      const isSelected = p.id_interno === activeProduct.id_interno;
                      const compCount = productosCompetencia.filter(pc => pc.id_producto_propio === p.id_interno && pc.activo).length;

                      return (
                        <button
                          key={p.id_interno || p.id}
                          onClick={() => {
                            handleSelectProduct(p);
                            setDropdownOpen(false);
                          }}
                          className={`w-full text-left p-2.5 rounded-xl transition-all flex items-center justify-between gap-3 ${
                            isSelected
                              ? 'bg-[#040d53]/5 border border-[#040d53]/20 text-[#040d53]'
                              : 'hover:bg-[#f3f4f9] border border-transparent text-[#1c1b1f]'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-extrabold text-xs truncate">{p.nombre}</span>
                              <span className="px-1.5 py-0.2 bg-[#f3f4f9] text-[#040d53] text-[9.5px] font-mono font-bold rounded">
                                {p.id_interno}
                              </span>
                            </div>
                            <p className="text-[11px] text-[#464650] truncate mt-0.5">
                              {p.principio_activo || '—'} {p.concentracion || ''} · {p.presentacion || ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[10px] font-mono font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-full">
                              {compCount} comp.
                            </span>
                            {isSelected && (
                              <span className="material-symbols-outlined text-base text-[#040d53] font-bold">check_circle</span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowClearConfirm(true)}
            disabled={clearing || historico.length === 0}
            className="px-3 py-2 border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 rounded-xl text-xs font-bold transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-xs"
            title="Eliminar historial acumulado para este producto"
          >
            <span className="material-symbols-outlined text-base">delete_sweep</span>
            <span className="hidden lg:inline">Limpiar Historial</span>
          </button>
          <button
            onClick={onClose}
            className="p-2 text-[#464650] hover:text-black hover:bg-[#e1e2ec]/50 rounded-xl transition-colors"
            title="Cerrar vista"
          >
            <span className="material-symbols-outlined text-2xl">close</span>
          </button>
        </div>
      </div>

      {/* Main Content Scrollable Container */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 max-w-7xl mx-auto w-full space-y-6">
          {/* Price and Currency Switch Controls */}
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-[#f3f4f9] p-4 rounded-2xl border border-[#e1e2ec] animate-fade-in">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 flex-1">
              {/* Unidosis vs Empaque Switcher */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">medication</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Modo:</span>
                </div>
                <div className="bg-[#e1e2ec] p-1 rounded-xl flex gap-1 h-[34px] items-center">
                  <button
                    onClick={() => setAnalisisMode('empaque')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 ${
                      analisisMode === 'empaque' 
                        ? 'bg-[#040d53] text-white shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    Empaque
                  </button>
                  <button
                    onClick={() => setAnalisisMode('unidosis')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 ${
                      analisisMode === 'unidosis' 
                        ? 'bg-[#040d53] text-white shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                    title="Analizar precios normalizados por 1 unidad/tableta/dosis"
                  >
                    Unidosis
                  </button>
                </div>
              </div>

              {/* Modo de Comparacion Selector */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">receipt_long</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Comparación:</span>
                </div>
                <div className="bg-[#e1e2ec] p-1 rounded-xl flex gap-1 h-[34px] items-center">
                  <button
                    onClick={() => setPriceMode('descuento')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 ${
                      priceMode === 'descuento' 
                        ? 'bg-white text-[#040d53] shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    Oferta
                  </button>
                  <button
                    onClick={() => setPriceMode('lista')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 ${
                      priceMode === 'lista' 
                        ? 'bg-white text-[#040d53] shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    Lista
                  </button>
                </div>
              </div>

              {/* Moneda Selector */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">monetization_on</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Moneda:</span>
                </div>
                <div className="bg-[#e1e2ec] p-1 rounded-xl flex gap-1 h-[34px] items-center">
                  <button
                    onClick={() => setModalCurrency('usd')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all ${
                      modalCurrency === 'usd' 
                        ? 'bg-white text-[#040d53] shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    USD ($)
                  </button>
                  <button
                    onClick={() => setModalCurrency('bs')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all ${
                      modalCurrency === 'bs' 
                        ? 'bg-white text-[#040d53] shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    Bs
                  </button>
                </div>
              </div>

              {/* Relación Selector */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">groups</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Relación Marca:</span>
                </div>
                <select
                  value={filterRelacion}
                  onChange={(e) => setFilterRelacion(e.target.value)}
                  className="bg-white border border-[#e1e2ec] rounded-xl px-2.5 py-1 text-[11px] font-bold focus:outline-none focus:border-[#040d53] text-[#464650] h-[34px] w-full"
                >
                  <option value="todos">Todos</option>
                  <option value="propio">Mi Marca</option>
                  <option value="competencia">Competidores</option>
                </select>
              </div>

              {/* Cadena Selector */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">storefront</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Cadena:</span>
                </div>
                <select
                  value={filterCadena}
                  onChange={(e) => setFilterCadena(e.target.value)}
                  className="bg-white border border-[#e1e2ec] rounded-xl px-2.5 py-1 text-[11px] font-bold focus:outline-none focus:border-[#040d53] text-[#464650] h-[34px] w-full"
                >
                  <option value="todas">Todas</option>
                  {cadenasDisponibles.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* BCV Rate Badge */}
            {bcvRate && (
              <div className="flex items-center gap-2 bg-white/60 border border-[#e1e2ec] px-3 py-2 rounded-xl text-[11px] font-mono text-[#464650] self-start xl:self-auto min-w-[110px] justify-center h-[34px] mt-auto">
                <span className="text-[9px] uppercase font-bold text-[#464650]/70">Tasa BCV:</span>
                <span className="font-extrabold text-[#040d53]">Bs {bcvRate.toFixed(2)}</span>
              </div>
            )}
          </div>

          {/* Smart Indicators Card Grid */}
          {validPrices.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
              {/* Mas Barato Card */}
              <div className="bg-white border border-[#e1e2ec] p-4 rounded-2xl shadow-sm space-y-1 relative">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">
                    Más Barato {analisisMode === 'unidosis' ? '(Unidosis)' : '(Mercado)'}
                  </span>
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
                  <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#2e7d32]">
                    Mi Precio {analisisMode === 'unidosis' ? '(Unidosis)' : '(Marca Propia)'}
                  </span>
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
                  <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">
                    Promedio {analisisMode === 'unidosis' ? '(Unidosis)' : '(Mercado)'}
                  </span>
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
                Precios Actuales por Cadena Farmacéutica {analisisMode === 'unidosis' ? '(Por Unidosis / Dosis)' : ''}
              </h3>
            </div>

            <div className="border border-[#e1e2ec] rounded-2xl overflow-hidden bg-white shadow-sm">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-[#f8f9fa] text-[#040d53] uppercase font-mono tracking-wider font-bold border-b border-[#e1e2ec]">
                  <tr>
                    <th className="text-left px-5 py-3.5">Cadena</th>
                    <th className="text-left px-5 py-3.5">Marca / Variante</th>
                    <th className="text-left px-5 py-3.5">Relación</th>
                    <th className="text-right px-5 py-3.5">
                      Precio Lista {analisisMode === 'unidosis' ? '(/u)' : ''}
                    </th>
                    <th className="text-right px-5 py-3.5">
                      Precio Oferta {analisisMode === 'unidosis' ? '(/u)' : ''}
                    </th>
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
                      const isCheapestFull = pc.adjustedFullBs && pc.adjustedFullBs === minFullPriceBs;
                      const isCheapestDesc = pc.adjustedDescBs && pc.adjustedDescBs === minDescPriceBs;
                      
                      return (
                        <tr key={pc.id} className="hover:bg-[#f8f9fa] transition-colors">
                          <td className="px-5 py-3 font-bold text-[#040d53]">{pc.cadena}</td>
                          <td className="px-5 py-3 font-semibold text-[#1c1b1f]">
                            {pc.url ? (
                              <a
                                href={pc.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline hover:text-[#040d53] inline-flex items-center gap-1 group transition-all"
                                title="Ver enlace de origen del producto ↗"
                              >
                                <span className="font-semibold">{pc.marca} {pc.concentracion || ''} {pc.tamano || ''}</span>
                                {pc.unidosisCount > 0 && (
                                  <span className="px-1.5 py-0.2 text-[10px] bg-sky-50 text-sky-700 border border-sky-200 rounded font-bold ml-1">
                                    {pc.unidosisCount}u
                                  </span>
                                )}
                                <span className="material-symbols-outlined text-[13px] text-primary/70 group-hover:text-[#040d53] transition-colors leading-none">
                                  open_in_new
                                </span>
                              </a>
                            ) : (
                              <div className="flex items-center gap-1">
                                <span>{pc.marca} {pc.concentracion || ''} {pc.tamano || ''}</span>
                                {pc.unidosisCount > 0 && (
                                  <span className="px-1.5 py-0.2 text-[10px] bg-sky-50 text-sky-700 border border-sky-200 rounded font-bold">
                                    {pc.unidosisCount}u
                                  </span>
                                )}
                              </div>
                            )}
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
                                {formatHeaderPrice(pc.adjustedFullBs)}
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
                                {formatHeaderPrice(pc.adjustedDescBs)}
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
                Historial de Tendencia de Precios ({modalCurrency === 'usd' ? 'USD $' : 'Bs'})
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
            <div className="bg-white rounded-2xl border border-[#e1e2ec] p-4 shadow-sm space-y-4">
              {/* Selector de tipo de gráfico */}
              {historico.length > 0 && !loading && !error && (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[#e1e2ec] animate-fade-in">
                  <div className="flex items-center gap-1.5 text-[#464650]">
                    <span className="material-symbols-outlined text-[16px]">insights</span>
                    <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Modo del Gráfico:</span>
                  </div>
                  <div className="bg-[#f3f4f9] p-0.5 rounded-xl flex gap-1 self-start sm:self-auto border border-[#e1e2ec]">
                    <button
                      onClick={() => setChartViewType('individual')}
                      className={`px-3 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 ${
                        chartViewType === 'individual'
                          ? 'bg-white text-[#040d53] shadow-sm'
                          : 'text-[#464650] hover:bg-white/50'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[14px]">medication</span>
                      Detalle por Variante
                    </button>
                    <button
                      onClick={() => setChartViewType('chainAverage')}
                      className={`px-3 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 ${
                        chartViewType === 'chainAverage'
                          ? 'bg-white text-[#040d53] shadow-sm'
                          : 'text-[#464650] hover:bg-white/50'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[14px]">corporate_fare</span>
                      Promedio por Cadena
                    </button>
                  </div>
                </div>
              )}

              {loading ? (
                <div className="h-64 flex flex-col items-center justify-center text-xs text-[#464650] font-semibold gap-1.5 animate-pulse">
                  <span className="material-symbols-outlined animate-spin text-2xl text-[#040d53]">autorenew</span>
                  Cargando tendencia histórica...
                </div>
              ) : error ? (
                <div className="h-64 flex items-center justify-center text-[#ba1a1a] text-xs font-mono font-bold">{error}</div>
              ) : chartData[chartViewType].data.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-[#464650] text-xs italic text-center px-4">
                  No hay suficiente historial que coincida con los filtros seleccionados (relación / cadena) para este gráfico.
                </div>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData[chartViewType].data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
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
                      <Tooltip content={
                        <CustomTooltip 
                          propios={chartViewType === 'individual' 
                            ? Array.from(chartData.individual.propios) 
                            : (propioItem ? [propioItem.cadena] : [])
                          } 
                          labMap={chartViewType === 'individual' ? Object.fromEntries(labMap) : {}} 
                          currency={modalCurrency} 
                          analisisMode={analisisMode}
                        />
                      } />
                      <Legend wrapperStyle={{ fontSize: 11, marginTop: 10 }} />
                      
                      {chartViewType === 'individual' ? (
                        chartData.individual.marcas.map((m, i) => {
                          const isPropio = chartData.individual.propios.has(m);
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
                        })
                      ) : (
                        chartData.chainAverage.cadenas.map((c, i) => {
                          const isPropioChain = propioItem && propioItem.cadena === c;
                          return (
                            <Line
                              key={c}
                              type="monotone"
                              dataKey={c}
                              name={isPropioChain ? `${c} ⭐ (Mi Cadena)` : c}
                              stroke={getLineColor(c, i, isPropioChain)}
                              strokeWidth={isPropioChain ? 4.5 : 2}
                              dot={{ r: isPropioChain ? 5 : 3 }}
                              connectNulls
                            />
                          );
                        })
                      )}

                      {/* Línea especial para el Promedio del mercado */}
                      {chartData[chartViewType].data.length > 0 && (
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

      {/* Clear Product History Dialog */}
      <ConfirmModal
        isOpen={showClearConfirm}
        title="¿Borrar Historial del Producto?"
        message={`¿Estás seguro de que deseas eliminar TODOS los registros de precios históricos para "${activeProduct.nombre}"?\n\nEsta acción no afectará la información actual del producto ni de sus competidores, pero vaciará el gráfico de tendencias.`}
        confirmText={clearing ? 'Borrando...' : 'Borrar'}
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleClearHistory}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  );
}
