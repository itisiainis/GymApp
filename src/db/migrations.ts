import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * Схема хранится версиями. При старте приложение смотрит PRAGMA user_version
 * и догоняет базу до LATEST_VERSION, применяя недостающие шаги по порядку.
 *
 * Добавляя новую миграцию: увеличь LATEST_VERSION и допиши блок `if (version < N)`.
 * Уже применённые блоки НИКОГДА не редактируются — на устройствах с установленным
 * приложением они выполнялись давно и повторно не запустятся.
 */

const LATEST_VERSION = 8;

export async function migrate(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;

  if (version < 1) {
    await db.execAsync(V1);
    version = 1;
  }

  if (version < 2) {
    // Подход без интервалов ошибочно считался идущим:
    // LEFT JOIN отдаёт строку с NULL в ended_at даже когда интервалов нет.
    await db.execAsync(`
      DROP VIEW IF EXISTS set_times;
      CREATE VIEW set_times AS
      SELECT
          s.id AS set_id,
          MIN(i.started_at) AS started_at,
          MAX(i.ended_at)   AS ended_at,
          COALESCE(SUM(
              CASE WHEN i.ended_at IS NOT NULL
                   THEN strftime('%s', i.ended_at) - strftime('%s', i.started_at)
                   ELSE 0 END
          ), 0) AS active_seconds,
          MAX(CASE WHEN i.id IS NOT NULL AND i.ended_at IS NULL THEN 1 ELSE 0 END)
              AS is_running
      FROM sets s
      LEFT JOIN set_intervals i ON i.set_id = s.id
      GROUP BY s.id;
    `);
    version = 2;
  }

  if (version < 3) {
    await db.execAsync(V3);
    version = 3;
  }

  if (version < 4) {
    await db.execAsync(V4);
    version = 4;
  }

  if (version < 5) {
    // Упражнение, на которое ссылается история, физически удалить нельзя —
    // строки подходов остались бы без имени. Прячем его вместо удаления.
    await db.execAsync(
      `ALTER TABLE exercises ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0`
    );
    version = 5;
  }

  if (version < 6) {
    // Старт и стоп сдвигаются на несколько секунд (дойти до снаряда,
    // дотянуться до телефона), поэтому короткий подход может дать
    // отрицательную длительность — обрезаем по нулю.
    await db.execAsync(`
      DROP VIEW IF EXISTS set_times;
      CREATE VIEW set_times AS
      SELECT
          s.id AS set_id,
          MIN(i.started_at) AS started_at,
          MAX(i.ended_at)   AS ended_at,
          COALESCE(SUM(
              CASE WHEN i.ended_at IS NOT NULL
                   THEN MAX(0, strftime('%s', i.ended_at) - strftime('%s', i.started_at))
                   ELSE 0 END
          ), 0) AS active_seconds,
          MAX(CASE WHEN i.id IS NOT NULL AND i.ended_at IS NULL THEN 1 ELSE 0 END)
              AS is_running
      FROM sets s
      LEFT JOIN set_intervals i ON i.set_id = s.id
      GROUP BY s.id;
    `);
    version = 6;
  }

  if (version < 7) {
    // Порядок упражнений внутри тренировки — это данные: их добавляют,
    // убирают и переставляют по ходу, и восстановить порядок из времени
    // подходов нельзя (у заготовок времени ещё нет).
    await db.execAsync(`
      CREATE TABLE workout_exercise_order (
          workout_id  INTEGER NOT NULL REFERENCES workouts(id)  ON DELETE CASCADE,
          exercise_id INTEGER NOT NULL REFERENCES exercises(id),
          position    INTEGER NOT NULL,
          PRIMARY KEY (workout_id, exercise_id)
      );
    `);
    version = 7;
  }

  if (version < 8) {
    // Порядок подходов внутри упражнения — раньше это был просто порядок
    // вставки (id), теперь данные: подходы тоже можно переставить руками.
    await db.execAsync(`ALTER TABLE sets ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
    // Бэкафилл без оконных функций (совместимость): позиция = сколько
    // более ранних подходов того же упражнения в той же тренировке уже есть.
    await db.execAsync(`
      UPDATE sets SET position = (
        SELECT COUNT(*) FROM sets s2
        WHERE s2.workout_id = sets.workout_id
          AND s2.exercise_id = sets.exercise_id
          AND s2.id < sets.id
      );
      CREATE INDEX idx_sets_position ON sets(workout_id, exercise_id, position);
    `);
    version = 8;
  }

  await db.execAsync(`PRAGMA user_version = ${LATEST_VERSION}`);
}

const V1 = `
-- ---------- Справочники ----------

CREATE TABLE muscles (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE exercises (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    description         TEXT,
    -- какой ввод показывать по умолчанию: 'reps' | 'hold'
    measurement_default TEXT NOT NULL DEFAULT 'reps'
        CHECK (measurement_default IN ('reps', 'hold')),
    -- 0 = встроенное (нельзя редактировать), 1 = созданное пользователем
    is_custom           INTEGER NOT NULL DEFAULT 1
);

-- Вклад мышцы в упражнение. share — доля от 1.0, сумма по упражнению = 1.0
CREATE TABLE exercise_muscles (
    exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    muscle_id   INTEGER NOT NULL REFERENCES muscles(id)   ON DELETE CASCADE,
    share       REAL    NOT NULL CHECK (share > 0 AND share <= 1),
    PRIMARY KEY (exercise_id, muscle_id)
);

-- ---------- Шаблоны (планы тренировок) ----------

CREATE TABLE routines (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    is_custom INTEGER NOT NULL DEFAULT 1
);

-- У шаблона нет времени, поэтому порядок упражнений — это данные.
CREATE TABLE routine_exercises (
    routine_id  INTEGER NOT NULL REFERENCES routines(id)  ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    position    INTEGER NOT NULL,
    PRIMARY KEY (routine_id, exercise_id)
);

-- ---------- Факт: тренировки, подходы, интервалы ----------

CREATE TABLE workouts (
    id         INTEGER PRIMARY KEY,
    routine_id INTEGER NOT NULL REFERENCES routines(id),
    started_at TEXT NOT NULL,   -- ISO-8601 UTC
    ended_at   TEXT             -- NULL = тренировка идёт
);

-- Подход НЕ хранит времена: они складываются из интервалов.
CREATE TABLE sets (
    id          INTEGER PRIMARY KEY,
    workout_id  INTEGER NOT NULL REFERENCES workouts(id)  ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    reps        INTEGER,
    weight_kg   REAL
);

-- Обычно ровно один интервал на подход. Больше одного — если подход
-- поставили на паузу и продолжили.
CREATE TABLE set_intervals (
    id         INTEGER PRIMARY KEY,
    set_id     INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at   TEXT             -- NULL = интервал идёт прямо сейчас
);

-- Пауза всей тренировки. Открытая строка (ended_at IS NULL) = тренировка на паузе.
CREATE TABLE workout_pauses (
    id         INTEGER PRIMARY KEY,
    workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at   TEXT
);

-- Заметка про ощущения: относится к паре (тренировка, упражнение).
CREATE TABLE workout_exercise_notes (
    workout_id  INTEGER NOT NULL REFERENCES workouts(id)  ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    note        TEXT,
    PRIMARY KEY (workout_id, exercise_id)
);

-- ---------- Вес тела: история, а не настройка ----------

CREATE TABLE bodyweight (
    id          INTEGER PRIMARY KEY,
    measured_at TEXT NOT NULL,
    weight_kg   REAL NOT NULL
);

-- ---------- Индексы ----------

CREATE INDEX idx_sets_workout        ON sets(workout_id);
CREATE INDEX idx_sets_exercise       ON sets(exercise_id);
CREATE INDEX idx_intervals_set       ON set_intervals(set_id, started_at);
CREATE INDEX idx_pauses_workout      ON workout_pauses(workout_id);
CREATE INDEX idx_workouts_started    ON workouts(started_at);
CREATE INDEX idx_bodyweight_measured ON bodyweight(measured_at);

-- ---------- Производные времена ----------
-- Единственное место, где считается длительность подхода.

CREATE VIEW set_times AS
SELECT
    s.id AS set_id,
    MIN(i.started_at) AS started_at,
    MAX(i.ended_at)   AS ended_at,
    COALESCE(SUM(
        CASE WHEN i.ended_at IS NOT NULL
             THEN strftime('%s', i.ended_at) - strftime('%s', i.started_at)
             ELSE 0 END
    ), 0) AS active_seconds,
    MAX(CASE WHEN i.ended_at IS NULL THEN 1 ELSE 0 END) AS is_running
FROM sets s
LEFT JOIN set_intervals i ON i.set_id = s.id
GROUP BY s.id;

-- ---------- Базовые мышцы ----------

INSERT INTO muscles (name) VALUES
    ('Chest'), ('Lats'), ('Traps'), ('Rhomboids'), ('Lower back'),
    ('Front delts'), ('Side delts'), ('Rear delts'),
    ('Biceps'), ('Triceps'), ('Forearms'),
    ('Abs'), ('Obliques'),
    ('Glutes'), ('Quads'), ('Hamstrings'), ('Calves'), ('Adductors');
`;

const V3 = `
ALTER TABLE muscles ADD COLUMN body_group TEXT;

UPDATE muscles SET name = 'Грудь',           body_group = 'Грудь' WHERE name = 'Chest';
UPDATE muscles SET name = 'Широчайшие',      body_group = 'Спина' WHERE name = 'Lats';
UPDATE muscles SET name = 'Трапеции',        body_group = 'Спина' WHERE name = 'Traps';
UPDATE muscles SET name = 'Ромбовидные',     body_group = 'Спина' WHERE name = 'Rhomboids';
UPDATE muscles SET name = 'Поясница',        body_group = 'Спина' WHERE name = 'Lower back';
UPDATE muscles SET name = 'Передние дельты', body_group = 'Плечи' WHERE name = 'Front delts';
UPDATE muscles SET name = 'Средние дельты',  body_group = 'Плечи' WHERE name = 'Side delts';
UPDATE muscles SET name = 'Задние дельты',   body_group = 'Плечи' WHERE name = 'Rear delts';
UPDATE muscles SET name = 'Бицепс',          body_group = 'Руки'  WHERE name = 'Biceps';
UPDATE muscles SET name = 'Трицепс',         body_group = 'Руки'  WHERE name = 'Triceps';
UPDATE muscles SET name = 'Предплечья',      body_group = 'Руки'  WHERE name = 'Forearms';
UPDATE muscles SET name = 'Пресс',           body_group = 'Кор'   WHERE name = 'Abs';
UPDATE muscles SET name = 'Косые',           body_group = 'Кор'   WHERE name = 'Obliques';
UPDATE muscles SET name = 'Ягодицы',         body_group = 'Ноги'  WHERE name = 'Glutes';
UPDATE muscles SET name = 'Квадрицепс',      body_group = 'Ноги'  WHERE name = 'Quads';
UPDATE muscles SET name = 'Бицепс бедра',    body_group = 'Ноги'  WHERE name = 'Hamstrings';
UPDATE muscles SET name = 'Икры',            body_group = 'Ноги'  WHERE name = 'Calves';
UPDATE muscles SET name = 'Приводящие',      body_group = 'Ноги'  WHERE name = 'Adductors';

INSERT OR IGNORE INTO muscles (name, body_group) VALUES
    ('Верх груди',              'Грудь'),
    ('Низ груди',               'Грудь'),
    ('Передняя зубчатая',       'Грудь'),
    ('Круглые мышцы спины',     'Спина'),
    ('Подостная',               'Спина'),
    ('Разгибатели спины',       'Спина'),
    ('Ротаторная манжета',      'Плечи'),
    ('Шея',                     'Плечи'),
    ('Плечевая (брахиалис)',    'Руки'),
    ('Разгибатели запястья',    'Руки'),
    ('Сгибатели запястья',      'Руки'),
    ('Поперечная живота',       'Кор'),
    ('Сгибатели бедра',         'Кор'),
    ('Отводящие',               'Ноги'),
    ('Средняя ягодичная',       'Ноги'),
    ('Передняя большеберцовая', 'Ноги'),
    ('Камбаловидная',           'Ноги');

UPDATE muscles SET body_group = 'Прочее' WHERE body_group IS NULL;
`;

const V4 = `
-- Канонические названия мышц — английские. Перевод живёт в src/lib/i18n.ts,
-- чтобы не плодить колонки под каждый язык.

UPDATE muscles SET name = 'Chest',              body_group = 'Chest'     WHERE name = 'Грудь';
UPDATE muscles SET name = 'Upper chest',        body_group = 'Chest'     WHERE name = 'Верх груди';
UPDATE muscles SET name = 'Lower chest',        body_group = 'Chest'     WHERE name = 'Низ груди';
UPDATE muscles SET name = 'Serratus anterior',  body_group = 'Chest'     WHERE name = 'Передняя зубчатая';
UPDATE muscles SET name = 'Lats',               body_group = 'Back'      WHERE name = 'Широчайшие';
UPDATE muscles SET name = 'Traps',              body_group = 'Back'      WHERE name = 'Трапеции';
UPDATE muscles SET name = 'Rhomboids',          body_group = 'Back'      WHERE name = 'Ромбовидные';
UPDATE muscles SET name = 'Lower back',         body_group = 'Back'      WHERE name = 'Поясница';
UPDATE muscles SET name = 'Teres major',        body_group = 'Back'      WHERE name = 'Круглые мышцы спины';
UPDATE muscles SET name = 'Infraspinatus',      body_group = 'Back'      WHERE name = 'Подостная';
UPDATE muscles SET name = 'Erector spinae',     body_group = 'Back'      WHERE name = 'Разгибатели спины';
UPDATE muscles SET name = 'Front delts',        body_group = 'Shoulders' WHERE name = 'Передние дельты';
UPDATE muscles SET name = 'Side delts',         body_group = 'Shoulders' WHERE name = 'Средние дельты';
UPDATE muscles SET name = 'Rear delts',         body_group = 'Shoulders' WHERE name = 'Задние дельты';
UPDATE muscles SET name = 'Rotator cuff',       body_group = 'Shoulders' WHERE name = 'Ротаторная манжета';
UPDATE muscles SET name = 'Neck',               body_group = 'Shoulders' WHERE name = 'Шея';
UPDATE muscles SET name = 'Biceps',             body_group = 'Arms'      WHERE name = 'Бицепс';
UPDATE muscles SET name = 'Triceps',            body_group = 'Arms'      WHERE name = 'Трицепс';
UPDATE muscles SET name = 'Forearms',           body_group = 'Arms'      WHERE name = 'Предплечья';
UPDATE muscles SET name = 'Brachialis',         body_group = 'Arms'      WHERE name = 'Плечевая (брахиалис)';
UPDATE muscles SET name = 'Wrist extensors',    body_group = 'Arms'      WHERE name = 'Разгибатели запястья';
UPDATE muscles SET name = 'Wrist flexors',      body_group = 'Arms'      WHERE name = 'Сгибатели запястья';
UPDATE muscles SET name = 'Abs',                body_group = 'Core'      WHERE name = 'Пресс';
UPDATE muscles SET name = 'Obliques',           body_group = 'Core'      WHERE name = 'Косые';
UPDATE muscles SET name = 'Transverse abdominis', body_group = 'Core'    WHERE name = 'Поперечная живота';
UPDATE muscles SET name = 'Hip flexors',        body_group = 'Core'      WHERE name = 'Сгибатели бедра';
UPDATE muscles SET name = 'Glutes',             body_group = 'Legs'      WHERE name = 'Ягодицы';
UPDATE muscles SET name = 'Glute medius',       body_group = 'Legs'      WHERE name = 'Средняя ягодичная';
UPDATE muscles SET name = 'Quads',              body_group = 'Legs'      WHERE name = 'Квадрицепс';
UPDATE muscles SET name = 'Hamstrings',         body_group = 'Legs'      WHERE name = 'Бицепс бедра';
UPDATE muscles SET name = 'Calves',             body_group = 'Legs'      WHERE name = 'Икры';
UPDATE muscles SET name = 'Soleus',             body_group = 'Legs'      WHERE name = 'Камбаловидная';
UPDATE muscles SET name = 'Tibialis anterior',  body_group = 'Legs'      WHERE name = 'Передняя большеберцовая';
UPDATE muscles SET name = 'Adductors',          body_group = 'Legs'      WHERE name = 'Приводящие';
UPDATE muscles SET name = 'Abductors',          body_group = 'Legs'      WHERE name = 'Отводящие';

UPDATE muscles SET body_group = 'Other' WHERE body_group IS NULL OR body_group = 'Прочее';

-- Настройки приложения: язык и всё, что появится дальше.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;
