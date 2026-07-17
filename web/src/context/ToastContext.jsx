import { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
    
    // Auto remove after 4 seconds
    setTimeout(() => {
      removeToast(id);
    }, 4000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      
      {/* Floating Toast Container */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none">
        {toasts.map((t) => {
          let bgColor = 'bg-white border-outline-variant';
          let textColor = 'text-on-surface';
          let icon = 'info';
          let iconColor = 'text-primary';

          if (t.type === 'success') {
            bgColor = 'bg-emerald-50 border-emerald-200';
            textColor = 'text-emerald-900';
            icon = 'check_circle';
            iconColor = 'text-emerald-600';
          } else if (t.type === 'error') {
            bgColor = 'bg-red-50 border-red-200';
            textColor = 'text-red-900';
            icon = 'error';
            iconColor = 'text-red-600';
          } else if (t.type === 'warning') {
            bgColor = 'bg-amber-50 border-amber-200';
            textColor = 'text-amber-900';
            icon = 'warning';
            iconColor = 'text-amber-600';
          }

          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-3 p-4 rounded-2xl border shadow-lg transition-all duration-300 transform translate-y-0 animate-fade-in-slide ${bgColor} ${textColor}`}
              role="alert"
            >
              <span className={`material-symbols-outlined select-none text-xl shrink-0 ${iconColor}`}>
                {icon}
              </span>
              <div className="flex-1 text-xs font-semibold leading-relaxed">
                {t.message}
              </div>
              <button
                onClick={() => removeToast(t.id)}
                className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0"
              >
                <span className="material-symbols-outlined select-none text-base">close</span>
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
