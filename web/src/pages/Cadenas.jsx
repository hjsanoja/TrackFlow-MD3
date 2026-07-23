import { useEffect, useState, useMemo } from 'react';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';

// Scrapers disponibles en el código actual
const SCRAPERS_DISPONIBLES = [
  { value: 'farmatodo', label: 'Farmatodo' },
  { value: 'locatel', label: 'Locatel' },
  { value: 'farmaciasaas', label: 'Farmacias SAAS' },
  { value: 'farmadon', label: 'FarmaDON (pendiente)' },
  { value: 'grupo_san_ignacio', label: 'Grupo San Ignacio (pendiente)' },
  { value: 'xana', label: 'Farmacias Xana (pendiente)' },
  { value: 'farmago', label: 'FarmaGo (pendiente)' },
];

const SCRAPERS_IMPLEMENTADOS = new Set(['farmatodo', 'locatel', 'farmaciasaas', 'saas']);

export default function Cadenas() {
  const {
    cadenas,
    productosCompetencia: competencia,
    loadingInitial: loading,
    refreshData: cargar
  } = useData();

  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const { addToast } = useToast();

  // Cuenta URLs activas por cadena
  const urlsPorCadena = useMemo(() => {
    const map = new Map();
    for (const c of competencia) {
      if (c.activo) {
        map.set(c.cadena, (map.get(c.cadena) || 0) + 1);
      }
    }
    return map;
  }, [competencia]);

  const handleSave = async (data, isNew) => {
    try {
      const docId = data.nombre.trim().replace(/\s+/g, '_');
      if (!docId) throw new Error('El nombre es obligatorio');
      if (isNew && cadenas.some(c => c.id === docId)) {
        throw new Error('Ya existe una cadena con ese nombre');
      }
      await setDoc(doc(db, 'cadenas', docId), {
        nombre: data.nombre.trim(),
        website: data.website.trim(),
        scraper_modulo: data.scraper_modulo,
        activo: data.activo,
      });
      addToast(isNew ? 'Cadena creada con éxito' : 'Cambios guardados con éxito', 'success');
      setEditing(null);
      await cargar();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleDelete = (cadena) => {
    setConfirmDelete(cadena);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const cadena = confirmDelete;
    setConfirmDelete(null);
    try {
      await deleteDoc(doc(db, 'cadenas', cadena.id));
      addToast('Cadena eliminada con éxito', 'success');
      await cargar();
    } catch (err) {
      addToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  const handleToggleActivo = async (cadena) => {
    try {
      await setDoc(doc(db, 'cadenas', cadena.id), {
        activo: !cadena.activo,
      }, { merge: true });
      await cargar();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  return (
    <div className="space-y-6 text-on-surface">
      {/* Title Header Block */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-outline-variant pb-4 gap-4">
        <div>
          <h1 className="text-3xl font-display font-extrabold text-primary tracking-tight">Cadenas de Monitoreo</h1>
          <p className="text-sm text-on-surface-variant font-sans mt-1">
            Administra las cadenas de farmacias registradas en el robot de extracción.
          </p>
        </div>
        <button onClick={() => setEditing('new')}
          className="text-xs px-5 py-2.5 bg-secondary hover:bg-secondary/90 text-on-secondary font-extrabold shadow-sm rounded-full transition-all flex items-center gap-1.5 self-start">
          <span className="material-symbols-outlined text-base">add</span>
          <span>Agregar Cadena</span>
        </button>
      </div>

      <div className="bg-primary-container border border-outline-variant/40 rounded-2xl px-5 py-4 text-xs text-on-primary-container space-y-1.5 shadow-sm">
        <div className="flex items-center gap-2 font-mono font-bold text-sm text-primary">
          <span className="material-symbols-outlined text-lg leading-none">info</span>
          <span>Información Técnica del Scraper</span>
        </div>
        <p className="font-sans text-xs text-on-surface-variant">
          La inserción de una cadena en esta sección registra la marca comercial en el catálogo de competencia. Recuerda que la ejecución diaria depende de que el robot Python respectivo esté programado en el motor de extracción backend para la descarga directa de datos.
        </p>
      </div>

      {/* Main Grid View */}
      <div className="bg-white rounded-3xl border border-outline-variant shadow-sm overflow-hidden">
        {loading ? (
          <div className="overflow-x-auto animate-pulse">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-surface-low text-primary text-xs uppercase font-mono tracking-wider border-b border-outline-variant">
                <tr>
                  <th className="text-left px-6 py-4 font-bold">Nombre Cadena</th>
                  <th className="text-left px-6 py-4 font-bold">Portal Website</th>
                  <th className="text-left px-6 py-4 font-bold">Identificador Técnico Scraper</th>
                  <th className="text-center px-6 py-4 font-bold">URLs Activas Scrapeadas</th>
                  <th className="text-center px-6 py-4 font-bold">Estado</th>
                  <th className="text-right px-6 py-4 font-bold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {[1, 2, 3].map((n) => (
                  <tr key={n}>
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-2/3"></div></td>
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-3/4"></div></td>
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-1/2"></div></td>
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-12 mx-auto"></div></td>
                    <td className="px-6 py-4"><div className="h-6 bg-gray-200 rounded-full w-14 mx-auto"></div></td>
                    <td className="px-6 py-4 text-right"><div className="h-4 bg-gray-200 rounded w-16 ml-auto"></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : cadenas.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant italic">
            Aún no hay cadenas registradas. Crea una para empezar.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-surface-low text-primary text-xs uppercase font-mono tracking-wider border-b border-outline-variant">
                <tr>
                  <th className="text-left px-6 py-4 font-bold">Nombre Cadena</th>
                  <th className="text-left px-6 py-4 font-bold">Portal Website</th>
                  <th className="text-left px-6 py-4 font-bold">Identificador Técnico Scraper</th>
                  <th className="text-center px-6 py-4 font-bold">URLs Activas Scrapeadas</th>
                  <th className="text-center px-6 py-4 font-bold">Estado</th>
                  <th className="text-right px-6 py-4 font-bold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {cadenas.map(c => {
                  const implementado = SCRAPERS_IMPLEMENTADOS.has(c.scraper_modulo);
                  const count = urlsPorCadena.get(c.nombre) || 0;
                  return (
                    <tr key={c.id} className="hover:bg-surface-low transition-colors">
                      <td className="px-6 py-4 font-bold text-on-surface font-display text-sm">{c.nombre}</td>
                      <td className="px-6 py-4">
                        {c.website ? (
                          <a href={c.website} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-mono text-primary hover:underline flex items-center gap-0.5">
                            <span>{c.website.replace(/^https?:\/\/(www\.)?/, '')}</span>
                            <span className="material-symbols-outlined text-[11px] leading-none">open_in_new</span>
                          </a>
                        ) : (
                          <span className="text-gray-300 font-mono select-none">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-on-surface">
                        <code className="bg-surface-low border border-outline-variant px-2.5 py-1 rounded-md font-bold">{c.scraper_modulo}</code>
                        {!implementado && (
                          <span className="ml-2 font-bold uppercase tracking-wider text-[10px] text-error bg-error-container border border-error/20 px-2 py-0.5 rounded-full">Pendiente</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center font-mono">
                        <span className={`inline-flex px-3 py-1 text-xs rounded-full font-bold ${
                          count === 0 ? 'bg-surface-low text-on-surface-variant border border-outline-variant' : 'bg-primary-container text-on-primary-container'
                        }`}>
                          {count} URLs
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button onClick={() => handleToggleActivo(c)}
                          className={`text-[10px] uppercase font-bold px-3 py-1 rounded-full transition-all ${
                            c.activo ? 'bg-secondary/15 text-secondary border border-secondary/30 shadow-sm' : 'bg-surface-low text-on-surface-variant border border-outline-variant/40'
                          }`}>
                          {c.activo ? 'Activo' : 'Inactivo'}
                        </button>
                      </td>
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        <button onClick={() => setEditing(c.id)}
                          className="text-xs text-primary hover:text-primary/80 font-bold mr-4 inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">edit</span>
                          Editar
                        </button>
                        <button onClick={() => handleDelete(c)}
                          className="text-xs text-error hover:text-error/80 font-bold inline-flex items-center gap-1">
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

      {editing && (
        <CadenaModal
          cadena={editing === 'new' ? null : cadenas.find(c => c.id === editing)}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Custom Confirmation Dialog */}
      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar Cadena de Monitoreo?"
        message={
          confirmDelete 
            ? `¿Estás seguro de que deseas eliminar la cadena de monitoreo "${confirmDelete.nombre}"?${
                (urlsPorCadena.get(confirmDelete.nombre) || 0) > 0 
                  ? `\n\nATENCIÓN: hay ${urlsPorCadena.get(confirmDelete.nombre)} URL(s) activa(s) asignadas a esta cadena. Esas URLs quedarán huérfanas pero no se eliminan automáticamente.`
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
    </div>
  );
}

function CadenaModal({ cadena, onSave, onClose }) {
  const isNew = !cadena;
  const [form, setForm] = useState({
    nombre: cadena?.nombre || '',
    website: cadena?.website || '',
    scraper_modulo: cadena?.scraper_modulo || 'farmatodo',
    activo: cadena?.activo ?? true,
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSave(form, isNew);
    setSaving(false);
  };
  const handleChange = (key, value) => setForm(f => ({ ...f, [key]: value }));

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-xl max-w-lg w-full flex flex-col border border-outline-variant"
        onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-xl font-display font-extrabold text-primary">{isNew ? 'Registrar Cadena' : 'Editar Cadena'}</h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <Field label="Nombre Comercial *" hint="Ej. Locatel, Farmatodo, FarmaDON">
            <input type="text" required value={form.nombre}
              onChange={e => handleChange('nombre', e.target.value)}
              disabled={!isNew}
              placeholder="Nombre comercial de la cadena"
              className="w-full px-4 py-2 border border-outline-variant rounded-xl disabled:bg-surface-low focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface" />
          </Field>

          <Field label="Website Principal" hint="Sitio web de e-commerce de la cadena">
            <input type="url" value={form.website}
              onChange={e => handleChange('website', e.target.value)}
              placeholder="https://www.ejemplo.com.ve"
              className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm text-on-surface" />
          </Field>

          <Field label="Identificador Técnico Robot" hint="Módulo Python de scraping asociado en backend">
            <select required value={form.scraper_modulo}
              onChange={e => handleChange('scraper_modulo', e.target.value)}
              className="w-full px-4 py-2 border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary font-sans text-sm bg-white text-on-surface">
              {SCRAPERS_DISPONIBLES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Estado Monitoreo">
            <label className="flex items-center gap-2 px-4 py-3 border border-outline rounded-xl cursor-pointer font-bold text-xs text-primary bg-surface-low select-none">
              <input type="checkbox" checked={form.activo}
                onChange={e => handleChange('activo', e.target.checked)}
                className="rounded text-primary focus:ring-primary h-4 w-4" />
              <span>ACTIVAR ROBOTS DE EXTRACCIÓN DIARIA</span>
            </label>
          </Field>

          <div className="flex justify-end gap-2 pt-4 border-t border-outline-variant">
            <button type="button" onClick={onClose}
              className="px-5 py-2 border border-outline rounded-full text-xs font-bold hover:bg-surface-low text-on-surface-variant">Cancelar</button>
            <button type="submit" disabled={saving}
              className="px-6 py-2 bg-secondary hover:bg-secondary/90 text-on-secondary rounded-full text-xs font-bold shadow-sm transition-all">
              {saving ? 'Guardando...' : isNew ? 'Registrar' : 'Guardar Cambios'}
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
