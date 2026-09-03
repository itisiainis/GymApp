import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { WorkoutDetail } from '../components/WorkoutDetail';
import { getWorkoutDates, listWorkouts, type WorkoutSummary } from '../db/library';
import { useT } from '../lib/i18n';
import { fmt } from '../lib/time';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Локальная дата как YYYY-MM-DD (база хранит UTC, показываем местное). */
function localKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** Недели, полностью покрывающие месяц; дни соседних месяцев тоже попадают. */
function buildMonth(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));

  const last = new Date(year, month + 1, 0);
  const end = new Date(last);
  end.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));

  const weeks: Date[][] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const row: Date[] = [];
    for (let i = 0; i < 7; i++) {
      row.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

export default function Calendar() {
  const today = new Date();
  const { t } = useT();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [recent, setRecent] = useState<WorkoutSummary[]>([]);
  const [openWorkout, setOpenWorkout] = useState<WorkoutSummary | null>(null);
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      getWorkoutDates().then((iso) =>
        setDone(new Set(iso.map((s) => localKey(new Date(s)))))
      );
      listWorkouts(20).then(setRecent);
    }, [])
  );

  const weeks = useMemo(() => buildMonth(year, month), [year, month]);
  const todayKey = localKey(today);

  const shift = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ padding: 16, paddingTop: 48, paddingBottom: 24 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
          <Pressable onPress={() => shift(-1)} style={{ padding: 8 }}>
            <Text style={{ fontSize: 20, color: '#4aa3df' }}>‹</Text>
          </Pressable>
          <Text style={{ flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '700' }}>
            {t(MONTHS[month])} {year}
          </Text>
          <Pressable onPress={() => shift(1)} style={{ padding: 8 }}>
            <Text style={{ fontSize: 20, color: '#4aa3df' }}>›</Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row' }}>
          {DAYS.map((l, i) => (
            <Text
              key={l}
              style={{
                flex: 1,
                textAlign: 'center',
                fontWeight: '600',
                color: i >= 5 ? '#b23c3c' : '#000',
              }}
            >
              {t(l)}
            </Text>
          ))}
        </View>

        {weeks.map((week, wi) => (
          <View key={wi} style={{ flexDirection: 'row', marginTop: 6 }}>
            {week.map((day) => {
              const key = localKey(day);
              const isDone = done.has(key);
              const isToday = key === todayKey;
              const otherMonth = day.getMonth() !== month;
              const weekend = (day.getDay() + 6) % 7 >= 5;

              return (
                <View key={key} style={{ flex: 1, alignItems: 'center' }}>
                  <View
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 19,
                      backgroundColor: isDone ? '#3aa655' : weekend ? '#f7d5d5' : '#e6e6e6',
                      opacity: otherMonth ? 0.25 : 1,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: isToday ? 2 : 0,
                      borderColor: '#b23c3c',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        color: isDone ? '#fff' : '#555',
                        fontWeight: isDone ? '700' : '400',
                      }}
                    >
                      {isDone ? '✓' : day.getDate()}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        ))}

        <Pressable
          onPress={() => router.push('/session')}
          style={{
            marginTop: 20,
            padding: 14,
            backgroundColor: '#3aa655',
            borderRadius: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>{t('Start a workout')}</Text>
        </Pressable>

        <Pressable
          onPress={() => router.push('/history')}
          style={{
            marginTop: 10,
            padding: 14,
            backgroundColor: '#4aa3df',
            borderRadius: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>
            {t('View workout history')}
          </Text>
        </Pressable>

        <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 24, marginBottom: 8 }}>
          {t('Recent workouts')}
        </Text>

        {recent.length === 0 ? (
          <Text style={{ color: '#999' }}>{t('Nothing recorded yet')}</Text>
        ) : (
          recent.slice(0, 5).map((w) => (
            <Pressable
              key={w.id}
              // тап показывает карточку прямо тут, не уводя с календаря;
              // за полной историей — отдельная кнопка выше
              onPress={() => setOpenWorkout(w)}
              style={{
                backgroundColor: '#00000008',
                borderRadius: 10,
                padding: 12,
                marginBottom: 8,
              }}
            >
              <View style={{ flexDirection: 'row' }}>
                <Text style={{ flex: 1, fontWeight: '600' }}>{w.routine_name}</Text>
                <Text style={{ color: '#666', fontSize: 13 }}>
                  {new Date(w.started_at).toLocaleDateString()}
                </Text>
              </View>
              <Text style={{ color: '#666', fontSize: 13, marginTop: 2 }}>
                {fmt(w.total_seconds)} · {t('sets')}: {w.set_count}
              </Text>
              {!!w.exercises && (
                <Text style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
                  {w.exercises}
                </Text>
              )}
            </Pressable>
          ))
        )}
      </View>

      <WorkoutDetail workout={openWorkout} onClose={() => setOpenWorkout(null)} />
    </ScrollView>
  );
}
