import { createContext, useContext } from 'react';

// Split from ConfirmDialog.jsx so that file can export only the
// <ConfirmProvider> component - react-refresh/only-export-components warns
// (errors, under this project's lint config) when a component file also
// exports plain functions/hooks, since that defeats Fast Refresh for the
// component.
export const ConfirmContext = createContext(null);

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm() must be used inside <ConfirmProvider>');
  return ctx.confirm;
}

export function useAlert() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useAlert() must be used inside <ConfirmProvider>');
  return ctx.notify;
}
