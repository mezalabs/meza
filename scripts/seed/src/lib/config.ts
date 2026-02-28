export interface SeedConfig {
  postgresUrl: string;
  authPort: number;
}

export function loadConfig(): SeedConfig {
  return {
    postgresUrl:
      process.env.MEZA_POSTGRES_URL ??
      'postgres://meza:meza@localhost:5432/meza?sslmode=disable',
    authPort: Number(process.env.MEZA_AUTH_PORT ?? 8081),
  };
}
