import { Platform } from 'react-native';

/**
 * Работа с файлом отличается по платформам, поэтому она вынесена сюда,
 * а логика бэкапа (db/backup.ts) о платформах ничего не знает.
 *
 * Нативные модули подгружаются через require внутри функций, а не
 * импортом сверху: на вебе их нет, и статический импорт уронил бы сборку.
 */

export async function saveJsonFile(filename: string, json: string): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  const { File, Paths } = require('expo-file-system');
  const Sharing = require('expo-sharing');

  // Новый API вместо writeAsStringAsync: тот устарел в SDK 54 и с SDK 57
  // ругается предупреждением на весь экран. write и create — синхронные.
  const file = new File(Paths.document, filename);
  file.create({ overwrite: true });
  file.write(json);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: filename,
    });
  }
}

/** Возвращает содержимое выбранного файла или null, если выбор отменили. */
export async function pickJsonFile(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      };
      input.click();
    });
  }

  const DocumentPicker = require('expo-document-picker');
  const { File } = require('expo-file-system');

  const res = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets?.[0]) return null;

  // readAsStringAsync устарел там же, где и writeAsStringAsync:
  // у импорта была ровно та же проблема, просто он реже вызывается.
  const file = new File(res.assets[0].uri);
  return file.text();
}
