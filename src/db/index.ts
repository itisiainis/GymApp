import * as SQLite from 'expo-sqlite';
import { migrate } from './migrations';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Одно соединение на всё приложение. Первый вызов открывает базу,
 * включает внешние ключи и прогоняет миграции.
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('gym.db');
      // foreign_keys — настройка соединения, а не базы: ставится каждый раз.
      // WAL — быстрее пишет, что важно, раз мы пишем на каждое действие.
      await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      await migrate(db);
      await db.execAsync(`
        INSERT OR IGNORE INTO exercises (id, name, measurement_default) VALUES
          (1, 'Приседания', 'reps'),
          (2, 'Румынская тяга', 'reps'),
          (3, 'Планш', 'hold');
        INSERT OR IGNORE INTO routines (id, name) VALUES (1, 'День ног');
        INSERT OR IGNORE INTO routine_exercises (routine_id, exercise_id, position) VALUES
          (1, 1, 0), (1, 2, 1);
      `);
      return db;
    })();
  }
  return dbPromise;
}

/** ISO-8601 UTC — единственный формат времени в базе. */
export function now(): string {
  return new Date().toISOString();
}
