import { useEffect, useState, useMemo, useRef } from 'react';
import { collection, getDocs, doc, setDoc, deleteDoc, getDoc, writeBatch } from 'firebase/firestore';
import { useSearchParams } from 'react-router-dom';
import { db } from '../firebase';
import ConfirmModal from '../components/ConfirmModal';

const TIPOS = [
  { value: 'propio', label: 'Mi marca' },
  { value: 'alternativa', label: 'Alternativa (competencia)' },
];

export default function Competencia() {
  const [items, setItems] = useState([]);
  const [productos, setProductos] = useState([]);
  const [cadenas, setCadenas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [filtroCadena, setFiltroCadena] = useState('todas');
  const [filtroProducto, setFiltroProducto] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [message, setMessage] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const fileInputRef = useRef(null);

  // Si llegamos con ?producto=P001, aplicamos ese filtro al cargar
  useEffect(() => {
    const productoParam = searchParams.get('producto');
    if (productoParam) {
      setFiltroProducto(productoParam);
    }
  }, [searchParams]);

  const cargar = async () => {
    setLoading(true);
    try {
      const [pcSnap, pSnap, cSnap] = await Promise.all([
        getDocs(collection(db, 'productos_competencia')),
        getDocs(collection(db, 'productos')),
        getDocs(collection(db, 'cadenas')),
      ]);
      setItems(pcSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setProductos(pSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setCadenas(cSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      setMessage({ type: 'error', text: 'Error al cargar: ' + err.message });
    }
    setLoading(false);
  };

  useEffect(() => { cargar(); }, []);

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

  // Si estamos viendo solo un producto y no tiene URLs, mostramos hint
  const productoFiltradoSinUrls = useMemo(() => {
    if (filtroProducto === 'todos') return null;
    if (ordenados.length > 0) return null;
    return productos.find(p => p.id_interno === filtroProducto) || null;
  }, [filtroProducto, ordenados, productos]);

  const handleSave = async (data, isNew) => {
    try {
      const docId = `${data.id_producto_propio}_${data.cadena}_${data.marca}`.replace(/\s+/g, '_');
      if (isNew && items.some(it => it.id === docId)) {
        throw new Error('Ya existe esta combinación de producto + cadena + marca');
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
      }, { merge: !isNew });
      setMessage({ type: 'success', text: isNew ? 'URL de competencia creada con éxito' : 'Cambios guardados con éxito' });
      setEditing(null);
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
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
      setMessage({ type: 'success', text: 'Enlace eliminado del scraper' });
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: 'Error al eliminar: ' + err.message });
    }
  };

  const handleToggleActivo = async (item) => {
    try {
      await setDoc(doc(db, 'productos_competencia', item.id), {
        activo: !item.activo,
      }, { merge: true });
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

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

          if (!id_producto || !cadena || !marca || !url) continue;

          const docId = `${id_producto}_${cadena}_${marca}`.replace(/\s+/g, '_');
          const compRef = doc(db, 'productos_competencia', docId);

          batch.set(compRef, {
            id_producto_propio: id_producto,
            cadena,
            tipo: tipo === 'propio' ? 'propio' : 'alternativa',
            marca,
            url,
            activo: row.activo ? (row.activo.toLowerCase() === 'true' || row.activo === '1') : true,
          }, { merge: true });

          count++;
        }

        if (count > 0) {
          await batch.commit();
          setMessage({ type: 'success', text: `Carga masiva exitosa: ${count} URLs de competencia importadas.` });
          await cargar();
        } else {
          throw new Error('No se encontraron filas con campos obligatorios (id_producto_propio, cadena, marca, url).');
        }
      } catch (err) {
        setMessage({ type: 'error', text: 'Error procesando CSV: ' + err.message });
      }
      setShowCsvModal(false);
    };
    reader.readAsText(file);
  };

  const parseCSV = (text) => {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0) return [];
    
    const splitLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
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
    const headers = 'id_producto_propio,cadena,tipo,marca,url,activo\n';
    const row1 = 'P001,Farmatodo,alternativa,Atamel Genérico,https://www.farmatodo.com.ve/producto/atamel-500mg,true\n';
    const row2 = 'P001,Locatel,alternativa,Calox Acetaminofén,https://www.locatel.com.ve/calox-500mg,true\n';
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
        <div className="flex gap-2">
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

      {message && (
        <div className={`px-4 py-3.5 rounded-2xl text-sm font-semibold flex items-center justify-between border ${
          message.type === 'success' ? 'bg-[#f0f9eb] border-[#c2e7b0] text-[#3c763d]'
          : 'bg-error-container text-error border border-error/20'
        }`}>
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg">{message.type === 'success' ? 'check_circle' : 'error'}</span>
            {message.text}
          </span>
          <button onClick={() => setMessage(null)} className="ml-2 text-current hover:opacity-75 font-bold">×</button>
        </div>
      )}

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
          <div className="p-12 text-center text-on-surface-variant font-semibold animate-pulse flex flex-col items-center justify-center gap-2">
            <span className="material-symbols-outlined animate-spin text-3xl text-primary">autorenew</span>
            Cargando enlaces vinculados...
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
                {ordenados.map(it => (
                  <tr key={it.id} className="hover:bg-surface-low transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-bold text-on-surface font-display text-sm truncate max-w-xs" title={productoNombre(it.id_producto_propio)}>
                        {productoNombre(it.id_producto_propio)}
                      </div>
                      <div className="text-[10px] text-on-surface-variant font-mono mt-0.5">{it.id_producto_propio}</div>
                    </td>
                    <td className="px-6 py-4 font-bold text-primary">{it.cadena}</td>
                    <td className="px-6 py-4">
                      <div className="font-bold text-on-surface text-sm">{it.marca}</div>
                      <a href={it.url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline truncate max-w-xs font-mono mt-0.5 flex items-center gap-0.5" title={it.url}>
                        <span>Ver Enlace Destino</span>
                        <span className="material-symbols-outlined text-[11px] leading-none">open_in_new</span>
                      </a>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-[10px] uppercase font-mono font-bold px-2.5 py-1 rounded-full ${
                        it.tipo === 'propio' ? 'bg-primary-container text-on-primary-container' : 'bg-surface-low text-on-surface-variant border border-outline-variant'
                      }`}>
                        {it.tipo === 'propio' ? 'Mi Marca' : 'Competencia'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right font-mono font-bold text-primary">
                      {it.ultimo_precio_desc_bs ? (
                        <div>
                          <div className="text-on-surface font-extrabold">{formatPrice(it.ultimo_precio_desc_bs)}</div>
                          {it.ultimo_precio_full_bs && it.ultimo_precio_full_bs !== it.ultimo_precio_desc_bs && (
                            <div className="text-[10px] text-on-surface-variant line-through font-normal">{formatPrice(it.ultimo_precio_full_bs)}</div>
                          )}
                        </div>
                      ) : it.ultimo_precio_full_bs ? (
                        <span className="font-extrabold">{formatPrice(it.ultimo_precio_full_bs)}</span>
                      ) : (
                        <span className="text-gray-300 font-mono select-none">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
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
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button onClick={() => handleToggleActivo(it)}
                        className={`text-[10px] uppercase font-bold px-3 py-1 rounded-full transition-all ${
                          it.activo ? 'bg-secondary/15 text-secondary border border-secondary/30' : 'bg-surface-low text-on-surface-variant border border-outline-variant/40'
                        }`}>
                        {it.activo ? 'Monitorear' : 'Pausado'}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right whitespace-nowrap">
                      <button onClick={() => setEditing(it.id)}
                        className="text-xs text-primary hover:text-primary/80 font-bold mr-4 inline-flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">edit</span>
                        Editar
                      </button>
                      <button onClick={() => handleDelete(it)}
                        className="text-xs text-error hover:text-error/80 font-bold inline-flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">delete</span>
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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

          <Field label="Nombre Comercial en Competidor *" hint="Ej. Acetaminofén Genérico Farmatodo">
            <input type="text" required value={form.marca}
              onChange={e => handleChange('marca', e.target.value)}
              disabled={!isNew}
              placeholder="Ej. Atamel 500mg"
              className="w-full px-4 py-2 border border-outline-variant rounded-xl disabled:bg-surface-low focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface" />
          </Field>

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
