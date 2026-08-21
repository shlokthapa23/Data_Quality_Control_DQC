import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, HelpCircle, Info } from 'lucide-react';
import { ConfirmContext } from './confirmContext';

/**
 * Replaces the browser's native window.confirm()/window.alert() everywhere in
 * the app with a themed card - the native dialogs are unstyled (show as
 * "localhost says"), block the JS thread, and can't be dismissed with Escape
 * consistently across browsers. This renders inline instead, matching every
 * other modal in the app (ColumnMapModal, AssetDetailModal, etc: fixed
 * inset-0 backdrop + centered white card).
 *
 * Usage (hooks live in confirmContext.js, split out so this file can stay a
 * component-only export for Fast Refresh):
 *   const confirmDialog = useConfirm(); const ok = await confirmDialog('Delete this?');
 *   const notify = useAlert(); await notify('Nothing new to add.');
 * Same call shape as window.confirm/window.alert - confirmDialog resolves a
 * boolean, notify resolves once dismissed - so call sites just add `await`
 * and drop the `window.` prefix.
 */
export function ConfirmProvider({ children }) {
  // mode: 'confirm' (Confirm/Cancel) or 'alert' (single OK button, no cancel)
  const [request, setRequest] = useState(null); // { message, confirmLabel, cancelLabel, tone, mode }
  const resolveRef = useRef(null);

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setRequest({
        mode: 'confirm',
        message,
        confirmLabel: opts.confirmLabel || 'Confirm',
        cancelLabel: opts.cancelLabel || 'Cancel',
        // 'danger' reads red for a destructive action (delete, discard);
        // default is the plain mastek-primary affirmative style.
        tone: opts.tone || 'default',
      });
    });
  }, []);

  const notify = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setRequest({
        mode: 'alert',
        message,
        confirmLabel: opts.confirmLabel || 'OK',
        tone: opts.tone || 'default',
      });
    });
  }, []);

  const settle = (result) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={{ confirm, notify }}>
      {children}
      {request && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onKeyDown={(e) => { if (e.key === 'Escape') settle(false); }}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-start gap-3 mb-5">
              <div className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-full ${
                request.tone === 'danger' ? 'bg-red-100 text-red-600' : 'bg-mastek-primary/10 text-mastek-primary'
              }`}>
                {request.tone === 'danger'
                  ? <AlertTriangle className="w-5 h-5" />
                  : request.mode === 'alert' ? <Info className="w-5 h-5" /> : <HelpCircle className="w-5 h-5" />}
              </div>
              <p className="text-sm text-slate-700 whitespace-pre-wrap pt-1.5">{request.message}</p>
            </div>
            <div className="flex items-center justify-end gap-2">
              {request.mode === 'confirm' && (
                <button
                  autoFocus
                  onClick={() => settle(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-500 rounded-lg hover:bg-slate-100"
                >
                  {request.cancelLabel}
                </button>
              )}
              <button
                autoFocus={request.mode === 'alert'}
                onClick={() => settle(true)}
                className={`px-4 py-2 text-sm font-medium text-white rounded-lg hover:brightness-110 ${
                  request.tone === 'danger' ? 'bg-red-600' : 'bg-mastek-primary'
                }`}
              >
                {request.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
