import { useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, View } from 'react-native';

/**
 * Список с перетаскиванием: зажать строку и потянуть.
 *
 * Высота строки фиксирована — это позволяет считать новый индекс
 * простым делением смещения на высоту, без измерения каждой строки.
 */
export function DragList<T>({
  items,
  keyOf,
  renderItem,
  onReorder,
  rowHeight = 56,
  gap = 8,
}: {
  items: T[];
  keyOf: (item: T) => string | number;
  renderItem: (item: T, index: number, dragging: boolean) => React.ReactNode;
  onReorder: (next: T[]) => void;
  rowHeight?: number;
  gap?: number;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const dy = useRef(new Animated.Value(0)).current;
  const step = rowHeight + gap;

  // насколько позиций сдвинулась зажатая строка
  const shift = dragIndex === null ? 0 : Math.round(offset / step);
  const target =
    dragIndex === null
      ? null
      : Math.max(0, Math.min(items.length - 1, dragIndex + shift));

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: () => dragIndexRef.current !== null,
      onPanResponderMove: (_, g) => {
        dy.setValue(g.dy);
        setOffset(g.dy);
      },
      onPanResponderRelease: () => {
        const from = dragIndexRef.current;
        const to = targetRef.current;
        if (from !== null && to !== null && from !== to) {
          const next = [...itemsRef.current];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          onReorder(next);
        }
        dy.setValue(0);
        setOffset(0);
        setDragIndex(null);
      },
      onPanResponderTerminate: () => {
        dy.setValue(0);
        setOffset(0);
        setDragIndex(null);
      },
    })
  ).current;

  // PanResponder создаётся один раз, поэтому актуальные значения
  // передаём через ref, а не через замыкание
  const dragIndexRef = useRef<number | null>(null);
  const targetRef = useRef<number | null>(null);
  const itemsRef = useRef(items);
  dragIndexRef.current = dragIndex;
  targetRef.current = target;
  itemsRef.current = items;

  return (
    <View>
      {items.map((item, i) => {
        const dragging = dragIndex === i;

        // остальные строки расступаются, освобождая место
        let slide = 0;
        if (dragIndex !== null && target !== null && !dragging) {
          if (dragIndex < target && i > dragIndex && i <= target) slide = -step;
          if (dragIndex > target && i >= target && i < dragIndex) slide = step;
        }

        return (
          <Animated.View
            key={keyOf(item)}
            style={{
              height: rowHeight,
              marginBottom: gap,
              transform: [{ translateY: dragging ? dy : slide }],
              zIndex: dragging ? 10 : 0,
              elevation: dragging ? 6 : 0,
              opacity: dragging ? 0.95 : 1,
            }}
            {...(dragging ? responder.panHandlers : {})}
          >
            <Pressable
              delayLongPress={220}
              onLongPress={() => setDragIndex(i)}
              style={{ flex: 1 }}
            >
              {renderItem(item, i, dragging)}
            </Pressable>
          </Animated.View>
        );
      })}
    </View>
  );
}
