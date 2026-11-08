import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import the full database array
import { INITIAL_RESOURCES } from '../src/seedData.ts';

const dbPath = path.join(__dirname, '../hai_database.json');
fs.writeFileSync(dbPath, JSON.stringify(INITIAL_RESOURCES, null, 2), 'utf-8');
console.log(`Successfully synced ${INITIAL_RESOURCES.length} records to hai_database.json`);
