import { registerCommand } from '../registry.ts';

registerCommand({
  name: 'gif',
  description: 'Search for a GIF to send',
  args: [{ name: 'query', description: 'Search terms', required: true }],
  silent: true,
  execute: () => {
    // Handled specially by MessageComposer — opens the GIF picker.
  },
});
