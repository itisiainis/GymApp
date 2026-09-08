import { useRef, useState } from 'react';
import { PanResponder, Pressable, Text, View } from 'react-native';
import { useT } from '../lib/i18n';
import { RIR_DEFAULT, RIR_OPTIONS, rirLabel, type RirValue } from '../lib/rir';
import {
  RIR_ACTIVE,
  RIR_ACTIVE_TEXT,
  RIR_IDLE_BG,
  RIR_IDLE_TEXT,
  RIR_PENDING,
  RIR_PENDING_TEXT,
} from '../lib/theme';

/**
 * Ввод RIR — шкала во всю ширину: все семь значений видны сразу, и
 * добираться до крайних прокруткой не нужно.
 *
 * Раньше это был барабан с прокруткой, и половина шкалы всегда оставалась
 * за краем — на каждый выбор приходился лишний скролл. Выбор из шкалы
 * по-прежнему остаётся движением вдоль неё: палец ведёт по значениям, и
 * они подсвечиваются под ним; тап по значению — то же самое одним
 * касанием.
 *
 * Пока подход не записан, шкала стоит на «>5» и покрашена серым: это
 * осмысленное положение («ещё много»), а не прочерк, но и не ответ.
 * Отдельного слота «не проставлено» нет — то, что подход ещё не записан,
 * видно по цвету, как и у остальных значений подхода.
 *
 * ВАЖНО, где она стоит. Жест горизонтальный, и строка подхода завёрнута в
 * SwipeRow, который ловит горизонтальный свайп для удаления. Вложить одно
 * в другое — тот самый конфликт жестов, из-за которого свайп подхода
 * когда-то удалял всё упражнение. Поэтому шкала живёт на СВОЕЙ строке,
 * снаружи SwipeRow (см. session.tsx), а не внутри SetLine.
 */

function indexOfValue(value: RirValue | null): number {
  const i = RIR_OPTIONS.indexOf(value ?? RIR_DEFAULT);
  return i === -1 ? 0 : i;
}

export function RirDrum({
  value,
  onChange,
  disabled = false,
}: {
  /** null — RIR не проставлен: шкала стоит на «>5» и покрашена серым. */
  value: RirValue | null;
  /** null означает «снять отметку». */
  onChange: (next: RirValue | null) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [width, setWidth] = useState(0);
  /** Значение под пальцем, пока ведут. null — не ведут. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const selected = indexOfValue(value);
  const shown = dragIndex ?? selected;
  const itemWidth = width > 0 ? width / RIR_OPTIONS.length : 0;

  // PanResponder создаётся один раз, поэтому всё, что меняется от
  // рендера к рендеру, читаем через ref — иначе жест застрянет на
  // значениях первого рендера (та же причина, что в SwipeRow).
  const state = useRef({ selected, itemWidth, disabled, onChange, value });
  state.current = { selected, itemWidth, disabled, onChange, value };
  const startIndex = useRef(0);

  const clamp = (i: number) => Math.min(RIR_OPTIONS.length - 1, Math.max(0, i));

  const responder = useRef(
    PanResponder.create({
      // Не на старте касания, а только на заметно горизонтальном движении:
      // иначе шкала перехватывала бы вертикальную прокрутку списка.
      onMoveShouldSetPanResponder: (_, g) =>
        !state.current.disabled &&
        state.current.itemWidth > 0 &&
        Math.abs(g.dx) > 6 &&
        Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderGrant: () => {
        startIndex.current = state.current.selected;
        setDragIndex(state.current.selected);
      },
      // Сдвиг считаем от начала жеста, а не от координат на экране: так
      // не нужно знать, где именно шкала лежит на странице.
      onPanResponderMove: (_, g) => {
        const steps = Math.round(g.dx / state.current.itemWidth);
        setDragIndex(
          Math.min(RIR_OPTIONS.length - 1, Math.max(0, startIndex.current + steps))
        );
      },
      onPanResponderRelease: (_, g) => {
        const steps = Math.round(g.dx / state.current.itemWidth);
        const next = Math.min(
          RIR_OPTIONS.length - 1,
          Math.max(0, startIndex.current + steps)
        );
        setDragIndex(null);
        // Довели до того же значения — но если подход ещё не записан, это
        // первый осознанный выбор, и записать его надо.
        if (next !== state.current.selected || state.current.value === null) {
          state.current.onChange(RIR_OPTIONS[next]);
        }
      },
      onPanResponderTerminate: () => setDragIndex(null),
    })
  ).current;

  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, opacity: disabled ? 0.35 : 1 }}
    >
      <Text style={{ fontSize: 12, fontWeight: '700', color: RIR_IDLE_TEXT, width: 30 }}>
        {t('RIR')}
      </Text>

      <View
        style={{ flex: 1, flexDirection: 'row' }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        {...(disabled ? {} : responder.panHandlers)}
      >
        {RIR_OPTIONS.map((slot, i) => {
          const isSelected = i === shown;
          // Пока ведут пальцем, значение ещё не записано — подсветка
          // показывает, на чём остановишься, а не что уже выбрано.
          const isAnswer = isSelected && (dragIndex !== null || value !== null);
          return (
            <Pressable
              key={slot}
              disabled={disabled}
              // Тап — то же движение по шкале, только в одно касание.
              // Повторный тап по выбранному снимает отметку: другого пути
              // назад у шкалы без слота «не проставлено» нет.
              onPress={() => {
                if (i === selected && value !== null) onChange(null);
                else onChange(RIR_OPTIONS[i]);
              }}
              style={{ flex: 1, paddingHorizontal: 2, paddingVertical: 4 }}
            >
              <View
                style={{
                  borderRadius: 999,
                  paddingVertical: 5,
                  alignItems: 'center',
                  backgroundColor: isSelected
                    ? isAnswer
                      ? RIR_ACTIVE
                      : RIR_PENDING
                    : RIR_IDLE_BG,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 13,
                    fontWeight: isSelected ? '700' : '500',
                    color: isSelected
                      ? isAnswer
                        ? RIR_ACTIVE_TEXT
                        : RIR_PENDING_TEXT
                      : RIR_IDLE_TEXT,
                  }}
                >
                  {rirLabel(slot)}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
