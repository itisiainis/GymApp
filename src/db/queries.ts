import { getDb, now } from './index';
import { getRecordingSettings } from './settings';

function shifted(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/* ------------------------------------------------------------------ */
/* Типы                                                                */
/* ------------------------------------------------------------------ */

export type MeasurementType = 'reps' | 'hold';

export interface Exercise {
  id: number;
  name: string;
  description: string | null;
  measurement_default: MeasurementType;
  is_custom: number;
}

export interface SetRow {
  id: number;
  workout_id: number;
  exercise_id: number;
  reps: number | null;
  weight_kg: number | null;
  started_at: string | null;
  ended_at: string | null;
  active_seconds: number;
  is_running: number;
}

export interface ActiveWorkout {
  id: number;
  routine_id: number;
  started_at: string;
  is_paused: number;
}

/* ------------------------------------------------------------------ */
/* Тренировка                                                          */
/* ------------------------------------------------------------------ */

export async function getActiveWorkout(): Promise<ActiveWorkout | null> {
  const db = await getDb();
  return db.getFirstAsync<ActiveWorkout>(`
    SELECT w.id, w.routine_id, w.started_at,
           EXISTS (SELECT 1 FROM workout_pauses p
                   WHERE p.workout_id = w.id AND p.ended_at IS NULL) AS is_paused
    FROM workouts w
    WHERE w.ended_at IS NULL
    ORDER BY w.started_at DESC
    LIMIT 1
  `);
}

export async function startWorkout(routineId: number): Promise<number> {
  const active = await getActiveWorkout();
  if (active) throw new Error('A workout is already in progress');

  const db = await getDb();
  const res = await db.runAsync(
    'INSERT INTO workouts (routine_id, started_at) VALUES (?, ?)',
    [routineId, now()]
  );
  return res.lastInsertRowId;
}

/** Завершить: закрыть открытый интервал и паузу, проставить ended_at. */
export async function endWorkout(workoutId: number): Promise<void> {
  const db = await getDb();
  const ts = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE set_intervals SET ended_at = ?
       WHERE ended_at IS NULL
         AND set_id IN (SELECT id FROM sets WHERE workout_id = ?)`,
      [ts, workoutId]
    );
    await db.runAsync(
      'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
      [ts, workoutId]
    );
    await db.runAsync('UPDATE workouts SET ended_at = ? WHERE id = ?', [ts, workoutId]);
  });
}

export async function pauseWorkout(workoutId: number): Promise<void> {
  const db = await getDb();
  const open = await db.getFirstAsync<{ id: number }>(
    'SELECT id FROM workout_pauses WHERE workout_id = ? AND ended_at IS NULL',
    [workoutId]
  );
  if (open) return;
  await db.runAsync(
    'INSERT INTO workout_pauses (workout_id, started_at) VALUES (?, ?)',
    [workoutId, now()]
  );
}

export async function resumeWorkout(workoutId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
    [now(), workoutId]
  );
}

/** Общее время тренировки за вычетом пауз, в секундах. */
export async function getWorkoutTotalSeconds(workoutId: number): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number }>(
    `
    SELECT
      (strftime('%s', COALESCE(w.ended_at, ?)) - strftime('%s', w.started_at))
      - COALESCE((
          SELECT SUM(strftime('%s', COALESCE(p.ended_at, ?)) - strftime('%s', p.started_at))
          FROM workout_pauses p WHERE p.workout_id = w.id
        ), 0) AS total
    FROM workouts w WHERE w.id = ?
    `,
    [now(), now(), workoutId]
  );
  return Math.max(0, row?.total ?? 0);
}

/* ------------------------------------------------------------------ */
/* Подходы                                                             */
/* ------------------------------------------------------------------ */

export async function getWorkoutSets(workoutId: number): Promise<SetRow[]> {
  const db = await getDb();
  return db.getAllAsync<SetRow>(
    `
    SELECT s.*, t.started_at, t.ended_at, t.active_seconds, t.is_running
    FROM sets s
    JOIN set_times t ON t.set_id = s.id
    WHERE s.workout_id = ?
    ORDER BY t.started_at IS NULL, t.started_at, s.id
    `,
    [workoutId]
  );
}

/**
 * Пустая строка подхода — заготовка. В базе есть, но времени нет,
 * пока не нажат старт. Сюда же подставляются веса из прошлой тренировки.
 */
export async function addSetDraft(
  workoutId: number,
  exerciseId: number,
  reps?: number | null,
  weightKg?: number | null
): Promise<number> {
  const db = await getDb();
  const posRow = await db.getFirstAsync<{ next: number }>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sets
     WHERE workout_id = ? AND exercise_id = ?`,
    [workoutId, exerciseId]
  );
  const res = await db.runAsync(
    'INSERT INTO sets (workout_id, exercise_id, reps, weight_kg, position) VALUES (?, ?, ?, ?, ?)',
    [workoutId, exerciseId, reps ?? null, weightKg ?? null, posRow?.next ?? 0]
  );
  return res.lastInsertRowId;
}

/**
 * Переставить подходы одного упражнения в заданном порядке — так же,
 * как setWorkoutExerciseOrder переставляет упражнения.
 */
export async function setExerciseSetOrder(
  workoutId: number,
  exerciseId: number,
  setIds: number[]
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < setIds.length; i++) {
      await db.runAsync(
        'UPDATE sets SET position = ? WHERE id = ? AND workout_id = ? AND exercise_id = ?',
        [i, setIds[i], workoutId, exerciseId]
      );
    }
  });
}

/**
 * Старт подхода. Снимает паузу тренировки, если она стояла.
 * Нельзя запустить, пока в тренировке есть другой открытый интервал.
 */
export async function startSet(setId: number): Promise<void> {
  const db = await getDb();
  const ctx = await db.getFirstAsync<{ workout_id: number; open_count: number }>(
    `
    SELECT s.workout_id,
           (SELECT COUNT(*) FROM set_intervals i
            JOIN sets s2 ON s2.id = i.set_id
            WHERE s2.workout_id = s.workout_id AND i.ended_at IS NULL) AS open_count
    FROM sets s WHERE s.id = ?
    `,
    [setId]
  );
  if (!ctx) throw new Error('Set not found');
  if (ctx.open_count > 0) throw new Error('Another set is already running');

  const ts = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
      [ts, ctx.workout_id]
    );
    await db.runAsync(
      'INSERT INTO set_intervals (set_id, started_at) VALUES (?, ?)',
      [setId, shifted((await getRecordingSettings()).prepSeconds)]
    );
  });
}

/**
 * Отметить подход выполненным без таймера: интервал нулевой длины.
 *
 * Момент времени всё равно сохраняется, поэтому порядок подходов и
 * отдых между ними считаются как раньше — теряется только длительность.
 */
export async function recordSet(setId: number): Promise<void> {
  const db = await getDb();
  const ts = now();
  const ctx = await db.getFirstAsync<{ workout_id: number }>(
    'SELECT workout_id FROM sets WHERE id = ?',
    [setId]
  );
  if (!ctx) throw new Error('Set not found');

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
      [ts, ctx.workout_id]
    );
    await db.runAsync(
      'INSERT INTO set_intervals (set_id, started_at, ended_at) VALUES (?, ?, ?)',
      [setId, ts, ts]
    );
  });
}

/** Отменить отметку — убирает все интервалы подхода. */
export async function unrecordSet(setId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM set_intervals WHERE set_id = ?', [setId]);
}

/**
 * Записать длительность подхода вручную, введённую с внешнего секундомера,
 * а не встроенным таймером.
 *
 * Срезаем prepSeconds/reachSeconds так же, как при старте/стопе таймером -
 * иначе один и тот же подход считался бы по-разному в зависимости от
 * способа записи, а этого быть не должно.
 */
export async function recordSetSeconds(setId: number, seconds: number): Promise<void> {
  const db = await getDb();
  const ts = now();
  const ctx = await db.getFirstAsync<{ workout_id: number }>(
    'SELECT workout_id FROM sets WHERE id = ?',
    [setId]
  );
  if (!ctx) throw new Error('Set not found');

  const { prepSeconds, reachSeconds } = await getRecordingSettings();
  const trimmed = Math.max(0, seconds - prepSeconds - reachSeconds);

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE workout_pauses SET ended_at = ? WHERE workout_id = ? AND ended_at IS NULL',
      [ts, ctx.workout_id]
    );
    await db.runAsync('DELETE FROM set_intervals WHERE set_id = ?', [setId]);
    await db.runAsync(
      'INSERT INTO set_intervals (set_id, started_at, ended_at) VALUES (?, ?, ?)',
      [setId, shifted(-trimmed), ts]
    );
  });
}

/** Стоп/пауза подхода — закрывает текущий интервал. */
export async function stopSet(setId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE set_intervals SET ended_at = ?
     WHERE set_id = ? AND ended_at IS NULL`,
    [shifted(-(await getRecordingSettings()).reachSeconds), setId]
  );
}

/**
 * Продолжить подход. Разрешено только для последнего подхода тренировки:
 * если после него уже начат другой, подход считается закрытым окончательно.
 */
export async function resumeSet(setId: number): Promise<void> {
  const db = await getDb();
  const check = await db.getFirstAsync<{ is_last: number }>(
    `
    SELECT CASE WHEN (
      SELECT s2.id FROM sets s2
      JOIN set_times t2 ON t2.set_id = s2.id
      WHERE s2.workout_id = (SELECT workout_id FROM sets WHERE id = ?)
        AND t2.started_at IS NOT NULL
      ORDER BY t2.started_at DESC, s2.id DESC LIMIT 1
    ) = ? THEN 1 ELSE 0 END AS is_last
    `,
    [setId, setId]
  );
  if (!check?.is_last) throw new Error('Only the last set can be resumed');

  await db.runAsync(
    'INSERT INTO set_intervals (set_id, started_at) VALUES (?, ?)',
    [setId, now()]
  );
}

export async function updateSetValues(
  setId: number,
  values: { reps?: number | null; weightKg?: number | null }
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE sets SET reps = COALESCE(?, reps), weight_kg = COALESCE(?, weight_kg) WHERE id = ?',
    [values.reps ?? null, values.weightKg ?? null, setId]
  );
}

export async function deleteSet(setId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM sets WHERE id = ?', [setId]);
}

export async function deleteWorkoutExercise(
  workoutId: number,
  exerciseId: number
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM sets WHERE workout_id = ? AND exercise_id = ?', [
      workoutId,
      exerciseId,
    ]);
    await db.runAsync(
      'DELETE FROM workout_exercise_notes WHERE workout_id = ? AND exercise_id = ?',
      [workoutId, exerciseId]
    );
  });
}

/* ------------------------------------------------------------------ */
/* Заметки про ощущения                                                */
/* ------------------------------------------------------------------ */

export async function setExerciseNote(
  workoutId: number,
  exerciseId: number,
  note: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO workout_exercise_notes (workout_id, exercise_id, note)
     VALUES (?, ?, ?)
     ON CONFLICT (workout_id, exercise_id) DO UPDATE SET note = excluded.note`,
    [workoutId, exerciseId, note]
  );
}

/* ------------------------------------------------------------------ */
/* Заготовка тренировки по шаблону                                     */
/* ------------------------------------------------------------------ */

export interface PrefillRow {
  exercise_id: number;
  name: string;
  measurement_default: MeasurementType;
  position: number;
  reps: number | null;
  weight_kg: number | null;
}

export async function getRoutinePrefill(routineId: number): Promise<PrefillRow[]> {
  const db = await getDb();
  const last = await db.getFirstAsync<{ id: number }>(
    `SELECT id FROM workouts
     WHERE routine_id = ? AND ended_at IS NOT NULL
     ORDER BY started_at DESC LIMIT 1`,
    [routineId]
  );

  if (!last) {
    return db.getAllAsync<PrefillRow>(
      `SELECT e.id AS exercise_id, e.name, e.measurement_default, re.position,
              NULL AS reps, NULL AS weight_kg
       FROM routine_exercises re
       JOIN exercises e ON e.id = re.exercise_id
       WHERE re.routine_id = ?
       ORDER BY re.position`,
      [routineId]
    );
  }

  return db.getAllAsync<PrefillRow>(
    `
    SELECT e.id AS exercise_id, e.name, e.measurement_default, re.position,
           s.reps, s.weight_kg
    FROM routine_exercises re
    JOIN exercises e ON e.id = re.exercise_id
    LEFT JOIN sets s ON s.exercise_id = e.id AND s.workout_id = ?
    LEFT JOIN set_times t ON t.set_id = s.id
    WHERE re.routine_id = ?
    ORDER BY re.position, t.started_at, s.id
    `,
    [last.id, routineId]
  );
}

/* ------------------------------------------------------------------ */
/* Восстановление после падения приложения                             */
/* ------------------------------------------------------------------ */

export interface DanglingSet {
  set_id: number;
  interval_id: number;
  exercise_name: string;
  started_at: string;
}

export async function findDanglingIntervals(): Promise<DanglingSet[]> {
  const db = await getDb();
  return db.getAllAsync<DanglingSet>(`
    SELECT i.set_id, i.id AS interval_id, e.name AS exercise_name, i.started_at
    FROM set_intervals i
    JOIN sets s      ON s.id = i.set_id
    JOIN exercises e ON e.id = s.exercise_id
    WHERE i.ended_at IS NULL
    ORDER BY i.started_at
  `);
}

export async function closeInterval(intervalId: number, endedAt: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE set_intervals SET ended_at = ? WHERE id = ?', [
    endedAt,
    intervalId,
  ]);
}

/* ------------------------------------------------------------------ */
/* Вес тела                                                            */
/* ------------------------------------------------------------------ */

export async function recordBodyweight(weightKg: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO bodyweight (measured_at, weight_kg) VALUES (?, ?)',
    [now(), weightKg]
  );
}

export async function getLatestBodyweight(): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ weight_kg: number }>(
    'SELECT weight_kg FROM bodyweight ORDER BY measured_at DESC LIMIT 1'
  );
  return row?.weight_kg ?? null;
}

/* ------------------------------------------------------------------ */
/* Справочник упражнений                                               */
/* ------------------------------------------------------------------ */

export async function searchExercises(query = ''): Promise<Exercise[]> {
  const db = await getDb();
  return db.getAllAsync<Exercise>(
    `SELECT * FROM exercises
     WHERE name LIKE ? AND is_archived = 0
     ORDER BY is_custom DESC, name`,
    [`%${query}%`]
  );
}

export async function createExercise(input: {
  name: string;
  description?: string;
  measurementDefault: MeasurementType;
  muscles: { muscleId: number; share: number }[];
}): Promise<number> {
  const total = input.muscles.reduce((s, m) => s + m.share, 0);
  if (Math.abs(total - 1) > 0.001) {
    throw new Error(
      `Muscle shares must add up to 100%, currently ${Math.round(total * 100)}%`
    );
  }

  const db = await getDb();
  let id = 0;
  await db.withTransactionAsync(async () => {
    const res = await db.runAsync(
      `INSERT INTO exercises (name, description, measurement_default, is_custom)
       VALUES (?, ?, ?, 1)`,
      [input.name, input.description ?? null, input.measurementDefault]
    );
    id = res.lastInsertRowId;
    for (const m of input.muscles) {
      await db.runAsync(
        'INSERT INTO exercise_muscles (exercise_id, muscle_id, share) VALUES (?, ?, ?)',
        [id, m.muscleId, m.share]
      );
    }
  });
  return id;
}
