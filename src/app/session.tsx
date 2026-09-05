import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ExerciseForm } from '../components/ExerciseForm';
import { ExercisePicker } from '../components/ExercisePicker';
import { RoutineForm } from '../components/RoutineForm';
import { Collapsible } from '../components/Collapsible';
import { ReorderableList } from '../components/ReorderableList';
import { SwipeRow } from '../components/SwipeRow';
import { WorkoutRecap } from '../components/WorkoutRecap';
import {
  addSetDraft,
  deleteSet,
  deleteWorkoutExercise,
  endWorkout,
  getActiveWorkout,
  getRoutinePrefill,
  getWorkoutTotalSeconds,
  pauseWorkout,
  resumeWorkout,
  setExerciseNote,
  setExerciseSetOrder,
  startSet,
  stopSet,
  recordSet,
  recordSetSeconds,
  unrecordSet,
  updateSetValues,
  type ActiveWorkout,
  type PrefillRow,
} from '../db/queries';
import {
  beginWorkout,
  ensureExerciseOrder,
  getExerciseNotes,
  getPreviousSets,
  getWorkoutSetsLive,
  listRoutines,
  setWorkoutExerciseOrder,
  type PreviousSet,
  type Routine,
  type SetRowLive,
} from '../db/workout-session';
import { DEFAULT_RECORDING, getRecordingSettings, type RecordingSettings } from '../db/settings';
import { useT } from '../lib/i18n';
import { fmt, fmtSigned, lastEndedAt, liveSeconds, restBySet, useNow } from '../lib/time';
import {
  HEADER_DONE,
  HEADER_DONE_PAUSED,
  HEADER_DONE_TEXT,
  HEADER_GREY,
  HEADER_GREY_TEXT,
  RED,
  RED_DARK,
  REST_BG,
  REST_HINT,
  REST_TEXT,
  REST_VALUE,
  SET_DONE_BG,
} from '../lib/theme';
import { setWorkoutActive } from '../lib/workoutLock';

/** Секунда на сворачивание: движение должно читаться, а не мигать. */
const COLLAPSE_MS = 1000;
/** Во время реордеринга сворачиваем быстрее — это техническая пауза, а не
 *  «упражнение закрыто», задерживать взгляд на ней незачем. */
const COLLAPSE_FAST_MS = 200;

/** Все подходы записаны и ни один не идёт — упражнение можно считать закрытым. */
function isGroupDone(sets: SetRowLive[]): boolean {
  return (
    sets.length > 0 && sets.every((s) => s.started_at !== null && s.is_running !== 1)
  );
}

/**
 * Готово к авто-сворачиванию — то же самое, но с единственным подходом не
 * считается: обычно сначала записывают один подход, а потом дописывают
 * ещё, и сворачивать в этот момент рано - только мешает добавить следующий.
 */
function shouldAutoCollapse(sets: SetRowLive[]): boolean {
  return sets.length > 1 && isGroupDone(sets);
}

export default function Session() {
  const { t } = useT();

  const [workout, setWorkout] = useState<ActiveWorkout | null>(null);
  const [rows, setRows] = useState<SetRowLive[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [routines, setRoutines] = useState<Routine[]>([]);

  // выбранная тренировка до старта: в базе ещё ничего нет
  const [pending, setPending] = useState<number | null>(null);
  const [preview, setPreview] = useState<PrefillRow[]>([]);
  const [prevSets, setPrevSets] = useState<PreviousSet[]>([]);
  const [countdown, setCountdown] = useState<number | null>(null);

  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [routineFormOpen, setRoutineFormOpen] = useState(false);
  const [editRoutineId, setEditRoutineId] = useState<number | null>(null);
  const [editExerciseId, setEditExerciseId] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [recapId, setRecapId] = useState<number | null>(null);
  const [recapTotal, setRecapTotal] = useState(0);
  // прокрутка гасится, пока карточку тащат: иначе список едет вместе с ней
  const [dragging, setDragging] = useState(false);
  // отдельно от dragging: перетаскивание ПОДХОДОВ внутри упражнения не
  // должно сворачивать все карточки, как это делает драг упражнений -
  // тогда были бы не видны сами подходы, которые тащишь
  const [setsDragging, setSetsDragging] = useState(false);
  // высота нижней панели: облако вешается над ней, а процентами это не
  // выразить — у панели высота auto, и bottom: '100%' не резолвится
  const [barHeight, setBarHeight] = useState(0);
  const [rec, setRec] = useState<RecordingSettings>(DEFAULT_RECORDING);

  const running = rows.find((r) => r.is_running === 1) ?? null;
  const paused = workout?.is_paused === 1;

  /**
   * Запирает экран только ИДУЩИЙ подход: пока таймер тикает, править веса и
   * переставлять карточки нечего — это тот подход, который прямо сейчас
   * делают.
   *
   * Пауза сюда больше не входит. Раньше она запирала всё то же самое, и на
   * паузе нельзя было ни добавить упражнение, ни поправить вес — а пауза как
   * раз для этого и нужна. Теперь она меняет только фон.
   */
  const locked = running !== null;
  /** Красная заливка — и на идущем подходе, и на паузе. */
  const redBackground = running !== null || paused;

  /** Подходы без отметки о выполнении — неважно, таймером или одним тапом. */
  const unrecorded = rows.filter((r) => !r.started_at).length;

  // во время перетаскивания тикающий таймер перерисовывал бы весь список
  const now = useNow(workout !== null && !dragging);

  // Отдых, который уже сложился между записанными подходами: подписывается
  // к каждому из них и дальше не меняется.
  const restBefore = restBySet(rows);
  /**
   * Идущий отдых: время с конца последнего записанного подхода. Пока подход
   * идёт, отдыха нет — там тикает свой таймер, и два счётчика рядом сбивали
   * бы с толку. На паузе отдых считается: пауза — это тоже отдых, просто
   * объявленный.
   */
  const lastEnd = lastEndedAt(rows);
  const restNow =
    running === null && lastEnd !== null
      ? Math.max(0, (now - Date.parse(lastEnd)) / 1000)
      : null;

  // Каждый await рвёт автобатчинг React 18 - если звать setState между
  // ними, экран перерисовывался бы отдельно на каждый запрос к базе, и
  // нижняя панель на мгновение показывала бы промежуточное состояние
  // (это и читалось как мигание, например при добавлении упражнения).
  // Поэтому сначала дочитываем всё нужное в переменные, а стейт выставляем
  // одним синхронным проходом - React соберёт его в один рендер.
  const refresh = useCallback(async () => {
    const w = await getActiveWorkout();
    if (!w) {
      const routineList = await listRoutines();
      setWorkout(null);
      setRows([]);
      setRoutines(routineList);
      return;
    }
    const [recSettings, liveRows, exerciseNotes] = await Promise.all([
      getRecordingSettings(),
      getWorkoutSetsLive(w.id),
      getExerciseNotes(w.id),
    ]);
    setWorkout(w);
    setPending(null);
    setRec(recSettings);
    setRows(liveRows);
    setNotes(exerciseNotes);
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  useEffect(() => {
    if (!workout) return;
    getWorkoutTotalSeconds(workout.id).then(setTotal);
  }, [workout, now]);

  // Свайп между вкладками (_layout.tsx) выключаем на время тренировки:
  // иначе он конфликтует со свайпами удаления сета/упражнения на этом же
  // экране. Сбрасываем и при уходе с экрана - иначе флаг остался бы
  // включённым навсегда, если тренировку закончили не через Finish
  // (например, свернули приложение).
  const hasWorkout = workout !== null;
  useEffect(() => {
    setWorkoutActive(hasWorkout);
    return () => setWorkoutActive(false);
  }, [hasWorkout]);

  // Отметил подход — предупреждение о незаписанных больше не про текущее
  // состояние: и его число, и «Finish anyway» устарели. Возвращаем спокойный
  // вид. Считаем по любому изменению: добавленный подход тоже делает
  // прежнее предупреждение неверным.
  const prevUnrecorded = useRef(unrecorded);
  useEffect(() => {
    if (prevUnrecorded.current === unrecorded) return;
    prevUnrecorded.current = unrecorded;
    setConfirmFinish(false);
  }, [unrecorded]);

  /**
   * Сворачивание — сам флаг только фиксирует, что пользователь тронул
   * карточку руками. Показываем ли её свёрнутой на самом деле — решает
   * displayCollapsed ниже: пока пользователь не вмешался явно, это
   * вычисляется заново на каждый рендер из «все подходы готовы?».
   *
   * Раньше «авто-сворачивание, когда всё готово» и «авто-раскрытие при
   * снятой отметке» были отдельным эффектом, который вручную отслеживал,
   * что сам свернул, а что нет, через ref-множество. Это заводило два
   * источника правды (collapsed и autoCollapsed) и легко расходилось —
   * например, после реордеринга, который тоже трогает collapsed. Здесь же
   * то, что не задано явно, всегда пересчитывается из текущего состояния
   * подходов, разъехаться нечему.
   */
  const toggleCollapsed = (exerciseId: number, next: boolean) => {
    setCollapsed((c) => ({ ...c, [exerciseId]: next }));
  };

  /**
   * "manual" в collapsed держится, пока его не тронут заново — а тронуть
   * его могли ещё ДО того, как упражнение стало готовым (раскрыл, чтобы
   * поправить вес перед подходом). После этого override навсегда
   * перекрывал бы allDone, и авто-сворачивание переставало бы работать
   * для любого упражнения, которое хоть раз открывали руками. Поэтому
   * снимаем override именно в момент перехода в «готово» — раскрытие уже
   * ПОСЛЕ этого момента (например, чтобы что-то поправить в готовом
   * упражнении) остаётся раскрытием и повторно не схлопывается.
   */
  const wasDoneRef = useRef<Record<number, boolean>>({});
  useEffect(() => {
    const byExercise = new Map<number, SetRowLive[]>();
    for (const row of rows) {
      const arr = byExercise.get(row.exercise_id);
      if (arr) arr.push(row);
      else byExercise.set(row.exercise_id, [row]);
    }
    const wasDone = wasDoneRef.current;
    const nowDone: Record<number, boolean> = {};
    const justFinished: number[] = [];
    byExercise.forEach((sets, exerciseId) => {
      const done = shouldAutoCollapse(sets);
      nowDone[exerciseId] = done;
      if (done && !wasDone[exerciseId]) justFinished.push(exerciseId);
    });
    wasDoneRef.current = nowDone;
    if (justFinished.length > 0) {
      setCollapsed((c) => {
        const next = { ...c };
        for (const id of justFinished) delete next[id];
        return next;
      });
    }
  }, [rows]);

  /**
   * Показывать ли карточку свёрнутой. dragging — то, что видно прямо
   * сейчас, пока идёт перетаскивание; наружу (в collapsed) он не
   * записывается, поэтому по окончании драга ничего не нужно
   * восстанавливать — оно и не менялось.
   */
  const displayCollapsed = (exerciseId: number, allDone: boolean): boolean => {
    if (dragging) return true;
    const manual = collapsed[exerciseId];
    return manual ?? allDone;
  };

  /** Открыть тренировку до старта: показываем состав и прошлые результаты. */
  const openPending = async (routineId: number) => {
    setPending(routineId);
    setCountdown(null);
    setPreview(await getRoutinePrefill(routineId));
    setPrevSets(await getPreviousSets(routineId));
  };

  // 5 секунд перед стартом — время дойти до снаряда
  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      if (pending !== null) {
        beginWorkout(pending).then(() => {
          setPending(null);
          setCollapsed({});
          refresh();
        });
      }
      return;
    }
    const id = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
  }, [countdown, pending, refresh]);

  /* ---------------- выбор тренировки ---------------- */

  // Собираем экран в переменную и рендерим один раз в конце, вместе с
  // WorkoutRecap - иначе он не попадал в дерево во время экранов до и до
  // старта тренировки и всплывал не тогда, когда нужно.
  let body: React.ReactNode;

  if (!workout && pending === null) {
    body = (
      <ScrollView style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={{ padding: 20, paddingTop: 56, gap: 12 }}>
          <Text style={{ fontSize: 24, fontWeight: '700' }}>{t('Start a workout')}</Text>

          {routines.length === 0 && (
            <Text style={{ color: '#888' }}>{t('No workouts yet')}</Text>
          )}

          <Pressable
            onPress={() => {
              setEditRoutineId(null);
              setRoutineFormOpen(true);
            }}
            style={{
              padding: 14,
              alignItems: 'center',
              backgroundColor: '#4aa3df',
              borderRadius: 10,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>{t('New workout')} +</Text>
          </Pressable>

          {routines.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => openPending(r.id)}
              style={{ padding: 16, backgroundColor: '#00000008', borderRadius: 10 }}
            >
              <Text style={{ fontSize: 17, fontWeight: '600' }}>{r.name}</Text>
              <Text style={{ color: '#888', fontSize: 13 }}>
                {t('Exercises')}: {r.exercise_count}
              </Text>
            </Pressable>
          ))}
        </View>

        <RoutineForm
          visible={routineFormOpen}
          routineId={editRoutineId}
          onClose={() => setRoutineFormOpen(false)}
          onSaved={() => {
            setRoutineFormOpen(false);
            refresh();
          }}
        />
      </ScrollView>
    );
  } else if (!workout && pending !== null) {
    const groups: { exerciseId: number; name: string; sets: PreviousSet[] }[] = [];
    for (const ex of preview) {
      if (!groups.some((g) => g.exerciseId === ex.exercise_id)) {
        groups.push({
          exerciseId: ex.exercise_id,
          name: ex.name,
          sets: prevSets.filter((p) => p.exercise_id === ex.exercise_id),
        });
      }
    }

    body = (
      <View style={{ flex: 1, backgroundColor: '#fff' }}>
        <ScrollView contentContainerStyle={{ padding: 12, paddingTop: 48 }}>
          {groups.map((g) => {
            // пустые упражнения свёрнуты, с прошлыми подходами — раскрыты
            const isCollapsed = collapsed[g.exerciseId] ?? g.sets.length === 0;
            return (
              <View
                key={g.exerciseId}
                style={{
                  marginBottom: 10,
                  backgroundColor: '#00000008',
                  borderRadius: 10,
                  padding: 10,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() =>
                      setCollapsed((c) => ({ ...c, [g.exerciseId]: !isCollapsed }))
                    }
                  >
                    <Text style={{ fontSize: 18, fontWeight: '600' }}>
                      {isCollapsed ? '▾' : '▴'} {g.name}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setEditExerciseId(g.exerciseId)}
                    style={{ paddingHorizontal: 10, paddingVertical: 6 }}
                  >
                    <Text style={{ color: '#4aa3df', fontWeight: '600' }}>{t('Edit')}</Text>
                  </Pressable>
                </View>

                {!isCollapsed && (
                  <View style={{ marginTop: 8, gap: 4 }}>
                    {g.sets.length === 0 ? (
                      <Text style={{ color: '#999', fontSize: 13 }}>{t('Nothing')}</Text>
                    ) : (
                      <>
                        <Text style={{ fontSize: 11, color: '#999' }}>
                          {t('Last time')} ·{' '}
                          {new Date(g.sets[0].workout_started).toLocaleDateString()}
                        </Text>
                        {g.sets.map((p, i) => (
                          <Text key={i} style={{ color: '#444', fontSize: 14 }}>
                            {p.reps != null && p.weight_kg != null
                              ? `${p.reps} × ${p.weight_kg} ${t('kg')}`
                              : p.reps != null
                                ? `${p.reps} ${t('reps')}`
                                : p.active_seconds > 0
                                  ? fmt(p.active_seconds)
                                  : '—'}
                          </Text>
                        ))}
                      </>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>

        {/* Let's start шире Back в отношении 4:3 */}
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: '#00000015',
          }}
        >
          <Pressable
            onPress={() => setCountdown(countdown === null ? 5 : null)}
            style={{
              flex: 4,
              padding: 16,
              alignItems: 'center',
              backgroundColor: countdown === null ? '#3aa655' : '#2c8746',
              borderRadius: 10,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>
              {countdown === null ? t("Let's start") : String(countdown)}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              setCountdown(null);
              setPending(null);
            }}
            style={{
              flex: 3,
              padding: 16,
              alignItems: 'center',
              backgroundColor: '#eee',
              borderRadius: 10,
            }}
          >
            <Text style={{ fontWeight: '600', fontSize: 16 }}>{t('Go back')}</Text>
          </Pressable>
        </View>

        <ExerciseForm
          visible={editExerciseId !== null}
          exerciseId={editExerciseId}
          onClose={() => setEditExerciseId(null)}
          onSaved={async () => {
            setEditExerciseId(null);
            if (pending !== null) setPreview(await getRoutinePrefill(pending));
          }}
        />
      </View>
    );
  } else {
    /* ---------------- активная тренировка ---------------- */

    const groups: { exerciseId: number; name: string; sets: SetRowLive[] }[] = [];
    for (const row of rows) {
      let g = groups.find((x) => x.exerciseId === row.exercise_id);
      if (!g) {
        g = { exerciseId: row.exercise_id, name: row.exercise_name, sets: [] };
        groups.push(g);
      }
      g.sets.push(row);
    }

    body = (
    <View style={{ flex: 1, backgroundColor: redBackground ? RED : '#fff' }}>
      <ScrollView
        style={{ flex: 1 }}
        scrollEnabled={!dragging && !setsDragging}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 12, paddingTop: 48 }}
      >
        <ReorderableList
          items={groups}
          keyOf={(g) => g.exerciseId}
          onDraggingChange={setDragging}
          onReorder={async (next) => {
            setRows((prev) => {
              const order = next.map((g) => g.exerciseId);
              return [...prev].sort(
                (a, b) =>
                  order.indexOf(a.exercise_id) - order.indexOf(b.exercise_id) ||
                  a.id - b.id
              );
            });
            await setWorkoutExerciseOrder(
              workout!.id,
              next.map((g) => g.exerciseId)
            );
          }}
          renderItem={(g, _i, isBeingDragged, startDrag) => {
          const hasRunning = g.sets.some((s) => s.is_running === 1);
          const allDone = isGroupDone(g.sets);
          const isCollapsed = displayCollapsed(g.exerciseId, shouldAutoCollapse(g.sets));
          const headerText = allDone ? HEADER_DONE_TEXT : HEADER_GREY_TEXT;

          return (
            <View
              style={{
                marginBottom: 10,
                backgroundColor: isBeingDragged
                  ? '#e2eef7'
                  : locked && !hasRunning
                    ? '#00000010'
                    : '#00000008',
                borderRadius: 10,
                padding: 10,
              }}
            >
              {/* Свайп висит на строке названия, а не на всей карточке:
                  иначе он оказывался снаружи свайпов подходов, ловил их жест
                  и удалял упражнение целиком вместо одного подхода. */}
              <SwipeRow
                disabled={locked}
                onDelete={async () => {
                  await deleteWorkoutExercise(workout!.id, g.exerciseId);
                  refresh();
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: allDone
                      ? paused
                        ? HEADER_DONE_PAUSED
                        : HEADER_DONE
                      : HEADER_GREY,
                    borderRadius: 8,
                    paddingLeft: 10,
                    paddingRight: 4,
                  }}
                >
                  <Pressable
                    // dragging — не только эта карточка: пока тащат любую,
                    // остальные тоже временно не реагируют на тап.
                    disabled={locked || dragging}
                    onPress={() => toggleCollapsed(g.exerciseId, !isCollapsed)}
                    // Зажал имя — карточка едет за пальцем прямо здесь,
                    // без отдельного экрана со списком.
                    onLongPress={() => {
                      if (groups.length > 1) startDrag();
                    }}
                    delayLongPress={280}
                    style={{ flex: 1, paddingVertical: 10 }}
                  >
                    <Text style={{ fontSize: 18, fontWeight: '600', color: headerText }}>
                      {isCollapsed ? '▾' : '▴'} {g.name}
                    </Text>
                  </Pressable>

                  <Pressable
                    disabled={locked}
                    onPress={() => setEditExerciseId(g.exerciseId)}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 10,
                      opacity: locked ? 0.3 : 1,
                    }}
                  >
                    <Text style={{ color: headerText, fontWeight: '600' }}>{t('Edit')}</Text>
                  </Pressable>
                </View>
              </SwipeRow>

              {/* Во время перетаскивания сворачивание быстрое: это не
                  «упражнение закрыто», а просто временно убрано с глаз,
                  чтобы видеть порядок карточек. */}
              <Collapsible
                collapsed={isCollapsed}
                duration={dragging ? COLLAPSE_FAST_MS : COLLAPSE_MS}
              >
                  <View style={{ gap: 6, marginTop: 8 }}>
                    <ReorderableList
                      items={g.sets}
                      keyOf={(s) => s.id}
                      onDraggingChange={setSetsDragging}
                      onReorder={async (nextSets) => {
                        const order = nextSets.map((s) => s.id);
                        // те же id, что уже были в rows, просто внутри
                        // одного упражнения переставлены; остальные строки
                        // не трогаем - sort с компаратором "0" стабилен
                        // (гарантия ES2019, Hermes её соблюдает)
                        setRows((prev) =>
                          [...prev].sort((a, b) => {
                            if (
                              a.exercise_id !== g.exerciseId ||
                              b.exercise_id !== g.exerciseId
                            ) {
                              return 0;
                            }
                            return order.indexOf(a.id) - order.indexOf(b.id);
                          })
                        );
                        await setExerciseSetOrder(workout!.id, g.exerciseId, order);
                      }}
                      renderItem={(s, _i, isSetBeingDragged, startSetDrag) => (
                        <View>
                          {/* Сколько отдыхали перед этим подходом. Стоит над
                              ним, а не под предыдущим: отдых — это то, с чем
                              подход подошёл к штанге, и читается он вместе
                              со строкой, к которой относится. */}
                          {restBefore[s.id] !== undefined && (
                            <Text
                              style={{
                                fontSize: 11,
                                color: REST_HINT,
                                paddingLeft: 14,
                                paddingBottom: 2,
                              }}
                            >
                              ⏱ {t('rest')} {fmt(restBefore[s.id])}
                            </Text>
                          )}

                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                            {/* Отдельная зона для драга: сама строка подхода
                                почти целиком из полей ввода, зажать точно
                                на них не выйдет - а тут выделенная ручка. */}
                            <Pressable
                              disabled={locked || s.is_running === 1 || g.sets.length < 2}
                              onLongPress={startSetDrag}
                              delayLongPress={200}
                              hitSlop={8}
                              style={{
                                paddingHorizontal: 4,
                                opacity: locked || s.is_running === 1 ? 0.2 : 1,
                              }}
                            >
                              <Text style={{ color: '#bbb', fontSize: 16 }}>≡</Text>
                            </Pressable>

                            <View
                              style={{
                                flex: 1,
                                backgroundColor: isSetBeingDragged ? '#e2eef7' : 'transparent',
                                borderRadius: 6,
                              }}
                            >
                              <SwipeRow
                                disabled={locked || s.is_running === 1}
                                onDelete={async () => {
                                  await deleteSet(s.id);
                                  refresh();
                                }}
                              >
                                <SetLine
                                  row={s}
                                  locked={locked && s.is_running !== 1}
                                  timed={rec.advancedReps || s.measurement_default === 'hold'}
                                  seconds={liveSeconds(s.active_seconds, s.running_since, now)}
                                  onChanged={refresh}
                                  // при «Finish anyway» показываем, каких
                                  // именно подходов не хватает
                                  flagged={confirmFinish && !s.started_at}
                                />
                              </SwipeRow>
                            </View>
                          </View>
                        </View>
                      )}
                    />

                    <Pressable
                      disabled={locked}
                      onPress={async () => {
                        const last = g.sets[g.sets.length - 1];
                        await addSetDraft(
                          workout!.id,
                          g.exerciseId,
                          last?.reps ?? null,
                          last?.weight_kg ?? null
                        );
                        refresh();
                      }}
                      style={{ paddingVertical: 8, opacity: locked ? 0.3 : 1 }}
                    >
                      <Text style={{ fontWeight: '600' }}>{t('Add set +')}</Text>
                    </Pressable>

                    <TextInput
                      editable={!locked}
                      placeholder={t('Pain or sensations during the sets')}
                      defaultValue={notes[g.exerciseId] ?? ''}
                      onEndEditing={(e) =>
                        setExerciseNote(workout!.id, g.exerciseId, e.nativeEvent.text)
                      }
                      style={{
                        backgroundColor: '#0000000a',
                        borderRadius: 6,
                        padding: 8,
                        fontSize: 13,
                      }}
                    />
                  </View>
              </Collapsible>
            </View>
          );
          }}
        />

        {running !== null &&
          liveSeconds(running.active_seconds, running.running_since, now) > 300 && (
            <Text
              style={{
                color: RED_DARK,
                fontWeight: '600',
                textAlign: 'center',
                paddingVertical: 8,
              }}
            >
              {t('Set is still running')}
            </Text>
          )}

        <Pressable
          disabled={locked}
          onPress={() => setPickerOpen(true)}
          style={{
            paddingVertical: 14,
            alignItems: 'center',
            opacity: locked ? 0.3 : 1,
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: '600' }}>{t('Add exercise +')}</Text>
        </Pressable>

        {groups.length > 1 && !locked && (
          <Text
            style={{
              color: '#999',
              fontSize: 12,
              textAlign: 'center',
              paddingVertical: 6,
            }}
          >
            {t('Hold an exercise name to reorder')}
          </Text>
        )}
      </ScrollView>

      {/* insets.bottom здесь не нужен: панель стоит над таббаром, а он уже
          учитывает системный отступ — вдвоём они давали пустую полосу. */}
      {confirmFinish && (
        <Cloud
          text={`${t('Unrecorded sets')}: ${unrecorded}`}
          bottom={barHeight + 8}
        />
      )}

      {/* Полоса отдыха и панель меряются вместе: облако с предупреждением
          висит над ними обеими, и по высоте одной панели оно наезжало бы
          на отдых. */}
      <View onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}>
        {restNow !== null && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              justifyContent: 'center',
              gap: 8,
              paddingVertical: 6,
              backgroundColor: REST_BG,
              borderTopWidth: 1,
              borderTopColor: '#00000010',
            }}
          >
            <Text style={{ color: REST_TEXT, fontSize: 13, fontWeight: '600' }}>
              {t('Rest')}
            </Text>
            <Text
              style={{
                color: REST_VALUE,
                fontSize: 22,
                fontWeight: '700',
                // моноширинные цифры: без них строка дёргается на каждой
                // секунде, потому что цифры разной ширины
                fontVariant: ['tabular-nums'],
              }}
            >
              {fmt(restNow)}
            </Text>
          </View>
        )}

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: '#00000015',
            backgroundColor: '#fff',
          }}
        >
          <Text style={{ flex: 1, fontSize: 16 }}>
            {t('Total')}: {fmt(total)}
            {paused ? ` (${t('paused')})` : ''}
          </Text>

          <Pressable
            disabled={locked}
            onPress={async () => {
              if (paused) {
                await resumeWorkout(workout!.id);
              } else {
                await pauseWorkout(workout!.id);
              }
              refresh();
            }}
            style={{
              paddingVertical: 10,
              paddingHorizontal: 14,
              backgroundColor: '#4aa3df',
              borderRadius: 8,
              opacity: locked ? 0.3 : 1,
            }}
          >
            <Text style={{ color: '#fff' }}>{paused ? t('Resume') : t('Pause')}</Text>
          </Pressable>

          <Pressable
            disabled={locked}
            onPress={async () => {
              if (unrecorded > 0 && !confirmFinish) {
                setConfirmFinish(true);
                // раскрываем упражнения с невыполненными сетами, если их
                // свернули руками - иначе пульсацию просто не видно
                const withUnrecorded = new Set(
                  rows.filter((r) => !r.started_at).map((r) => r.exercise_id)
                );
                setCollapsed((c) => {
                  const next = { ...c };
                  for (const id of withUnrecorded) next[id] = false;
                  return next;
                });
                return;
              }
              const id = workout!.id;
              const secs = await getWorkoutTotalSeconds(id);
              await endWorkout(id);
              setConfirmFinish(false);
              setRecapTotal(secs);
              setRecapId(id);
              refresh();
            }}
            style={{
              paddingVertical: 10,
              paddingHorizontal: 14,
              backgroundColor: RED_DARK,
              borderRadius: 8,
              opacity: locked ? 0.3 : 1,
            }}
          >
            <Text style={{ color: '#fff' }}>
              {confirmFinish ? t('Finish anyway') : t('Finish')}
            </Text>
          </Pressable>
        </View>
      </View>

      <ExercisePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={async (exerciseId) => {
          await addSetDraft(workout!.id, exerciseId, null, null);
          await ensureExerciseOrder(workout!.id, exerciseId);
          // без await шторка закрывалась бы до того, как экран под ней
          // обновится, - см. комментарий в ExercisePicker.confirm
          await refresh();
        }}
      />

      <ExerciseForm
        visible={editExerciseId !== null}
        exerciseId={editExerciseId}
        onClose={() => setEditExerciseId(null)}
        onSaved={() => {
          setEditExerciseId(null);
          refresh();
        }}
      />
    </View>
    );
  }

  // Рендерится всегда, независимо от того, какой из трёх экранов выше
  // сейчас активен - иначе финальный отчёт всплывал только когда
  // начиналась следующая тренировка, а не сразу после этой.
  return (
    <>
      {body}
      <WorkoutRecap
        workoutId={recapId}
        totalSeconds={recapTotal}
        onClose={() => setRecapId(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Всплывающее облако над нижней панелью                               */
/* ------------------------------------------------------------------ */

/**
 * Предупреждение висит над панелью, а не занимает строку под ней:
 * оно появляется редко, и постоянное место под него оставлять незачем.
 */
function Cloud({ text, bottom }: { text: string; bottom: number }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [anim]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        // отсчёт от низа экрана: панель уже измерена, проценты не годятся
        bottom,
        right: 12,
        zIndex: 20,
        opacity: anim,
        transform: [
          { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
        ],
      }}
    >
      <View
        style={{
          backgroundColor: RED_DARK,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 8,
          elevation: 4,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '600' }}>{text}</Text>
      </View>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ */
/* Строка подхода                                                      */
/* ------------------------------------------------------------------ */

function SetLine({
  row,
  locked,
  timed,
  seconds,
  onChanged,
  flagged,
}: {
  row: SetRowLive;
  locked: boolean;
  /** Мерить время подхода или просто отмечать выполнение. */
  timed: boolean;
  /** Уже посчитанное время: родитель пересчитывает его каждые полсекунды. */
  seconds: number;
  onChanged: () => void;
  /** Подход мешает завершить тренировку — пульсируем, чтобы его нашли. */
  flagged: boolean;
}) {
  const { t } = useT();
  const isRunning = row.is_running === 1;
  const isDone = !isRunning && row.started_at !== null;
  const prepping = timed && row.started_at !== null && seconds < 0;

  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!flagged) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        // цвет — не transform, нативным драйвером его не прогнать
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 650, useNativeDriver: false }),
      ]),
      // 3 раза достаточно, чтобы привлечь внимание - дальше это не тревога,
      // а фон, который просто мешает
      { iterations: 3 }
    );
    loop.start();
    return () => loop.stop();
  }, [flagged, pulse]);

  const background = flagged
    ? pulse.interpolate({
        inputRange: [0, 1],
        // тот же светло-красный, что заливает экран во время подхода
        outputRange: ['rgba(232,196,196,0)', 'rgba(232,196,196,1)'],
      })
    : isRunning
      ? '#ffffff'
      : isDone
        ? SET_DONE_BG
        : 'transparent';

  return (
    <Animated.View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        opacity: locked ? 0.3 : 1,
        backgroundColor: background,
        borderRadius: 6,
        paddingVertical: 4,
      }}
    >
      <TextInput
        editable={!locked}
        keyboardType="numeric"
        placeholder={t('kg')}
        defaultValue={row.weight_kg == null ? '' : String(row.weight_kg)}
        onEndEditing={async (e) => {
          const v = e.nativeEvent.text.trim();
          await updateSetValues(row.id, { weightKg: v === '' ? null : Number(v) });
          onChanged();
        }}
        style={[inputStyle, { backgroundColor: locked ? 'transparent' : '#fff' }]}
      />

      <TextInput
        editable={!locked}
        keyboardType="numeric"
        placeholder={t('reps')}
        defaultValue={row.reps == null ? '' : String(row.reps)}
        onEndEditing={async (e) => {
          const v = e.nativeEvent.text.trim();
          await updateSetValues(row.id, { reps: v === '' ? null : Number(v) });
          onChanged();
        }}
        style={[inputStyle, { backgroundColor: locked ? 'transparent' : '#fff' }]}
      />

      <Pressable
        disabled={locked}
        onPress={async () => {
          if (timed) {
            if (isRunning) await stopSet(row.id);
            else await startSet(row.id);
          } else {
            // один тап: отметил — снял отметку
            if (isDone) await unrecordSet(row.id);
            else await recordSet(row.id);
          }
          onChanged();
        }}
        style={{
          paddingVertical: 8,
          paddingHorizontal: 12,
          backgroundColor: isRunning
            ? RED_DARK
            : locked
              ? '#00000020'
              : isDone
                ? '#2c8746'
                : '#3aa655',
          borderRadius: 6,
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '700' }}>
          {timed ? (isRunning ? '❚❚' : isDone ? '✓' : '▶') : isDone ? '✓' : '○'}
        </Text>
      </Pressable>

      {timed &&
        (isRunning ? (
          // во время самого подхода значение тикает — редактировать нечего
          <Text
            style={{
              width: 56,
              textAlign: 'right',
              color: prepping ? '#999' : undefined,
              fontWeight: prepping ? '600' : undefined,
            }}
          >
            {fmtSigned(seconds)}
          </Text>
        ) : (
          // ручной ввод секунд — для тех, кто засекает внешним секундомером
          // и не хочет держаться за прижимной таймер приложения
          <TextInput
            editable={!locked}
            keyboardType="numeric"
            placeholder={t('sec')}
            defaultValue={row.started_at ? String(Math.round(seconds)) : ''}
            onEndEditing={async (e) => {
              const v = e.nativeEvent.text.trim();
              if (v === '') {
                if (row.started_at) {
                  await unrecordSet(row.id);
                  onChanged();
                }
                return;
              }
              const n = Number(v);
              if (!Number.isFinite(n) || n < 0) return;
              await recordSetSeconds(row.id, Math.round(n));
              onChanged();
            }}
            style={[
              inputStyle,
              {
                flex: 0,
                width: 56,
                textAlign: 'right',
                backgroundColor: locked ? 'transparent' : '#fff',
                color: isDone ? '#2c8746' : undefined,
                fontWeight: isDone ? '600' : undefined,
              },
            ]}
          />
        ))}
    </Animated.View>
  );
}

const inputStyle = {
  flex: 1,
  borderWidth: 1,
  borderColor: '#00000020',
  borderRadius: 6,
  paddingVertical: 6,
  paddingHorizontal: 8,
  fontSize: 15,
} as const;
