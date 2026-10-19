import { PostgresStore } from '../src/store/postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const store = new PostgresStore(url);
  await store.init();
  await store.close();
  console.log('schema applied');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
