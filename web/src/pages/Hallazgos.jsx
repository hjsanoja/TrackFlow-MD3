import { useEffect, useState, useMemo } from 'react';
import { useBcvRate } from '../hooks/useBcvRate';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';

export default function Hallazgos({ user, userDoc }) {
  const { productos, productosCompetencia, historicoPrecios, loadingInitial: loading } = useData();
  const [currency, setCurrency] = useState('usd');
  const [search, setSearch] = useState('');
  const [categoriaSeleccionada, setCategoriaSeleccionada] = useState('Todas');
  const [unSeleccionada, setUnSeleccionada] = useState('Todas');
  const [tipoMercadoSeleccionado, setTipoMercadoSeleccionado] = useState('Todos');
  const [severidadSeleccionada, setSeveridadSeleccionada] = useState('Todos');
  const [mostrarSoloConHallazgos, setMostrarSoloConHallazgos] = useState(true);
  const [paginaActual, setPaginaActual] = useState(1);

  const bcv = useBcvRate();
  const { addToast } = useToast();

  // Reset pagination when filters change
  useEffect(() => {
    setPaginaActual(1);
  }, [search, categoriaSeleccionada, unSeleccionada, tipoMercadoSeleccionado, severidadSeleccionada, mostrarSoloConHallazgos]);

  // Dynamic category list
  const categorias = useMemo(() => {
    const list = new Set(productos.map(p => p.categoria).filter(Boolean));
    return ['Todas', ...Array.from(list)];
  }, [productos]);

  // Rules engine to find insights per product
  const productosConHallazgos = useMemo(() => {
    if (productos.length === 0) return [];

    return productos
      .filter(p => p.activo)
      .map(p => {
        const compItems = productosCompetencia.filter(pc => pc.id_producto_propio === p.id_interno && pc.activo);
        
        // Competitor prices (converted to USD using rate)
        const competitorPricesUsd = compItems
          .filter(c => c.tipo !== 'propio')
          .map(c => {
            const priceBs = c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs;
            if (!priceBs || !bcv.rate) return null;
            return {
              id: c.id,
              cadena: c.cadena,
              marca: c.marca,
              priceUsd: priceBs / bcv.rate,
              priceBs: priceBs,
              url: c.url
            };
          })
          .filter(Boolean);

        const avgCompUsd = competitorPricesUsd.length > 0 
          ? competitorPricesUsd.reduce((a, b) => a + b, 0) / competitorPricesUsd.length 
          : null;

        const minCompUsd = competitorPricesUsd.length > 0 ? Math.min(...competitorPricesUsd.map(x => x.priceUsd)) : null;
        const maxCompUsd = competitorPricesUsd.length > 0 ? Math.max(...competitorPricesUsd.map(x => x.priceUsd)) : null;

        const dispersionPercent = (minCompUsd && maxCompUsd && minCompUsd > 0)
          ? ((maxCompUsd - minCompUsd) / minCompUsd) * 100
          : 0;

        // Our own price details
        const propioItem = compItems.find(c => c.tipo === 'propio');
        const propioPriceBs = propioItem ? (propioItem.ultimo_precio_desc_bs || propioItem.ultimo_precio_full_bs) : null;
        const propioPriceUsd = (propioPriceBs && bcv.rate) ? (propioPriceBs / bcv.rate) : null;

        const ipr = (propioPriceUsd && avgCompUsd) ? (propioPriceUsd / avgCompUsd) * 100 : null;

        // --- programmatic rules ---
        const hallazgos = [];

        // RULE 1: INTERNAL PRICE INVERSION (CRITICAL)
        // If this product is a generic, let's find if we have a Brand option for the same active ingredient + presentation
        const pTipo = (p.market_type || 'GENERICO').toUpperCase();
        if (pTipo === 'GENERICO' && propioPriceUsd) {
          const brandCounterpart = productos.find(other => 
            other.activo &&
            other.id_interno !== p.id_interno &&
            (other.market_type || '').toUpperCase() === 'MARCA' &&
            (other.principio_activo || '').trim().toLowerCase() === (p.principio_activo || '').trim().toLowerCase() &&
            (other.concentracion || '').trim().toLowerCase() === (p.concentracion || '').trim().toLowerCase() &&
            (other.tamano || '').trim().toLowerCase() === (p.tamano || '').trim().toLowerCase()
          );

          if (brandCounterpart) {
            // Find our price for the brand counterpart
            const brandComp = productosCompetencia.find(pc => pc.id_producto_propio === brandCounterpart.id_interno && pc.tipo === 'propio' && pc.activo);
            const brandPriceBs = brandComp ? (brandComp.ultimo_precio_desc_bs || brandComp.ultimo_precio_full_bs) : null;
            const brandPriceUsd = (brandPriceBs && bcv.rate) ? (brandPriceBs / bcv.rate) : null;

            if (brandPriceUsd && propioPriceUsd > brandPriceUsd) {
              hallazgos.push({
                id: 'inversion_precios',
                tipo: 'Inversión de Precio',
                severidad: 'critico',
                icon: 'gavel',
                titulo: 'Inversión de Precio Interna Crítica',
                detalle: `Tu producto Genérico tiene un precio de venta de $${propioPriceUsd.toFixed(2)} (Bs ${(propioPriceUsd * bcv.rate).toFixed(2)}), el cual supera a tu opción de Marca homóloga ${brandCounterpart.nombre} ($${brandPriceUsd.toFixed(2)} / Bs ${(brandPriceUsd * bcv.rate).toFixed(2)}).`,
                recomendacion: 'Ajustar la tarifa del Genérico a la baja o re-evaluar la marca para restaurar la coherencia de portafolio y evitar confusión en el canal.'
              });
            } else if (brandPriceUsd) {
              // RULE 2: BRAND CANNIBALIZATION / BRECHA ESTRECHA (ALERTA)
              const gap = ((brandPriceUsd - propioPriceUsd) / propioPriceUsd) * 100;
              if (gap < 15) {
                hallazgos.push({
                  id: 'brecha_estrecha',
                  tipo: 'Paridad Estrecha',
                  severidad: 'alerta',
                  icon: 'warning',
                  titulo: 'Riesgo de Canibalización de Marca',
                  detalle: `La brecha de precio entre tu opción de Marca ($${brandPriceUsd.toFixed(2)}) y tu Genérico ($${propioPriceUsd.toFixed(2)}) es de solo ${gap.toFixed(0)}%. Una brecha tan estrecha diluye la prima de marca y desvía la demanda.`,
                  recomendacion: 'Incrementar el precio de la Marca en al menos un 10% o regular los descuentos del Genérico para mantener una brecha saludable (>25%).'
                });
              }
            }
          }
        }

        // RULE 3: UNDERPRICED / EBITDA GAP (OPORTUNIDAD DE ALZA)
        if (propioPriceUsd) {
          // If our price is cheaper than competitor average by > 15% (IPR < 85%) OR cheaper than competitor minimum by > 5%
          if (ipr && ipr < 85) {
            hallazgos.push({
              id: 'sub_indexacion',
              tipo: 'Oportunidad de EBITDA',
              severidad: 'oportunidad',
              icon: 'add_circle',
              titulo: 'Oportunidad de Margen (Sub-indexado)',
              detalle: `Tu precio de $${propioPriceUsd.toFixed(2)} se encuentra un ${(100 - ipr).toFixed(0)}% por debajo del promedio de la competencia ($${avgCompUsd?.toFixed(2)}). Estás cediendo margen de forma innecesaria.`,
              recomendacion: `Tienes espacio de alza de hasta un 8% o 12% para capturar rentabilidad directa sin perder tu atractivo competitivo en el canal.`
            });
          } else if (minCompUsd && propioPriceUsd < minCompUsd * 0.90) {
            const diffMinPct = ((minCompUsd - propioPriceUsd) / minCompUsd) * 100;
            hallazgos.push({
              id: 'oportunidad_minimo',
              tipo: 'Oportunidad de EBITDA',
              severidad: 'oportunidad',
              icon: 'trending_up',
              titulo: 'Súper-Competitivo vs Mínimo del Mercado',
              detalle: `Estás un ${diffMinPct.toFixed(0)}% por debajo del competidor más barato del mercado ($${minCompUsd.toFixed(2)}). Esto sobre-estimula la demanda a costa de tu EBITDA.`,
              recomendacion: 'Incrementar de forma escalonada el precio de lista para alinearte con el piso competitivo del mercado.'
            });
          }
        }

        // RULE 4: OVERPRICED COMPETITIVENESS RISK (ALERTA)
        if (propioPriceUsd && ipr && ipr > 115) {
          hallazgos.push({
            id: 'sobre_indexacion',
            tipo: 'Riesgo de Rotación',
            severidad: 'alerta',
            icon: 'remove_circle',
            titulo: 'Pérdida de Competitividad (Sobre-indexado)',
            detalle: `Tu precio de $${propioPriceUsd.toFixed(2)} supera en un ${(ipr - 100).toFixed(0)}% al promedio competitivo ($${avgCompUsd?.toFixed(2)}). Esto puede frenar la rotación y la formulación médica.`,
            recomendacion: 'Re-evaluar descuentos por volumen o aplicar campañas promocionales tácticas para amortiguar el diferencial de precio.'
          });
        }

        // RULE 5: HIGH MARKET VOLATILITY / DISPERSION (MERCADO / INFORMATIVO)
        if (dispersionPercent > 20 && competitorPricesUsd.length > 1) {
          hallazgos.push({
            id: 'alta_dispersion',
            tipo: 'Anomalía de Mercado',
            severidad: 'mercado',
            icon: 'insights',
            titulo: 'Dispersión de Precios Elevada',
            detalle: `Se detectó una brecha de ${dispersionPercent.toFixed(0)}% entre el competidor más barato ($${minCompUsd?.toFixed(2)}) y el más caro ($${maxCompUsd?.toFixed(2)}) en farmacias externas.`,
            recomendacion: 'Estudiar si la cadena líder de precio bajo sostiene la oferta por subsidios o liquidaciones puntuales, para no reaccionar con pánico.'
          });
        }

        // RULE 6: COMPETITOR GENERIC DEARER THAN OUR BRAND (CAMPAÑA / OPORTUNIDAD)
        if (pTipo === 'MARCA' && propioPriceUsd && competitorPricesUsd.length > 0) {
          // Find alternative generics of this molecule in the market
          // Let's check if any competitor option has the word generic or if they represent alternative competitors
          const cheaperGenericsOfCompetitors = competitorPricesUsd.filter(cp => cp.priceUsd > propioPriceUsd);
          if (cheaperGenericsOfCompetitors.length > 0) {
            const highComp = cheaperGenericsOfCompetitors[0];
            hallazgos.push({
              id: 'marca_barata',
              tipo: 'Ventaja de Marca',
              severidad: 'oportunidad',
              icon: 'campaign',
              titulo: 'Marca Premium a Precio de Genérico',
              detalle: `Tu producto de Marca ($${propioPriceUsd.toFixed(2)}) es más económico que la opción comercializada por la competencia en ${highComp.cadena} ($${highComp.priceUsd.toFixed(2)}).`,
              recomendacion: 'Activar esfuerzos de marketing y visitas médicas destacando que ofreces un medicamento de marca respaldado a un precio inferior al de un genérico.'
            });
          }
        }

        const totalSeveridadRanking = hallazgos.reduce((score, h) => {
          if (h.severidad === 'critico') return score + 100;
          if (h.severidad === 'alerta') return score + 10;
          if (h.severidad === 'oportunidad') return score + 5;
          return score + 1;
        }, 0);

        return {
          producto: p,
          competencia: compItems,
          avgCompUsd,
          minCompUsd,
          maxCompUsd,
          propioPriceUsd,
          dispersionPercent,
          ipr,
          hallazgos,
          hasHallazgos: hallazgos.length > 0,
          score: totalSeveridadRanking
        };
      })
      .sort((a, b) => b.score - a.score); // Prioritize critical products at the top!
  }, [productos, productosCompetencia, bcv.rate]);

  // Compute analytics for summary metrics
  const totalConAlertasCriticas = useMemo(() => {
    return productosConHallazgos.filter(p => p.hallazgos.some(h => h.severidad === 'critico')).length;
  }, [productosConHallazgos]);

  const totalConAlertasModeradas = useMemo(() => {
    return productosConHallazgos.filter(p => p.hallazgos.some(h => h.severidad === 'alerta')).length;
  }, [productosConHallazgos]);

  const totalOportunidadesEbitda = useMemo(() => {
    return productosConHallazgos.filter(p => p.hallazgos.some(h => h.severidad === 'oportunidad')).length;
  }, [productosConHallazgos]);

  // Filtered insights list
  const filteredProducts = useMemo(() => {
    const term = search.toLowerCase().trim();
    return productosConHallazgos.filter(item => {
      // Search matches
      const matchSearch = !term || 
        item.producto.nombre.toLowerCase().includes(term) ||
        (item.producto.principio_activo || '').toLowerCase().includes(term) ||
        item.producto.id_interno.toLowerCase().includes(term);

      // Business Unit
      const pUn = (item.producto.unidad_negocio || 'La Sante').toUpperCase();
      const matchUn = unSeleccionada === 'Todas' || pUn === unSeleccionada.toUpperCase();

      // Market Type
      const pTipo = (item.producto.market_type || 'GENERICO').toUpperCase();
      const matchTipo = tipoMercadoSeleccionado === 'Todos' || pTipo === tipoMercadoSeleccionado.toUpperCase();

      // Category
      const matchCat = categoriaSeleccionada === 'Todas' || item.producto.categoria === categoriaSeleccionada;

      // Severity selection
      const matchSeverity = severidadSeleccionada === 'Todos' || item.hallazgos.some(h => {
        if (severidadSeleccionada === 'critico') return h.severidad === 'critico';
        if (severidadSeleccionada === 'alerta') return h.severidad === 'alerta';
        if (severidadSeleccionada === 'oportunidad') return h.severidad === 'oportunidad';
        if (severidadSeleccionada === 'mercado') return h.severidad === 'mercado';
        return true;
      });

      // Show only with findings
      const matchFindingsOnly = !mostrarSoloConHallazgos || item.hasHallazgos;

      return matchSearch && matchUn && matchTipo && matchCat && matchSeverity && matchFindingsOnly;
    });
  }, [productosConHallazgos, search, unSeleccionada, tipoMercadoSeleccionado, categoriaSeleccionada, severidadSeleccionada, mostrarSoloConHallazgos]);

  // Pagination
  const itemsPorPagina = 8;
  const totalPaginas = Math.ceil(filteredProducts.length / itemsPorPagina);
  const paginatedProducts = useMemo(() => {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    return filteredProducts.slice(inicio, inicio + itemsPorPagina);
  }, [filteredProducts, paginaActual]);

  // Currency helper
  const fmt = (priceUsd) => {
    if (priceUsd == null || isNaN(priceUsd)) return '—';
    if (currency === 'usd') {
      return `$${priceUsd.toFixed(2)}`;
    }
    if (!bcv.rate) return '—';
    return 'Bs ' + (priceUsd * bcv.rate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Export programmatic findings CSV
  const handleExportInsights = () => {
    let csv = '\ufeff'; // BOM for Excel UTF-8
    csv += 'ID Interno,Producto,UN,Tipo,Categoría,Mi Precio (USD),Mín Competidor (USD),Prom Competidor (USD),Dispersión (%),IPR (%),Severidad Hallazgo,Tipo Hallazgo,Título Hallazgo,Diagnóstico,Prescripción Recomendada\n';

    productosConHallazgos.forEach(item => {
      const p = item.producto;
      const rate = bcv.rate || 1;
      
      if (item.hallazgos.length === 0) {
        // Healthy product
        const row = [
          p.id_interno,
          p.nombre,
          p.unidad_negocio || 'La Sante',
          p.market_type || 'GENERICO',
          p.categoria,
          item.propioPriceUsd ? item.propioPriceUsd.toFixed(2) : '—',
          item.minCompUsd ? item.minCompUsd.toFixed(2) : '—',
          item.avgCompUsd ? item.avgCompUsd.toFixed(2) : '—',
          item.dispersionPercent ? item.dispersionPercent.toFixed(1) : '—',
          item.ipr ? item.ipr.toFixed(1) : '—',
          'Sano',
          'Coherencia Óptima',
          'Sin anomalías',
          'El precio del producto cumple con los parámetros de paridad competitiva e interna.',
          'Mantener monitoreo regular.'
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + '\n';
        csv += row;
      } else {
        item.hallazgos.forEach(h => {
          const row = [
            p.id_interno,
            p.nombre,
            p.unidad_negocio || 'La Sante',
            p.market_type || 'GENERICO',
            p.categoria,
            item.propioPriceUsd ? item.propioPriceUsd.toFixed(2) : '—',
            item.minCompUsd ? item.minCompUsd.toFixed(2) : '—',
            item.avgCompUsd ? item.avgCompUsd.toFixed(2) : '—',
            item.dispersionPercent ? item.dispersionPercent.toFixed(1) : '—',
            item.ipr ? item.ipr.toFixed(1) : '—',
            h.severidad.toUpperCase(),
            h.tipo,
            h.titulo,
            h.detalle,
            h.recomendacion
          ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + '\n';
          csv += row;
        });
      }
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Auditoria_Hallazgos_Precios_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addToast('Reporte de inteligencia estratégica descargado con éxito.', 'success');
  };

  if (loading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center space-y-4">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-mono font-bold text-primary animate-pulse">
          Escaneando base de precios competitivos...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 text-on-background">
      {/* Header section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-extrabold text-on-background flex items-center gap-2">
            <span className="material-symbols-outlined text-3xl text-primary">troubleshoot</span>
            Auditoría de Hallazgos & Prescripción Estratégica
          </h1>
          <p className="text-sm text-on-surface-variant font-sans mt-1">
            Motor de reglas comerciales que detecta inconsistencias críticas, canibalización, brechas de EBITDA e indexación de mercado por molécula.
          </p>
        </div>

        {/* Currency controls & Action button */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="bg-white rounded-full border border-outline-variant p-0.5 flex">
            <button
              onClick={() => setCurrency('usd')}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                currency === 'usd' ? 'bg-[#040d53] text-white shadow-sm' : 'text-on-surface hover:bg-on-surface/5'
              }`}
            >
              USD
            </button>
            <button
              onClick={() => setCurrency('bs')}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1 ${
                currency === 'bs' ? 'bg-[#040d53] text-white shadow-sm' : 'text-on-surface hover:bg-on-surface/5'
              }`}
            >
              VES
              {bcv.rate && <span className="text-[9px] opacity-75">({bcv.rate.toFixed(2)})</span>}
            </button>
          </div>

          <button
            onClick={handleExportInsights}
            className="flex items-center gap-2 px-5 py-2.5 bg-[#040d53] text-white font-bold rounded-full hover:bg-opacity-90 transition-all text-sm shadow-sm"
          >
            <span className="material-symbols-outlined text-lg">download</span>
            <span>Exportar Hallazgos</span>
          </button>
        </div>
      </div>

      {/* Summary KPI grid widgets */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total scan */}
        <div className="bg-white border border-outline-variant p-5 rounded-3xl flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-2xl bg-surface-low flex items-center justify-center text-primary shrink-0 border border-outline-variant/30">
            <span className="material-symbols-outlined text-2xl">medication</span>
          </div>
          <div>
            <span className="text-[11px] font-mono font-bold text-on-surface-variant uppercase tracking-wider">Productos Escaneados</span>
            <div className="text-2xl font-display font-extrabold text-on-background mt-0.5">
              {productos.filter(p => p.activo).length}
            </div>
            <span className="text-[10px] text-on-surface-variant block mt-0.5">
              Catálogo de marcas activas
            </span>
          </div>
        </div>

        {/* Critical Alerts */}
        <div className="bg-white border border-outline-variant p-5 rounded-3xl flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-2xl bg-red-500/[0.04] border border-red-200 flex items-center justify-center text-error shrink-0">
            <span className="material-symbols-outlined text-2xl">gavel</span>
          </div>
          <div>
            <span className="text-[11px] font-mono font-bold text-red-700 uppercase tracking-wider">Alertas Críticas</span>
            <div className="text-2xl font-display font-extrabold text-error mt-0.5">
              {totalConAlertasCriticas}
            </div>
            <span className="text-[10px] text-red-600 font-semibold block mt-0.5">
              Inversión de precios urgentes
            </span>
          </div>
        </div>

        {/* Moderated Alerts */}
        <div className="bg-white border border-outline-variant p-5 rounded-3xl flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/[0.04] border border-amber-200 flex items-center justify-center text-amber-700 shrink-0">
            <span className="material-symbols-outlined text-2xl">warning</span>
          </div>
          <div>
            <span className="text-[11px] font-mono font-bold text-amber-700 uppercase tracking-wider">Alertas de Portafolio</span>
            <div className="text-2xl font-display font-extrabold text-amber-700 mt-0.5">
              {totalConAlertasModeradas}
            </div>
            <span className="text-[10px] text-amber-600 block mt-0.5">
              Canibalización o sobreprecio
            </span>
          </div>
        </div>

        {/* EBITDA Opportunities */}
        <div className="bg-white border border-outline-variant p-5 rounded-3xl flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/[0.04] border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
            <span className="material-symbols-outlined text-2xl">payments</span>
          </div>
          <div>
            <span className="text-[11px] font-mono font-bold text-emerald-700 uppercase tracking-wider">Brechas de EBITDA</span>
            <div className="text-2xl font-display font-extrabold text-emerald-700 mt-0.5">
              {totalOportunidadesEbitda}
            </div>
            <span className="text-[10px] text-emerald-600 font-semibold block mt-0.5">
              Oportunidades de alza de precio
            </span>
          </div>
        </div>
      </div>

      {/* Advanced search and filtering bar */}
      <div className="bg-white rounded-3xl border border-outline-variant p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2 border-b pb-3 mb-1">
          <span className="material-symbols-outlined text-primary text-xl">filter_alt</span>
          <h2 className="font-display font-extrabold text-sm text-on-background uppercase tracking-wide">
            Filtros Avanzados de Inteligencia
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {/* Search box */}
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">search</span>
            <input
              type="text"
              placeholder="Buscar por producto o principio..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-xs pl-10 pr-4 py-2.5 rounded-full border border-outline bg-white hover:border-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all text-on-surface"
            />
          </div>

          {/* SBU / UN Filter */}
          <div>
            <select
              value={unSeleccionada}
              onChange={(e) => setUnSeleccionada(e.target.value)}
              className="w-full text-xs px-4 py-2.5 rounded-full border border-outline bg-white hover:border-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all text-on-surface font-sans"
            >
              <option value="Todas">Todas las Unidades (UN)</option>
              <option value="La Sante">La Santé</option>
              <option value="Pharmetique">Pharmetique</option>
              <option value="OTC">OTC</option>
            </select>
          </div>

          {/* Market Type Filter */}
          <div>
            <select
              value={tipoMercadoSeleccionado}
              onChange={(e) => setTipoMercadoSeleccionado(e.target.value)}
              className="w-full text-xs px-4 py-2.5 rounded-full border border-outline bg-white hover:border-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all text-on-surface font-sans"
            >
              <option value="Todos">Todos los Mercados</option>
              <option value="GENERICO">Genérico</option>
              <option value="MARCA">Marca</option>
            </select>
          </div>

          {/* Category Filter */}
          <div>
            <select
              value={categoriaSeleccionada}
              onChange={(e) => setCategoriaSeleccionada(e.target.value)}
              className="w-full text-xs px-4 py-2.5 rounded-full border border-outline bg-white hover:border-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all text-on-surface font-sans"
            >
              {categorias.map(cat => (
                <option key={cat} value={cat}>{cat === 'Todas' ? 'Todas las Categorías' : cat}</option>
              ))}
            </select>
          </div>

          {/* Severity Filter */}
          <div>
            <select
              value={severidadSeleccionada}
              onChange={(e) => setSeveridadSeleccionada(e.target.value)}
              className="w-full text-xs px-4 py-2.5 rounded-full border border-outline bg-white hover:border-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all text-on-surface font-sans"
            >
              <option value="Todos">Cualquier Gravedad</option>
              <option value="critico">Crítico (Inversiones de precio)</option>
              <option value="alerta">Alerta (Sobreprecios / Brechas)</option>
              <option value="oportunidad">Oportunidad (Márgenes de alza)</option>
              <option value="mercado">Mercado (Dispersión / Arbitrajes)</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pt-2 border-t border-dashed border-outline-variant/60 gap-3">
          {/* Toggle with findings only */}
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={mostrarSoloConHallazgos}
              onChange={(e) => setMostrarSoloConHallazgos(e.target.checked)}
              className="sr-only peer"
            />
            <div className="relative w-9 h-5 bg-on-surface/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
            <span className="text-xs font-semibold text-on-surface">
              Mostrar únicamente productos con hallazgos activos ({productosConHallazgos.filter(p => p.hasHallazgos).length})
            </span>
          </label>

          <div className="text-xs text-on-surface-variant font-mono">
            Filtrados: <strong className="font-bold text-on-surface">{filteredProducts.length}</strong> de {productosConHallazgos.length} productos
          </div>
        </div>
      </div>

      {/* Main product audit list */}
      <div className="space-y-4">
        {paginatedProducts.length === 0 ? (
          <div className="bg-white rounded-3xl border border-outline-variant p-10 text-center space-y-3">
            <span className="material-symbols-outlined text-4xl text-on-surface-variant/40 animate-pulse">fact_check</span>
            <h3 className="font-display font-extrabold text-base text-on-background">Ningún producto cumple con los criterios</h3>
            <p className="text-xs text-on-surface-variant max-w-md mx-auto">
              Intenta ensanchar el término de búsqueda o desactivar los filtros seleccionados para revisar los diagnósticos del portafolio.
            </p>
          </div>
        ) : (
          paginatedProducts.map(item => {
            const p = item.producto;
            const cardBgClass = item.hasHallazgos 
              ? 'bg-white hover:border-outline transition-all shadow-sm'
              : 'bg-emerald-50/[0.02] border-emerald-500/10 hover:border-emerald-500/25 transition-all shadow-sm';

            return (
              <div key={p.id_interno} className={`rounded-3xl border border-outline-variant p-6 ${cardBgClass} flex flex-col lg:flex-row gap-6 justify-between`}>
                
                {/* Product Meta Section */}
                <div className="space-y-4 lg:w-1/3">
                  <div>
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      <span className={`text-[9px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                        p.unidad_negocio === 'OTC' 
                          ? 'bg-amber-50 text-amber-800 border-amber-200' 
                          : p.unidad_negocio === 'Pharmetique' 
                          ? 'bg-blue-50 text-blue-800 border-blue-200' 
                          : 'bg-teal-50 text-teal-800 border-teal-200'
                      }`}>
                        UN {p.unidad_negocio || 'La Sante'}
                      </span>
                      <span className="text-[9px] font-mono font-bold text-on-surface-variant bg-surface-low px-2 py-0.5 rounded-md border border-outline-variant/60">
                        {(p.market_type || 'GENERICO').toUpperCase()}
                      </span>
                      <span className="text-[9px] font-mono font-bold text-on-surface-variant bg-surface-low px-2 py-0.5 rounded-md border border-outline-variant/60">
                        {p.categoria}
                      </span>
                    </div>

                    <h3 className="font-display font-extrabold text-lg text-on-background leading-snug">
                      {p.nombre}
                    </h3>
                    
                    <p className="text-xs font-mono font-bold text-primary uppercase tracking-wide mt-1">
                      {p.principio_activo || '—'} {p.concentracion} · {p.tamano}
                    </p>
                    <p className="text-[10px] text-on-surface-variant font-mono mt-0.5">
                      Código Interno: {p.id_interno} | Laboratorio: {p.laboratorio || 'La Santé'}
                    </p>
                  </div>

                  {/* Price Metrics mini-grid */}
                  <div className="grid grid-cols-3 gap-2.5 pt-4 border-t border-dashed border-outline-variant/50 text-xs">
                    <div className="bg-surface-low/45 p-2.5 rounded-2xl border border-outline-variant/40 text-center">
                      <span className="text-[10px] text-on-surface-variant block mb-1">Mi Precio</span>
                      <span className="font-mono font-extrabold text-on-surface text-sm">
                        {fmt(item.propioPriceUsd)}
                      </span>
                    </div>

                    <div className="bg-surface-low/45 p-2.5 rounded-2xl border border-outline-variant/40 text-center">
                      <span className="text-[10px] text-on-surface-variant block mb-1">Mín Mercado</span>
                      <span className="font-mono font-extrabold text-on-surface text-sm">
                        {fmt(item.minCompUsd)}
                      </span>
                    </div>

                    <div className="bg-surface-low/45 p-2.5 rounded-2xl border border-outline-variant/40 text-center">
                      <span className="text-[10px] text-on-surface-variant block mb-1">Promedio Comp</span>
                      <span className="font-mono font-extrabold text-on-surface text-sm">
                        {fmt(item.avgCompUsd)}
                      </span>
                    </div>
                  </div>

                  {/* Relative indicators */}
                  {item.propioPriceUsd && item.avgCompUsd && (
                    <div className="flex items-center justify-between text-xs font-medium pt-1">
                      <span className="text-on-surface-variant">Índice IPR vs Competencia:</span>
                      <span className={`font-mono font-extrabold ${
                        item.ipr > 115 
                          ? 'text-error' 
                          : item.ipr < 85 
                          ? 'text-green-700' 
                          : 'text-secondary'
                      }`}>
                        {item.ipr.toFixed(1)}% ({item.ipr >= 100 ? `+${(item.ipr - 100).toFixed(0)}%` : `-${(100 - item.ipr).toFixed(0)}%`})
                      </span>
                    </div>
                  )}
                </div>

                {/* Rules audit list */}
                <div className="flex-1 space-y-3 lg:border-l lg:pl-6 lg:border-outline-variant/50">
                  <div className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant mb-2 flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">assignment_turned_in</span>
                    Auditoría de consistencia de precios:
                  </div>

                  {!item.hasHallazgos ? (
                    <div className="p-4 rounded-2xl bg-emerald-500/[0.01] border border-emerald-500/15 flex items-start gap-3">
                      <span className="material-symbols-outlined text-emerald-600 shrink-0 text-xl">check_circle</span>
                      <div className="space-y-0.5">
                        <h4 className="text-xs font-bold text-emerald-800">
                          Posicionamiento Coherente
                        </h4>
                        <p className="text-xs text-emerald-700 font-sans leading-relaxed">
                          El producto se encuentra perfectamente indexado frente a sus homólogos comerciales e internos. Cumple satisfactoriamente con la paridad óptima de mercado.
                        </p>
                      </div>
                    </div>
                  ) : (
                    item.hallazgos.map((hallazgo, idx) => {
                      const sevColors = {
                        critico: 'bg-red-50 text-red-700 border-red-200/60',
                        alerta: 'bg-amber-50 text-amber-700 border-amber-200/60',
                        oportunidad: 'bg-emerald-50 text-emerald-700 border-emerald-200/60',
                        mercado: 'bg-blue-50 text-blue-700 border-blue-200/60'
                      };

                      const sevBadges = {
                        critico: 'bg-red-600 text-white',
                        alerta: 'bg-amber-500 text-white',
                        oportunidad: 'bg-emerald-600 text-white',
                        mercado: 'bg-blue-600 text-white'
                      };

                      const containerColor = sevColors[hallazgo.severidad] || sevColors.mercado;
                      const badgeColor = sevBadges[hallazgo.severidad] || sevBadges.mercado;

                      return (
                        <div key={idx} className={`p-4 rounded-2xl border ${containerColor} space-y-2`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="material-symbols-outlined text-lg shrink-0">{hallazgo.icon}</span>
                              <h4 className="text-xs font-bold font-display uppercase tracking-wide">
                                {hallazgo.titulo}
                              </h4>
                            </div>
                            <span className={`text-[8px] font-mono font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full ${badgeColor}`}>
                              {hallazgo.tipo}
                            </span>
                          </div>

                          <p className="text-[11px] font-sans leading-relaxed text-on-surface opacity-90">
                            {hallazgo.detalle}
                          </p>

                          <div className="pt-2 border-t border-current/10 text-[11px] leading-relaxed">
                            <strong className="font-bold block uppercase font-mono text-[9px] tracking-wide mb-0.5">Sugerencia Estratégica:</strong>
                            <span className="font-sans text-on-surface">{hallazgo.recomendacion}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination Controls */}
      {totalPaginas > 1 && (
        <div className="flex items-center justify-between border-t border-outline-variant/50 pt-4 text-xs">
          <button
            onClick={() => setPaginaActual(prev => Math.max(1, prev - 1))}
            disabled={paginaActual === 1}
            className="px-4 py-2 border border-outline rounded-full font-bold hover:bg-surface-low disabled:opacity-40 disabled:hover:bg-transparent transition-all select-none text-on-surface"
          >
            Anterior
          </button>
          
          <span className="font-mono text-on-surface-variant font-medium">
            Página <strong className="font-bold text-on-surface">{paginaActual}</strong> de {totalPaginas}
          </span>

          <button
            onClick={() => setPaginaActual(prev => Math.min(totalPaginas, prev + 1))}
            disabled={paginaActual === totalPaginas}
            className="px-4 py-2 border border-outline rounded-full font-bold hover:bg-surface-low disabled:opacity-40 disabled:hover:bg-transparent transition-all select-none text-on-surface"
          >
            Siguiente
          </button>
        </div>
      )}
    </div>
  );
}
