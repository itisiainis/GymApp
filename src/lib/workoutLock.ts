import { useEffect, useState } from 'react';

/**
 * Пока идёт тренировка, горизонтальный свайп между вкладками (_layout.tsx)
 * конфликтует со свайпами внутри session.tsx (удаление сета/упражнения) и
 * может увести с экрана посреди записи подхода. session.tsx публикует сюда
 * состояние "тренировка активна", а _layout.tsx на него подписывается —
 * без контекста/пропсов, так как это разные, не вложенные друг в друга
 * экраны роутера.
 */
let active = false;
const listeners = new Set<(next: boolean) => void>();

export function setWorkoutActive(next: boolean) {
  if (active === next) return;
  active = next;
  listeners.forEach((l) => l(active));
}

export function useWorkoutActive(): boolean {
  const [state, setState] = useState(active);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
