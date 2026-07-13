import { useEffect, useState, useMemo, useRef } from 'react';
import {
  collection, getDocs, doc, setDoc, deleteDoc, writeBatch
} from 'firebase/firestore';
import { db } from '../firebase';
import ConfirmModal from '../components/ConfirmModal';

const CATEGORIAS = [
  'Analgésicos',
  'Antialérgicos',
  'Antibióticos',
  'Antigripales',
  'Cardiovasculares',
  'Dermatológicos',
  'Gastrointestinales',
  'Vitaminas',
  'Otros',
];

export default function Productos() {
  const [productos, setProductos] = useState([]);
  const [competencia, setCompetencia] = useState([]);
  const [cadenas, setCadenas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [filtroActivo, setFiltroActivo] = useState('todos');
  const [filtroUrls, setFiltroUrls] = useState('todos'); // todos | con_urls | sin_urls
  const [message, setMessage] = useState(null);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const fileInputRef = useRef(null);

  const cargar = async () => {
    setLoading(true);
    try {
      const [pSnap, pcSnap, cSnap] = await Promise.all([
        getDocs(collection(db, 'productos')),
        getDocs(collection(db, 'productos_competencia')),
        getDocs(collection(db, 'cadenas')),
      ]);
      const docs = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      docs.sort((a, b) => (a.id_interno || '').localeCompare(b.id_interno || ''));
      setProductos(docs);
      setCompetencia(pcSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setCadenas(cSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      setMessage({ type: 'error', text: 'Error al cargar: ' + err.message });
    }
    setLoading(false);
  };

  useEffect(() => { cargar(); }, []);

  // Cuenta URLs activas por producto
  const urlsPorProducto = useMemo(() => {
    const map = new Map();
    for (const c of competencia) {
      if (c.activo) {
        map.set(c.id_producto_propio, (map.get(c.id_producto_propio) || []).concat(c));
      }
    }
    return map;
  }, [competencia]);

  const filtrados = useMemo(() => {
    const term = search.toLowerCase().trim();
    return productos.filter(p => {
      if (filtroActivo === 'activos' && !p.activo) return false;
      if (filtroActivo === 'inactivos' && p.activo) return false;
      const links = urlsPorProducto.get(p.id_interno) || [];
      if (filtroUrls === 'con_urls' && links.length === 0) return false;
      if (filtroUrls === 'sin_urls' && links.length > 0) return false;
      if (!term) return true;
      return (
        (p.nombre || '').toLowerCase().includes(term) ||
        (p.laboratorio || '').toLowerCase().includes(term) ||
        (p.principio_activo || '').toLowerCase().includes(term) ||
        (p.categoria || '').toLowerCase().includes(term) ||
        (p.id_interno || '').toLowerCase().includes(term)
      );
    });
  }, [productos, search, filtroActivo, filtroUrls, urlsPorProducto]);

  const huerfanos = useMemo(() => {
    return productos.filter(p => p.activo && (urlsPorProducto.get(p.id_interno) || []).length === 0).length;
  }, [productos, urlsPorProducto]);

  const handleSave = async (data, isNew, activeUrls) => {
    try {
      const id = data.id_interno.trim();
      if (!id) throw new Error('El ID interno es obligatorio');
      if (isNew && productos.some(p => p.id_interno === id)) {
        throw new Error('Ya existe un producto con ese ID interno');
      }

      const cleanProductData = {
        id_interno: id,
        nombre: data.nombre.trim(),
        principio_activo: (data.principio_activo || '').trim(),
        concentracion: (data.concentracion || '').trim(),
        tamano: (data.tamano || '').trim(),
        presentacion: `${data.concentracion || ''} ${data.tamano || ''}`.trim() || (data.presentacion || ''),
        laboratorio: (data.laboratorio || '').trim(),
        categoria: data.categoria || 'Otros',
        activo: data.activo ?? true,
      };

      const batch = writeBatch(db);
      
      // 1. Save product
      const prodRef = doc(db, 'productos', id);
      batch.set(prodRef, cleanProductData);

      // 2. Save dynamic URLs
      for (const chainName of Object.keys(activeUrls)) {
        const urlData = activeUrls[chainName];
        if (urlData.url.trim()) {
          const docId = `${id}_${chainName}_${urlData.marca || 'Generico'}`.replace(/\s+/g, '_');
          const compRef = doc(db, 'productos_competencia', docId);
          batch.set(compRef, {
            id_producto_propio: id,
            cadena: chainName,
            tipo: urlData.tipo || 'alternativa',
            marca: (urlData.marca || data.nombre).trim(),
            url: urlData.url.trim(),
            activo: true,
          }, { merge: true });
        }
      }

      await batch.commit();

      setMessage({ type: 'success', text: isNew ? 'Producto y enlaces creados con éxito' : 'Producto actualizado con éxito' });
      setEditing(null);
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleDelete = (producto) => {
    setConfirmDelete(producto);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const producto = confirmDelete;
    const links = urlsPorProducto.get(producto.id_interno) || [];
    const count = links.length;
    setConfirmDelete(null);

    try {
      await deleteDoc(doc(db, 'productos', producto.id));
      if (count > 0) {
        const batch = writeBatch(db);
        links.forEach(l => {
          batch.delete(doc(db, 'productos_competencia', l.id));
        });
        await batch.commit();
      }
      setMessage({ type: 'success', text: 'Producto y sus enlaces de competencia eliminados' });
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: 'Error al eliminar: ' + err.message });
    }
  };

  const handleToggleActivo = async (producto) => {
    try {
      await setDoc(doc(db, 'productos', producto.id), {
        activo: !producto.activo,
      }, { merge: true });
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleCsvUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = evt.target.result;
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error('El archivo CSV está vacío o no es válido.');

        const batch = writeBatch(db);
        let count = 0;

        for (const row of rows) {
          const id = (row.id_interno || row.id || row.ID || '').trim();
          const nombre = (row.nombre || row.nombre_producto || row.Nombre || '').trim();
          
          if (!id || !nombre) continue;

          const principio_activo = (row.principio_activo || row.molecula || row.Molecula || '').trim();
          const concentracion = (row.concentracion || row.Concentracion || '').trim();
          const tamano = (row.tamano || row.presentacion || row.Tamano || '').trim();
          const laboratorio = (row.laboratorio || row.Laboratorio || '').trim();
          const categoria = (row.categoria || row.Categoria || 'Otros').trim();

          const cleanProd = {
            id_interno: id,
            nombre: nombre,
            principio_activo,
            concentracion,
            tamano,
            presentacion: `${concentracion} ${tamano}`.trim() || tamano,
            laboratorio,
            categoria: CATEGORIAS.includes(categoria) ? categoria : 'Otros',
            activo: true,
          };

          const prodRef = doc(db, 'productos', id);
          batch.set(prodRef, cleanProd);
          count++;

          for (const key of Object.keys(row)) {
            if (key.toLowerCase().startsWith('url_')) {
              const chainNameClean = key.slice(4).trim();
              const urlVal = row[key].trim();
              if (urlVal) {
                const docId = `${id}_${chainNameClean}_Competencia`.replace(/\s+/g, '_');
                const compRef = doc(db, 'productos_competencia', docId);
                batch.set(compRef, {
                  id_producto_propio: id,
                  cadena: chainNameClean.charAt(0).toUpperCase() + chainNameClean.slice(1),
                  tipo: 'alternativa',
                  marca: nombre,
                  url: urlVal,
                  activo: true,
                }, { merge: true });
              }
            }
          }
        }

        if (count > 0) {
          await batch.commit();
          setMessage({ type: 'success', text: `Carga masiva exitosa: ${count} productos registrados en el catálogo.` });
          await cargar();
        } else {
          throw new Error('No se encontraron filas válidas con ID y Nombre.');
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

  const sugerirId = () => {
    const numeros = productos
      .map(p => p.id_interno)
      .filter(id => /^P\d+$/.test(id))
      .map(id => parseInt(id.slice(1), 10));
    const max = numeros.length > 0 ? Math.max(...numeros) : 0;
    return 'P' + String(max + 1).padStart(3, '0');
  };

  const downloadExampleCsv = () => {
    const headers = 'id_interno,nombre,principio_activo,concentracion,tamano,laboratorio,categoria,url_farmatodo,url_locatel\n';
    const row1 = 'P001,Atamel,Acetaminofén,500 mg,10 tabletas,La Santé,Analgésicos,https://www.farmatodo.com.ve/producto/atamel-500mg,https://www.locatel.com.ve/atamel\n';
    const row2 = 'P002,Calox,Ibuprofeno,400 mg,20 capsulas,Calox,Analgésicos,,\n';
    const blob = new Blob([headers + row1 + row2], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'plantilla_productos.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Editorial Title Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-outline-variant pb-4 gap-4">
        <div>
          <h1 className="text-3xl font-display font-extrabold text-primary tracking-tight">Catálogo de Productos</h1>
          <p className="text-sm text-on-surface-variant font-sans mt-1">
            Gestiona el catálogo de medicamentos registrados y asocia sus enlaces de competencia.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowCsvModal(true)}
            className="text-xs px-4 py-2.5 bg-white border border-outline-variant hover:bg-surface-low font-bold text-primary rounded-full transition-all flex items-center gap-1.5 shadow-sm">
            <span className="material-symbols-outlined text-base">upload_file</span>
            <span>Carga Masiva (CSV)</span>
          </button>
          <button onClick={() => setEditing('new')}
            className="text-xs px-5 py-2.5 bg-secondary hover:bg-secondary/90 text-on-secondary font-extrabold shadow-sm rounded-full transition-all flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">add</span>
            <span>Nuevo Producto</span>
          </button>
        </div>
      </div>

      {huerfanos > 0 && (
        <div className="bg-primary-container text-on-primary-container px-5 py-4 rounded-2xl flex items-center justify-between border border-outline-variant/40 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-xl leading-none select-none text-primary">warning</span>
            <span className="text-sm font-sans">
              Hay <strong>{huerfanos} producto{huerfanos > 1 ? 's activos' : ' activo'} sin enlaces</strong> de competencia registrados para el scraper.
            </span>
          </div>
          <button onClick={() => setFiltroUrls('sin_urls')}
            className="text-xs px-4 py-2 bg-white text-primary hover:bg-surface-low rounded-full font-bold shadow-sm transition-all">
            Ver Cuáles
          </button>
        </div>
      )}

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

      {/* Structured Grid & Filters Area */}
      <div className="bg-white rounded-3xl border border-outline-variant p-5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
        <div className="flex-1 min-w-[280px] relative">
          <span className="material-symbols-outlined text-on-surface-variant absolute left-3 top-2.5 select-none">search</span>
          <input type="text" placeholder="Buscar por nombre, molécula, ID o laboratorio..."
            value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-outline-variant rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans" />
        </div>
        
        <div className="flex gap-4 flex-wrap">
          <div className="flex bg-surface-low rounded-full p-1 text-xs font-mono font-bold border border-outline-variant">
            <button onClick={() => setFiltroActivo('todos')}
              className={`px-4 py-1.5 rounded-full transition-all ${filtroActivo === 'todos' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-primary'}`}>TODOS</button>
            <button onClick={() => setFiltroActivo('activos')}
              className={`px-4 py-1.5 rounded-full transition-all ${filtroActivo === 'activos' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-primary'}`}>ACTIVOS</button>
            <button onClick={() => setFiltroActivo('inactivos')}
              className={`px-4 py-1.5 rounded-full transition-all ${filtroActivo === 'inactivos' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-primary'}`}>INACTIVOS</button>
          </div>

          <div className="flex bg-surface-low rounded-full p-1 text-xs font-mono font-bold border border-outline-variant">
            <button onClick={() => setFiltroUrls('todos')}
              className={`px-4 py-1.5 rounded-full transition-all ${filtroUrls === 'todos' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-primary'}`}>TODOS</button>
            <button onClick={() => setFiltroUrls('con_urls')}
              className={`px-4 py-1.5 rounded-full transition-all ${filtroUrls === 'con_urls' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-primary'}`}>CON ENLACES</button>
            <button onClick={() => setFiltroUrls('sin_urls')}
              className={`px-4 py-1.5 rounded-full transition-all ${filtroUrls === 'sin_urls' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-primary'}`}>SIN ENLACES</button>
          </div>
        </div>
      </div>

      {/* Main Table View */}
      <div className="bg-white rounded-3xl border border-outline-variant shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-on-surface-variant font-semibold animate-pulse flex flex-col items-center justify-center gap-2">
            <span className="material-symbols-outlined animate-spin text-3xl text-primary">autorenew</span>
            Cargando catálogo...
          </div>
        ) : filtrados.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant italic">
            {search || filtroActivo !== 'todos' || filtroUrls !== 'todos'
              ? 'No se encontraron productos con los filtros seleccionados.'
              : 'Aún no hay productos registrados. Sube un CSV o haz click en "+ Nuevo Producto".'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-surface-low text-primary text-xs uppercase font-mono tracking-wider border-b border-outline-variant">
                <tr>
                  <th className="text-left px-6 py-4 font-bold">ID</th>
                  <th className="text-left px-6 py-4 font-bold">Nombre / Molécula</th>
                  <th className="text-left px-6 py-4 font-bold">Concentración / Tamaño</th>
                  <th className="text-left px-6 py-4 font-bold">Laboratorio</th>
                  <th className="text-left px-6 py-4 font-bold">Categoría</th>
                  <th className="text-center px-6 py-4 font-bold">Enlaces Activos</th>
                  <th className="text-center px-6 py-4 font-bold">Estado</th>
                  <th className="text-right px-6 py-4 font-bold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {filtrados.map(p => {
                  const links = urlsPorProducto.get(p.id_interno) || [];
                  const count = links.length;
                  return (
                    <tr key={p.id} className="hover:bg-surface-low transition-colors">
                      <td className="px-6 py-4 font-mono text-xs text-primary font-bold">{p.id_interno}</td>
                      <td className="px-6 py-4">
                        <div className="font-bold text-on-surface text-base font-display">{p.nombre}</div>
                        <div className="text-xs text-on-surface-variant font-mono mt-0.5">{p.principio_activo || 'Sin molécula'}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-on-surface font-semibold">{p.concentracion || '—'}</div>
                        <div className="text-xs text-on-surface-variant font-mono mt-0.5">{p.tamano || '—'}</div>
                      </td>
                      <td className="px-6 py-4 text-on-surface">{p.laboratorio || '—'}</td>
                      <td className="px-6 py-4">
                        <span className="px-3 py-1 text-xs rounded-full bg-surface-low text-on-surface font-medium border border-outline-variant">
                          {p.categoria || 'Otros'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full font-mono text-xs font-bold ${
                          count === 0
                            ? 'bg-error-container text-error border border-error/20'
                            : 'bg-primary-container text-on-primary-container border border-outline-variant/30'
                        }`}>
                          <span className="material-symbols-outlined text-sm leading-none">{count === 0 ? 'link_off' : 'link'}</span>
                          {count === 0 ? 'Sin Enlaces' : `${count} Enlace${count > 1 ? 's' : ''}`}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button onClick={() => handleToggleActivo(p)}
                          className={`text-xs px-3 py-1 rounded-full font-bold uppercase tracking-wider transition-all ${
                            p.activo ? 'bg-secondary/15 text-secondary border border-secondary/30' : 'bg-surface-low text-on-surface-variant border border-outline-variant/40'
                          }`}>
                          {p.activo ? 'Activo' : 'Inactivo'}
                        </button>
                      </td>
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        <button onClick={() => setEditing(p.id)}
                          className="text-xs text-primary hover:text-primary/85 font-bold mr-4 inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">edit</span>
                          Editar
                        </button>
                        <button onClick={() => handleDelete(p)}
                          className="text-xs text-error hover:text-error/85 font-bold inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">delete</span>
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create/Edit Product Modal */}
      {editing && (
        <ProductoModal
          producto={editing === 'new' ? null : productos.find(p => p.id === editing)}
          sugerirId={sugerirId}
          onSave={handleSave}
          cadenas={cadenas}
          competenciaActual={competencia}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Custom Confirmation Dialog */}
      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar Producto?"
        message={
          confirmDelete 
            ? `¿Estás seguro de que deseas eliminar "${confirmDelete.nombre}"?${
                (urlsPorProducto.get(confirmDelete.id_interno) || []).length > 0 
                  ? `\n\nATENCIÓN: este producto tiene ${(urlsPorProducto.get(confirmDelete.id_interno) || []).length} URL(s) de competencia activa(s) que también se eliminarán.`
                  : ''
              }\n\nEsta acción no se puede deshacer.`
            : ''
        }
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* CSV Import Modal */}
      {showCsvModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-white rounded-3xl shadow-xl max-w-lg w-full p-6 space-y-4 border border-outline-variant">
            <div className="flex items-center justify-between border-b pb-3 border-outline-variant">
              <h2 className="text-xl font-display font-extrabold text-primary">Importación Masiva (CSV)</h2>
              <button onClick={() => setShowCsvModal(false)} className="text-on-surface-variant hover:text-on-surface text-2xl leading-none">×</button>
            </div>
            <div className="space-y-4 text-sm text-on-background">
              <p>
                Sube tu catálogo y enlaces de competidores de forma masiva. El archivo debe estar delimitado por comas.
              </p>
              <div className="bg-surface-low p-4 rounded-2xl border border-outline-variant space-y-1.5 font-mono text-xs">
                <div className="font-bold text-primary border-b pb-1 mb-1 border-outline-variant flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-sm">lists</span>
                  Columnas Admitidas:
                </div>
                <div>id_interno <span className="text-on-surface-variant font-sans font-medium">(Obligatorio)</span></div>
                <div>nombre <span className="text-on-surface-variant font-sans font-medium">(Obligatorio)</span></div>
                <div>principio_activo <span className="text-on-surface-variant font-sans font-medium">(Molécula)</span></div>
                <div>concentracion, tamano, laboratorio, categoria</div>
                <div>url_farmatodo, url_locatel <span className="text-on-surface-variant font-sans font-medium">(Enlaces opcionales)</span></div>
              </div>
              <div className="flex justify-between items-center pt-2">
                <button type="button" onClick={downloadExampleCsv}
                  className="text-xs text-primary font-bold hover:underline inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">download</span>
                  Descargar Plantilla Ejemplo CSV
                </button>
              </div>

              {/* Drag and Drop Zone */}
              <div className="border-2 border-dashed border-outline hover:border-primary transition-colors rounded-2xl p-8 text-center cursor-pointer bg-surface-low"
                onClick={() => fileInputRef.current.click()}>
                <span className="material-symbols-outlined text-4xl text-primary">upload_file</span>
                <p className="mt-2 text-sm font-bold text-primary">Haz click o arrastra tu archivo CSV aquí</p>
                <p className="text-xs text-on-surface-variant mt-1">Soporta formato .csv delimitado por comas</p>
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

function ProductoModal({ producto, sugerirId, onSave, cadenas, competenciaActual, onClose }) {
  const isNew = !producto;
  const [form, setForm] = useState({
    id_interno: producto?.id_interno || sugerirId(),
    nombre: producto?.nombre || '',
    laboratorio: producto?.laboratorio || '',
    principio_activo: producto?.principio_activo || '',
    concentracion: producto?.concentracion || '',
    tamano: producto?.tamano || '',
    presentacion: producto?.presentacion || '',
    categoria: producto?.categoria || '',
    activo: producto?.activo ?? true,
  });

  const initialUrls = useMemo(() => {
    const urls = {};
    cadenas.forEach(c => {
      const existing = competenciaActual.find(
        pc => pc.id_producto_propio === (producto?.id_interno || '') && pc.cadena === c.nombre
      );
      urls[c.nombre] = {
        url: existing?.url || '',
        marca: existing?.marca || '',
        tipo: existing?.tipo || 'alternativa',
      };
    });
    return urls;
  }, [cadenas, competenciaActual, producto]);

  const [activeUrls, setActiveUrls] = useState(initialUrls);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSave(form, isNew, activeUrls);
    setSaving(false);
  };

  const handleChange = (key, value) => setForm(f => ({ ...f, [key]: value }));
  const handleUrlChange = (chainName, field, value) => {
    setActiveUrls(prev => ({
      ...prev,
      [chainName]: {
        ...prev[chainName],
        [field]: value,
      }
    }));
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-xl max-w-2xl w-full max-h-[92vh] flex flex-col border border-outline-variant"
        onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-xl font-display font-extrabold text-primary">{isNew ? 'Registrar Nuevo Producto' : 'Editar Propiedades'}</h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface text-xl leading-none">×</button>
        </div>
        
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="ID Interno *" hint="Código único (ej: P001)">
              <input type="text" required value={form.id_interno}
                onChange={e => handleChange('id_interno', e.target.value)}
                disabled={!isNew}
                className="w-full px-4 py-2 border border-outline-variant rounded-xl disabled:bg-surface-low focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-mono text-sm" />
            </Field>
            
            <Field label="Nombre Comercial *" hint="Ej. Atamel">
              <input type="text" required value={form.nombre}
                onChange={e => handleChange('nombre', e.target.value)}
                placeholder="Nombre comercial"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm" />
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Molécula / Principio">
              <input type="text" value={form.principio_activo}
                onChange={e => handleChange('principio_activo', e.target.value)}
                placeholder="Acetaminofén"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary text-sm" />
            </Field>

            <Field label="Concentración" hint="Ej: 500 mg, 10%">
              <input type="text" value={form.concentracion}
                onChange={e => handleChange('concentracion', e.target.value)}
                placeholder="500 mg"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary text-sm" />
            </Field>

            <Field label="Tamaño / Unidades" hint="Ej: 10 tabletas">
              <input type="text" value={form.tamano}
                onChange={e => handleChange('tamano', e.target.value)}
                placeholder="10 tabletas"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary text-sm" />
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Laboratorio">
              <input type="text" value={form.laboratorio}
                onChange={e => handleChange('laboratorio', e.target.value)}
                placeholder="La Santé"
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary text-sm" />
            </Field>

            <Field label="Categoría">
              <select value={form.categoria} onChange={e => handleChange('categoria', e.target.value)}
                className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary bg-white text-sm">
                <option value="">— Selecciona —</option>
                {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>

          {/* Dynamic Competition URL Fields */}
          <div className="border-t border-outline-variant pt-5 space-y-4">
            <h3 className="text-md font-display font-extrabold text-primary flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">link</span>
              Enlaces de Competencia por Cadena
              <span className="text-xs font-mono font-normal text-on-surface-variant">(Se monitorearán automáticamente)</span>
            </h3>

            {cadenas.length === 0 ? (
              <p className="text-xs text-on-surface-variant italic">No hay cadenas de farmacias registradas en el sistema. Agrégalas en la sección "Cadenas".</p>
            ) : (
              <div className="space-y-4 bg-surface-low p-4 rounded-2xl border border-outline-variant">
                {cadenas.map(c => {
                  const data = activeUrls[c.nombre] || { url: '', marca: '', tipo: 'alternativa' };
                  return (
                    <div key={c.nombre} className="grid grid-cols-1 md:grid-cols-12 gap-3 pb-3 border-b border-outline-variant last:border-0 last:pb-0">
                      <div className="md:col-span-3 flex flex-col justify-center">
                        <span className="text-sm font-bold text-primary">{c.nombre}</span>
                        <span className="text-xs text-on-surface-variant font-mono">{c.website ? new URL(c.website).hostname : ''}</span>
                      </div>
                      
                      <div className="md:col-span-6">
                        <input type="url" value={data.url}
                          onChange={e => handleUrlChange(c.nombre, 'url', e.target.value)}
                          placeholder={`https://www.${c.nombre.toLowerCase()}.com/producto/...`}
                          className="w-full px-3 py-1.5 border border-outline-variant rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary" />
                      </div>

                      <div className="md:col-span-3">
                        <input type="text" value={data.marca}
                          onChange={e => handleUrlChange(c.nombre, 'marca', e.target.value)}
                          placeholder="Marca o Variante"
                          className="w-full px-3 py-1.5 border border-outline-variant rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-between items-center pt-4 border-t border-outline-variant">
            <label className="flex items-center gap-2 cursor-pointer font-bold text-xs text-primary select-none">
              <input type="checkbox" checked={form.activo}
                onChange={e => handleChange('activo', e.target.checked)}
                className="rounded text-primary focus:ring-primary h-4 w-4" />
              <span>PRODUCTO ACTIVO</span>
            </label>
            
            <div className="flex gap-2">
              <button type="button" onClick={onClose}
                className="px-5 py-2 border border-outline rounded-full text-xs font-bold hover:bg-surface-low text-on-surface-variant">
                Cancelar
              </button>
              <button type="submit" disabled={saving}
                className="px-6 py-2 bg-secondary hover:bg-secondary/90 text-on-secondary rounded-full text-xs font-extrabold shadow-sm transition-all">
                {saving ? 'Guardando...' : isNew ? 'Registrar' : 'Guardar Cambios'}
              </button>
            </div>
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
