import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  useWindowDimensions,
  View,
  type ColorValue,
} from 'react-native';
import {
  GestureHandlerRootView,
  PanGestureHandler,
  State,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { LanguageProvider, useT } from '../lib/i18n';
import { useWorkoutActive } from '../lib/workoutLock';

// Иконки берём из @expo/vector-icons — он уже стоит вместе с Expo,
// отдельно ставить ничего не нужно.
type IconName = React.ComponentProps<typeof Ionicons>['name'];

// color приходит от навигатора как ColorValue (строка или непрозрачный
// нативный цвет), а не как string — Ionicons принимает и то, и другое.
const icon =
  (name: IconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => (
    <Ionicons name={name} size={size} color={color} />
  );

// Порядок вкладок для свайпа влево/вправо. history сюда не входит — своей
// кнопки в таббаре у неё нет, она открывается только с календаря.
const TAB_ORDER = ['/', '/session', '/workouts', '/exercises', '/settings'];

// Проезд экрана в сторону и обратно: слишком быстро — не читается как
// анимация, слишком медленно — свайп ощущается вязким.
const SLIDE_MS = 220;
// Порог, после которого отпущенный свайп долистывает до соседней вкладки,
// а не пружинит обратно.
const SWIPE_THRESHOLD = 60;

function TabsInner() {
  const { t } = useT();
  const router = useRouter();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  // Свайп конфликтует со свайпами удаления сета/упражнения внутри
  // session.tsx - на время тренировки отключаем.
  const workoutActive = useWorkoutActive();

  const translateX = useRef(new Animated.Value(0)).current;
  // Край, с которого должен въехать новый экран, когда роут реально
  // сменится; null — обычная навигация (таб-бар), эффект ничего не делает.
  const pendingEdge = useRef<number | null>(null);

  // router.push асинхронный: если запускать «въезд» сразу после него, кадр-
  // другой ещё виден старый экран, хотя контейнер уже едет к центру — отсюда
  // была вспышка старого экрана. Стартуем только когда pathname правда
  // обновился, то есть новый экран уже отрисован.
  useEffect(() => {
    if (pendingEdge.current === null) return;
    translateX.setValue(pendingEdge.current);
    pendingEdge.current = null;
    Animated.timing(translateX, {
      toValue: 0,
      duration: SLIDE_MS,
      // быстро проезжаем пустой участок у края, дольше задерживаемся, когда
      // экран уже почти на месте
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [pathname, translateX]);

  const goTo = (path: string, fromEdge: number) => {
    pendingEdge.current = fromEdge;
    router.push(path as never);
  };

  // react-native-reanimated 4 не работает в Expo Go (начиная с v4 требует
  // dev-client), поэтому жест ведём через классический API gesture-handler
  // (onGestureEvent/onHandlerStateChange, колбэки на JS-потоке) и обычный
  // Animated из react-native — то же, чем уже везде в проекте перетаскивают
  // карточки (см. ReorderableList, SwipeRow). Сам PanGestureHandler всё
  // равно нужен: React Navigation (react-native-screens +
  // react-native-gesture-handler) владеет нативным жестовым распознаванием
  // внутри табов, и голый JS PanResponder жест не получал.
  const onGestureEvent = (e: PanGestureHandlerGestureEvent) => {
    const i = TAB_ORDER.indexOf(pathname);
    const { translationX } = e.nativeEvent;
    // на первой/последней вкладке дальше тянуть некуда — тащим с
    // сопротивлением, а не жёстко упираемся в край
    const atStart = i <= 0 && translationX > 0;
    const atEnd = i >= TAB_ORDER.length - 1 && translationX < 0;
    translateX.setValue(atStart || atEnd ? translationX / 3 : translationX);
  };

  const onHandlerStateChange = (e: PanGestureHandlerStateChangeEvent) => {
    if (e.nativeEvent.oldState !== State.ACTIVE) return;
    const i = TAB_ORDER.indexOf(pathname);
    const { translationX } = e.nativeEvent;
    if (i === -1) {
      Animated.timing(translateX, {
        toValue: 0,
        duration: SLIDE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    if (translationX < -SWIPE_THRESHOLD && i < TAB_ORDER.length - 1) {
      // текущий экран доезжает за левый край, следующий стартует у правого
      Animated.timing(translateX, {
        toValue: -width,
        duration: SLIDE_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) goTo(TAB_ORDER[i + 1], width);
      });
    } else if (translationX > SWIPE_THRESHOLD && i > 0) {
      Animated.timing(translateX, {
        toValue: width,
        duration: SLIDE_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) goTo(TAB_ORDER[i - 1], -width);
      });
    } else {
      Animated.timing(translateX, {
        toValue: 0,
        duration: SLIDE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      {/* Лежит за уезжающим экраном и проглядывает ровно в тот момент,
          когда там пусто — саму пустоту без полноценного пейджера не
          убрать, но так она читается как штрих, а не как баг. */}
      <View pointerEvents="none" style={styles.gapBackground}>
        <Image
          source={require('../../assets/splash-icon.png')}
          style={styles.gapIcon}
          resizeMode="contain"
        />
      </View>

      <PanGestureHandler
        enabled={!workoutActive}
        onGestureEvent={onGestureEvent}
        onHandlerStateChange={onHandlerStateChange}
        // активируется только на заметно горизонтальном движении —
        // вертикальный скролл экранов (например, session.tsx) остаётся нетронутым
        activeOffsetX={[-20, 20]}
        failOffsetY={[-15, 15]}
      >
        <Animated.View style={{ flex: 1, transform: [{ translateX }] }}>
          <Tabs screenOptions={{ headerShown: false }}>
            <Tabs.Screen
              name="index"
              options={{ title: t('Calendar'), tabBarIcon: icon('calendar-outline') }}
            />
            <Tabs.Screen
              name="session"
              options={{ title: t('Session'), tabBarIcon: icon('stopwatch-outline') }}
            />
            <Tabs.Screen
              name="workouts"
              options={{ title: t('Workouts'), tabBarIcon: icon('barbell-outline') }}
            />
            <Tabs.Screen
              name="exercises"
              options={{ title: t('Exercises'), tabBarIcon: icon('list-outline') }}
            />
            <Tabs.Screen
              name="settings"
              options={{ title: t('Settings'), tabBarIcon: icon('settings-outline') }}
            />
            {/* история открывается кнопкой с календаря, своей вкладки не имеет */}
            <Tabs.Screen name="history" options={{ href: null }} />
          </Tabs>
        </Animated.View>
      </PanGestureHandler>
    </View>
  );
}

const styles = StyleSheet.create({
  gapBackground: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gapIcon: {
    width: 88,
    height: 88,
    opacity: 0.12,
  },
});

export default function Layout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Экраны приложения всегда светлые (белый фон, светло-красный во
          время подхода), поэтому иконки статус-бара тёмные жёстко, а не
          "auto": auto смотрит на системную тему устройства и в тёмной делал
          их белыми — по белому фону их просто не было видно. */}
      <StatusBar style="dark" />
      <LanguageProvider>
        <TabsInner />
      </LanguageProvider>
    </GestureHandlerRootView>
  );
}
