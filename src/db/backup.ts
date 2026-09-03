import { getDb } from './index';

/**
 * Экспорт/импорт всей базы одним JSON.
 *
 * Формат намеренно плоский — «таблица: массив строк». Такой файл
 * читается pandas в одну строку (pd.json_normalize / pd.DataFrame),
 * то есть годится и как бэкап, и как выгрузка для анализа.
 */

/** Порядок важен: родители раньше детей, иначе внешние ключи не пройдут. */
const TABLES = [
  'muscles',
  'exercises',
  'exercise_muscles',
  'routines',
  'routine_exercises',
  'workouts',
  'sets',
  'set_intervals',
  'workout_pauses',
  'workout_exercise_notes',
  'bodyweight',
  'settings',
] as const;

export interface Backup {
  format: 'gymapp-backup';
  schema_version: number;
  exported_at: string;
  tables: Record<string, any[]>;
}

export async function exportBackup(): Promise<Backup> {
  const db = await getDb();
  const v = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');

  const tables: Record<string, any[]> = {};
  for (const name of TABLES) {
    tables[name] = await db.getAllAsync(`SELECT * FROM ${name}`);
  }

  return {
    format: 'gymapp-backup',
    schema_version: v?.user_version ?? 0,
    exported_at: new Date().toISOString(),
    tables,
  };
}

export function backupToJson(b: Backup): string {
  return JSON.stringify(b, null, 2);
}

export interface ImportResult {
  rows: number;
  skippedTables: string[];
}

/**
 * Импорт ЗАМЕЩАЕТ текущие данные целиком — сливать две базы нельзя:
 * id совпадут и связи перемешаются.
 *
 * Всё идёт одной транзакцией: если файл битый, база останется прежней.
 */
export async function importBackup(json: string): Promise<ImportResult> {
  let parsed: Backup;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('File is not valid JSON');
  }

  if (parsed?.format !== 'gymapp-backup' || !parsed.tables) {
    throw new Error('Not a GymApp backup file');
  }

  const db = await getDb();
  const cur = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = cur?.user_version ?? 0;

  if (parsed.schema_version > currentVersion) {
    throw new Error('Backup is from a newer app version');
  }

  let rows = 0;
  const skippedTables: string[] = [];

  await db.withTransactionAsync(async () => {
    // чистим в обратном порядке — сначала дети
    for (const name of [...TABLES].reverse()) {
      await db.runAsync(`DELETE FROM ${name}`);
    }

    for (const name of TABLES) {
      const data = parsed.tables[name];
      if (!Array.isArray(data) || data.length === 0) {
        if (!Array.isArray(data)) skippedTables.push(name);
        continue;
      }

      // колонки берём из файла: если схема с тех пор обросла новыми
      // необязательными полями, старый бэкап всё равно встанет
      const cols = Object.keys(data[0]);
      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${placeholders})`;

      for (const row of data) {
        await db.runAsync(sql, cols.map((c) => row[c] ?? null));
        rows++;
      }
    }
  });

  return { rows, skippedTables };
}
