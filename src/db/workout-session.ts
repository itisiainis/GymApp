import { NAME_SEPARATOR } from '../lib/workoutName';
import { getDb } from './index';
import {
  addSetDraft,
  getExercisePrefill,
  getRoutinePrefill,
  startWorkout,
} from './queries';

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
  /** Повторов в запасе: 0–5, 6 = «>5». NULL — не проставлен. */
  rir: number | null;
  /** Правила веса из снаряжения упражнения — см. lib/load.ts. */
  weight_factor: number | null;
  adds_bodyweight: number | null;
  started_at: string | null;
  /** Конец последнего закрытого интервала — от него считается отдых. */
  ended_at: string | null;
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
 * Завести тренировку. Время при этом НЕ идёт: сначала собирают состав, и
 * только «Let's start» запускает часы (startWorkoutClock в queries.ts).
 *
 * Пустой черновик заводится лениво — по первому же действию на экране, а
 * не при заходе на вкладку: иначе каждое открытие вкладки оставляло бы за
 * собой пустую тренировку.
 */
export async function createDraftWorkout(routineId: number | null = null): Promise<number> {
  const workoutId = await startWorkout(routineId);
  if (routineId !== null) await copyRoutineInto(workoutId, routineId);
  return workoutId;
}

/**
 * Разложить состав шаблона в тренировку — со значениями из последнего
 * исполнения каждого упражнения, а не из самого шаблона (в нём значений
 * и нет, только список упражнений).
 */
export async function copyRoutineInto(
  workoutId: number,
  routineId: number
): Promise<void> {
  const prefill = await getRoutinePrefill(routineId);
  const db = await getDb();
  const already = await db.getAllAsync<{ exercise_id: number }>(
    'SELECT DISTINCT exercise_id FROM sets WHERE workout_id = ?',
    [workoutId]
  );
  const skip = new Set(already.map((r) => r.exercise_id));

  const seen = new Set<number>();
  for (const row of prefill) {
    if (skip.has(row.exercise_id)) continue;
    await addSetDraft(workoutId, row.exercise_id, row.reps, row.weight_kg);
    if (!seen.has(row.exercise_id)) {
      seen.add(row.exercise_id);
      await ensureExerciseOrder(workoutId, row.exercise_id);
    }
  }
  await refreshWorkoutName(workoutId);
}

export interface RecentWorkout {
  id: number;
  title: string | null;
  started_at: string;
  exercise_count: number;
  /** Имена упражнений через запятую — по ним и узнают тренировку. */
  exercises: string | null;
}

/**
 * Чем занимались на днях — предложение для пустого экрана тренировки.
 *
 * Неделя, а не «последние N штук»: повторяют обычно то, что делали на
 * этой же неделе, а список из пяти тренировок за полгода ничего не
 * подсказывает. Границу считаем в JS: ISO-строки сравниваются как
 * строки, и это правильный хронологический порядок, а datetime('now')
 * вернул бы формат без T и Z, который с ними не сходится.
 */
export async function listRecentWorkouts(days = 7): Promise<RecentWorkout[]> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.getAllAsync<RecentWorkout>(
    `
    SELECT w.id, COALESCE(w.name, r.name) AS title,
           COALESCE(w.began_at, w.started_at) AS started_at,
           (SELECT COUNT(DISTINCT s.exercise_id) FROM sets s WHERE s.workout_id = w.id)
             AS exercise_count,
           (SELECT GROUP_CONCAT(name, ', ') FROM (
              SELECT DISTINCT e.name
              FROM sets s JOIN exercises e ON e.id = s.exercise_id
              WHERE s.workout_id = w.id
           )) AS exercises
    FROM workouts w
    LEFT JOIN routines r ON r.id = w.routine_id
    WHERE w.ended_at IS NOT NULL
      AND COALESCE(w.began_at, w.started_at) >= ?
    ORDER BY COALESCE(w.began_at, w.started_at) DESC
    `,
    [since]
  );
}

/**
 * Перенести состав прошлой тренировки в текущую: те же упражнения, в том
 * же порядке, с теми же подходами.
 *
 * Это «повторить», а не «начать по плану», поэтому копируются и значения
 * подходов — вес с повторами из того раза. Упражнения, которые в текущей
 * тренировке уже есть, пропускаются: повторное нажатие не должно
 * задваивать состав.
 */
export async function copyWorkoutInto(
  workoutId: number,
  sourceWorkoutId: number
): Promise<void> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    exercise_id: number;
    reps: number | null;
    weight_kg: number | null;
  }>(
    `
    SELECT s.exercise_id, s.reps, s.weight_kg
    FROM sets s
    JOIN exercises e ON e.id = s.exercise_id
    LEFT JOIN workout_exercise_order o
           ON o.workout_id = s.workout_id AND o.exercise_id = s.exercise_id
    WHERE s.workout_id = ? AND e.is_archived = 0
    ORDER BY COALESCE(o.position, 999999), s.exercise_id, s.position, s.id
    `,
    [sourceWorkoutId]
  );

  const already = await db.getAllAsync<{ exercise_id: number }>(
    'SELECT DISTINCT exercise_id FROM sets WHERE workout_id = ?',
    [workoutId]
  );
  const skip = new Set(already.map((r) => r.exercise_id));

  for (const row of rows) {
    if (skip.has(row.exercise_id)) continue;
    await addSetDraft(workoutId, row.exercise_id, row.reps, row.weight_kg);
    await ensureExerciseOrder(workoutId, row.exercise_id);
  }
  await refreshWorkoutName(workoutId);
}

/**
 * Добавить упражнение в идущую тренировку — вместе с заготовкой подходов
 * из его прошлого исполнения и пересчётом имени тренировки.
 */
export async function addExerciseToWorkout(
  workoutId: number,
  exerciseId: number
): Promise<void> {
  const prefill = await getExercisePrefill([exerciseId]);
  for (const row of prefill) {
    await addSetDraft(workoutId, exerciseId, row.reps, row.weight_kg);
  }
  await ensureExerciseOrder(workoutId, exerciseId);
  await refreshWorkoutName(workoutId);
}

/**
 * Пересчитать имя тренировки по главным мышцам её упражнений.
 *
 * Только для тренировок с нуля: у начатой по шаблону имя берётся у
 * шаблона (COALESCE в getActiveWorkout и listWorkouts), и перебивать его
 * автоматическим было бы неожиданно — шаблон назвали руками.
 *
 * Мышцы ранжируются по числу упражнений, где они главные: в «жим, жим
 * под углом, разгибания» грудь стоит за двумя упражнениями, трицепс за
 * одним, и порядок в имени это повторяет. Берём две — имя должно
 * помещаться в строку списка истории, а не перечислять всё подряд.
 *
 * При равном счёте (обычный случай: у каждого упражнения своя главная
 * мышца) решает порядок упражнений в тренировке. По алфавиту было бы
 * произвольно: в «жим, разгибания, присед» трицепс вылетал бы из имени
 * только потому, что Quads стоит в словаре раньше Triceps.
 */
export async function refreshWorkoutName(workoutId: number): Promise<void> {
  const db = await getDb();
  const w = await db.getFirstAsync<{ routine_id: number | null }>(
    'SELECT routine_id FROM workouts WHERE id = ?',
    [workoutId]
  );
  if (!w || w.routine_id !== null) return;

  const rows = await db.getAllAsync<{ name: string }>(
    `
    SELECT m.name
    FROM sets s
    JOIN exercise_muscles em ON em.exercise_id = s.exercise_id AND em.role = 'primary'
    JOIN muscles m ON m.id = em.muscle_id
    LEFT JOIN workout_exercise_order o
           ON o.workout_id = s.workout_id AND o.exercise_id = s.exercise_id
    WHERE s.workout_id = ?
    GROUP BY m.id
    ORDER BY COUNT(DISTINCT s.exercise_id) DESC,
             MIN(COALESCE(o.position, 999999)),
             m.name
    LIMIT 2
    `,
    [workoutId]
  );

  // Пусто — у тренировки ещё нет упражнений (или у них не проставлены
  // главные мышцы). NULL честнее выдуманного названия: показывать
  // пустую тренировку всё равно нечем, кроме слова «тренировка».
  const name = rows.length > 0 ? rows.map((r) => r.name).join(NAME_SEPARATOR) : null;
  await db.runAsync('UPDATE workouts SET name = ? WHERE id = ?', [name, workoutId]);
}

/**
 * Сохранить состав тренировки как шаблон — то самое «постфактум».
 *
 * Тренировку к получившемуся шаблону НЕ привязываем: она была собрана с
 * нуля, и это остаётся правдой. Шаблон — слепок её состава на будущее, а
 * не задним числом объявленный план.
 */
export async function saveWorkoutAsRoutine(
  workoutId: number,
  name: string
): Promise<number> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ exercise_id: number }>(
    `
    SELECT s.exercise_id, COALESCE(o.position, 999999) AS position
    FROM sets s
    LEFT JOIN workout_exercise_order o
           ON o.workout_id = s.workout_id AND o.exercise_id = s.exercise_id
    WHERE s.workout_id = ?
    GROUP BY s.exercise_id
    ORDER BY position, s.exercise_id
    `,
    [workoutId]
  );
  if (rows.length === 0) throw new Error('This workout has no exercises yet');

  let routineId = 0;
  await db.withTransactionAsync(async () => {
    const res = await db.runAsync('INSERT INTO routines (name) VALUES (?)', [name]);
    routineId = res.lastInsertRowId;
    for (let i = 0; i < rows.length; i++) {
      await db.runAsync(
        `INSERT INTO routine_exercises (routine_id, exercise_id, position)
         VALUES (?, ?, ?)`,
        [routineId, rows[i].exercise_id, i]
      );
    }
  });
  return routineId;
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
           s.rir,
           e.name AS exercise_name,
           e.measurement_default,
           q.weight_factor, q.adds_bodyweight,
           t.started_at, t.ended_at, t.active_seconds, t.is_running,
           (SELECT i.started_at FROM set_intervals i
            WHERE i.set_id = s.id AND i.ended_at IS NULL
            LIMIT 1) AS running_since
    FROM sets s
    JOIN exercises e ON e.id = s.exercise_id
    LEFT JOIN equipment q ON q.id = e.equipment_id
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

/*
 * Отдельного запроса «что было в прошлый раз» для экрана до старта больше
 * нет: ровно это и отдаёт getRoutinePrefill (queries.ts) — те же подходы,
 * которые он разложит в тренировку. Раньше это были два разных запроса,
 * которые обязаны были сходиться друг с другом, и они регулярно
 * расходились: упражнение попадало в заготовку, но на экране перед
 * стартом стояло с пометкой «пусто».
 */

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
