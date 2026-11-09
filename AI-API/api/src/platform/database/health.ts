import { sql } from "./client";

export async function checkDatabaseHealth() {
  try {
    await sql`SELECT 1`;

    return {
      status: "UP",
    };
  } catch {
    return {
      status: "DOWN",
    };
  }
}