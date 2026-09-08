import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { searchExercises, type Exercise } from '../db/queries';
import { useT } from '../lib/i18n';
import { matchesQuery } from '../lib/tags';
import { SheetModal } from './SheetModal';
import { ExerciseForm } from './ExerciseForm';

/**
 * Выбор упражнений: отмечаем нужные галочками и подтверждаем кнопкой Add.
 * Тап по строке НЕ закрывает список — иначе набрать несколько упражнений
 * можно только заходя сюда по разу на каждое.
 *
 * onPick вызывается по одному разу на каждое выбранное упражнение,
 * поэтому вызывающий код менять не нужно.
 */
export function ExercisePicker({
  visible,
  onPick,
  onClose,
}: {
  visible: boolean;
  /** Дожидаемся каждого вызова перед закрытием шторки, поэтому может быть async. */
  onPick: (exerciseId: number) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Exercise[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    if (!visible) return;
    searchExercises().then(setItems);
  }, [visible]);

  // По названию и по тегам (мышцы, снаряд) — см. lib/tags.ts
  const found = useMemo(
    () => items.filter((e) => matchesQuery(e, query, t)),
    [items, query, t]
  );

  useEffect(() => {
    if (visible) setChosen([]);
  }, [visible]);

  const toggle = (id: number) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const confirm = async () => {
    // ждём, пока каждый onPick реально дойдёт до конца (включая refresh
    // родителя), и только потом закрываем шторку - иначе она уезжала
    // раньше, чем экран под ней успевал обновиться, и это читалось
    // как мигание.
    for (const id of chosen) {
      await onPick(id);
    }
    onClose();
  };

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#fff' }}>
        {/* Кнопки сверху: до них не надо доскроллить весь список */}
        <View style={{ padding: 16, paddingTop: 48, gap: 10 }}>
          <Pressable
            onPress={confirm}
            disabled={chosen.length === 0}
            style={{
              padding: 14,
              alignItems: 'center',
              backgroundColor: chosen.length === 0 ? '#00000015' : '#3aa655',
              borderRadius: 8,
            }}
          >
            <Text
              style={{
                color: chosen.length === 0 ? '#888' : '#fff',
                fontWeight: '700',
                fontSize: 16,
              }}
            >
              {t('Add')}
              {chosen.length > 0 ? ` (${chosen.length})` : ''}
            </Text>
          </Pressable>

          <Pressable
            onPress={onClose}
            style={{
              padding: 12,
              alignItems: 'center',
              backgroundColor: '#eee',
              borderRadius: 8,
            }}
          >
            <Text>{t('Cancel')}</Text>
          </Pressable>

          <TextInput
            placeholder={t('Search')}
            value={query}
            onChangeText={setQuery}
            style={{
              borderWidth: 1,
              borderColor: '#00000020',
              borderRadius: 8,
              padding: 12,
              fontSize: 16,
            }}
          />

          <Pressable
            onPress={() => setFormOpen(true)}
            style={{
              paddingVertical: 12,
              paddingHorizontal: 14,
              backgroundColor: '#00000008',
              borderRadius: 8,
            }}
          >
            <Text style={{ fontWeight: '600' }}>{t('New exercise')} +</Text>
          </Pressable>
        </View>

        <FlatList
          style={{ flex: 1, paddingHorizontal: 16 }}
          data={found}
          keyExtractor={(i) => String(i.id)}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: '#eee' }} />
          )}
          renderItem={({ item }) => {
            const on = chosen.includes(item.id);
            return (
              <Pressable
                onPress={() => toggle(item.id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 12,
                }}
              >
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 5,
                    borderWidth: 2,
                    borderColor: on ? '#3aa655' : '#00000030',
                    backgroundColor: on ? '#3aa655' : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {on && <Text style={{ color: '#fff', fontSize: 14 }}>✓</Text>}
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16 }}>{item.name}</Text>
                  <Text style={{ fontSize: 12, color: '#888' }}>
                    {item.measurement_default === 'hold' ? t('Time') : t('Reps')}
                    {item.is_custom ? ` · ${t('Mine')}` : ''}
                  </Text>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={{ color: '#888', paddingVertical: 20 }}>
              {t('Nothing found')}
            </Text>
          }
        />
      </View>

      <ExerciseForm
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={(id) => {
          setFormOpen(false);
          // созданное упражнение сразу отмечено, но список не закрываем
          setChosen((c) => (c.includes(id) ? c : [...c, id]));
          searchExercises().then(setItems);
        }}
      />
    </SheetModal>
  );
}
