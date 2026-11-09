import { Pool } from 'pg';
import {
  buildPostgresPoolConfig,
  logPostgresConnInfo,
} from './platform/database/postgres-env';

const conn = buildPostgresPoolConfig();
logPostgresConnInfo(conn);

const pool = new Pool(conn.poolConfig);

export default pool;
