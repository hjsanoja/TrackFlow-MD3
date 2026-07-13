import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

const COLORS = ['#040d53', '#70C145', '#ba1a1a', '#004ecb', '#002f6c', '#0891b2', '#db2777'];

export default function ProductDetailModal({ producto, competencia, currency, bcvRate, onClose }) {
  const [historico, setHistorico] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
                        <td className="px-5 py-3 font-semibold text-[#1c1b1f]">{pc.marca}</td>
                        <td className="px-5 py-3">
                          <span className={`text-[10px] uppercase font-mono font-bold px-2 py-0.5 rounded-full ${
                            pc.tipo === 'propio' ? 'bg-[#e0e1f9] text-[#040d53]' : 'bg-[#f3f4f9] text-[#464650] border border-[#e1e2ec]'
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
            <h3 className="text-xs font-bold text-[#040d53] uppercase font-mono tracking-wider flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">show_chart</span>
              Historial de Tendencia de Precios ({currency === 'usd' ? 'USD $' : 'Bs'})
            </h3>
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
      </div>
    </div>
  );
}
