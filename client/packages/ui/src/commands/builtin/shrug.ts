import { registerCommand } from '../registry.ts';

registerCommand({
  name: 'shrug',
  description: 'Appends ¯\\_(ツ)_/¯ to your message',
  execute: (args, ctx) => {
    const text = args.trim();
    ctx.sendMessage(text ? `${text} ¯\\\\\\_(ツ)\\_/¯` : '¯\\\\\\_(ツ)\\_/¯');
  },
});
