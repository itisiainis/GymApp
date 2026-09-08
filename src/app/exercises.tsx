import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ExerciseForm } from '../components/ExerciseForm';
import { SwipeRow } from '../components/SwipeRow';
import {
  deleteExercise,
  getExerciseMuscles,
  getExerciseUsage,
  type ExerciseMuscle,
} from '../db/library';
import { searchExercises, type Exercise } from '../db/queries';
import { useT } from '../lib/i18n';
import { exerciseTags, matchesQuery } from '../lib/tags';

export default function Exercises() {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Exercise[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [muscles, setMuscles] = useState<ExerciseMuscle[]>([]);
  const [usage, setUsage] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    searchExercises().then(setItems);
  }, []);

  useFocusEffect(load);
  useEffect(load, [load]);

  // Поиск идёт по названию И по тегам — мышцам и снаряду: «бицепс штанга»
  // находит то, что размечено обоими. Фильтруем в памяти, потому что
  // переводы тегов известны только здесь (см. lib/tags.ts).
  const found = useMemo(
    () => items.filter((e) => matchesQuery(e, query, t)),
    [items, query, t]
  );

  const mine = found.filter((e) => e.is_custom === 1);
  const builtin = found.filter((e) => e.is_custom === 0);

  const openCard = async (id: number) => {
    setMuscles(await getExerciseMuscles(id));
    setUsage(await getExerciseUsage(id));
    setOpenId(id);
  };

  const renderItem = (e: Exercise) => {
    const open = openId === e.id;
    return (
      <SwipeRow
        key={e.id}
        disabled={e.is_custom !== 1}
        onDelete={async () => {
          try {
            setError('');
            await deleteExercise(e.id);
            setOpenId(null);
            load();
          } catch (err: any) {
            setError(err.message);
          }
        }}
      >
      <View
        style={{
          backgroundColor: '#00000008',
          borderRadius: 10,
          padding: 12,
          marginBottom: 8,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => (open ? setOpenId(null) : openCard(e.id))}
          >
            <Text style={{ fontSize: 16, fontWeight: '600' }}>{e.name}</Text>
            <Text style={{ color: '#888', fontSize: 12 }}>
              {e.measurement_default === 'hold' ? t('Time') : t('Reps')}
            </Text>
          </Pressable>

          {e.is_custom === 1 && (
            <Pressable
              onPress={() => {
                setEditId(e.id);
                setFormOpen(true);
              }}
              style={{ paddingHorizontal: 10, paddingVertical: 6 }}
            >
              <Text style={{ color: '#4aa3df', fontWeight: '600' }}>{t('Edit')}</Text>
            </Pressable>
          )}

        </View>

        {open && (
          <View style={{ marginTop: 10, gap: 4 }}>
            {!!e.description && (
              <Text style={{ color: '#444' }}>{e.description}</Text>
            )}
            <Text style={{ color: '#666', fontSize: 13 }}>
              {t('used in workouts')}: {usage}
            </Text>
            {muscles.length > 0 ? (
              muscles.map((m) => (
                <Text
                  key={m.muscle_id}
                  style={{
                    fontSize: 13,
                    // главные выделены жирным, вторичные приглушены -
                    // так список читается без подписи роли у каждой строки
                    fontWeight: m.role === 'primary' ? '700' : '400',
                    color: m.role === 'primary' ? '#222' : '#777',
                  }}
                >
                  {t(m.name)}
                </Text>
              ))
            ) : (
              <Text style={{ color: '#999', fontSize: 13 }}>{t('Muscles not set')}</Text>
            )}
          </View>
        )}
      </View>
      </SwipeRow>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ padding: 16, paddingTop: 48 }}>
        <Text style={{ fontSize: 24, fontWeight: '700', marginBottom: 10 }}>
          {t('Exercises')}
        </Text>

        <TextInput
          placeholder={t('Search')}
          value={query}
          onChangeText={setQuery}
          style={{
            borderWidth: 1,
            borderColor: '#00000020',
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
          }}
        />

        {!!error && (
          <Text style={{ color: '#b23c3c', marginBottom: 8 }}>{error}</Text>
        )}

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 8,
            gap: 10,
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: '700', flex: 1 }}>{t('Mine')}</Text>
          <Pressable
            onPress={() => {
              setEditId(null);
              setFormOpen(true);
            }}
          >
            <Text style={{ color: '#4aa3df', fontSize: 22 }}>+</Text>
          </Pressable>
        </View>

        {mine.length === 0 ? (
          <Text style={{ color: '#999', marginBottom: 12 }}>
            {t('No exercises of your own yet')}
          </Text>
        ) : (
          mine.map(renderItem)
        )}

        <Text style={{ fontSize: 18, fontWeight: '700', marginVertical: 8 }}>
          {t('Built-in')}
        </Text>
        {builtin.length === 0 ? (
          <Text style={{ color: '#999' }}>{t('Nothing')}</Text>
        ) : (
          builtin.map(renderItem)
        )}
      </View>

      <ExerciseForm
        visible={formOpen}
        exerciseId={editId}
        onClose={() => {
          setFormOpen(false);
          setEditId(null);
        }}
        onSaved={async (id) => {
          setFormOpen(false);
          setEditId(null);
          load();
          // карточка открыта — обновляем её содержимое
          if (openId === id) {
            setMuscles(await getExerciseMuscles(id));
          }
        }}
      />
    </ScrollView>
  );
}
