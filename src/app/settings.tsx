import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { backupToJson, exportBackup, importBackup } from '../db/backup';
import {
  DEFAULT_RECORDING,
  getRecordingSettings,
  setRecordingSettings,
  type RecordingSettings,
} from '../db/settings';
import { pickJsonFile, saveJsonFile } from '../lib/backup-file';
import { useT, type Lang } from '../lib/i18n';

export default function Settings() {
  const { t, lang, setLang } = useT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmImport, setConfirmImport] = useState(false);
  const [rec, setRec] = useState<RecordingSettings>(DEFAULT_RECORDING);

  useEffect(() => {
    getRecordingSettings().then(setRec);
  }, []);

  const saveRec = (next: RecordingSettings) => {
    setRec(next);
    setRecordingSettings(next);
  };

  const options: { key: Lang; label: string }[] = [
    { key: 'en', label: t('English') },
    { key: 'ru', label: t('Russian') },
  ];

  const doExport = async () => {
    try {
      setBusy(true);
      setError('');
      setMessage('');
      const backup = await exportBackup();
      const stamp = new Date().toISOString().slice(0, 10);
      await saveJsonFile(`gymapp-${stamp}.json`, backupToJson(backup));
      const count = Object.values(backup.tables).reduce((s, r) => s + r.length, 0);
      setMessage(`${t('Exported')}: ${count}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    try {
      setBusy(true);
      setError('');
      setMessage('');
      const json = await pickJsonFile();
      if (json === null) return;
      const res = await importBackup(json);
      setMessage(`${t('Imported')}: ${res.rows}`);
      setConfirmImport(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ padding: 16, paddingTop: 48, gap: 14 }}>
        <Text style={{ fontSize: 24, fontWeight: '700' }}>{t('Settings')}</Text>

        <Text style={{ fontWeight: '600', marginTop: 8 }}>{t('Language')}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {options.map((o) => (
            <Pressable
              key={o.key}
              onPress={() => setLang(o.key)}
              style={{
                flex: 1,
                padding: 14,
                alignItems: 'center',
                borderRadius: 8,
                backgroundColor: lang === o.key ? '#4aa3df' : '#00000010',
              }}
            >
              <Text style={{ color: lang === o.key ? '#fff' : '#333', fontWeight: '600' }}>
                {o.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={{ fontWeight: '600', marginTop: 16 }}>
          {t('Recording rep sets')}
        </Text>
        <Text style={{ color: '#888', fontSize: 13 }}>
          {t('Recording rep sets hint')}
        </Text>

        <Pressable
          onPress={() => saveRec({ ...rec, advancedReps: !rec.advancedReps })}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 10,
          }}
        >
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 5,
              borderWidth: 2,
              borderColor: rec.advancedReps ? '#3aa655' : '#00000030',
              backgroundColor: rec.advancedReps ? '#3aa655' : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {rec.advancedReps && <Text style={{ color: '#fff', fontSize: 14 }}>✓</Text>}
          </View>
          <Text style={{ fontSize: 15 }}>{t('Record sets with a stopwatch')}</Text>
        </Pressable>

        {/* Срезка — своя настройка, а не приложение к секундомеру для
            повторов: упражнения на время меряются таймером всегда, и
            снятая галочка выше её не отменяет. Раньше она вместе с
            галочкой пропадала с экрана, хотя продолжала действовать. */}
        <Text style={{ fontWeight: '600', marginTop: 16 }}>{t('Trimming')}</Text>
        <Text style={{ color: '#888', fontSize: 13 }}>{t('Trim hint')}</Text>

        <View style={{ gap: 8 }}>
          {([
            ['prepSeconds', 'Trim at start'],
            ['reachSeconds', 'Trim at end'],
          ] as const).map(([key, label]) => (
            <View
              key={key}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              <Text style={{ flex: 1 }}>{t(label)}</Text>
              <TextInput
                keyboardType="numeric"
                value={String(rec[key])}
                onChangeText={(v) =>
                  saveRec({ ...rec, [key]: Number(v.replace(/\D/g, '')) || 0 })
                }
                style={{
                  width: 64,
                  borderWidth: 1,
                  borderColor: '#00000020',
                  borderRadius: 8,
                  padding: 8,
                  textAlign: 'right',
                }}
              />
            </View>
          ))}
        </View>

        <Text style={{ fontWeight: '600', marginTop: 16 }}>{t('Backup')}</Text>
        <Text style={{ color: '#888', fontSize: 13 }}>{t('Backup hint')}</Text>

        <Pressable
          disabled={busy}
          onPress={doExport}
          style={{
            padding: 14,
            alignItems: 'center',
            borderRadius: 8,
            backgroundColor: '#3aa655',
            opacity: busy ? 0.5 : 1,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>{t('Export data')}</Text>
        </Pressable>

        {!confirmImport ? (
          <Pressable
            disabled={busy}
            onPress={() => setConfirmImport(true)}
            style={{
              padding: 14,
              alignItems: 'center',
              borderRadius: 8,
              backgroundColor: '#00000010',
              opacity: busy ? 0.5 : 1,
            }}
          >
            <Text style={{ fontWeight: '600' }}>{t('Import data')}</Text>
          </Pressable>
        ) : (
          <View style={{ gap: 8 }}>
            <Text style={{ color: '#b23c3c' }}>{t('Import replaces everything')}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                disabled={busy}
                onPress={() => setConfirmImport(false)}
                style={{
                  flex: 1,
                  padding: 14,
                  alignItems: 'center',
                  borderRadius: 8,
                  backgroundColor: '#eee',
                }}
              >
                <Text>{t('Cancel')}</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={doImport}
                style={{
                  flex: 1,
                  padding: 14,
                  alignItems: 'center',
                  borderRadius: 8,
                  backgroundColor: '#b23c3c',
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>
                  {t('Choose file')}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {!!message && <Text style={{ color: '#3aa655' }}>{message}</Text>}
        {!!error && <Text style={{ color: '#b23c3c' }}>{t(error)}</Text>}

        <Text style={{ color: '#888', fontSize: 13, marginTop: 12 }}>
          Russian covers the current screens only; the rest stays in English for now.
        </Text>
      </View>
    </ScrollView>
  );
}
