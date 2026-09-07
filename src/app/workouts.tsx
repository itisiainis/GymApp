import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { RoutineForm } from '../components/RoutineForm';
import { SwipeRow } from '../components/SwipeRow';
import { useT } from '../lib/i18n';
import { deleteRoutine, getRoutineExercises, type RoutineExercise } from '../db/library';
import { listRoutines, type Routine } from '../db/workout-session';

export default function Workouts() {
  const { t } = useT();
  const [items, setItems] = useState<Routine[]>([]);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [exercises, setExercises] = useState<RoutineExercise[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    listRoutines().then(setItems);
  }, []);

  useFocusEffect(load);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((r) => r.name.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const openRoutine = async (id: number) => {
    setExercises(await getRoutineExercises(id));
    setOpenId(id);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ padding: 16, paddingTop: 48, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ flex: 1, fontSize: 24, fontWeight: '700' }}>{t('Templates')}</Text>
          <Pressable
            onPress={() => {
              setEditId(null);
              setFormOpen(true);
            }}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 14,
              backgroundColor: '#4aa3df',
              borderRadius: 8,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>
              {t('New template')}
            </Text>
          </Pressable>
        </View>

        {/* Шаблон — вторичная вещь: тренировка собирается с нуля, а шаблон
            берётся, когда он как раз есть, или сохраняется постфактум из
            уже сделанной тренировки. */}
        <Text style={{ color: '#888', fontSize: 13 }}>{t('Templates hint')}</Text>

        <TextInput
          placeholder={t('Search')}
          value={query}
          onChangeText={setQuery}
          style={{
            borderWidth: 1,
            borderColor: '#00000020',
            borderRadius: 8,
            padding: 10,
          }}
        />

        {!!error && <Text style={{ color: '#b23c3c' }}>{t(error)}</Text>}

        {filtered.length === 0 && (
          <Text style={{ color: '#999' }}>
            {items.length === 0 ? t('No templates yet') : t('Nothing found')}
          </Text>
        )}

        {filtered.map((r) => {
          const open = openId === r.id;
          return (
            <SwipeRow
              key={r.id}
              onDelete={async () => {
                    try {
                      setError('');
                      await deleteRoutine(r.id);
                      setOpenId(null);
                      load();
                    } catch (e: any) {
                      setError(e.message);
                    }
              }}
            >
            <View style={{ backgroundColor: '#00000008', borderRadius: 10, padding: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => (open ? setOpenId(null) : openRoutine(r.id))}
                >
                  <Text style={{ fontSize: 17, fontWeight: '600' }}>
                    {open ? '▴' : '▾'} {r.name}
                  </Text>
                  <Text style={{ color: '#888', fontSize: 13 }}>
                    {t('Exercises')}: {r.exercise_count}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => {
                    setEditId(r.id);
                    setFormOpen(true);
                  }}
                  style={{ paddingHorizontal: 10, paddingVertical: 6 }}
                >
                  <Text style={{ color: '#4aa3df', fontWeight: '600' }}>{t('Edit')}</Text>
                </Pressable>

              </View>

              {open && (
                <View style={{ marginTop: 8, gap: 4 }}>
                  {exercises.length === 0 ? (
                    <Text style={{ color: '#999', fontSize: 13 }}>
                      {t('This template has no exercises yet')}
                    </Text>
                  ) : (
                    exercises.map((e, i) => (
                      <Text key={e.exercise_id} style={{ fontSize: 14 }}>
                        {i + 1}. {e.name}
                        {e.measurement_default === 'hold' ? ` (${t('Time')})` : ''}
                      </Text>
                    ))
                  )}
                </View>
              )}
            </View>
            </SwipeRow>
          );
        })}
      </View>

      <RoutineForm
        visible={formOpen}
        routineId={editId}
        onClose={() => {
          setFormOpen(false);
          setEditId(null);
        }}
        onSaved={async (id) => {
          setFormOpen(false);
          setEditId(null);
          load();
          if (openId === id) await openRoutine(id);
        }}
      />
    </ScrollView>
  );
}
