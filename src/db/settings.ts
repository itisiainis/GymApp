import { getDb } from './index';

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key]
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

/* ---------------- Настройки записи подходов ---------------- */

export interface RecordingSettings {
  /**
   * Записывать подходы на повторы секундомером. Выключено — подход
   * засчитывается через RIR (см. lib/rir.ts), и это режим по умолчанию:
   * время подхода на повторы почти ничего не говорит о нагрузке.
   * Холды меряются временем всегда, независимо от этой настройки.
   *
   * Ключ в базе остался прежним (`advanced_reps`): смысл сменился, но
   * значение то же самое, и переносить его в новый ключ незачем.
   */
  advancedReps: boolean;
  /** Секунды, срезаемые в начале подхода: дойти до снаряда. */
  prepSeconds: number;
  /** Секунды, срезаемые в конце: дотянуться до телефона. */
  reachSeconds: number;
}

export const DEFAULT_RECORDING: RecordingSettings = {
  advancedReps: false,
  prepSeconds: 5,
  reachSeconds: 5,
};

export async function getRecordingSettings(): Promise<RecordingSettings> {
  const [adv, prep, reach] = await Promise.all([
    getSetting('advanced_reps'),
    getSetting('prep_seconds'),
    getSetting('reach_seconds'),
  ]);
  return {
    advancedReps: adv === '1',
    prepSeconds: prep === null ? DEFAULT_RECORDING.prepSeconds : Number(prep),
    reachSeconds: reach === null ? DEFAULT_RECORDING.reachSeconds : Number(reach),
  };
}

export async function setRecordingSettings(v: RecordingSettings): Promise<void> {
  await setSetting('advanced_reps', v.advancedReps ? '1' : '0');
  await setSetting('prep_seconds', String(v.prepSeconds));
  await setSetting('reach_seconds', String(v.reachSeconds));
}
