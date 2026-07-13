import { useEffect } from 'react';

export default function ConfirmModal({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = 'Confirmar',
  cancelText = 'Cancelar',
  isDanger = false
}) {
  // Prevent scrolling of background when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in text-[#1c1b1f]"
      onClick={onCancel}
    >
      <div 
        className="bg-white rounded-[28px] shadow-xl max-w-md w-full flex flex-col border border-[#e1e2ec] overflow-hidden transform transition-all animate-scale-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header Block */}
        <div className="px-6 py-5 border-b border-[#e1e2ec] flex items-center justify-between">
          <h2 className={`text-lg font-display font-extrabold tracking-tight ${isDanger ? 'text-error' : 'text-[#040d53]'}`}>
            {title}
          </h2>
          <button 
            onClick={onCancel} 
            className="text-[#464650] hover:text-black text-2xl leading-none font-bold"
          >
            ×
          </button>
        </div>

        {/* Content Area */}
        <div className="p-6">
          <p className="text-sm text-[#464650] whitespace-pre-line leading-relaxed font-sans">
            {message}
          </p>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-surface-low border-t border-[#e1e2ec] flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-5 py-2.5 bg-white hover:bg-[#e1e2ec]/30 border border-[#c6c5d2] rounded-full text-xs font-bold text-[#464650] transition-all"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-5 py-2.5 rounded-full text-xs font-bold text-white transition-all shadow-sm ${
              isDanger 
                ? 'bg-error hover:bg-error/90 active:bg-error' 
                : 'bg-primary hover:bg-primary/90 active:bg-primary'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
