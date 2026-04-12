export interface SeedConfig {
  postgresUrl: string;
  scyllaHost: string;
  authPort: number;
  chatPort: number;
  keyPort: number;
}

export function loadConfig(): SeedConfig {
  return {
    postgresUrl:
      process.env.MEZA_POSTGRES_URL ??
      'postgres://meza:meza@localhost:5432/meza?sslmode=disable',
    scyllaHost: process.env.MEZA_SCYLLA_HOST ?? '127.0.0.1',
    authPort: Number(process.env.MEZA_AUTH_PORT ?? 8081),
    chatPort: Number(process.env.MEZA_CHAT_PORT ?? 8082),
    keyPort: Number(process.env.MEZA_KEY_PORT ?? 8088),
  };
}
