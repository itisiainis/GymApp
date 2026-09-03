import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { getSetting, setSetting } from '../db/settings';

export type Lang = 'en' | 'ru';

/**
 * Английский — канонический язык: ключи словаря совпадают с английским текстом,
 * поэтому пропущенный перевод деградирует до английского, а не до пустоты.
 * Названия мышц лежат в базе по-английски и переводятся здесь же.
 */
const RU: Record<string, string> = {
  // навигация
  Calendar: 'Календарь',
  Session: 'Тренировка',
  Workouts: 'Тренировки',
  Exercises: 'Упражнения',
  Settings: 'Настройки',

  // календарь
  'View workout history': 'Посмотреть историю тренировок',
  'Recent workouts': 'Последние тренировки',
  'Start a workout': 'Начать тренировку',
  'Nothing recorded yet': 'Пока ничего не записано',
  sets: 'подходов',

  // месяцы
  January: 'Январь', February: 'Февраль', March: 'Март', April: 'Апрель',
  May: 'Май', June: 'Июнь', July: 'Июль', August: 'Август',
  September: 'Сентябрь', October: 'Октябрь', November: 'Ноябрь', December: 'Декабрь',
  Mon: 'Пн', Tue: 'Вт', Wed: 'Ср', Thu: 'Чт', Fri: 'Пт', Sat: 'Сб', Sun: 'Вс',

  // общее
  Cancel: 'Отмена',
  Save: 'Сохранить',
  'Go back': 'Назад',
  Edit: 'Изменить',
  Done: 'Готово',
  Add: 'Добавить',
  Search: 'Поиск...',
  Name: 'Название',
  Nothing: 'Пусто',
  'Nothing found': 'Ничего не найдено',

  // тренировка
  "Let's start": 'Начать',
  'Add set +': 'Добавить подход +',
  'Add exercise +': 'Добавить упражнение +',
  'Reorder exercises': 'Изменить порядок упражнений',
  'Hold an exercise name to reorder': 'Зажми имя упражнения, чтобы поменять порядок',
  'New workout': 'Новая тренировка',
  'Edit workout': 'Изменить тренировку',
  'Pain or sensations during the sets': 'Ощущения, боль во время подходов',
  Total: 'Всего',
  'Last time': 'В прошлый раз',
  Pause: 'Пауза',
  Resume: 'Продолжить',
  Finish: 'Завершить',
  'Workout done': 'Тренировка завершена',
  'New personal records': 'Новых рекордов',
  'Nice work': 'Отличная работа',
  'Unrecorded sets': 'Есть незаписанные подходы',
  'Finish anyway': 'Всё равно завершить',
  'Set is still running': 'Подход всё ещё идёт — не забыл остановить?',
  paused: 'пауза',
  reps: 'повт',
  kg: 'кг',
  sec: 'сек',

  // шаблоны
  'No workouts yet': 'Тренировок пока нет',
  'Exercises in this workout': 'Упражнения в тренировке',
  'This workout has no exercises yet': 'В этой тренировке пока нет упражнений',

  // упражнения
  Mine: 'Мои',
  'Built-in': 'Встроенные',
  'New exercise': 'Новое упражнение',
  'Edit exercise': 'Изменить упражнение',
  Description: 'Описание',
  Reps: 'Повторы',
  Time: 'Время',
  Muscles: 'Мышцы',
  Select: 'Выбрать',
  'Which muscles are involved': 'Какие мышцы участвуют',
  'Which muscles are involved in': 'Какие мышцы участвуют в',

  // сообщения об ошибках
  'Exercise is already used in workouts': 'Упражнение уже есть в записанных тренировках',
  'Exercise is part of a workout template': 'Упражнение входит в состав тренировки — сначала убери его оттуда',
  'Hold and drag to reorder': 'Зажми и перетащи, чтобы поменять порядок',
  'Exercise not found': 'Упражнение не найдено',
  'Built-in exercises cannot be edited': 'Встроенные упражнения нельзя менять',
  'This workout already has recorded sessions': 'По этой тренировке уже есть записи',
  'A workout is already in progress': 'Тренировка уже идёт',
  'Set not found': 'Подход не найден',
  'Another set is already running': 'Другой подход уже идёт',
  'Only the last set can be resumed': 'Продолжить можно только последний подход',
  'Name is required': 'Нужно название',
  'Pick muscles and set percentages': 'Выбери мышцы и проставь проценты',
  'No muscle selected yet': 'Ни одна мышца не выбрана',
  'Split evenly': 'Поровну',
  'By group': 'По группам',
  Alphabetical: 'По алфавиту',
  'used in workouts': 'в тренировках',
  'Muscles not set': 'Мышцы не заданы',
  'No exercises of your own yet': 'Своих упражнений пока нет',

  // история
  History: 'История',
  'No finished workouts yet': 'Пока нет завершённых тренировок',

  // настройки
  Language: 'Язык',
  'Advanced rep recording': 'Продвинутая запись подходов',
  'Advanced rep recording hint': 'По умолчанию подход на повторы отмечается одним тапом. Упражнения на время меряются таймером всегда.',
  'Time every set': 'Мерить время каждого подхода',
  'Trim hint': 'Секунды, которые не считаются рабочими: дойти до снаряда и вернуться к телефону.',
  'Trim at start': 'Срезать в начале, сек',
  'Trim at end': 'Срезать в конце, сек',
  Backup: 'Резервная копия',
  'Backup hint': 'Экспорт сохраняет всё в один JSON-файл: тренировки, упражнения, шаблоны, настройки.',
  'Export data': 'Экспорт',
  'Import data': 'Импорт',
  'Import replaces everything': 'Импорт заменит все текущие данные. Сначала сделай экспорт.',
  'Choose file': 'Выбрать файл',
  Exported: 'Выгружено записей',
  Imported: 'Загружено записей',
  'File is not valid JSON': 'Файл не является корректным JSON',
  'Not a GymApp backup file': 'Это не файл резервной копии GymApp',
  'Backup is from a newer app version': 'Копия сделана в более новой версии приложения',
  English: 'English',
  Russian: 'Русский',

  // группы мышц
  Chest: 'Грудь', Back: 'Спина', Shoulders: 'Плечи',
  Arms: 'Руки', Core: 'Кор', Legs: 'Ноги', Other: 'Прочее',

  // мышцы
  'Upper chest': 'Верх груди',
  'Lower chest': 'Низ груди',
  'Serratus anterior': 'Передняя зубчатая',
  Lats: 'Широчайшие',
  Traps: 'Трапеции',
  Rhomboids: 'Ромбовидные',
  'Lower back': 'Поясница',
  'Teres major': 'Круглые мышцы спины',
  Infraspinatus: 'Подостная',
  'Erector spinae': 'Разгибатели спины',
  'Front delts': 'Передние дельты',
  'Side delts': 'Средние дельты',
  'Rear delts': 'Задние дельты',
  'Rotator cuff': 'Ротаторная манжета',
  Neck: 'Шея',
  Biceps: 'Бицепс',
  Triceps: 'Трицепс',
  Forearms: 'Предплечья',
  Brachialis: 'Плечевая',
  'Wrist extensors': 'Разгибатели запястья',
  'Wrist flexors': 'Сгибатели запястья',
  Abs: 'Пресс',
  Obliques: 'Косые',
  'Transverse abdominis': 'Поперечная живота',
  'Hip flexors': 'Сгибатели бедра',
  Glutes: 'Ягодицы',
  'Glute medius': 'Средняя ягодичная',
  Quads: 'Квадрицепс',
  Hamstrings: 'Бицепс бедра',
  Calves: 'Икры',
  Soleus: 'Камбаловидная',
  'Tibialis anterior': 'Передняя большеберцовая',
  Adductors: 'Приводящие',
  Abductors: 'Отводящие',
};

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const LangContext = createContext<Ctx>({
  lang: 'en',
  setLang: () => {},
  t: (k) => k,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    getSetting('lang').then((v) => {
      if (v === 'ru' || v === 'en') setLangState(v);
    });
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    setSetting('lang', l);
  };

  const t = (key: string) => (lang === 'ru' ? (RU[key] ?? key) : key);

  return createElement(LangContext.Provider, { value: { lang, setLang, t } }, children);
}

export function useT() {
  return useContext(LangContext);
}
