import { MongoClient, Collection } from 'mongodb';
import { config } from '../config';

let client: MongoClient;

export async function getMongoClient(): Promise<MongoClient> {
  if (!client) {
    client = new MongoClient(config.mongoUrl);
    await client.connect();
    console.log('[MongoDB] Connected');
  }
  return client;
}

export async function getRawSignalsCollection(): Promise<Collection> {
  const c = await getMongoClient();
  const db = c.db('ims_signals');
  const col = db.collection('raw_signals');
  // Ensure indexes
  await col.createIndex({ workItemId: 1 });
  await col.createIndex({ componentId: 1 });
  await col.createIndex({ timestamp: -1 });
  return col;
}

export async function closeMongo(): Promise<void> {
  if (client) await client.close();
}
