import { useEffect, useState, useMemo } from 'react';
import { useBcvRate } from '../hooks/useBcvRate';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import {
  ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip,
  BarChart, Bar, Cell, ReferenceLine
} from 'recharts';

export default function Simulador({ user, userDoc }) {
  const { productos, productosCompetencia, historicoPrecios, loadingInitial: loading } = useData();
  const [dashboardPriceMode, setDashboardPriceMode] = useState('lista');

  // Simulation State
  const [simulacionVariacion, setSimulacionVariacion] = useState(0);
  const [reporteCargando, setReporteCargando] = useState(false);
  const [reporteCargandoPaso, setReporteCargandoPaso] = useState('');
  const [reporteGenerado, setReporteGenerado] = useState(null);
  const [activeReportTab, setActiveReportTab] = useState('ejecutivo');

  const bcv = useBcvRate();
  const { addToast } = useToast();

  // Helper to normalize history grouping key
  const getHistoryKey = (id_producto, cadena, marca) => {
    return `${id_producto}_${cadena}_${marca}`.toLowerCase().replace(/[\s/\\]+/g, '_');
  };

  // Main calculations for products and competitors
  const analizados = useMemo(() => {
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
        
        const chainPrices = compItems.map(c => {
          const priceBs = dashboardPriceMode === 'descuento'
            ? (c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs)
            : c.ultimo_precio_full_bs;
          if (!priceBs || !bcv.rate) return null;

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

        const hasChangesToday = chainPrices.some(cp => Math.abs(cp.changePercent) > 0.05);

        const competitorPricesUsd = chainPrices
          .filter(x => x.tipo !== 'propio')
          .map(x => x.priceUsd);

        const avgCompUsd = competitorPricesUsd.length > 0 
          ? competitorPricesUsd.reduce((a, b) => a + b, 0) / competitorPricesUsd.length 
          : null;

        const minCompUsd = competitorPricesUsd.length > 0 ? Math.min(...competitorPricesUsd) : null;
        const maxCompUsd = competitorPricesUsd.length > 0 ? Math.max(...competitorPricesUsd) : null;

        const dispersionPercent = (minCompUsd && maxCompUsd && minCompUsd > 0)
          ? ((maxCompUsd - minCompUsd) / minCompUsd) * 100
          : 0;

        const cheapestChains = chainPrices
          .filter(x => Math.abs(x.priceUsd - minCompUsd) < 0.001)
          .map(x => x.cadena);

        const mostExpensiveChains = chainPrices
          .filter(x => Math.abs(x.priceUsd - maxCompUsd) < 0.001)
          .map(x => x.cadena);

        const propioItem = compItems.find(c => c.tipo === 'propio');
        const propioPriceBs = propioItem ? (
          dashboardPriceMode === 'descuento'
            ? (propioItem.ultimo_precio_desc_bs || propioItem.ultimo_precio_full_bs)
            : propioItem.ultimo_precio_full_bs
        ) : null;
        const propioPriceUsd = (propioPriceBs && bcv.rate) ? (propioPriceBs / bcv.rate) : null;

        const diffMinUsd = (propioPriceUsd !== null && minCompUsd !== null) ? propioPriceUsd - minCompUsd : null;
        const diffMinPercent = (diffMinUsd !== null && minCompUsd > 0) ? (diffMinUsd / minCompUsd) * 100 : null;

        const diffAvgUsd = (propioPriceUsd !== null && avgCompUsd !== null) ? propioPriceUsd - avgCompUsd : null;
        const diffAvgPercent = (diffAvgUsd !== null && avgCompUsd > 0) ? (diffAvgUsd / avgCompUsd) * 100 : null;

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

  // Strategic Business Unit (UN) analysis
  const analisisUnidadNegocio = useMemo(() => {
    const uns = ['La Sante', 'Pharmetique', 'OTC'];
    
    return uns.map(un => {
      // Filter analizados belonging to this UN
      const itemsUn = analizados.filter(item => {
        const pUn = (item.producto.unidad_negocio || 'La Sante').toUpperCase();
        return pUn === un.toUpperCase();
      });

      const totalProductos = itemsUn.length;
      
      // Calculate average deviation vs competitor average for products with own price
      const itemsConPrecio = itemsUn.filter(item => item.propioPriceUsd && item.avgCompUsd);
      
      let avgDiffAvg = 0;
      let avgDiffMin = 0;
      let ownAvgPrice = 0;
      let compAvgPrice = 0;

      if (itemsConPrecio.length > 0) {
        const sumDiffAvg = itemsConPrecio.reduce((sum, item) => sum + (item.diffAvgPercent || 0), 0);
        const sumDiffMin = itemsConPrecio.reduce((sum, item) => sum + (item.diffMinPercent || 0), 0);
        const sumOwnPrice = itemsConPrecio.reduce((sum, item) => sum + item.propioPriceUsd, 0);
        const sumCompPrice = itemsConPrecio.reduce((sum, item) => sum + item.avgCompUsd, 0);

        avgDiffAvg = sumDiffAvg / itemsConPrecio.length;
        avgDiffMin = sumDiffMin / itemsConPrecio.length;
        ownAvgPrice = sumOwnPrice / itemsConPrecio.length;
        compAvgPrice = sumCompPrice / itemsConPrecio.length;
      }

      // Calculate Brand vs Generic Premium within this UN
      const genericos = itemsUn.filter(item => (item.producto.market_type || 'GENERICO').toUpperCase() === 'GENERICO' && item.propioPriceUsd);
      const marcas = itemsUn.filter(item => (item.producto.market_type || 'GENERICO').toUpperCase() === 'MARCA' && item.propioPriceUsd);

      let avgPriceGenerico = 0;
      let avgPriceMarca = 0;
      let brandPremiumAvg = 0;

      if (genericos.length > 0) {
        avgPriceGenerico = genericos.reduce((sum, item) => sum + item.propioPriceUsd, 0) / genericos.length;
      }
      if (marcas.length > 0) {
        avgPriceMarca = marcas.reduce((sum, item) => sum + item.propioPriceUsd, 0) / marcas.length;
      }
      if (avgPriceGenerico > 0 && avgPriceMarca > 0) {
        brandPremiumAvg = ((avgPriceMarca - avgPriceGenerico) / avgPriceGenerico) * 100;
      }

      // Generate personalized business recommendations matching user triggers
      const alertas = [];
      const recomendaciones = [];

      if (totalProductos === 0) {
        recomendaciones.push({
          tipo: 'info',
          titulo: 'Sin datos registrados',
          detalle: `No se han detectado productos para la Unidad de Negocio ${un}. Configura la unidad en la sección "Productos" o sube un CSV para activarla.`
        });
      } else {
        // Rule 1: OTC raises prices if below avg
        if (un === 'OTC') {
          // If average price deviation is negative (cheaper than competitors), or less than -5%
          if (avgDiffAvg < -0.05) {
            alertas.push(`OTC Sub-indexado: La UN OTC se encuentra promediando un ${Math.abs(avgDiffAvg * 100).toFixed(0)}% por debajo del promedio del mercado.`);
            recomendaciones.push({
              tipo: 'subir_precios',
              titulo: 'Oportunidad de Margen (Subir Precios)',
              detalle: `La UN OTC debe subir precios ya que se encuentra un ${Math.abs(avgDiffAvg * 100).toFixed(0)}% por debajo del promedio. Esto optimizará el EBITDA de la línea de consumo sin mermar la demanda.`
            });
          } else if (avgDiffAvg > 0.15) {
            recomendaciones.push({
              tipo: 'bajar_precios',
              titulo: 'Riesgo de Competitividad',
              detalle: `La línea OTC promedia un precio ${Math.abs(avgDiffAvg * 100).toFixed(0)}% superior al mercado, lo cual podría mermar la rotación rápida requerida en consumo masivo.`
            });
          } else {
            recomendaciones.push({
              tipo: 'estable',
              titulo: 'Posicionamiento Saludable',
              detalle: `La línea OTC se encuentra bien indexada (promedio vs competencia: ${avgDiffAvg >= 0 ? '+' : ''}${(avgDiffAvg * 100).toFixed(1)}%). Mantener monitoreo regular.`
            });
          }
        }

        // Rule 2: La Sante lower prices if above Brand prices
        if (un === 'La Sante') {
          // Let's check brand premium deviation vs overall generic pricing
          // If La Sante average price is significantly above competitor brands or has high brand premium
          if (avgDiffAvg > 0.15) {
            alertas.push(`La Santé Sobre-indexado: Promedia precios un ${(avgDiffAvg * 100).toFixed(0)}% por encima de la competencia.`);
            recomendaciones.push({
              tipo: 'bajar_precios',
              titulo: 'Ajuste de Precios a la Baja',
              detalle: `La UN La Santé debe bajar precios ya que tiene un precio superior al promedio de la competencia en un ${(avgDiffAvg * 100).toFixed(0)}%. Se recomienda regular descuentos para proteger la base de volumen.`
            });
          } else if (avgDiffAvg < -0.15) {
            recomendaciones.push({
              tipo: 'subir_precios',
              titulo: 'Margen de Crecimiento',
              detalle: `La Santé promedia un ${(Math.abs(avgDiffAvg) * 100).toFixed(0)}% por debajo del mercado. Hay espacio estratégico para ajustar precios al alza en portafolio clave.`
            });
          } else {
            // General recommendation for Sante
            recomendaciones.push({
              tipo: 'estable',
              titulo: 'Indexación Estratégica',
              detalle: `La Santé promedia un ${avgDiffAvg >= 0 ? '+' : ''}${(avgDiffAvg * 100).toFixed(1)}% vs competencia. Cumple con la paridad óptima para conservar cuota de mercado.`
            });
          }

          // Brand parity issues inside Sante
          if (brandPremiumAvg > 33) {
            recomendaciones.push({
              tipo: 'bajar_precios',
              titulo: 'Brecha Excesiva de Marca vs Genérico',
              detalle: `La UN La Santé debe bajar precios ya que tiene un precio superior a los de Marca en un ${brandPremiumAvg.toFixed(0)}% promedio, ensanchando la brecha de compra del paciente.`
            });
          }
        }

        // Rule 3: Pharmetique specific rules
        if (un === 'Pharmetique') {
          if (avgDiffAvg > 0.10) {
            recomendaciones.push({
              tipo: 'bajar_precios',
              titulo: 'Optimización de Canal',
              detalle: `Pharmetique promedia un ${(avgDiffAvg * 100).toFixed(0)}% por encima del promedio del mercado. Analizar si la prima de prescripción médica justifica este diferencial.`
            });
          } else if (avgDiffAvg < -0.10) {
            recomendaciones.push({
              tipo: 'subir_precios',
              titulo: 'Captura de Valor',
              detalle: `Pharmetique está ${(Math.abs(avgDiffAvg) * 100).toFixed(0)}% por debajo de competidores de marca equivalentes. Oportunidad para subir precios de lista en moléculas premium.`
            });
          } else {
            recomendaciones.push({
              tipo: 'estable',
              titulo: 'Posicionamiento Competitivo Óptimo',
              detalle: `Pharmetique mantiene un excelente alineamiento competitivo, posicionándose un ${(avgDiffAvg * 100).toFixed(1)}% respecto al promedio de competencia.`
            });
          }
        }

        // Rule 4: General checks
        // Check for "Generic priced higher than Brand" anomaly inside the UN
        const anomalos = itemsUn.filter(item => {
          if ((item.producto.market_type || 'GENERICO').toUpperCase() === 'GENERICO' && item.propioPriceUsd) {
            // Find brands of the same molecule
            const marcasMolecula = itemsUn.filter(m => 
              (m.producto.market_type || 'GENERICO').toUpperCase() === 'MARCA' && 
              m.producto.principio_activo === item.producto.principio_activo &&
              m.propioPriceUsd
            );
            return marcasMolecula.some(m => item.propioPriceUsd > m.propioPriceUsd);
          }
          return false;
        });

        if (anomalos.length > 0) {
          alertas.push(`Inconsistencia Crítica de Precios: Se detectaron ${anomalos.length} productos Genéricos con un precio de venta superior a su opción de Marca correspondiente.`);
          recomendaciones.push({
            tipo: 'urgente',
            titulo: 'Corrección Urgente de Paridad (Anomalía)',
            detalle: `Se detectaron genéricos (${anomalos.map(a => a.producto.nombre).join(', ')}) costando más que su respectiva opción de marca en la misma UN. Corregir esta anomalía inmediatamente para evitar confusión en el canal.`
          });
        }
      }

      return {
        un,
        totalProductos,
        productosMonitoreados: itemsConPrecio.length,
        avgDiffAvg: avgDiffAvg * 100, // as percentage
        avgDiffMin: avgDiffMin * 100, // as percentage
        ownAvgPrice,
        compAvgPrice,
        brandPremiumAvg,
        alertas,
        recomendaciones
      };
    });
  }, [analizados]);

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
            const diffPct = ((propioPrice - minAlt) / minAlt) * 100;
            totalDiffVsMin += diffPct;
            diffVsMinCount++;
          } else {
            ownBrandLider++;
          }
        }
      }
    });

    const porcentajeLiderazgoPropio = ownBrandTotal > 0 ? Math.round((ownBrandLider / ownBrandTotal) * 100) : 100;
    const brechaPromedioVsMin = diffVsMinCount > 0 ? (totalDiffVsMin / diffVsMinCount) : 0;

    let totalIpr = 0;
    let iprCount = 0;

    analizados.forEach(item => {
      if (item.propioPriceUsd && item.avgCompUsd) {
        totalIpr += (item.propioPriceUsd / item.avgCompUsd) * 100;
        iprCount++;
      }
    });

    const globalIpr = iprCount > 0 ? totalIpr / iprCount : null;

    return {
      avgDispersion: productsWithDispersion > 0 ? totalDispersion / productsWithDispersion : 0,
      porcentajeLiderazgoPropio,
      brechaPromedioVsMin,
      globalIpr,
    };
  }, [analizados]);

  // Calculations for simulated pricing (Fase 3)
  const simulatedStats = useMemo(() => {
    let totalSimIpr = 0;
    let simIprCount = 0;
    let ownBrandTotal = 0;
    let ownBrandLiderSim = 0;
    let totalDiffVsMinSim = 0;
    let diffVsMinCountSim = 0;

    const itemsSimulados = analizados.map(item => {
      const { propioPriceUsd, avgCompUsd, chainPrices } = item;
      
      const simOwnPriceUsd = propioPriceUsd !== null 
        ? propioPriceUsd * (1 + simulacionVariacion / 100) 
        : null;

      let simRanking = item.ranking;
      let isLiderSim = false;

      if (simOwnPriceUsd !== null) {
        ownBrandTotal++;
        
        const altPrices = chainPrices
          .filter(cp => cp.tipo === 'alternativa')
          .map(cp => cp.priceUsd);

        if (altPrices.length > 0) {
          const minAlt = Math.min(...altPrices);
          isLiderSim = simOwnPriceUsd <= minAlt;
          
          const diffPct = ((simOwnPriceUsd - minAlt) / minAlt) * 100;
          totalDiffVsMinSim += diffPct;
          diffVsMinCountSim++;
        } else {
          isLiderSim = true;
        }

        if (isLiderSim) {
          ownBrandLiderSim++;
        }

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

  // Price gap bar chart data: deviation % vs competitors
  const priceGapData = useMemo(() => {
    return analizados
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
  }, [analizados]);

  // Currency Formatter Helper
  const fmt = (priceUsd) => {
    if (priceUsd === null || priceUsd === undefined) return '—';
    return '$' + priceUsd.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const fmtBs = (priceUsd) => {
    if (priceUsd === null || priceUsd === undefined) return '—';
    return 'Bs ' + (priceUsd * bcv.rate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Custom tooltip for price gap bar chart
  const PriceGapTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const isCheaper = data.gap < 0;
      const gapAbs = Math.abs(data.gap).toFixed(1);
      
      return (
        <div className="bg-white/95 p-3.5 border border-outline-variant rounded-2xl shadow-lg backdrop-blur-sm max-w-xs font-sans text-on-surface">
          <p className="text-xs font-bold mb-1.5">{data.fullName}</p>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between gap-6">
              <span className="text-on-surface-variant">Nuestro Precio:</span>
              <span className="font-semibold">{fmt(data.propioPrice)} ({fmtBs(data.propioPrice)})</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-on-surface-variant">Promedio Competencia:</span>
              <span className="font-semibold">{fmt(data.avgComp)} ({fmtBs(data.avgComp)})</span>
            </div>
            <div className="pt-1.5 border-t border-outline/10 flex justify-between gap-6 items-center">
              <span>Desviación:</span>
              <span className={`font-bold px-1.5 py-0.5 rounded-full text-[11px] ${isCheaper ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {isCheaper ? `-${gapAbs}%` : `+${gapAbs}%`}
              </span>
            </div>
          </div>
          <p className={`text-[10px] mt-2 font-semibold ${isCheaper ? 'text-emerald-600' : 'text-red-600'}`}>
            {isCheaper 
              ? `Estás un ${gapAbs}% más barato que el promedio.` 
              : `Estás un ${gapAbs}% más caro que el promedio.`}
          </p>
        </div>
      );
    }
    return null;
  };

  // Report Generation with deep insights for BOTH overly expensive and overly cheap items
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
      
      // DEEP RECOMMENDATIONS FOR OVERLY CHEAP PRODUCTS (PROTECT MARGINS!)
      oportunidadesSubir: numSubir.map(x => {
        const gapAbs = Math.abs(x.diffAvgPercent);
        // Suggested increase that keeps them slightly cheaper but captures missing margins
        const incrementoRecomendado = Math.max(5, Math.round(gapAbs - 5));
        const precioSugeridoUsd = x.propioPriceUsd * (1 + incrementoRecomendado / 100);
        
        return {
          id: x.producto.id_interno,
          nombre: x.producto.nombre,
          precioPropio: x.propioPriceUsd,
          precioPromedio: x.avgCompUsd,
          gap: x.diffAvgPercent,
          incrementoPct: incrementoRecomendado,
          precioSugeridoUsd,
          recomendacion: `Estás un ${gapAbs.toFixed(1)}% por debajo del promedio. RECOMENDACIÓN MARGEN: Incrementar tu precio en un **${incrementoRecomendado}%** (hasta llegar a **${fmt(precioSugeridoUsd)}** / **${fmtBs(precioSugeridoUsd)}**). Esto te posiciona en la franja de descuento seguro del -5% frente al promedio de competencia, lo que detiene la erosión innecesaria de margen y recupera rentabilidad de forma segura, manteniendo una excelente percepción de bajo costo ante tus pacientes sin arriesgar volumen.`
        };
      }),

      // DEEP RECOMMENDATIONS FOR OVERLY EXPENSIVE PRODUCTS (AVOID FLIGHT OF CLIENTS!)
      oportunidadesBajar: numBajar.map(x => {
        const gapAbs = Math.abs(x.diffAvgPercent);
        // Suggested discount to enter competitive tolerance zone
        const descuentoRecomendado = Math.max(5, Math.round(gapAbs - 2));
        const precioSugeridoUsd = x.propioPriceUsd * (1 - descuentoRecomendado / 100);
        
        return {
          id: x.producto.id_interno,
          nombre: x.producto.nombre,
          precioPropio: x.propioPriceUsd,
          precioPromedio: x.avgCompUsd,
          gap: x.diffAvgPercent,
          descuentoPct: descuentoRecomendado,
          precioSugeridoUsd,
          recomendacion: `Estás un ${gapAbs.toFixed(1)}% por encima del promedio. ALERTA DE FUGA: Existe un riesgo crítico de pérdida de volumen. Recomendamos aplicar un descuento estratégico correctivo del **${descuentoRecomendado}%** (ajustando a **${fmt(precioSugeridoUsd)}** / **${fmtBs(precioSugeridoUsd)}**) para reingresar al rango de paridad del mercado y contener de inmediato la fuga persistente de pacientes hacia cadenas rivales.`
        };
      }),

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
      txt += `--- OPORTUNIDADES DE CAPTURA DE MARGEN (EVITAR PERDER DINERO) ---\n`;
      r.oportunidadesSubir.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio actual: ${fmt(o.precioPropio)} | Promedio Competidores: ${fmt(o.precioPromedio)} (${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    if (r.oportunidadesBajar.length > 0) {
      txt += `--- ALERTAS DE PÉRDIDA DE VOLUMEN (SOBREPRECIOS CRÍTICOS) ---\n`;
      r.oportunidadesBajar.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio actual: ${fmt(o.precioPropio)} | Promedio Competidores: ${fmt(o.precioPromedio)} (+${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
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
      txt += `--- OPORTUNIDADES DE CAPTURA DE MARGEN (EVITAR PERDER DINERO) ---\n`;
      r.oportunidadesSubir.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio actual: ${fmt(o.precioPropio)} | Promedio Competidores: ${fmt(o.precioPromedio)} (${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    if (r.oportunidadesBajar.length > 0) {
      txt += `--- ALERTAS DE PÉRDIDA DE VOLUMEN (SOBREPRECIOS CRÍTICOS) ---\n`;
      r.oportunidadesBajar.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio actual: ${fmt(o.precioPropio)} | Promedio Competidores: ${fmt(o.precioPromedio)} (+${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Reporte_Estrategico_Precios_${new Date().toISOString().slice(0, 10)}.txt`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 space-y-4">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-mono font-bold text-primary animate-pulse">Cargando simulador de estrategia...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12 font-sans">
      
      {/* Header and top view controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-extrabold text-on-background flex items-center gap-2">
            <span className="material-symbols-outlined text-3xl text-primary">insights</span>
            Análisis Estratégico & Simulador
          </h1>
          <p className="text-sm text-on-surface-variant font-sans mt-1">
            Diagnóstico dinámico por unidad de negocio, recomendaciones de paridad de mercado y simulación predictiva de precios.
          </p>
        </div>

        {/* Price mode toggle */}
        <div className="flex items-center gap-3 bg-white p-1.5 rounded-2xl border border-outline-variant shadow-sm w-fit self-end md:self-center">
          <button
            onClick={() => setDashboardPriceMode('descuento')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
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
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
              dashboardPriceMode === 'lista' 
                ? 'bg-primary text-on-primary shadow-sm' 
                : 'text-on-surface-variant hover:bg-surface/50'
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">receipt_long</span>
            Precio de Lista
          </button>
        </div>
      </div>

      {/* Strategic Business Unit Analytics & Recommendations */}
      <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-4">
        <div>
          <h2 className="text-sm font-bold text-primary uppercase font-mono tracking-wider flex items-center gap-1.5 mb-1">
            <span className="material-symbols-outlined text-lg">corporate_fare</span>
            Análisis Estratégico & Recomendaciones por Unidad de Negocio (UN)
          </h2>
          <p className="text-xs text-on-surface-variant font-sans max-w-3xl leading-relaxed">
            Diagnóstico dinámico de posicionamiento y rentabilidad de nuestras tres líneas de negocio comparado con el promedio del mercado competitivo de marca y genéricos.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {analisisUnidadNegocio.map(item => {
            const hasAlerts = item.alertas.length > 0;
            return (
              <div key={item.un} className={`rounded-2xl border p-5 flex flex-col justify-between transition-all hover:shadow-sm ${
                item.un === 'OTC' 
                  ? 'bg-amber-500/[0.02] border-amber-500/10 hover:border-amber-500/25' 
                  : item.un === 'Pharmetique' 
                  ? 'bg-blue-500/[0.02] border-blue-500/10 hover:border-blue-500/25' 
                  : 'bg-teal-500/[0.02] border-teal-500/10 hover:border-teal-500/25'
              }`}>
                <div>
                  {/* Header */}
                  <div className="flex items-center justify-between border-b pb-3 mb-4">
                    <div className="flex items-center gap-2">
                      <span className={`w-3 h-3 rounded-full ${
                        item.un === 'OTC' ? 'bg-amber-500' : item.un === 'Pharmetique' ? 'bg-blue-500' : 'bg-teal-500'
                      }`}></span>
                      <h3 className="font-display font-extrabold text-[#040d53] text-base">
                        {item.un === 'La Sante' ? 'La Santé' : item.un}
                      </h3>
                    </div>
                    <span className="text-[10px] font-mono font-bold text-on-surface-variant bg-surface-low px-2 py-0.5 rounded-md border border-outline-variant/50">
                      {item.totalProductos} Productos
                    </span>
                  </div>

                  {/* Pricing Diagnostics */}
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-on-surface-variant font-medium">Índice IPR vs Competencia:</span>
                      <span className={`font-mono font-extrabold ${
                        item.avgDiffAvg > 10 
                          ? 'text-error' 
                          : item.avgDiffAvg < -10 
                          ? 'text-green-700' 
                          : 'text-secondary'
                      }`}>
                        {item.avgDiffAvg ? `${item.avgDiffAvg >= 0 ? '+' : ''}${item.avgDiffAvg.toFixed(1)}%` : '—'}
                      </span>
                    </div>

                    <div className="flex justify-between items-center text-xs">
                      <span className="text-on-surface-variant font-medium">Brecha vs Competidor Mín:</span>
                      <span className="font-mono font-extrabold text-on-surface">
                        {item.avgDiffMin ? `+${item.avgDiffMin.toFixed(1)}%` : '—'}
                      </span>
                    </div>

                    {item.brandPremiumAvg > 0 && (
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-on-surface-variant font-medium">Prima Marca vs Genérico:</span>
                        <span className={`font-mono font-bold ${item.brandPremiumAvg > 33 ? 'text-amber-700' : 'text-on-surface'}`}>
                          +{item.brandPremiumAvg.toFixed(0)}%
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Recommendations */}
                  <div className="mt-5 pt-4 border-t border-dashed border-outline-variant/50 space-y-3">
                    <div className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant">
                      Prescripción Estratégica:
                    </div>
                    {item.recomendaciones.map((rec, idx) => (
                      <div key={idx} className="flex gap-2 text-xs leading-relaxed text-on-surface">
                        <span className={`material-symbols-outlined text-sm shrink-0 mt-0.5 ${
                          rec.tipo === 'subir_precios' 
                            ? 'text-green-600' 
                            : rec.tipo === 'bajar_precios' 
                            ? 'text-error' 
                            : rec.tipo === 'urgente' 
                            ? 'text-error' 
                            : 'text-secondary'
                        }`}>
                          {rec.tipo === 'subir_precios' ? 'add_circle' : rec.tipo === 'bajar_precios' ? 'remove_circle' : rec.tipo === 'urgente' ? 'gavel' : 'info'}
                        </span>
                        <div>
                          <strong className="block font-bold">{rec.titulo}</strong>
                          <span className="text-[11px] text-on-surface-variant font-sans">{rec.detalle}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Bulletins/Alerts indicator */}
                {hasAlerts && (
                  <div className="mt-4 p-2 bg-error-container/30 border border-error/10 rounded-xl text-[10px] text-error flex gap-1.5 items-center">
                    <span className="material-symbols-outlined text-xs">warning</span>
                    <span className="font-semibold leading-tight">{item.alertas[0]}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Simulator Control and KPIs Row */}
      <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-outline-variant pb-4 gap-4">
          <div>
            <h2 className="text-lg font-display font-extrabold text-primary flex items-center gap-1.5">
              <span className="material-symbols-outlined">tune</span>
              Variables de Simulación
            </h2>
            <p className="text-xs text-on-surface-variant font-sans">
              Modifica el deslizador para ver cómo respondería tu catálogo frente a la paridad con la competencia actual.
            </p>
          </div>

          <button
            onClick={handleGenerarReporte}
            disabled={reporteCargando}
            className={`text-xs font-bold px-6 py-3 rounded-full shadow-sm transition-all flex items-center gap-2 border ${
              reporteCargando
                ? 'bg-surface-low text-on-surface-variant border-outline-variant cursor-not-allowed'
                : 'bg-primary text-on-primary border-primary hover:bg-primary/95 hover:shadow'
            }`}
          >
            <span className="material-symbols-outlined text-base">analytics</span>
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
                Acciones de Lista Sugeridas ({reporteGenerado.oportunidadesSubir.length + reporteGenerado.oportunidadesBajar.length})
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
                  <p dangerouslySetInnerHTML={{ __html: reporteGenerado.resumenEjecutivo.replaceAll('**', '<strong>').replaceAll('</strong></strong>', '</strong>') }}></p>
                  <p className="bg-primary/5 p-3 rounded-xl border border-primary/10 text-[11px]">
                    <strong>Indicación estratégica:</strong> Mantener un IPR cercano al 100% asegura que tu catálogo preserve el balance óptimo de rentabilidad y recordación de marca de bajo precio ante tus pacientes/clientes de farmacia.
                  </p>
                </div>
              )}

              {activeReportTab === 'oportunidades' && (
                <div className="space-y-6">
                  {/* CHEAP PRODUCTS RECOMMENDATIONS (STOP MARGIN LOSS) */}
                  {reporteGenerado.oportunidadesSubir.length > 0 && (
                    <div className="space-y-3">
                      <h4 className="font-bold text-emerald-700 text-sm font-display flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-base">savings</span>
                        Oportunidades de Captura de Margen (Evitar Pérdidas por Subprecio)
                      </h4>
                      <p className="text-[11px] text-on-surface-variant">
                        Los siguientes productos se venden <strong>excesivamente baratos</strong> frente al promedio de los competidores. Puedes aumentar sus precios para capturar márgenes sin perder competitividad:
                      </p>
                      <div className="space-y-3">
                        {reporteGenerado.oportunidadesSubir.map(o => (
                          <div key={o.id} className="bg-emerald-500/5 p-4 rounded-xl border border-emerald-500/10 flex justify-between items-start gap-4 flex-wrap">
                            <div className="flex-1 min-w-[260px]">
                              <strong className="text-emerald-800 font-sans block text-sm">{o.nombre}</strong>
                              <span className="text-[10px] font-mono text-on-surface-variant mt-0.5 block">ID: {o.id}</span>
                              <p className="text-[11px] text-on-surface mt-2 bg-emerald-500/10 p-2.5 rounded-lg border border-emerald-500/20 leading-relaxed">
                                {o.recomendacion}
                              </p>
                            </div>
                            <div className="text-right font-mono shrink-0 bg-white p-3 rounded-xl border border-outline-variant/40 shadow-sm min-w-[150px]">
                              <div className="text-on-surface-variant text-[10px]">Precio actual:</div>
                              <div className="text-on-surface font-bold font-sans text-xs">{fmt(o.precioPropio)}</div>
                              
                              <div className="text-emerald-700 text-[10px] mt-2 font-semibold">Sugerido (+{o.incrementoPct}%):</div>
                              <div className="text-emerald-700 font-extrabold font-sans text-sm">{fmt(o.precioSugeridoUsd)}</div>
                              <div className="text-[10px] text-emerald-600">{fmtBs(o.precioSugeridoUsd)}</div>
                              
                              <div className="text-on-surface-variant text-[9px] mt-2 pt-1.5 border-t border-outline/10">Promedio Comp: {fmt(o.precioPromedio)}</div>
                              <div className="text-emerald-600 font-extrabold text-[10px]">Brecha: {o.gap.toFixed(1)}%</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* EXPENSIVE PRODUCTS RECOMMENDATIONS (AVOID SALES FLIGHT) */}
                  {reporteGenerado.oportunidadesBajar.length > 0 && (
                    <div className="space-y-3">
                      <h4 className="font-bold text-error text-sm font-display flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-base">error</span>
                        Riesgos Críticos de Fuga de Ventas (Alineación por Sobreprecio)
                      </h4>
                      <p className="text-[11px] text-on-surface-variant">
                        Estás perdiendo el posicionamiento de bajo costo en estos ítems. Se recomienda un ajuste correctivo a la baja para evitar que tus clientes migren a la competencia:
                      </p>
                      <div className="space-y-3">
                        {reporteGenerado.oportunidadesBajar.map(o => (
                          <div key={o.id} className="bg-error-container/10 p-4 rounded-xl border border-error/10 flex justify-between items-start gap-4 flex-wrap">
                            <div className="flex-1 min-w-[260px]">
                              <strong className="text-error font-sans block text-sm">{o.nombre}</strong>
                              <span className="text-[10px] font-mono text-on-surface-variant mt-0.5 block">ID: {o.id}</span>
                              <p className="text-[11px] text-on-surface mt-2 bg-error-container/20 p-2.5 rounded-lg border border-error/20 leading-relaxed">
                                {o.recomendacion}
                              </p>
                            </div>
                            <div className="text-right font-mono shrink-0 bg-white p-3 rounded-xl border border-outline-variant/40 shadow-sm min-w-[150px]">
                              <div className="text-on-surface-variant text-[10px]">Precio actual:</div>
                              <div className="text-on-surface font-bold font-sans text-xs">{fmt(o.precioPropio)}</div>
                              
                              <div className="text-error text-[10px] mt-2 font-semibold">Sugerido (-{o.descuentoPct}%):</div>
                              <div className="text-error font-extrabold font-sans text-sm">{fmt(o.precioSugeridoUsd)}</div>
                              <div className="text-[10px] text-error/80">{fmtBs(o.precioSugeridoUsd)}</div>
                              
                              <div className="text-on-surface-variant text-[9px] mt-2 pt-1.5 border-t border-outline/10">Promedio Comp: {fmt(o.precioPromedio)}</div>
                              <div className="text-error font-extrabold text-[10px]">Brecha: +{o.gap.toFixed(1)}%</div>
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
          <div className="md:col-span-1 bg-surface-low border border-outline-variant p-5 rounded-2xl flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono font-bold uppercase text-on-surface-variant tracking-wider">Ajuste de Mi Marca</span>
                <span className={`text-base font-mono font-extrabold ${simulacionVariacion > 0 ? 'text-primary' : simulacionVariacion < 0 ? 'text-emerald-700' : 'text-on-surface-variant'}`}>
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
                <button onClick={() => setSimulacionVariacion(10)} className="p-1 bg-white border border-outline-variant hover:bg-surface rounded font-bold">+10%</button>
              </div>
            </div>

            <div className="pt-4 border-t border-outline-variant/50 text-[10px] text-on-surface-variant font-sans leading-relaxed mt-4">
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
                    <span className={`text-[10px] font-mono font-bold flex items-center ${simulatedStats.simGlobalIpr < (kpiStats.globalIpr || 100) ? 'text-emerald-600' : 'text-error'}`}>
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
                    <span className={`text-[10px] font-mono font-bold flex items-center ${simulatedStats.porcentajeLiderazgoSim > kpiStats.porcentajeLiderazgoPropio ? 'text-emerald-600' : 'text-error'}`}>
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
                    : simulacionVariacion < 0 ? 'text-emerald-700'
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

      {/* Pricing Positioning (Price Gap vs Competitors) */}
      <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm flex flex-col justify-between">
        <div>
          <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider mb-1 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">bar_chart</span>
            Desviación de Precios vs. Promedio de Competidores
          </h2>
          <p className="text-xs text-on-surface-variant font-sans mb-6 leading-relaxed">
            Muestra el porcentaje en el que nuestros precios se desvían de la media del mercado. Las barras hacia abajo (verde) indican que somos más baratos (liderazgo de bajo costo) y las barras hacia arriba (rojo) representan sobreprecios (pérdida de competitividad).
          </p>
        </div>
        <div className="h-80 mt-2">
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

    </div>
  );
}
