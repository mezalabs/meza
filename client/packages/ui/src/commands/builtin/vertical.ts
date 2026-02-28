import { useTilingStore } from '../../stores/tiling.ts';
import { registerCommand } from '../registry.ts';

registerCommand({
  name: 'vertical',
  description: 'Split the current pane into side-by-side columns',
  silent: true,
  execute: () => {
    useTilingStore.getState().splitFocused('horizontal');
  },
});
