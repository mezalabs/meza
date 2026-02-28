export interface SlashCommandArg {
  name: string;
  description: string;
  required: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  args?: SlashCommandArg[];
  /** If true, this command does not send a message (e.g., tiling commands). */
  silent?: boolean;
  execute: (args: string, context: CommandContext) => void | Promise<void>;
}

export interface CommandContext {
  channelId: string;
  serverId?: string;
  sendMessage: (text: string) => void;
}

const commands: Map<string, SlashCommand> = new Map();

export function registerCommand(command: SlashCommand) {
  commands.set(command.name, command);
}

export function getCommand(name: string): SlashCommand | undefined {
  return commands.get(name);
}

export function searchCommands(query: string): SlashCommand[] {
  const lower = query.toLowerCase();
  return Array.from(commands.values()).filter(
    (cmd) =>
      cmd.name.includes(lower) || cmd.description.toLowerCase().includes(lower),
  );
}

export function getAllCommands(): SlashCommand[] {
  return Array.from(commands.values());
}
