import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.ts';
import { connectDb, disconnectDb, query } from './db.ts';

test('connects to PostgreSQL and executes a read-only query', async () => {
  try {
    await connectDb(loadConfig());
    const result = await query('SELECT 1::int AS value');

    assert.equal(result.rows[0]?.value, 1);
  } finally {
    await disconnectDb();
  }
});
