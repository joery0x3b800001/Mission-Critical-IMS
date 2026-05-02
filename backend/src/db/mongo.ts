import { MongoClient, Collection } from 'mongodb';
import { config } from '../config';

let client: MongoClient;
let indexesInitialized = false;

export async function getMongoClient(): Promise<MongoClient> {
  if (!client) {
    client = new MongoClient(config.mongoUrl);
    await client.connect();
    console.log('[MongoDB] Connected');

    // Initialize indexes once at startup
    if (!indexesInitialized) {
      await initializeIndexes();
    }
  }
  return client;
}

async function initializeIndexes(): Promise<void> {
  try {
    const c = await getMongoClient();
    const db = c.db('ims_signals');
    const col = db.collection('raw_signals');

    // Create indexes with options
    await Promise.all([
      col.createIndex({ workItemId: 1 }, { name: 'idx_workItemId' }),
      col.createIndex({ componentId: 1 }, { name: 'idx_componentId' }),
      col.createIndex({ timestamp: -1 }, { name: 'idx_timestamp_desc' }),
      col.createIndex({ ingestedAt: -1 }, { name: 'idx_ingestedAt_desc' }),
      // TTL index: auto-delete raw signals after 30 days
      col.createIndex({ ingestedAt: 1 }, { expireAfterSeconds: 2592000, name: 'idx_ttl' }),
    ]);

    indexesInitialized = true;
    console.log('[MongoDB] Indexes initialized');
  } catch (err) {
    console.error('[MongoDB] Failed to initialize indexes:', (err as Error).message);
    throw err;
  }
}

export async function getRawSignalsCollection(): Promise<Collection> {
  const c = await getMongoClient();
  const db = c.db('ims_signals');
  // Return collection directly - indexes already created at startup
  return db.collection('raw_signals');
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null as any;
    indexesInitialized = false;
  }
}
