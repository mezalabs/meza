import { useTilingStore } from '../../stores/tiling.ts';
import { registerCommand } from '../registry.ts';

registerCommand({
  name: 'horizontal',
  description: 'Split the current pane into stacked rows',
  silent: true,
  execute: () => {
    useTilingStore.getState().splitFocused('vertical');
  },
});
