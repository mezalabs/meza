// search/types.ts — shared between main thread and worker

export interface IndexableMessage {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly content: string;
  readonly createdAt: number; // unix ms
  readonly hasAttachment: boolean;
  readonly hasMention: boolean;
}

export interface SearchOpts {
  readonly channelId?: string;
  readonly authorId?: string;
  readonly before?: number; // unix ms
  readonly after?: number;
  readonly hasAttachment?: boolean;
  readonly limit?: number;
}

export interface SearchHit {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly hasAttachment: boolean;
  readonly hasMention: boolean;
  // content NOT stored in FlexSearch — fetched from message store on demand
}

// Worker RPC protocol
export type WorkerRequest =
  | { id: number; method: 'initChannel'; args: [string] }
  | { id: number; method: 'addMessages'; args: [string, IndexableMessage[]] }
  | { id: number; method: 'updateMessage'; args: [string, IndexableMessage] }
  | { id: number; method: 'removeMessage'; args: [string, string] }
  | { id: number; method: 'removeMessages'; args: [string, string[]] }
  | { id: number; method: 'search'; args: [string, SearchOpts] }
  | { id: number; method: 'flush'; args: [] }
  | { id: number; method: 'clearChannel'; args: [string] }
  | { id: number; method: 'clearAll'; args: [] };

export type WorkerResponse =
  | { id: number; result: unknown }
  | { id: number; error: string };
