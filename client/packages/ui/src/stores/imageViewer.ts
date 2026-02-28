import type { Attachment } from '@meza/core';
import { create } from 'zustand';

interface ImageViewerState {
  open: boolean;
  attachments: Attachment[];
  channelId: string;
  currentIndex: number;
}

interface ImageViewerActions {
  openViewer: (
    attachments: Attachment[],
    startIndex: number,
    channelId: string,
  ) => void;
  closeViewer: () => void;
  setIndex: (index: number) => void;
}

export const useImageViewerStore = create<
  ImageViewerState & ImageViewerActions
>((set, get) => ({
  open: false,
  attachments: [],
  channelId: '',
  currentIndex: 0,

  openViewer: (attachments, startIndex, channelId) =>
    set({ open: true, attachments, currentIndex: startIndex, channelId }),

  closeViewer: () =>
    set({ open: false, attachments: [], currentIndex: 0, channelId: '' }),

  setIndex: (index) => {
    const { attachments } = get();
    if (index >= 0 && index < attachments.length) {
      set({ currentIndex: index });
    }
  },
}));
