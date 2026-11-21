/**
 * 0.35.0: spoken time warnings on the customer PCs ("Edhe 5 minuta", "Koha juaj mbaroi").
 *
 * The switch, the language, the volume and the chime are ordinary settings: they join the page's
 * draft and are saved with "Save". The owner's own recordings are files: an upload is stored at
 * once and reaches every PC right away. "Try" plays an announcement on this computer the way a PC
 * would play it — same order (chime, then the owner's recording or the built-in voice), same
 * volume.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play, Square, Trash2, Upload } from 'lucide-react';
import {
  VOICE_CHIME_FILE,
  VOICE_LANGUAGES,
  VOICE_SLOT_UP,
  VOICE_UPLOAD_MAX_BYTES,
  VOICE_UPLOAD_MAX_SECONDS,
  hasBuiltInVoice,
  voiceFileUrl,
  voicePlan,
  voiceSlots,
  type SettingKey,
  type SettingsMap,
  type VoiceCustomMap,
} from '@likapcs/shared';
import { api, ApiError, apiUpload, fileUrl } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Badge, Button, Card, Field, Segmented, Switch } from '../ui/primitives';

interface Props {
  /** The settings as the page shows them (saved values with the unsaved changes on top). */
  current: SettingsMap;
  set: <K extends SettingKey>(key: K, value: SettingsMap[K]) => void;
  readOnly: boolean;
}

const builtInUrl = (file: string) => `${import.meta.env.BASE_URL}voice/${file}`;
const CHIME_VOLUME = 0.7;

/** Seconds of an audio file, or null when this browser cannot read it. */
function audioSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 5000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

export function VoiceCard({ current, set, readOnly }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSlot = useRef<string | null>(null);
  const stopPlaying = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => () => stopPlaying.current?.(), []);

  const enabled = current['client.voice_enabled'];
  const language = current['client.voice_language'];
  const volume = current['client.voice_volume'];
  const chime = current['client.voice_chime'];
  const custom = current['client.voice_custom'];
  const slots = voiceSlots(current['stations.expiry_warning_minutes']);
  // Recordings kept from a minute that is no longer warned about: shown, so they can be removed.
  const unused = Object.keys(custom).filter((slot) => !slots.includes(slot));

  const slotLabel = (slot: string) =>
    slot === VOICE_SLOT_UP
      ? t('settings.voice.slotUp')
      : slot === '1'
        ? t('settings.voice.slotOneMinute')
        : t('settings.voice.slotMinutes', { n: Number(slot) });

  const applyCustom = (next: VoiceCustomMap) => {
    queryClient.setQueryData<SettingsMap>(['settings', 'all'], (old) =>
      old ? { ...old, 'client.voice_custom': next } : old,
    );
    void queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  const stop = () => {
    stopPlaying.current?.();
    stopPlaying.current = null;
    setPlaying(null);
  };

  /** Plays the announcement on this computer, as a PC would: chime, then the first source that plays. */
  const preview = async (slot: string) => {
    stop();
    const plan = voicePlan(
      {
        enabled: true, // "Try" also works while the voice is still switched off
        language,
        volume,
        chime,
        custom: Object.fromEntries(
          Object.entries(custom).map(([s, clip]) => [s, fileUrl(voiceFileUrl(clip.file)) ?? '']),
        ),
      },
      slot,
    );
    if (!plan) {
      toast.error(volume <= 0 ? t('settings.voice.silent') : t('settings.voice.nothingToPlay'));
      return;
    }
    let cancelled = false;
    const audios: HTMLAudioElement[] = [];
    stopPlaying.current = () => {
      cancelled = true;
      for (const audio of audios) audio.pause();
    };
    const play = (url: string, level: number) =>
      new Promise<void>((resolve, reject) => {
        if (cancelled) return resolve();
        const audio = new Audio(url);
        audios.push(audio);
        audio.volume = Math.min(1, Math.max(0, level));
        audio.onended = () => resolve();
        audio.onpause = () => cancelled && resolve();
        audio.onerror = () => reject(new Error('cannot play'));
        audio.play().catch(reject);
      });
    setPlaying(slot);
    try {
      if (plan.chime) {
        await play(builtInUrl(VOICE_CHIME_FILE), plan.volume * CHIME_VOLUME).catch(() => undefined);
        if (plan.sources.length > 0 && !cancelled) await new Promise((r) => setTimeout(r, 180));
      }
      let said = plan.sources.length === 0;
      for (const source of plan.sources) {
        if (cancelled) break;
        try {
          await play(source.kind === 'custom' ? source.url : builtInUrl(source.file), plan.volume);
          said = true;
          break;
        } catch {
          // the next source (the built-in voice) still speaks, as on the PC
        }
      }
      if (!said && !cancelled) toast.error(t('settings.voice.playFailed'));
    } finally {
      if (!cancelled) {
        stopPlaying.current = null;
        setPlaying(null);
      }
    }
  };

  const pickFile = (slot: string) => {
    uploadSlot.current = slot;
    fileInput.current?.click();
  };

  const onFile = async (file: File | undefined) => {
    const slot = uploadSlot.current;
    if (fileInput.current) fileInput.current.value = '';
    if (!file || !slot) return;
    if (file.size > VOICE_UPLOAD_MAX_BYTES) {
      toast.error(t('settings.voice.tooLarge'));
      return;
    }
    const seconds = await audioSeconds(file);
    if (seconds !== null && seconds > VOICE_UPLOAD_MAX_SECONDS) {
      toast.error(t('settings.voice.tooLong', { seconds: VOICE_UPLOAD_MAX_SECONDS }));
      return;
    }
    setBusy(slot);
    try {
      const res = await apiUpload<{ custom: VoiceCustomMap }>(
        `/client/voice/${slot}`,
        file,
        { name: file.name },
        { method: 'PUT' },
      );
      applyCustom(res.custom);
      toast.success(t('settings.voice.uploaded'));
    } catch (err) {
      const code =
        err instanceof ApiError ? (err.details as { code?: string } | undefined)?.code : '';
      if (err instanceof ApiError && err.status === 413) toast.error(t('settings.voice.tooLarge'));
      else if (code === 'VOICE_FORMAT' || code === 'VOICE_EMPTY')
        toast.error(t('settings.voice.notAudio'));
      else toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (slot: string) => {
    setBusy(slot);
    try {
      const res = await api<{ custom: VoiceCustomMap }>(`/client/voice/${slot}`, {
        method: 'DELETE',
      });
      applyCustom(res.custom);
      toast.success(t('settings.voice.removed'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    } finally {
      setBusy(null);
    }
  };

  const row = (slot: string, inUse: boolean) => {
    const clip = custom[slot];
    const builtIn = hasBuiltInVoice(slot);
    return (
      <div className="voice-row" key={slot} data-testid={`voice-row-${slot}`} data-unused={!inUse}>
        <div className="voice-row__what">
          <strong>{slotLabel(slot)}</strong>
          {!inUse && <span className="faint"> · {t('settings.voice.unused')}</span>}
        </div>
        <div className="voice-row__plays" data-testid={`voice-plays-${slot}`}>
          {clip ? (
            <>
              <Badge tone="info">{t('settings.voice.custom')}</Badge>
              <span className="voice-row__file" title={clip.name}>
                {clip.name}
              </span>
            </>
          ) : builtIn ? (
            <span>
              {t('settings.voice.builtIn', { language: t(`settings.voice.lang.${language}`) })}
            </span>
          ) : (
            <span className="text-warning">
              {chime ? t('settings.voice.chimeOnly') : t('settings.voice.nothing')}
            </span>
          )}
        </div>
        <div className="voice-row__actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (playing === slot ? stop() : void preview(slot))}
            data-testid={`voice-play-${slot}`}
            aria-label={`${t('settings.voice.play')} — ${slotLabel(slot)}`}
          >
            {playing === slot ? <Square size={14} /> : <Play size={14} />}
            {playing === slot ? t('settings.voice.stop') : t('settings.voice.play')}
          </Button>
          {!readOnly && inUse && (
            <Button
              size="sm"
              loading={busy === slot}
              disabled={busy !== null}
              onClick={() => pickFile(slot)}
              data-testid={`voice-upload-${slot}`}
            >
              <Upload size={14} />
              {clip ? t('settings.voice.replace') : t('settings.voice.upload')}
            </Button>
          )}
          {!readOnly && clip && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void remove(slot)}
              data-testid={`voice-remove-${slot}`}
              aria-label={`${t('settings.voice.remove')} — ${slotLabel(slot)}`}
            >
              <Trash2 size={14} />
              {t('settings.voice.remove')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card
      title={t('settings.voice.title')}
      subtitle={t('settings.voice.subtitle')}
      testId="voice-card"
    >
      <div className="form-grid">
        <div className="span-2">
          <Switch
            checked={enabled}
            onChange={(v) => set('client.voice_enabled', v)}
            disabled={readOnly}
            testId="voice-enabled"
            label={
              <span>
                {t('settings.voice.enabled')}
                <div className="faint" style={{ fontSize: 12 }}>
                  {t('settings.voice.enabledHint')}
                </div>
              </span>
            }
          />
        </div>
        <Field label={t('settings.voice.language')}>
          {() => (
            <Segmented
              value={language}
              options={VOICE_LANGUAGES.map((v) => ({
                value: v,
                label: t(`settings.voice.lang.${v}`),
              }))}
              onChange={(v) => !readOnly && set('client.voice_language', v)}
              testId="voice-language"
            />
          )}
        </Field>
        <Field label={`${t('settings.voice.volume')} · ${volume}%`}>
          {(id) => (
            <input
              id={id}
              type="range"
              className="voice-volume"
              min={0}
              max={100}
              step={5}
              value={volume}
              disabled={readOnly}
              onChange={(e) => set('client.voice_volume', Number(e.target.value))}
              data-testid="voice-volume"
            />
          )}
        </Field>
        <div className="span-2">
          <Switch
            checked={chime}
            onChange={(v) => set('client.voice_chime', v)}
            disabled={readOnly}
            testId="voice-chime"
            label={
              <span>
                {t('settings.voice.chime')}
                <div className="faint" style={{ fontSize: 12 }}>
                  {t('settings.voice.chimeHint')}
                </div>
              </span>
            }
          />
        </div>
      </div>

      <h4 className="voice-rows__title">{t('settings.voice.announcements')}</h4>
      <p className="faint voice-rows__hint">{t('settings.voice.announcementsHint')}</p>
      <div className="voice-rows" data-testid="voice-rows">
        {slots.map((slot) => row(slot, true))}
        {unused.map((slot) => row(slot, false))}
      </div>
      <p className="faint voice-rows__hint">{t('settings.voice.formats')}</p>
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a"
        hidden
        data-testid="voice-file"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
    </Card>
  );
}
