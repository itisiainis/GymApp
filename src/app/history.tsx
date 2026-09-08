import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  deleteWorkout,
  getWorkoutDetail,
  listWorkouts,
  type HistorySet,
  type WorkoutSummary,
} from '../db/library';
import { SwipeRow } from '../components/SwipeRow';
import { useT } from '../lib/i18n';
import { effectiveLoad, fmtKg } from '../lib/load';
import { rirBadge } from '../lib/rir';
import { fmt, fmtMs } from '../lib/time';
import { localizeWorkoutName } from '../lib/workoutName';

function dateLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
}

export default function History() {
  const { t } = useT();
  const { open } = useLocalSearchParams<{ open?: string }>();
  const [items, setItems] = useState<WorkoutSummary[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<HistorySet[]>([]);

  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef<Record<number, number>>({});

  const expand = useCallback(async (id: number) => {
    setDetail(await getWorkoutDetail(id));
    setOpenId(id);
  }, []);

  useFocusEffect(
    useCallback(() => {
      listWorkouts().then(async (rows) => {
        setItems(rows);
        // пришли по ссылке с календаря — сразу раскрываем нужную тренировку
        const target = open ? Number(open) : null;
        if (target && rows.some((r) => r.id === target)) {
          await expand(target);
        }
      });
    }, [open, expand])
  );

  /**
   * Скроллим после того, как карточка раскрылась и её высота известна.
   * onLayout запоминает позицию каждой карточки, поэтому прыжок точный.
   */
  const scrollToOpen = (id: number) => {
    const y = offsets.current[id];
    if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
  };

  return (
    <ScrollView ref={scrollRef} style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ padding: 16, paddingTop: 48, gap: 10 }}>
        <Text style={{ fontSize: 24, fontWeight: '700' }}>{t('History')}</Text>

        {items.length === 0 && (
          <Text style={{ color: '#888' }}>{t('No finished workouts yet')}</Text>
        )}

        {items.map((w) => {
          const isOpen = openId === w.id;
          return (
            <SwipeRow
              key={w.id}
              onDelete={async () => {
                await deleteWorkout(w.id);
                setOpenId(null);
                setItems(await listWorkouts());
              }}
            >
            <View
              onLayout={(e) => {
                offsets.current[w.id] = e.nativeEvent.layout.y;
                if (isOpen && String(w.id) === open) scrollToOpen(w.id);
              }}
              style={{ backgroundColor: '#00000008', borderRadius: 10, padding: 12 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => (isOpen ? setOpenId(null) : expand(w.id))}
                >
                  <Text style={{ fontSize: 17, fontWeight: '600' }}>
                    {isOpen ? '▴' : '▾'}{' '}
                    {localizeWorkoutName(w.title, t) ?? t('Workout')}
                  </Text>
                  <Text style={{ color: '#666', fontSize: 13 }}>
                    {dateLabel(w.started_at)} · {fmt(w.total_seconds)} · {t('sets')}:{' '}
                    {w.set_count}
                  </Text>
                  {!isOpen && !!w.exercises && (
                    <Text style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
                      {w.exercises}
                    </Text>
                  )}
                </Pressable>

              </View>

              {isOpen && (
                <View style={{ marginTop: 10, gap: 8 }}>
                  {groupByExercise(detail).map((g) => (
                    <View key={g.exerciseId}>
                      <Text style={{ fontWeight: '600' }}>{g.name}</Text>
                      {/* Завершённая тренировка — запись, а не черновик:
                          отдельные подходы здесь не удаляем. */}
                      {g.sets.map((s) => (
                        <Text key={s.id} style={{ color: '#444', fontSize: 13 }}>
                          {setLabel(s, t)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              )}
            </View>
            </SwipeRow>
          );
        })}
      </View>
    </ScrollView>
  );
}

/** Как показать подход: 8 × 60 kg · RIR 2 / 8 reps / 0:25 */
function setLabel(s: HistorySet, t: (k: string) => string): string {
  const badge = rirBadge(s, t);
  // У подходов, записанных до перехода на RIR, его нет — там строка
  // остаётся ровно такой же, какой была.
  const suffix = badge === null ? '' : ` · ${badge}`;
  if (s.measurement_default === 'hold' && s.active_seconds > 0) return fmtMs(s.active_seconds);
  // Показываем настоящую нагрузку: в подходе записан вес одной гантели
  // или блин на поясе, а поднято — с учётом снаряжения (lib/load.ts).
  const load = effectiveLoad(s.weight_kg, s, s.bodyweight_kg);
  if (s.reps != null && load != null)
    return `${s.reps} × ${fmtKg(load)} ${t('kg')}${suffix}`;
  if (s.reps != null) return `${s.reps} ${t('reps')}${suffix}`;
  if (s.active_seconds > 0) return fmtMs(s.active_seconds);
  return badge ?? '—';
}

function groupByExercise(sets: HistorySet[]) {
  const out: { exerciseId: number; name: string; sets: HistorySet[] }[] = [];
  for (const s of sets) {
    let g = out.find((x) => x.exerciseId === s.exercise_id);
    if (!g) {
      g = { exerciseId: s.exercise_id, name: s.exercise_name, sets: [] };
      out.push(g);
    }
    g.sets.push(s);
  }
  return out;
}
