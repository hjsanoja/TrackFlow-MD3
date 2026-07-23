import { useEffect, useState, useMemo, useRef } from 'react';
import { doc, setDoc, deleteDoc, getDoc, writeBatch, onSnapshot } from 'firebase/firestore';
import { useSearchParams } from 'react-router-dom';
import { db } from '../firebase';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { exportToCSV } from '../utils/exportUtils';

const TIPOS = [
  { value: 'propio', label: 'Mi marca' },
  { value: 'alternativa', label: 'Alternativa (competencia)' },
];

export default function Competencia() {
  const {
    productosCompetencia: items,
    productos,
    cadenas,
    loadingInitial: loading,
    refreshData: cargar
  } = useData();

  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [filtroCadena, setFiltroCadena] = useState('todas');
  const [filtroProducto, setFiltroProducto] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [scrapingItems, setScrapingItems] = useState({});
  const [manualPriceItem, setManualPriceItem] = useState(null);

  const { addToast } = useToast();

  const fileInputRef = useRef(null);

  // Si llegamos con ?producto=P001, aplicamos ese filtro al cargar
  useEffect(() => {
    const productoParam = searchParams.get('producto');
    if (productoParam) {
      setFiltroProducto(productoParam);
    }
  }, [searchParams]);

  const filtrados = useMemo(() => {
    const term = search.toLowerCase().trim();
    return items.filter(it => {
      if (filtroCadena !== 'todas' && it.cadena !== filtroCadena) return false;
      if (filtroProducto !== 'todos' && it.id_producto_propio !== filtroProducto) return false;
      if (filtroTipo !== 'todos' && it.tipo !== filtroTipo) return false;
      if (!term) return true;
      return (
        (it.marca || '').toLowerCase().includes(term) ||
        (it.url || '').toLowerCase().includes(term)
      );
    });
  }, [items, search, filtroCadena, filtroProducto, filtroTipo]);

  const ordenados = useMemo(() => {
    return [...filtrados].sort((a, b) => {
      return (a.id_producto_propio || '').localeCompare(b.id_producto_propio || '') ||
        (a.cadena || '').localeCompare(b.cadena || '') ||
        (a.marca || '').localeCompare(b.marca || '');
    });
  }, [filtrados]);

  const [paginaActual, setPaginaActual] = useState(1);
  const itemsPorPagina = 20;

  useEffect(() => {
    setPaginaActual(1);
  }, [search, filtroCadena, filtroProducto, filtroTipo]);

  const totalPaginas = Math.max(1, Math.ceil(ordenados.length / itemsPorPagina));
  const itemsPaginados = useMemo(() => {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    return ordenados.slice(inicio, inicio + itemsPorPagina);
  }, [ordenados, paginaActual]);

  // Si estamos viendo solo un producto y no tiene URLs, mostramos hint
  const productoFiltradoSinUrls = useMemo(() => {
    if (filtroProducto === 'todos') return null;
    if (ordenados.length > 0) return null;
    return productos.find(p => p.id_interno === filtroProducto) || null;
  }, [filtroProducto, ordenados, productos]);

  const handleSave = async (data, isNew) => {
    try {
      const labPart = data.laboratorio?.trim() ? `_${data.laboratorio.trim()}` : '';
      const docId = isNew
        ? `${data.id_producto_propio}_${data.cadena}_${data.marca}${labPart}`.replace(/[\s/\\]+/g, '_')
        : editing.id;
      
      if (isNew && items.some(it => it.id === docId)) {
        throw new Error('Ya existe esta combinación de producto + cadena + marca + laboratorio');
      }
      const cadenaObj = cadenas.find(c => c.nombre === data.cadena);
      if (cadenaObj && cadenaObj.website && data.url) {
        try {
          const urlHost = new URL(data.url).hostname.replace(/^www\./, '');
          const cadenaHost = new URL(cadenaObj.website).hostname.replace(/^www\./, '');
          if (!urlHost.endsWith(cadenaHost) && !cadenaHost.endsWith(urlHost)) {
            console.warn(`La URL parece ser de "${urlHost}" pero la cadena "${data.cadena}" usa "${cadenaHost}".`);
          }
        } catch {
          throw new Error('La URL no es válida');
        }
      }
      await setDoc(doc(db, 'productos_competencia', docId), {
        id_producto_propio: data.id_producto_propio,
        cadena: data.cadena,
        tipo: data.tipo,
        marca: data.marca.trim(),
        url: data.url.trim(),
        activo: data.activo,
        laboratorio: data.laboratorio?.trim() || '',
        concentracion: data.concentracion?.trim() || '',
        tamano: data.tamano?.trim() || '',
      }, { merge: !isNew });
      addToast(isNew ? 'URL de competencia creada con éxito' : 'Cambios guardados con éxito', 'success');
      setEditing(null);
      await cargar();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleDelete = (item) => {
    setConfirmDelete(item);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const item = confirmDelete;
    setConfirmDelete(null);
    try {
      await deleteDoc(doc(db, 'productos_competencia', item.id));
      addToast('Enlace eliminado del scraper', 'success');
      await cargar();
    } catch (err) {
      addToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  const handleToggleActivo = async (item) => {
    try {
      await setDoc(doc(db, 'productos_competencia', item.id), {
        activo: !item.activo,
      }, { merge: true });
      await cargar();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleScrapeIndividual = async (item) => {
    setScrapingItems(prev => ({ ...prev, [item.id]: 'disparando' }));
    try {
      const secretSnap = await getDoc(doc(db, 'secrets', 'github_dispatch'));
      if (!secretSnap.exists()) {
        throw new Error('Falta configurar las credenciales de GitHub en Firestore (secrets/github_dispatch).');
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
          body: JSON.stringify({
            event_type: workflow_event_type || 'run-scraper',
            client_payload: {
              product_id: item.id_producto_propio,
              doc_id: item.id
            }
          }),
        }
      );
      if (res.status === 204) {
        setScrapingItems(prev => ({ ...prev, [item.id]: 'esperando' }));
        addToast(`El robot se ha lanzado para extraer "${item.marca}" de forma individual en tiempo real. La tabla se actualizará automáticamente en unos instantes.`, 'success');

        // Suscribirse en tiempo real al documento para detectar cuando cambie
        const unsubscribe = onSnapshot(doc(db, 'productos_competencia', item.id), (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            // Si tiene fecha de scrape nueva o el estado ya no es "esperando", refrescamos
            setScrapingItems(prev => {
              if (prev[item.id] === 'esperando') {
                const copy = { ...prev };
                delete copy[item.id];
                // Recargar de nuevo los items
                cargar();
                return copy;
              }
              return prev;
            });
            unsubscribe();
          }
        });

        // Timeout de seguridad de 3 minutos
        setTimeout(() => {
          setScrapingItems(prev => {
            const copy = { ...prev };
            delete copy[item.id];
            return copy;
          });
        }, 180000);

      } else {
        const txt = await res.text();
        throw new Error(`GitHub respondió ${res.status}: ${txt}`);
      }
    } catch (err) {
      setScrapingItems(prev => {
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      addToast('Error al lanzar robot: ' + err.message, 'error');
    }
  };

  // Cálculos para KPIs de Competencia
  const kpis = useMemo(() => {
    const activos = items.filter(it => it.activo);
    const exitosos = activos.filter(it => it.estado === 'ok');
    const conError = activos.filter(it => it.estado === 'error');
    
    // 1. Tasa de Salud Técnica
    const tasaSalud = activos.length > 0 ? Math.round((exitosos.length / activos.length) * 100) : 100;
    
    // 2. Enlaces Desactualizados (> 24 horas)
    const desactualizados = activos.filter(it => {
      if (!it.ultimo_scrape) return true;
      const scrapeTime = it.ultimo_scrape.toDate?.()?.getTime() || new Date(it.ultimo_scrape).getTime();
      const diffHrs = (Date.now() - scrapeTime) / (1000 * 60 * 60);
      return diffHrs > 24;
    }).length;

    // 3. Comparativa de precios vs competencia
    const prodGrupos = {};
    activos.forEach(it => {
      const pId = it.id_producto_propio;
      if (!prodGrupos[pId]) prodGrupos[pId] = [];
      prodGrupos[pId].push(it);
    });

    let propiosMasBaratos = 0;
    let totalComparables = 0;

    Object.keys(prodGrupos).forEach(pId => {
      const g = prodGrupos[pId];
      const propio = g.find(it => it.tipo === 'propio');
      const alternativas = g.filter(it => it.tipo === 'alternativa');
      
      if (propio && alternativas.length > 0) {
        const precioPropio = propio.ultimo_precio_desc_bs || propio.ultimo_precio_full_bs;
        if (precioPropio) {
          totalComparables++;
          const preciosAlt = alternativas
            .map(a => a.ultimo_precio_desc_bs || a.ultimo_precio_full_bs)
            .filter(Boolean);
          
          if (preciosAlt.length > 0) {
            const minAlt = Math.min(...preciosAlt);
            if (precioPropio < minAlt) {
              propiosMasBaratos++;
            }
          }
        }
      }
    });

    return {
      totalEnlaces: items.length,
      activosCount: activos.length,
      exitososCount: exitosos.length,
      erroresCount: conError.length,
      tasaSalud,
      desactualizados,
      propiosMasBaratos,
      totalComparables
    };
  }, [items]);

  const limpiarFiltros = () => {
    setSearch('');
    setFiltroCadena('todas');
    setFiltroProducto('todos');
    setFiltroTipo('todos');
    setSearchParams({});
  };

  const productoNombre = (id) => productos.find(p => p.id_interno === id)?.nombre || id;
  const formatPrice = (priceBs) => {
    if (priceBs == null) return '—';
    return 'Bs ' + priceBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // CSV Parsing for Bulk Competitor upload
  const handleCsvUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = evt.target.result;
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error('El archivo CSV está vacío.');

        const batch = writeBatch(db);
        let count = 0;

        for (const row of rows) {
          const id_producto = (row.id_producto_propio || row.ID_Producto || row.id_producto || '').trim();
          const cadena = (row.cadena || row.Cadena || '').trim();
          const marca = (row.marca || row.Marca || '').trim();
          const url = (row.url || row.URL || '').trim();
          const tipo = (row.tipo || row.Tipo || 'alternativa').trim().toLowerCase();
          const laboratorio = (row.laboratorio || row.Laboratorio || '').trim();
          const concentracion = (row.concentracion || row.Concentracion || '').trim();
          const tamano = (row.tamano || row.Tamano || '').trim();

          if (!id_producto || !cadena || !marca || !url) continue;

          const labPart = laboratorio ? `_${laboratorio}` : '';
          const docId = `${id_producto}_${cadena}_${marca}${labPart}`.replace(/[\s/\\]+/g, '_');
          const compRef = doc(db, 'productos_competencia', docId);

          batch.set(compRef, {
            id_producto_propio: id_producto,
            cadena,
            tipo: tipo === 'propio' ? 'propio' : 'alternativa',
            marca,
            url,
            activo: row.activo ? (row.activo.toLowerCase() === 'true' || row.activo === '1') : true,
            laboratorio,
            concentracion,
            tamano,
          }, { merge: true });

          count++;
        }

        if (count > 0) {
          await batch.commit();
          addToast(`Carga masiva exitosa: ${count} URLs de competencia importadas.`, 'success');
          await cargar();
        } else {
          throw new Error('No se encontraron filas con campos obligatorios (id_producto_propio, cadena, marca, url).');
        }
      } catch (err) {
        addToast('Error procesando CSV: ' + err.message, 'error');
      }
      setShowCsvModal(false);
    };
    reader.readAsText(file);
  };

  const parseCSV = (text) => {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0) return [];
    
    // Detect delimiter
    const firstLine = lines[0];
    let delimiter = ',';
    if (firstLine.includes('\t')) {
      delimiter = '\t';
    } else if (firstLine.includes(';') && !firstLine.includes(',')) {
      delimiter = ';';
    } else if (firstLine.includes(';')) {
      const commaCount = (firstLine.match(/,/g) || []).length;
      const semiCount = (firstLine.match(/;/g) || []).length;
      if (semiCount > commaCount) {
        delimiter = ';';
      }
    }
    
    const splitLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === delimiter && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result.map(v => v.replace(/^"|"$/g, ''));
    };

    const headers = splitLine(lines[0]);
    const result = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const values = splitLine(line);
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });
      result.push(row);
    }
    return result;
  };

  const downloadExampleCsv = () => {
    const headers = 'id_producto_propio,cadena,tipo,marca,url,activo,laboratorio,concentracion,tamano\n';
    const row1 = 'P001,Farmatodo,alternativa,Acetaminofén,https://www.farmatodo.com.ve/producto/atamel-500mg,true,Genven,500mg,10tab\n';
    const row2 = 'P001,Locatel,alternativa,Acetaminofén,https://www.locatel.com.ve/calox-500mg,true,Calox,500mg,10tab\n';
    const blob = new Blob([headers + row1 + row2], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'plantilla_competencia.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportarEnlaces = () => {
    const headers = [
      { label: 'Producto Propio', key: 'producto_propio' },
      { label: 'Cadena/Competidor', key: 'cadena' },
      { label: 'Marca/Línea', key: 'marca' },
      { label: 'Tipo', key: 'tipo_str' },
      { label: 'Precio Full (Bs)', key: 'ultimo_precio_full_bs' },
      { label: 'Precio Desc (Bs)', key: 'ultimo_precio_desc_bs' },
      { label: 'Estado del Link', key: 'estado_str' },
      { label: 'URL Monitoreada', key: 'url' }
    ];

    const dataRows = ordenados.map(it => ({
      ...it,
      producto_propio: productoNombre(it.id_producto_propio),
      tipo_str: it.tipo === 'propio' ? 'MI MARCA' : 'COMPETENCIA',
      ultimo_precio_full_bs: it.ultimo_precio_full_bs || '—',
      ultimo_precio_desc_bs: it.ultimo_precio_desc_bs || '—',
      estado_str: it.ultimo_exito ? 'OK / ACTIVO' : 'FALLO LECTURA',
      url: it.url || ''
    }));

    exportToCSV('Enlaces_Competencia_Monitoreados', headers, dataRows);
    addToast(`Exportados ${dataRows.length} enlaces a CSV.`, 'success');
  };

  return (
    <div className="space-y-6 text-on-surface">
      {/* Title Header Block */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-outline-variant pb-4 gap-4">
        <div>
          <h1 className="text-3xl font-display font-extrabold text-primary tracking-tight">Enlaces de Competencia</h1>
          <p className="text-sm text-on-surface-variant font-sans mt-1">
            Vincula productos locales con URLs externas para el monitoreo automático de precios.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleExportarEnlaces}
            className="text-xs px-4 py-2.5 bg-white border border-outline-variant hover:bg-surface-low font-bold text-primary rounded-full transition-all flex items-center gap-1.5 shadow-sm"
            title="Exportar enlaces filtrados a archivo CSV">
            <span className="material-symbols-outlined text-base">download</span>
            <span>Exportar CSV</span>
          </button>
          <button onClick={() => setShowCsvModal(true)}
            className="text-xs px-4 py-2.5 bg-white border border-outline-variant hover:bg-surface-low font-bold text-primary rounded-full transition-all flex items-center gap-1.5 shadow-sm">
            <span className="material-symbols-outlined text-base">upload_file</span>
            <span>Importar CSV</span>
          </button>
          <button onClick={() => setEditing('new')}
            className="text-xs px-5 py-2.5 bg-secondary hover:bg-secondary/90 text-on-secondary font-extrabold shadow-sm rounded-full transition-all flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">add</span>
            <span>Vincular Enlace</span>
          </button>
        </div>
      </div>



      {productoFiltradoSinUrls && (
        <div className="bg-primary-container text-on-primary-container px-5 py-4 rounded-2xl flex items-center justify-between border border-outline-variant/40 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-xl text-primary">warning</span>
            <span className="text-sm font-sans">
              El producto <strong>"{productoFiltradoSinUrls.nombre}"</strong> todavía no tiene ningún enlace competidor asignado.
            </span>
          </div>
          <button onClick={() => setEditing('new')} className="text-xs bg-white text-primary hover:bg-surface-low px-4 py-2 rounded-full font-bold shadow-sm transition-all">
            Vincular Enlace Ahora
          </button>
        </div>
      )}

      {/* KPIs de Competencia Bento Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* KPI 1: Tasa de Salud Técnica */}
        <div className="bg-white rounded-3xl border border-outline-variant p-5 flex items-center justify-between shadow-sm relative overflow-hidden">
          <div className="space-y-1.5">
            <span className="text-[11px] font-mono font-bold text-on-surface-variant uppercase tracking-wider">Salud del Catálogo</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-display font-extrabold text-primary">{kpis.tasaSalud}%</span>
              <span className="text-xs font-semibold text-on-surface-variant">Enlaces OK</span>
            </div>
            <p className="text-xs text-on-surface-variant/80 font-sans">
              {kpis.exitososCount} de {kpis.activosCount} activos sin fallos de lectura.
            </p>
          </div>
          <div className={`p-4 rounded-2xl flex items-center justify-center ${kpis.tasaSalud > 90 ? 'bg-[#f0f9eb] text-[#2e7d32]' : 'bg-error-container text-error'}`}>
            <span className="material-symbols-outlined text-2xl">{kpis.tasaSalud > 90 ? 'health_and_safety' : 'sync_problem'}</span>
          </div>
        </div>

        {/* KPI 2: Frescura de Datos */}
        <div className="bg-white rounded-3xl border border-outline-variant p-5 flex items-center justify-between shadow-sm relative overflow-hidden">
          <div className="space-y-1.5">
            <span className="text-[11px] font-mono font-bold text-on-surface-variant uppercase tracking-wider">Frescura de Precios</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-display font-extrabold text-primary">
                {kpis.desactualizados}
              </span>
              <span className="text-xs font-semibold text-on-surface-variant">Vencidos</span>
            </div>
            <p className="text-xs text-on-surface-variant/80 font-sans">
              Enlaces que requieren actualización de precios (&gt; 24h).
            </p>
          </div>
          <div className={`p-4 rounded-2xl flex items-center justify-center ${kpis.desactualizados === 0 ? 'bg-[#f0f9eb] text-[#2e7d32]' : 'bg-amber-50 text-amber-600 border border-amber-200/40'}`}>
            <span className="material-symbols-outlined text-2xl">{kpis.desactualizados === 0 ? 'schedule' : 'history_toggle_off'}</span>
          </div>
        </div>

        {/* KPI 3: Liderazgo de Mercado */}
        <div className="bg-white rounded-3xl border border-outline-variant p-5 flex items-center justify-between shadow-sm relative overflow-hidden">
          <div className="space-y-1.5">
            <span className="text-[11px] font-mono font-bold text-on-surface-variant uppercase tracking-wider">Liderazgo en Precios</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-display font-extrabold text-primary">
                {kpis.totalComparables > 0 ? `${Math.round((kpis.propiosMasBaratos / kpis.totalComparables) * 100)}%` : '—'}
              </span>
              <span className="text-xs font-semibold text-on-surface-variant">Líder</span>
            </div>
            <p className="text-xs text-on-surface-variant/80 font-sans">
              {kpis.propiosMasBaratos} de {kpis.totalComparables} comparables son los más baratos.
            </p>
          </div>
          <div className="p-4 rounded-2xl bg-secondary/10 text-secondary flex items-center justify-center">
            <span className="material-symbols-outlined text-2xl">leaderboard</span>
          </div>
        </div>
      </div>

      {/* Filter and Query Section */}
      <div className="bg-white rounded-3xl border border-outline-variant p-5 flex flex-wrap items-center gap-3 shadow-sm">
        <div className="flex-1 min-w-[280px] relative">
          <span className="material-symbols-outlined text-on-surface-variant absolute left-3 top-2.5 select-none">search</span>
          <input type="text" placeholder="Buscar por variante, marca o dirección URL..."
            value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-outline rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans" />
        </div>
        
        <select value={filtroProducto} onChange={(e) => setFiltroProducto(e.target.value)}
          className="px-4 py-2.5 border border-outline rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans bg-white text-on-surface">
          <option value="todos">Todos los productos</option>
          {productos.map(p => <option key={p.id} value={p.id_interno}>{p.nombre}</option>)}
        </select>

        <select value={filtroCadena} onChange={(e) => setFiltroCadena(e.target.value)}
          className="px-4 py-2.5 border border-outline rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans bg-white text-on-surface">
          <option value="todas">Todas las cadenas</option>
          {cadenas.map(c => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
        </select>

        <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}
          className="px-4 py-2.5 border border-outline rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans bg-white text-on-surface">
          <option value="todos">Todos los tipos</option>
          {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        {(search || filtroCadena !== 'todas' || filtroProducto !== 'todos' || filtroTipo !== 'todos') && (
          <button onClick={limpiarFiltros} className="text-xs font-bold text-error hover:underline uppercase font-mono px-2">
            Limpiar Filtros
          </button>
        )}
      </div>

      {/* Main Grid View */}
      <div className="bg-white rounded-3xl border border-outline-variant shadow-sm overflow-hidden">
        {loading ? (
          <div className="overflow-x-auto animate-pulse">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-surface-low text-primary text-xs uppercase font-mono tracking-wider border-b border-outline-variant">
                <tr>
                  <th className="text-left px-6 py-4 font-bold">Mi Producto Local</th>
                  <th className="text-left px-6 py-4 font-bold">Cadena Farmacia</th>
                  <th className="text-left px-6 py-4 font-bold">Variante Competidor</th>
                  <th className="text-left px-6 py-4 font-bold">Tipo Asociación</th>
                  <th className="text-right px-6 py-4 font-bold">Último Precio Detectado</th>
                  <th className="text-center px-6 py-4 font-bold">Status Scrape</th>
                  <th className="text-center px-6 py-4 font-bold">Scraper Activo</th>
                  <th className="text-right px-6 py-4 font-bold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {[1, 2, 3, 4, 5].map((n) => (
                  <tr key={n}>
                    <td className="px-6 py-4">
                      <div className="h-4 bg-gray-200 rounded w-48 mb-1.5"></div>
                      <div className="h-3 bg-gray-100 rounded w-24"></div>
                    </td>
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-24"></div></td>
                    <td className="px-6 py-4">
                      <div className="h-4 bg-gray-200 rounded w-40 mb-1"></div>
                      <div className="h-3 bg-gray-100 rounded w-60"></div>
                    </td>
                    <td className="px-6 py-4"><div className="h-6 bg-gray-200 rounded-full w-20"></div></td>
                    <td className="px-6 py-4 text-right"><div className="h-4 bg-gray-200 rounded w-16 ml-auto"></div></td>
                    <td className="px-6 py-4"><div className="h-6 bg-gray-200 rounded-full w-24 mx-auto"></div></td>
                    <td className="px-6 py-4"><div className="h-6 bg-gray-200 rounded-full w-12 mx-auto"></div></td>
                    <td className="px-6 py-4 text-right"><div className="h-4 bg-gray-200 rounded w-16 ml-auto"></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : ordenados.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant italic">
            {items.length === 0 
              ? 'Aún no hay enlaces vinculados en el catálogo de competencia.' 
              : 'No se encontraron registros con los filtros activos.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-surface-low text-primary text-xs uppercase font-mono tracking-wider border-b border-outline-variant">
                <tr>
                  <th className="text-left px-6 py-4 font-bold">Mi Producto Local</th>
                  <th className="text-left px-6 py-4 font-bold">Cadena Farmacia</th>
                  <th className="text-left px-6 py-4 font-bold">Variante Competidor</th>
                  <th className="text-left px-6 py-4 font-bold">Tipo Asociación</th>
                  <th className="text-right px-6 py-4 font-bold">Último Precio Detectado</th>
                  <th className="text-center px-6 py-4 font-bold">Status Scrape</th>
                  <th className="text-center px-6 py-4 font-bold">Scraper Activo</th>
                  <th className="text-right px-6 py-4 font-bold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {itemsPaginados.map(it => (
                  <tr key={it.id} className="hover:bg-surface-low transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-bold text-on-surface font-display text-sm truncate max-w-xs" title={productoNombre(it.id_producto_propio)}>
                        {productoNombre(it.id_producto_propio)}
                      </div>
                      <div className="text-[10px] text-on-surface-variant font-mono mt-0.5">{it.id_producto_propio}</div>
                    </td>
                    <td className="px-6 py-4 font-bold text-primary">{it.cadena}</td>
                    <td className="px-6 py-4">
                      <div className="font-bold text-on-surface text-sm">
                        {it.marca} {it.concentracion || ''} {it.tamano || ''}
                      </div>
                      {it.laboratorio && (
                        <div className="text-[10px] text-on-surface-variant font-medium mt-0.5">Lab: {it.laboratorio}</div>
                      )}
                      <a href={it.url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline truncate max-w-xs font-mono mt-0.5 flex items-center gap-0.5" title={it.url}>
                        <span>Ver Enlace Destino</span>
                        <span className="material-symbols-outlined text-[11px] leading-none">open_in_new</span>
                      </a>
                      {it.estado === 'error' && it.ultimo_error && (
                        <div className="text-[10px] text-error bg-error/5 border border-error/15 px-2 py-1 rounded-xl mt-1.5 font-medium max-w-xs leading-normal flex items-start gap-1 shadow-sm">
                          <span className="material-symbols-outlined text-[12px] mt-0.5 flex-shrink-0 text-error leading-none">warning</span>
                          <span><strong>Error lectura:</strong> {it.ultimo_error}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-[10px] uppercase font-mono font-bold px-2.5 py-1 rounded-full border ${
                        it.tipo === 'propio' ? 'bg-[#e8f5e9] text-[#2e7d32] border-[#a5d6a7]' : 'bg-surface-low text-on-surface-variant border-outline-variant'
                      }`}>
                        {it.tipo === 'propio' ? 'Mi Marca' : 'Competencia'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right font-mono font-bold text-primary">
                      {it.ultimo_precio_desc_bs ? (
                        <div>
                          <div className="text-on-surface font-extrabold flex items-center justify-end gap-1">
                            {it.actualizado_manualmente && (
                              <span className="material-symbols-outlined text-xs text-amber-500 font-sans" title="Precio actualizado manualmente por el usuario">edit_note</span>
                            )}
                            {formatPrice(it.ultimo_precio_desc_bs)}
                          </div>
                          {it.ultimo_precio_full_bs && it.ultimo_precio_full_bs !== it.ultimo_precio_desc_bs && (
                            <div className="text-[10px] text-on-surface-variant line-through font-normal">{formatPrice(it.ultimo_precio_full_bs)}</div>
                          )}
                        </div>
                      ) : it.ultimo_precio_full_bs ? (
                        <div className="flex items-center justify-end gap-1">
                          {it.actualizado_manualmente && (
                            <span className="material-symbols-outlined text-xs text-amber-500 font-sans" title="Precio actualizado manualmente por el usuario">edit_note</span>
                          )}
                          <span className="font-extrabold">{formatPrice(it.ultimo_precio_full_bs)}</span>
                        </div>
                      ) : (
                        <span className="text-gray-300 font-mono select-none">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {scrapingItems[it.id] ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold font-mono px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 animate-pulse">
                          <span className="material-symbols-outlined animate-spin text-[11px] leading-none">autorenew</span>
                          {scrapingItems[it.id] === 'disparando' ? 'Gatillando...' : 'En cola...'}
                        </span>
                      ) : (
                        <>
                          {it.estado === 'ok' && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold font-mono px-2.5 py-1 rounded-full bg-[#f0f9eb] text-[#214f00] border border-secondary/30">
                              <span className="material-symbols-outlined text-[10px] leading-none">check_circle</span>
                              OK
                            </span>
                          )}
                          {it.estado === 'error' && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold font-mono px-2.5 py-1 rounded-full bg-error-container text-error border border-error/20" title={it.ultimo_error}>
                              <span className="material-symbols-outlined text-[10px] leading-none">error</span>
                              Error
                            </span>
                          )}
                          {!it.estado && <span className="text-[10px] font-bold font-mono px-2.5 py-1 bg-surface-low text-on-surface-variant border border-outline-variant rounded-full">Sin Datos</span>}
                        </>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button onClick={() => handleToggleActivo(it)}
                        className={`text-[10px] uppercase font-bold px-3 py-1 rounded-full transition-all ${
                          it.activo ? 'bg-secondary/15 text-secondary border border-secondary/30' : 'bg-surface-low text-on-surface-variant border border-outline-variant/40'
                        }`}>
                        {it.activo ? 'Monitorear' : 'Pausado'}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right whitespace-nowrap space-x-2.5">
                      <button onClick={() => handleScrapeIndividual(it)}
                        disabled={!!scrapingItems[it.id] || !it.activo}
                        className={`text-xs font-bold inline-flex items-center gap-0.5 ${
                          scrapingItems[it.id] || !it.activo ? 'text-gray-300 cursor-not-allowed' : 'text-secondary hover:text-secondary/80'
                        }`}
                        title={!it.activo ? "Activa la monitorización para poder usar el robot" : "Lanzar robot extractor para esta variante en tiempo real"}>
                        <span className="material-symbols-outlined text-xs">bolt</span>
                        Robot
                      </button>
                      <button onClick={() => setManualPriceItem(it)}
                        className="text-xs text-amber-600 hover:text-amber-700 font-bold inline-flex items-center gap-0.5"
                        title="Corregir precio manualmente si el robot falló">
                        <span className="material-symbols-outlined text-xs">edit_note</span>
                        Precio
                      </button>
                      <button onClick={() => setEditing(it.id)}
                        className="text-xs text-primary hover:text-primary/80 font-bold inline-flex items-center gap-0.5">
                        <span className="material-symbols-outlined text-xs">edit</span>
                        Editar
                      </button>
                      <button onClick={() => handleDelete(it)}
                        className="text-xs text-error hover:text-error/80 font-bold inline-flex items-center gap-0.5">
                        <span className="material-symbols-outlined text-xs">delete</span>
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {ordenados.length > 0 && (
          <div className="px-6 py-4 bg-surface-low border-t border-outline-variant flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-on-surface-variant font-mono">
              Mostrando <span className="font-bold text-primary">{Math.min(ordenados.length, (paginaActual - 1) * itemsPorPagina + 1)}</span> - <span className="font-bold text-primary">{Math.min(ordenados.length, paginaActual * itemsPorPagina)}</span> de <span className="font-bold text-primary">{ordenados.length}</span> enlaces
            </div>
            {totalPaginas > 1 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPaginaActual(p => Math.max(1, p - 1))}
                  disabled={paginaActual === 1}
                  className="px-3 py-1.5 rounded-lg border border-outline-variant bg-white text-xs font-bold text-primary disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-all flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">chevron_left</span>
                  Anterior
                </button>
                <span className="text-xs font-mono font-bold px-3 py-1 bg-white border border-outline-variant rounded-lg text-primary">
                  {paginaActual} / {totalPaginas}
                </span>
                <button
                  onClick={() => setPaginaActual(p => Math.min(totalPaginas, p + 1))}
                  disabled={paginaActual === totalPaginas}
                  className="px-3 py-1.5 rounded-lg border border-outline-variant bg-white text-xs font-bold text-primary disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-all flex items-center gap-1"
                >
                  Siguiente
                  <span className="material-symbols-outlined text-sm">chevron_right</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {!loading && ordenados.length > 0 && (
        <p className="text-xs text-on-surface-variant font-mono text-center">
          Mostrando {ordenados.length} de {items.length} Enlaces Registrados.
        </p>
      )}

      {editing && (
        <CompetenciaModal
          item={editing === 'new' ? null : items.find(i => i.id === editing)}
          productoIdPreseleccionado={editing === 'new' && filtroProducto !== 'todos' ? filtroProducto : null}
          productos={productos}
          cadenas={cadenas}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Custom Confirmation Dialog */}
      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar Enlace de Competencia?"
        message={
          confirmDelete 
            ? `¿Estás seguro de que deseas eliminar "${confirmDelete.marca}" en la cadena "${confirmDelete.cadena}"?\n\nProducto Asociado: ${productos.find(p => p.id_interno === confirmDelete.id_producto_propio)?.nombre || confirmDelete.id_producto_propio}\nURL: ${confirmDelete.url}\n\nLos registros históricos de precios se conservarán.`
            : ''
        }
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* CSV Mass Upload Competitors Modal */}
      {showCsvModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-white rounded-3xl shadow-xl max-w-lg w-full p-6 space-y-4 border border-outline-variant">
            <div className="flex items-center justify-between border-b pb-3 border-outline-variant">
              <h2 className="text-xl font-display font-extrabold text-primary">Importar Enlaces CSV</h2>
              <button onClick={() => setShowCsvModal(false)} className="text-on-surface-variant hover:text-on-surface text-2xl leading-none">×</button>
            </div>
            <div className="space-y-4 text-sm text-on-background">
              <p>
                Asocia enlaces de forma masiva a tus productos registrados.
              </p>
              <div className="bg-surface-low p-4 rounded-2xl border border-outline-variant space-y-1.5 font-mono text-xs">
                <div className="font-bold text-primary border-b pb-1 mb-1 border-outline-variant flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-sm">lists</span>
                  Columnas Obligatorias del CSV:
                </div>
                <div>id_producto_propio <span className="text-on-surface-variant font-sans font-medium">(ID del Producto, ej. P001)</span></div>
                <div>cadena <span className="text-on-surface-variant font-sans font-medium">(Nombre de la Cadena, ej. Farmatodo)</span></div>
                <div>marca <span className="text-on-surface-variant font-sans font-medium">(Variante/Nombre en competidor)</span></div>
                <div>url <span className="text-on-surface-variant font-sans font-medium">(Enlace completo)</span></div>
                <div>tipo <span className="text-on-surface-variant font-sans font-medium">(Opcional: propio / alternativa)</span></div>
                <div>activo <span className="text-on-surface-variant font-sans font-medium">(Opcional: true / false)</span></div>
                <div>laboratorio <span className="text-on-surface-variant font-sans font-medium">(Opcional: Laboratorio fabricante)</span></div>
                <div>concentracion <span className="text-on-surface-variant font-sans font-medium">(Opcional: Concentración, ej. 500mg)</span></div>
                <div>tamano <span className="text-on-surface-variant font-sans font-medium">(Opcional: Presentación, ej. 10tab)</span></div>
              </div>
              <div className="flex justify-between items-center pt-2">
                <button type="button" onClick={downloadExampleCsv}
                  className="text-xs text-primary font-bold hover:underline inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">download</span>
                  Descargar Plantilla Ejemplo CSV
                </button>
              </div>

              {/* File drop area */}
              <div className="border-2 border-dashed border-outline hover:border-primary transition-colors rounded-2xl p-8 text-center cursor-pointer bg-surface-low"
                onClick={() => fileInputRef.current.click()}>
                <span className="material-symbols-outlined text-4xl text-primary">upload_file</span>
                <p className="mt-2 text-sm font-bold text-primary">Haz click o arrastra tu archivo CSV aquí</p>
                <p className="text-xs text-on-surface-variant mt-1">Soporta formato .csv plano</p>
                <input type="file" ref={fileInputRef} onChange={handleCsvUpload} accept=".csv" className="hidden" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t border-outline-variant">
              <button onClick={() => setShowCsvModal(false)}
                className="px-5 py-2 border border-outline rounded-full text-xs font-bold hover:bg-surface-low text-on-surface-variant">
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Price Override Dialog */}
      {manualPriceItem && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in" onClick={() => setManualPriceItem(null)}>
          <div className="bg-white rounded-3xl shadow-xl max-w-md w-full p-6 space-y-4 border border-outline-variant" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b pb-3 border-outline-variant">
              <h2 className="text-xl font-display font-extrabold text-primary">Ingresar Precio Manual</h2>
              <button onClick={() => setManualPriceItem(null)} className="text-on-surface-variant hover:text-on-surface text-2xl leading-none">×</button>
            </div>
            <div className="space-y-4 text-sm text-on-background">
              <p>
                Anula los errores del scraper automático para <strong>{manualPriceItem.marca}</strong> de <strong>{manualPriceItem.cadena}</strong>.
              </p>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-on-surface-variant font-mono">Precio en Bolívares (Bs. *):</label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="Ej: 450.50"
                  id="manualPriceInput"
                  defaultValue={manualPriceItem.ultimo_precio_desc_bs || manualPriceItem.ultimo_precio_full_bs || ''}
                  className="w-full px-4 py-2.5 border border-outline rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans bg-white text-on-surface"
                />
              </div>
              <p className="text-[11px] text-on-surface-variant italic">
                * Esto establecerá el estado de la URL como "OK" y registrará el precio ingresado en el historial de precios y en el panel.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3 border-outline-variant">
              <button onClick={() => setManualPriceItem(null)} className="px-4 py-2 text-xs font-bold text-on-surface-variant hover:bg-surface-low rounded-full">
                Cancelar
              </button>
              <button
                onClick={async () => {
                  const inputVal = document.getElementById('manualPriceInput').value;
                  const price = parseFloat(inputVal);
                  if (isNaN(price) || price <= 0) {
                    alert('Por favor ingresa un precio válido mayor a 0');
                    return;
                  }
                  try {
                    const docId = manualPriceItem.id;
                    const ahora = new Date();
                    
                    // 1. Guardar precio en el documento de competencia
                    await setDoc(doc(db, 'productos_competencia', docId), {
                      ultimo_precio_full_bs: price,
                      ultimo_precio_desc_bs: price,
                      ultimo_scrape: ahora,
                      estado: 'ok',
                      actualizado_manualmente: true,
                      ultimo_error: null,
                    }, { merge: true });

                    // 2. Insertar en historico_precios
                    const runId = 'MANUAL_' + ahora.toISOString().slice(0, 10).replace(/-/g, '') + '_' + ahora.toTimeString().slice(0, 8).replace(/:/g, '');
                    await setDoc(doc(collection(db, 'historico_precios')), {
                      prod_comp_id: docId,
                      id_producto_propio: manualPriceItem.id_producto_propio,
                      cadena: manualPriceItem.cadena,
                      marca: manualPriceItem.marca,
                      tipo: manualPriceItem.tipo,
                      nombre: manualPriceItem.marca + ' (Manual)',
                      precio_full_bs: price,
                      precio_desc_bs: price,
                      tiene_descuento: false,
                      scraped_at: ahora,
                      run_id: runId,
                    });

                    addToast(`Precio de ${manualPriceItem.marca} actualizado manualmente a Bs ${price.toFixed(2)}.`, 'success');
                    setManualPriceItem(null);
                    await cargar();
                  } catch (err) {
                    addToast('Error: ' + err.message, 'error');
                  }
                }}
                className="px-5 py-2 text-xs font-bold bg-primary hover:bg-primary/90 text-white rounded-full shadow-sm"
              >
                Guardar Precio
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CompetenciaModal({ item, productoIdPreseleccionado, productos, cadenas, onSave, onClose }) {
  const isNew = !item;
  const [form, setForm] = useState({
    id_producto_propio: item?.id_producto_propio || productoIdPreseleccionado || '',
    cadena: item?.cadena || '',
    tipo: item?.tipo || 'alternativa',
    marca: item?.marca || '',
    url: item?.url || '',
    activo: item?.activo ?? true,
    laboratorio: item?.laboratorio || '',
    concentracion: item?.concentracion || '',
    tamano: item?.tamano || '',
  });
  const [saving, setSaving] = useState(false);

  const productosActivos = productos.filter(p => p.activo);
  const cadenasActivas = cadenas.filter(c => c.activo);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.id_producto_propio || !form.cadena || !form.marca || !form.url) return;
    setSaving(true);
    await onSave(form, isNew);
    setSaving(false);
  };

  const handleChange = (key, value) => setForm(f => ({ ...f, [key]: value }));
  const probarUrl = () => { if (form.url) window.open(form.url, '_blank', 'noopener,noreferrer'); };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-xl max-w-lg w-full max-h-[92vh] flex flex-col border border-outline-variant"
        onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-xl font-display font-extrabold text-primary">{isNew ? 'Vincular Enlace Competidor' : 'Propiedades de Enlace'}</h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto">
          <Field label="Producto en Catálogo Interno *">
            <select required value={form.id_producto_propio}
              onChange={e => handleChange('id_producto_propio', e.target.value)}
              disabled={!isNew}
              className="w-full px-4 py-2 border border-outline-variant rounded-xl disabled:bg-surface-low focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm bg-white text-on-surface">
              <option value="">— Seleccionar —</option>
              {productosActivos.map(p => (
                <option key={p.id} value={p.id_interno}>{p.id_interno} · {p.nombre}</option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Cadena de Farmacia *">
              <select required value={form.cadena}
                onChange={e => handleChange('cadena', e.target.value)}
                disabled={!isNew}
                className="w-full px-4 py-2 border border-outline-variant rounded-xl disabled:bg-surface-low focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm bg-white text-on-surface">
                <option value="">— Seleccionar —</option>
                {cadenasActivas.map(c => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
              </select>
            </Field>
            
            <Field label="Tipo de Relación *">
              <select required value={form.tipo} onChange={e => handleChange('tipo', e.target.value)}
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm bg-white text-on-surface">
                {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Nombre Comercial / Marca *" hint="Ej. Acetaminofén, Atamel">
              <input type="text" required value={form.marca}
                onChange={e => handleChange('marca', e.target.value)}
                disabled={!isNew}
                placeholder="Ej. Atamel"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl disabled:bg-surface-low focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface" />
            </Field>

            <Field label="Laboratorio / Fabricante" hint="Ej. Genven, La Santé">
              <input type="text" value={form.laboratorio}
                onChange={e => handleChange('laboratorio', e.target.value)}
                placeholder="Ej. Genven"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface" />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Concentración" hint="Ej. 650mg, 500mg">
              <input type="text" value={form.concentracion}
                onChange={e => handleChange('concentracion', e.target.value)}
                placeholder="Ej. 650mg"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface" />
            </Field>

            <Field label="Tamaño / Presentación" hint="Ej. 10tab, 20tab, 120ml">
              <input type="text" value={form.tamano}
                onChange={e => handleChange('tamano', e.target.value)}
                placeholder="Ej. 10tab"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface" />
            </Field>
          </div>

          <Field label="Dirección URL del Producto *" hint="Dirección exacta para el robot de extracción">
            <div className="flex gap-2">
              <input type="url" required value={form.url}
                onChange={e => handleChange('url', e.target.value)}
                placeholder="https://www.farmatodo.com.ve/producto/..."
                className="flex-1 px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-xs text-on-surface" />
              <button type="button" onClick={probarUrl} disabled={!form.url}
                className="px-4 py-2 text-xs border border-outline-variant font-bold rounded-full hover:bg-surface-low disabled:opacity-50 text-primary transition-all whitespace-nowrap">Probar URL ↗</button>
            </div>
          </Field>

          <Field label="Monitoreo Continuo">
            <label className="flex items-center gap-2 px-4 py-3 border border-outline rounded-xl cursor-pointer font-bold text-xs text-primary bg-surface-low select-none">
              <input type="checkbox" checked={form.activo}
                onChange={e => handleChange('activo', e.target.checked)}
                className="rounded text-primary focus:ring-primary h-4 w-4" />
              <span>ACTIVAR EXTRACCIÓN DIARIA PARA ESTE ENLACE</span>
            </label>
          </Field>

          {!isNew && (
            <div className="bg-surface-low rounded-2xl p-3 text-xs text-on-surface-variant font-mono border border-outline-variant">
              Nota: El producto, la cadena y la marca variante no se pueden reasignar para mantener la coherencia histórica.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t border-outline-variant">
            <button type="button" onClick={onClose}
              className="px-5 py-2 border border-outline rounded-full text-xs font-bold hover:bg-surface-low text-on-surface-variant">Cancelar</button>
            <button type="submit" disabled={saving}
              className="px-6 py-2 bg-secondary hover:bg-secondary/90 text-on-secondary rounded-full text-xs font-bold shadow-sm transition-all">
              {saving ? 'Guardando...' : isNew ? 'Vincular' : 'Guardar Cambios'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-mono font-bold uppercase tracking-wider text-primary">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-on-surface-variant font-mono">{hint}</p>}
    </div>
  );
}
