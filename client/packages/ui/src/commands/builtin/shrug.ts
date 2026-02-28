import { registerCommand } from '../registry.ts';

registerCommand({
  name: 'shrug',
  description: 'Appends \u00AF\\_(\u30C4)_/\u00AF to your message',
  execute: (args, ctx) => {
    const text = args.trim();
    ctx.sendMessage(
      text ? `${text} \u00AF\\_(\u30C4)_/\u00AF` : '\u00AF\\_(\u30C4)_/\u00AF',
    );
  },
});
