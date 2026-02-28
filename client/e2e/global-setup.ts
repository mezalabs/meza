import { expect, test as setup } from '@playwright/test';

const SERVICE_PORTS = [8080, 8081, 8082, 8083, 8084, 8085];

setup('health check services', async ({ request }) => {
  for (const port of SERVICE_PORTS) {
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const res = await request.get(`http://localhost:${port}/health`);
        if (res.ok()) {
          healthy = true;
          break;
        }
      } catch {
        // Service not up yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(healthy, `Service on port ${port} not healthy`).toBe(true);
  }
});
