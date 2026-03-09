import { create } from 'zustand';

export type ToastVariant = 'info' | 'warning' | 'error';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

export interface ToastState {
  toasts: Toast[];
}

export interface ToastActions {
  addToast: (message: string, variant?: ToastVariant) => void;
  dismissToast: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState & ToastActions>()((set) => ({
  toasts: [],

  addToast: (message, variant = 'info') => {
    const id = `toast-${++nextId}`;
    set((state) => ({ toasts: [...state.toasts, { id, message, variant }] }));

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, 5000);
  },

  dismissToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));
