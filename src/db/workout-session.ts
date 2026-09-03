import { getDb } from './index';
import { addSetDraft, getRoutinePrefill, startWorkout } from './queries';

/**
 * Дополнения к queries.ts, нужные экрану активной тренировки.
 */

export interface Routine {
  id: number;
  name: string;
  exercise_count: number;
}

export interface SetRowLive {
  id: number;
  workout_id: number;
  exercise_id: number;
  exercise_name: string;
  measurement_default: 'reps' | 'hold';
  reps: number | null;
  weight_kg: number | null;
  started_at: string | null;
  active_seconds: number;
  is_running: number;
  /** Начало открытого интервала. NULL, если подход не идёт. */
  running_since: string | null;
}

export async function listRoutines(): Promise<Routine[]> {
  const db = await getDb();
  return db.getAllAsync<Routine>(`
    SELECT r.id, r.name,
           (SELECT COUNT(*) FROM routine_exercises re WHERE re.routine_id = r.id)
             AS exercise_count
    FROM routines r
    ORDER BY r.name
  `);
}

export async function createRoutine(name: string): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync('INSERT INTO routines (name) VALUES (?)', [name]);
  return res.lastInsertRowId;
}

/**
 * Начать тренировку по шаблону и сразу разложить заготовки подходов
 * со значениями из прошлого исполнения этого же шаблона.
 */
export async function beginWorkout(routineId: number): Promise<number> {
  const prefill = await getRoutinePrefill(routineId);
  const workoutId = await startWorkout(routineId);

  const db = await getDb();
  const seen = new Set<number>();

  for (const row of prefill) {
    await addSetDraft(workoutId, row.exercise_id, row.reps, row.weight_kg);

    if (!seen.has(row.exercise_id)) {
      seen.add(row.exercise_id);
      await db.runAsync(
        `INSERT OR IGNORE INTO workout_exercise_order (workout_id, exercise_id, position)
         VALUES (?, ?, ?)`,
        [workoutId, row.exercise_id, row.position]
      );
    }
  }

  // Шаблон запускается впервые — упражнения есть, подходов нет.
  // Даём по одной пустой строке на упражнение.
  if (prefill.every((r) => r.reps === null && r.weight_kg === null)) {
    // addSetDraft выше уже создал по строке на каждое упражнение шаблона
  }

  return workoutId;
}

/**
 * Подходы тренировки со всем, что нужно для отрисовки:
 * имя упражнения, накопленное время и начало текущего интервала.
 */
export async function getWorkoutSetsLive(workoutId: number): Promise<SetRowLive[]> {
  const db = await getDb();
  return db.getAllAsync<SetRowLive>(
    `
    SELECT s.id, s.workout_id, s.exercise_id, s.reps, s.weight_kg,
           e.name AS exercise_name,
           e.measurement_default,
           t.started_at, t.active_seconds, t.is_running,
           (SELECT i.started_at FROM set_intervals i
            WHERE i.set_id = s.id AND i.ended_at IS NULL
            LIMIT 1) AS running_since
    FROM sets s
    JOIN exercises e ON e.id = s.exercise_id
    JOIN set_times t ON t.set_id = s.id
    LEFT JOIN workout_exercise_order o
           ON o.workout_id = s.workout_id AND o.exercise_id = s.exercise_id
    WHERE s.workout_id = ?
    ORDER BY COALESCE(o.position, 999999), s.exercise_id, s.position, s.id
    `,
    [workoutId]
  );
}

export async function getExerciseNotes(
  workoutId: number
): Promise<Record<number, string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ exercise_id: number; note: string }>(
    'SELECT exercise_id, note FROM workout_exercise_notes WHERE workout_id = ?',
    [workoutId]
  );
  const out: Record<number, string> = {};
  rows.forEach((r) => (out[r.exercise_id] = r.note));
  return out;
}

export interface PreviousSet {
  exercise_id: number;
  reps: number | null;
  weight_kg: number | null;
  active_seconds: number;
  workout_started: string;
}

/**
 * Подходы из последней завершённой тренировки, где встречалось упражнение.
 * Показываем в карточке тренировки, чтобы было видно, от чего отталкиваться.
 */
export async function getPreviousSets(routineId: number): Promise<PreviousSet[]> {
  const db = await getDb();
  return db.getAllAsync<PreviousSet>(
    `
    SELECT s.exercise_id, s.reps, s.weight_kg, t.active_seconds,
           w.started_at AS workout_started
    FROM sets s
    JOIN workouts w  ON w.id = s.workout_id
    JOIN set_times t ON t.set_id = s.id
    WHERE w.ended_at IS NOT NULL
      AND s.exercise_id IN (
            SELECT exercise_id FROM routine_exercises WHERE routine_id = ?
          )
      AND w.id = (
            SELECT w2.id FROM workouts w2
            JOIN sets s2 ON s2.workout_id = w2.id
            WHERE s2.exercise_id = s.exercise_id AND w2.ended_at IS NOT NULL
            ORDER BY w2.started_at DESC LIMIT 1
          )
    ORDER BY s.exercise_id, t.started_at, s.id
    `,
    [routineId]
  );
}

/** Дописать упражнение в конец порядка, если его там ещё нет. */
export async function ensureExerciseOrder(
  workoutId: number,
  exerciseId: number
): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM workout_exercise_order WHERE workout_id = ?',
    [workoutId]
  );
  await db.runAsync(
    `INSERT OR IGNORE INTO workout_exercise_order (workout_id, exercise_id, position)
     VALUES (?, ?, ?)`,
    [workoutId, exerciseId, row?.next ?? 0]
  );
}

/** Переписать порядок целиком — так же, как в составе шаблона. */
export async function setWorkoutExerciseOrder(
  workoutId: number,
  exerciseIds: number[]
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM workout_exercise_order WHERE workout_id = ?', [workoutId]);
    for (let i = 0; i < exerciseIds.length; i++) {
      await db.runAsync(
        `INSERT INTO workout_exercise_order (workout_id, exercise_id, position)
         VALUES (?, ?, ?)`,
        [workoutId, exerciseIds[i], i]
      );
    }
  });
}
