import { useEffect, useState } from 'react';
import { collection, query, where, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import ConfirmModal from './ConfirmModal';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

const COLORS = ['#040d53', '#70C145', '#ba1a1a', '#004ecb', '#002f6c', '#0891b2', '#db2777'];

export default function ProductDetailModal({ producto, competencia, currency, bcvRate, onClose }) {
  const [historico, setHistorico] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

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
      console.error('Error clearing product history:', err);
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
        console.error('Error cargando histórico:', err.message || err);
        setError(err.message);
      }
      setLoading(false);
    })();
  }, [producto.id_interno]);

  // Pivot: convertir historico en serie por marca-cadena, agrupado por dia.
  const chartData = (() => {
    const byDate = new Map();
    const marcasVistas = new Set();

    for (const h of historico) {
      if (!h.scraped_at) continue;
      const dateKey = h.scraped_at.toISOString().slice(0, 10);
      const marca = `${h.marca} (${h.cadena})`;
      marcasVistas.add(marca);

      const precioBs = h.precio_desc_bs || h.precio_full_bs;
      if (!precioBs) continue;
      const precio = currency === 'usd' && bcvRate ? precioBs / bcvRate : precioBs;

      if (!byDate.has(dateKey)) byDate.set(dateKey, { date: dateKey });
      byDate.get(dateKey)[marca] = parseFloat(precio.toFixed(2));
    }

    return {
      data: Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
      marcas: Array.from(marcasVistas),
    };
  })();

  // Calculations for smart indicators
  const validPrices = competencia
    .map(c => {
      const pBs = c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs;
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
  const propioPriceBs = propioItem ? (propioItem.ultimo_precio_desc_bs || propioItem.ultimo_precio_full_bs) : null;

  const diffMinBs = (propioPriceBs !== null && minPriceItem !== null) ? propioPriceBs - minPriceItem.priceBs : null;
  const pctMin = (diffMinBs !== null && minPriceItem.priceBs > 0) ? (diffMinBs / minPriceItem.priceBs) * 100 : null;

  const diffAvgBs = (propioPriceBs !== null && avgPriceBs !== null) ? propioPriceBs - avgPriceBs : null;
  const pctAvg = (diffAvgBs !== null && avgPriceBs > 0) ? (diffAvgBs / avgPriceBs) * 100 : null;

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
          {/* Smart Indicators Card Grid */}
          {validPrices.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
              {/* Mas Barato Card */}
              <div className="bg-white border border-[#e1e2ec] p-4 rounded-2xl shadow-sm space-y-1">
                <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">Más Barato (Mercado)</span>
                <div className="text-lg font-display font-extrabold text-[#70C145]">
                  {formatHeaderPrice(minPriceItem?.priceBs)}
                </div>
                <p className="text-[10px] text-[#464650] truncate font-semibold">
                  En: {minPriceItem?.cadena} ({minPriceItem?.marca})
                </p>
              </div>

              {/* Mi Precio Card */}
              <div className="bg-white border border-[#e1e2ec] p-4 rounded-2xl shadow-sm space-y-1">
                <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">Mi Precio (Marca Propia)</span>
                <div className="text-lg font-display font-extrabold text-[#70C145]">
                  {propioPriceBs ? formatHeaderPrice(propioPriceBs) : '—'}
                </div>
                <p className="text-[10px] text-[#464650] font-semibold truncate">
                  {propioItem ? `Marca: ${propioItem.marca}` : 'No vinculado'}
                </p>
              </div>

              {/* vs Minimo Card */}
              <div className="bg-white border border-[#e1e2ec] p-4 rounded-2xl shadow-sm space-y-1">
                <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">Diferencia vs Mínimo</span>
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

              {/* vs Promedio Card */}
              <div className="bg-white border border-[#e1e2ec] p-4 rounded-2xl shadow-sm space-y-1">
                <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-[#464650]">Diferencia vs Promedio</span>
                {propioPriceBs && avgPriceBs ? (
                  <>
                    <div className={`text-lg font-display font-extrabold ${pctAvg && pctAvg > 0 ? 'text-[#ba1a1a]' : 'text-[#70C145]'}`}>
                      {pctAvg && pctAvg > 0 ? `+${pctAvg.toFixed(1)}%` : `${pctAvg?.toFixed(1)}%`}
                    </div>
                    <p className="text-[10px] text-[#464650] font-semibold font-mono leading-none">
                      {pctAvg && pctAvg > 0 ? `+${formatHeaderPrice(diffAvgBs)} vs promedio` : `${formatHeaderPrice(diffAvgBs)} vs promedio`}
                    </p>
                  </>
                ) : (
                  <div className="text-lg font-display font-bold text-gray-300">—</div>
                )}
              </div>
            </div>
          )}

          {/* Current Competitor Prices Table */}
          <div className="space-y-2">
            <h3 className="text-xs font-bold text-[#040d53] uppercase font-mono tracking-wider flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">payments</span>
              Precios Actuales por Cadena Farmacéutica
            </h3>
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
                  {competencia.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="px-5 py-6 text-center text-[#464650] italic bg-white">
                        Sin enlaces de competencia vinculados para este producto.
                      </td>
                    </tr>
                  ) : (
                    competencia.map(pc => (
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
                          {formatHeaderPrice(pc.ultimo_precio_full_bs)}
                        </td>
                        <td className="px-5 py-3 text-right font-mono font-extrabold text-[#040d53]">
                          {formatHeaderPrice(pc.ultimo_precio_desc_bs)}
                        </td>
                      </tr>
                    ))
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
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#464650' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#464650' }} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11, marginTop: 10 }} />
                      {chartData.marcas.map((m, i) => (
                        <Line
                          key={m}
                          type="monotone"
                          dataKey={m}
                          stroke={COLORS[i % COLORS.length]}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          connectNulls
                        />
                      ))}
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
