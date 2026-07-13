import { useEffect, useState } from 'react';
import { collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import ConfirmModal from '../components/ConfirmModal';

const ROLES = [
  { value: 'administrador', label: 'Administrador', desc: 'Acceso completo, puede editar todo' },
  { value: 'lector', label: 'Lector', desc: 'Solo ver y exportar datos' },
];

function emailToDocId(email) {
  return email.toLowerCase().replace('@', '_at_').replaceAll('.', '_');
}

export default function Usuarios({ userDoc }) {
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const cargar = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'usuarios'));
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      docs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      setUsuarios(docs);
    } catch (err) {
      setMessage({ type: 'error', text: 'Error al cargar: ' + err.message });
    }
    setLoading(false);
  };

  useEffect(() => { cargar(); }, []);

  const handleSave = async (data, isNew) => {
    try {
      const email = data.email.trim().toLowerCase();
      if (!email || !/\S+@\S+\.\S+/.test(email)) {
        throw new Error('Email inválido');
      }
      const docId = emailToDocId(email);
      if (isNew && usuarios.some(u => u.id === docId)) {
        throw new Error('Ya existe un usuario con ese email');
      }
      await setDoc(doc(db, 'usuarios', docId), {
        email,
        nombre: data.nombre.trim(),
        rol: data.rol,
        recibe_alertas_inmediatas: data.recibe_alertas_inmediatas,
        recibe_resumen_diario: data.recibe_resumen_diario,
        activo: data.activo,
      });
      setMessage({
        type: 'success',
        text: isNew
          ? `Usuario creado. IMPORTANTE: este usuario aún NO puede iniciar sesión. Crea su cuenta en Firebase Console con el mismo email.`
          : 'Cambios guardados con éxito'
      });
      setEditing(null);
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleDelete = (usuario) => {
    if (usuario.email === userDoc?.email) {
      setMessage({ type: 'error', text: 'No puedes eliminar tu propio usuario.' });
      return;
    }
    setConfirmDelete(usuario);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const usuario = confirmDelete;
    setConfirmDelete(null);
    try {
      await deleteDoc(doc(db, 'usuarios', usuario.id));
      setMessage({ type: 'success', text: 'Usuario eliminado con éxito de Firestore.' });
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: 'Error al eliminar: ' + err.message });
    }
  };

  const handleToggleActivo = async (usuario) => {
    if (usuario.email === userDoc?.email && usuario.activo) {
      setMessage({ type: 'error', text: 'No puedes desactivar tu propio usuario.' });
      return;
    }
    try {
      await setDoc(doc(db, 'usuarios', usuario.id), {
        activo: !usuario.activo,
      }, { merge: true });
      await cargar();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  return (
    <div className="space-y-6 text-[#1c1b1f]">
      {/* Title Header Block */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-[#e1e2ec] pb-4 gap-4">
        <div>
          <h1 className="text-3xl font-display font-extrabold text-[#040d53] tracking-tight">Usuarios Autorizados</h1>
          <p className="text-sm text-[#464650] font-sans mt-1">
            Administra los roles de acceso, credenciales y perfiles de alertas del sistema.
          </p>
        </div>
        <button onClick={() => setEditing('new')}
          className="text-xs px-5 py-2.5 bg-[#70C145] hover:bg-[#5ca536] text-[#040d53] font-extrabold shadow-sm rounded-full transition-all flex items-center gap-1.5 self-start">
          <span className="material-symbols-outlined text-base">person_add</span>
          <span>Invitar Usuario</span>
        </button>
      </div>

      {message && (
        <div className={`px-4 py-3.5 rounded-2xl text-sm font-semibold flex items-center justify-between border ${
          message.type === 'success' ? 'bg-[#f0f9eb] border-[#c2e7b0] text-[#3c763d]'
          : 'bg-[#fef0f0] border-[#fde2e2] text-[#93000a]'
        }`}>
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg">{message.type === 'success' ? 'check_circle' : 'error'}</span>
            {message.text}
          </span>
          <button onClick={() => setMessage(null)} className="ml-2 text-current hover:opacity-75 font-bold">×</button>
        </div>
      )}

      <div className="bg-[#e0e1f9] border border-[#c6c5d2]/40 rounded-2xl px-5 py-4 text-xs text-[#00174c] space-y-1.5 shadow-sm">
        <div className="flex items-center gap-2 font-mono font-bold text-sm text-[#040d53]">
          <span className="material-symbols-outlined text-lg leading-none">info</span>
          <span>Cómo invitar a un nuevo colaborador</span>
        </div>
        <ol className="list-decimal ml-5 mt-1 space-y-1 text-xs text-[#464650] font-sans">
          <li>Haz clic en el botón <strong>"Invitar Usuario"</strong> para registrar el correo y rol en Firestore.</li>
          <li>Accede a tu Firebase Console → Authentication → Add User para registrar su credencial de login formal con ese mismo correo.</li>
          <li>Suministra la contraseña de acceso temporal generada para su primer inicio de sesión.</li>
        </ol>
      </div>

      {/* Main Grid View */}
      <div className="bg-white rounded-3xl border border-[#e1e2ec] shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-[#464650] font-semibold animate-pulse flex flex-col items-center justify-center gap-2">
            <span className="material-symbols-outlined animate-spin text-3xl text-[#040d53]">autorenew</span>
            Cargando perfiles de usuario...
          </div>
        ) : usuarios.length === 0 ? (
          <div className="p-12 text-center text-[#464650] italic">
            Aún no hay usuarios registrados. Invita a alguien para empezar.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-[#f8f9fa] text-[#040d53] text-xs uppercase font-mono tracking-wider border-b border-[#e1e2ec]">
                <tr>
                  <th className="text-left px-6 py-4 font-bold">Nombre</th>
                  <th className="text-left px-6 py-4 font-bold">Email</th>
                  <th className="text-left px-6 py-4 font-bold">Rol</th>
                  <th className="text-center px-6 py-4 font-bold">Alertas Inmediatas</th>
                  <th className="text-center px-6 py-4 font-bold">Resumen Diario</th>
                  <th className="text-center px-6 py-4 font-bold">Estado</th>
                  <th className="text-right px-6 py-4 font-bold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e1e2ec]">
                {usuarios.map(u => {
                  const isCurrent = u.email === userDoc?.email;
                  return (
                    <tr key={u.id} className="hover:bg-[#f8f9fa] transition-colors">
                      <td className="px-6 py-4">
                        <span className="font-bold text-[#1c1b1f] font-display text-sm">{u.nombre}</span>
                        {isCurrent && (
                          <span className="ml-2 text-[10px] bg-[#dfe0ff] text-[#071155] font-mono uppercase font-bold px-2 py-0.5 rounded-full">
                            Tú
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-[#464650]">{u.email}</td>
                      <td className="px-6 py-4">
                        <span className={`text-[10px] uppercase font-mono font-bold px-2.5 py-1 rounded-full ${
                          u.rol === 'administrador' ? 'bg-[#e0e1f9] text-[#040d53]' : 'bg-[#f3f4f9] text-[#464650] border border-[#e1e2ec]'
                        }`}>
                          {u.rol}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {u.recibe_alertas_inmediatas ? (
                          <span className="material-symbols-outlined text-base text-[#70C145] select-none">check_circle</span>
                        ) : (
                          <span className="text-gray-300 font-mono select-none">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {u.recibe_resumen_diario ? (
                          <span className="material-symbols-outlined text-base text-[#70C145] select-none">check_circle</span>
                        ) : (
                          <span className="text-gray-300 font-mono select-none">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button onClick={() => handleToggleActivo(u)} disabled={isCurrent && u.activo}
                          className={`text-[10px] uppercase font-bold px-3 py-1 rounded-full transition-all ${
                            u.activo ? 'bg-[#70C145]/15 text-[#214f00] border border-[#70C145]/30' : 'bg-[#f3f4f9] text-[#464650] border border-[#e1e2ec]'
                          } ${isCurrent && u.activo ? 'opacity-50 cursor-not-allowed' : ''}`}>
                          {u.activo ? 'Activo' : 'Inactivo'}
                        </button>
                      </td>
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        <button onClick={() => setEditing(u.id)}
                          className="text-xs text-[#040d53] hover:text-[#040d53]/80 font-bold mr-4 inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">edit</span>
                          Editar
                        </button>
                        <button onClick={() => handleDelete(u)} disabled={isCurrent}
                          className={`text-xs text-[#93000a] hover:text-[#93000a]/80 font-bold inline-flex items-center gap-1 ${
                            isCurrent ? 'opacity-30 cursor-not-allowed' : ''
                          }`}>
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
        <UsuarioModal
          usuario={editing === 'new' ? null : usuarios.find(u => u.id === editing)}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Custom Confirmation Dialog */}
      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar Usuario?"
        message={
          confirmDelete 
            ? `¿Estás seguro de que deseas eliminar a "${confirmDelete.nombre}" (${confirmDelete.email})?\n\nIMPORTANTE: El documento se borrará de Firestore, pero su cuenta de Firebase Auth seguirá activa. Para impedir el inicio de sesión completamente, también debes eliminarla en Firebase Console → Authentication.`
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

function UsuarioModal({ usuario, onSave, onClose }) {
  const isNew = !usuario;
  const [form, setForm] = useState({
    email: usuario?.email || '',
    nombre: usuario?.nombre || '',
    rol: usuario?.rol || 'lector',
    recibe_alertas_inmediatas: usuario?.recibe_alertas_inmediatas ?? false,
    recibe_resumen_diario: usuario?.recibe_resumen_diario ?? true,
    activo: usuario?.activo ?? true,
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
      <div className="bg-white rounded-3xl shadow-xl max-w-lg w-full flex flex-col border border-[#e1e2ec]"
        onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-[#e1e2ec] flex items-center justify-between">
          <h2 className="text-xl font-display font-extrabold text-[#040d53]">{isNew ? 'Invitar Usuario' : 'Editar Usuario'}</h2>
          <button onClick={onClose} className="text-[#464650] hover:text-black text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <Field label="Correo Electrónico *">
            <input type="email" required value={form.email}
              onChange={e => handleChange('email', e.target.value)}
              disabled={!isNew}
              placeholder="correo@empresa.com"
              className="w-full px-4 py-2 border border-[#c6c5d2] rounded-xl disabled:bg-[#f3f4f9] focus:outline-none focus:ring-2 focus:ring-[#040d53]/25 focus:border-[#040d53] font-sans text-sm text-[#1c1b1f]" />
          </Field>
          <Field label="Nombre Completo *">
            <input type="text" required value={form.nombre}
              onChange={e => handleChange('nombre', e.target.value)}
              placeholder="Ej. Juan Pérez"
              className="w-full px-4 py-2 border border-[#c6c5d2] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#040d53]/25 focus:border-[#040d53] font-sans text-sm text-[#1c1b1f]" />
          </Field>
          <Field label="Rol Autorizado *">
            <div className="space-y-2">
              {ROLES.map(r => (
                <label key={r.value} className="flex items-start gap-3 p-3.5 border border-[#c6c5d2] rounded-2xl cursor-pointer hover:bg-[#f8f9fa] transition-all select-none">
                  <input type="radio" name="rol" value={r.value}
                    checked={form.rol === r.value}
                    onChange={e => handleChange('rol', e.target.value)}
                    className="mt-1 text-[#040d53] focus:ring-[#040d53] h-4 w-4" />
                  <div>
                    <div className="text-sm font-bold text-[#040d53]">{r.label}</div>
                    <div className="text-xs text-[#464650] mt-0.5 font-sans">{r.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Preferencias de Notificaciones">
            <div className="space-y-2 px-4 py-3 border border-[#c6c5d2] rounded-2xl bg-[#f8f9fa]">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={form.recibe_alertas_inmediatas}
                  onChange={e => handleChange('recibe_alertas_inmediatas', e.target.checked)}
                  className="rounded text-[#040d53] focus:ring-[#040d53] h-4 w-4" />
                <span className="text-xs font-bold text-[#040d53]">Alertas inmediatas cuando se cruce un umbral de volatilidad</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={form.recibe_resumen_diario}
                  onChange={e => handleChange('recibe_resumen_diario', e.target.checked)}
                  className="rounded text-[#040d53] focus:ring-[#040d53] h-4 w-4" />
                <span className="text-xs font-bold text-[#040d53]">Resumen diario consolidado por correo</span>
              </label>
            </div>
          </Field>
          <Field label="Estado del Acceso">
            <label className="flex items-center gap-2 px-4 py-3 border border-[#c6c5d2] rounded-xl cursor-pointer bg-[#f8f9fa] select-none font-bold text-xs text-[#040d53]">
              <input type="checkbox" checked={form.activo}
                onChange={e => handleChange('activo', e.target.checked)}
                className="rounded text-[#040d53] focus:ring-[#040d53] h-4 w-4" />
              <span>{form.activo ? 'ACCESO ACTIVO (Inicia sesión sin restricción)' : 'ACCESO INACTIVO (Bloqueo temporal)'}</span>
            </label>
          </Field>
          <div className="flex justify-end gap-2 pt-4 border-t border-[#e1e2ec]">
            <button type="button" onClick={onClose}
              className="px-5 py-2 border border-[#c6c5d2] rounded-full text-xs font-bold hover:bg-[#f8f9fa] text-[#464650]">Cancelar</button>
            <button type="submit" disabled={saving}
              className="px-6 py-2 bg-[#70C145] hover:bg-[#5ca536] text-[#040d53] rounded-full text-xs font-bold shadow-sm transition-all">
              {saving ? 'Guardando...' : isNew ? 'Invitar' : 'Guardar Cambios'}
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
      <label className="block text-xs font-mono font-bold uppercase tracking-wider text-[#040d53]">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-[#464650] font-mono">{hint}</p>}
    </div>
  );
}
