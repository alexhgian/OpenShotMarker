/**
 * The single screen (§9). Thin: it holds no timecode maths, only layout, state and the
 * ordering rule. Everything it computes comes from core/.
 *
 * The browser dev harness must work with no device, no camera and no network
 * (CLAUDE.md): manual TC entry replaces the OCR lock, sql.js replaces SQLite, typed
 * notes replace voice.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MARKER_TYPES,
  MARKER_LABELS,
  DEFAULT_PREROLL_MS,
  createSession,
  createCamera,
  softDelete,
  withNote,
  type Marker,
  type MarkerType,
  type Session,
  type Camera,
} from '../core/markers';
import { TcClock, performanceNow, measureOffsetFrames, OFFSET_MEANING } from '../core/clock';
import { tcToFrames, isFpsName, FPS_NAMES, dropAllowed, type FpsName } from '../core/timecode';
import { buildTcfix, tcfixToJson, tcfixFilename } from '../core/export/tcfix';
import { markersToCsv, cameraKeyMap } from '../core/export/csv';
import { SqlJsStore } from '../platform/sqljs-store';
import { IndexedDbBlobStore } from '../platform/blob';
import { MarkerRecorder } from './recorder';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

const DEVICE = 'browser-harness';
const SESSION_LABEL = 'dev harness session';

const TYPE_STYLES: Record<MarkerType, string> = {
  earmark: 'bg-red-600/90 active:bg-red-500',
  great: 'bg-emerald-600/90 active:bg-emerald-500',
  cutaway: 'bg-amber-500/90 active:bg-amber-400',
  inout: 'bg-sky-600/90 active:bg-sky-500',
  note: 'bg-stone-400/90 active:bg-stone-300',
};

interface CameraState {
  camera: Camera;
  clock: TcClock | null;
}

export function App() {
  const [store, setStore] = useState<SqlJsStore | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [cameras, setCameras] = useState<CameraState[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [note, setNote] = useState('');
  const [running, setRunning] = useState<string>('--:--:--:--');
  const [queue, setQueue] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const camerasRef = useRef<CameraState[]>([]);
  camerasRef.current = cameras;

  const refCam = useMemo(
    () => cameras.find((c) => c.camera.key === session?.reference_camera) ?? cameras[0] ?? null,
    [cameras, session],
  );

  // ------------------------------------------------------------------ boot

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = new SqlJsStore({
        blobStore: new IndexedDbBlobStore(),
        locateFile: () => wasmUrl,
      });
      await s.init();

      let sess = (await s.listSessions())[0] ?? null;
      let cams: Camera[] = sess ? await s.listCameras(sess.id) : [];

      if (!sess) {
        sess = createSession({
          label: SESSION_LABEL,
          fps: '29.97',
          drop_frame: true,
          device: DEVICE,
        });
        cams = [
          createCamera({ session_id: sess.id, key: 'A', fps: '29.97', drop_frame: true, label: 'Camera A' }),
          createCamera({ session_id: sess.id, key: 'B', fps: '29.97', drop_frame: true, label: 'Camera B' }),
        ];
        await s.putSession(sess);
        for (const c of cams) await s.putCamera(c);
        await s.persist();
      }

      const loaded = await s.listMarkers(sess.id);
      if (cancelled) return;
      setStore(s);
      setSession(sess);
      setCameras(cams.map((camera) => ({ camera, clock: null })));
      setMarkers(loaded);
      setQueue(await s.queueDepth(sess.id));
    })().catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  // ------------------------------------------------- the running timecode (§9)

  useEffect(() => {
    if (!refCam?.clock) return;
    let raf = 0;
    const tick = () => {
      setRunning(refCam.clock!.tcAt(performanceNow()));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [refCam]);

  // ------------------------------------------------------------- the pad (§9)

  const recorder = useMemo(() => {
    if (!store || !session || !refCam?.clock) return null;
    return new MarkerRecorder({
      store,
      clock: refCam.clock,
      session_id: session.id,
      camera_id: refCam.camera.id,
      device: DEVICE,
      now: performanceNow,
      onCommitted: () => {
        void store.queueDepth(session.id).then(setQueue);
      },
      onError: (_m, err) => setError(String(err)),
    });
  }, [store, session, refCam]);

  /**
   * §9 rule 1. `recorder.capture` is synchronous and takes performance.now() on its
   * first line; this handler is not async and must never become async. Everything
   * below the capture is presentation.
   */
  const onPadPointerDown = useCallback(
    (type: MarkerType) => {
      if (!recorder) return;
      const marker = recorder.capture(type, note.trim() ? { note: note.trim(), source: 'typed' } : {});
      setMarkers((prev) => [marker, ...prev]);
      setNote('');
    },
    [recorder, note],
  );

  // ------------------------------------------------------------ manual lock

  const lockCamera = useCallback(
    (key: string, tc: string, fps: FpsName, drop: boolean) => {
      const t = performanceNow();
      let tcFrame: number;
      try {
        tcFrame = tcToFrames(tc, fps, drop);
      } catch (e) {
        setError(String(e));
        return;
      }
      setError(null);
      setCameras((prev) =>
        prev.map((c) =>
          c.camera.key !== key
            ? c
            : {
                camera: { ...c.camera, fps, drop_frame: drop, last_locked_at: new Date().toISOString() },
                clock: new TcClock({ fps, drop, anchor: { tcFrame, t } }),
              },
        ),
      );
    },
    [],
  );

  // Once two cameras are locked, §6 falls out of the two anchors for free.
  useEffect(() => {
    if (!store || !session) return;
    const ref = camerasRef.current.find((c) => c.camera.key === session.reference_camera);
    if (!ref?.clock) return;
    const t = performanceNow();
    for (const c of camerasRef.current) {
      if (c === ref || !c.clock) continue;
      try {
        const offset = measureOffsetFrames(ref.clock, c.clock, t);
        if (c.camera.offset_frames === offset) continue;
        const updated: Camera = {
          ...c.camera,
          offset_frames: offset,
          offset_measured_at: new Date().toISOString(),
          offset_confidence_frames: 1,
        };
        setCameras((prev) => prev.map((x) => (x.camera.key === c.camera.key ? { ...x, camera: updated } : x)));
        void store.putCamera(updated).then(() => store.persist());
      } catch (e) {
        setError(String(e));
      }
    }
  }, [cameras, store, session]);

  // -------------------------------------------------------------- edit rows

  const editNote = useCallback(
    (m: Marker, text: string) => {
      const updated = withNote(m, text);
      setMarkers((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
      recorder?.update(updated);
    },
    [recorder],
  );

  const removeMarker = useCallback(
    (m: Marker) => {
      const gone = softDelete(m);
      setMarkers((prev) => prev.filter((x) => x.id !== m.id));
      recorder?.update(gone);
    },
    [recorder],
  );

  // ----------------------------------------------------------------- export

  const download = useCallback((filename: string, text: string, mime: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.setAttribute('data-testid', 'download-anchor');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  const exportTcfix = useCallback(() => {
    if (!session) return;
    try {
      const file = buildTcfix({ session, cameras: cameras.map((c) => c.camera), markers });
      download(tcfixFilename(session), tcfixToJson(file), 'application/json');
    } catch (e) {
      setError(String(e));
    }
  }, [session, cameras, markers, download]);

  const exportCsv = useCallback(() => {
    if (!session) return;
    const csv = markersToCsv(markers, { cameraKeys: cameraKeyMap(cameras.map((c) => c.camera)) });
    download(tcfixFilename(session).replace('.tcfix.json', '.csv'), csv, 'text/csv');
  }, [session, cameras, markers, download]);

  if (error && !session) {
    return (
      <main className="p-6 text-red-300" data-testid="fatal">
        {error}
      </main>
    );
  }
  if (!session || !store) {
    return (
      <main className="p-6 text-stone-400" data-testid="booting">
        starting…
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-3 px-3 safe-top safe-bottom">
      <SessionStrip
        session={session}
        cameras={cameras}
        onLock={lockCamera}
        queue={queue}
      />

      <section className="rounded-xl bg-black/40 py-4 text-center">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">
          {session.reference_camera} · {refCam?.camera.fps ?? session.fps}
          {refCam?.camera.drop_frame ? ' DF' : ' NDF'}
        </div>
        <div
          className="font-mono text-4xl tabular-nums tracking-tight"
          data-testid="running-tc"
          data-locked={refCam?.clock ? 'yes' : 'no'}
        >
          {running}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2" data-testid="pad">
        {MARKER_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            disabled={!recorder}
            data-testid={`pad-${type}`}
            // §9: pointerdown, not click. The timestamp is taken inside, first line.
            onPointerDown={() => onPadPointerDown(type)}
            className={`h-20 rounded-xl text-lg font-semibold text-white shadow-lg transition
                        disabled:opacity-30 ${TYPE_STYLES[type]} ${type === 'note' ? 'col-span-2 text-stone-900' : ''}`}
          >
            {MARKER_LABELS[type]}
            <span className="ml-2 align-middle text-xs font-normal opacity-70">
              −{(DEFAULT_PREROLL_MS[type] / 1000).toFixed(1)}s
            </span>
          </button>
        ))}
      </section>

      <input
        data-testid="note-input"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="typed note — attaches to the next marker"
        className="w-full rounded-lg bg-stone-900 px-3 py-3 text-sm outline-none ring-1 ring-stone-800 focus:ring-stone-600"
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={exportTcfix}
          data-testid="export-tcfix"
          className="flex-1 rounded-lg bg-stone-800 py-2 text-sm active:bg-stone-700"
        >
          Export .tcfix.json
        </button>
        <button
          type="button"
          onClick={exportCsv}
          data-testid="export-csv"
          className="flex-1 rounded-lg bg-stone-800 py-2 text-sm active:bg-stone-700"
        >
          Export CSV
        </button>
      </div>

      {error && (
        <div data-testid="error" className="rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <MarkerList markers={markers} onEdit={editNote} onDelete={removeMarker} />
    </main>
  );
}

function SessionStrip({
  session,
  cameras,
  onLock,
  queue,
}: {
  session: Session;
  cameras: CameraState[];
  onLock: (key: string, tc: string, fps: FpsName, drop: boolean) => void;
  queue: number;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <header className="flex flex-col gap-2 pt-2">
      <div className="flex items-baseline justify-between">
        <h1 className="text-sm font-medium text-stone-300">{session.label}</h1>
        <span className="text-[11px] text-stone-500" data-testid="queue-depth">
          {queue} local
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {cameras.map(({ camera, clock }) => (
          <button
            key={camera.key}
            type="button"
            data-testid={`chip-${camera.key}`}
            onClick={() => setOpen(open === camera.key ? null : camera.key)}
            className={`rounded-full px-3 py-1 text-xs ring-1 ${
              clock ? 'bg-emerald-950/60 text-emerald-300 ring-emerald-800' : 'bg-red-950/50 text-red-300 ring-red-900'
            }`}
          >
            {camera.key} · {clock ? 'LOCKED' : 'NEVER LOCKED'}
            {camera.offset_frames !== 0 && (
              <span className="ml-1 opacity-80">
                · {camera.offset_frames > 0 ? '+' : ''}
                {camera.offset_frames}f
              </span>
            )}
          </button>
        ))}
      </div>
      {open && <LockSheet cameraKey={open} onLock={onLock} onClose={() => setOpen(null)} />}
    </header>
  );
}

/**
 * Manual TC entry — the no-camera stand-in for the §4 OCR lock. The operator reads the
 * LCD and types it; the anchor is taken the instant they commit.
 */
function LockSheet({
  cameraKey,
  onLock,
  onClose,
}: {
  cameraKey: string;
  onLock: (key: string, tc: string, fps: FpsName, drop: boolean) => void;
  onClose: () => void;
}) {
  const [tc, setTc] = useState('10:00:00;00');
  const [fps, setFps] = useState<FpsName>('29.97');
  const [drop, setDrop] = useState(true);

  return (
    <div className="rounded-xl bg-stone-900 p-3 ring-1 ring-stone-800" data-testid={`lock-sheet-${cameraKey}`}>
      <div className="mb-2 text-xs text-stone-400">
        Lock camera {cameraKey} — type the timecode on the LCD
      </div>
      <input
        data-testid="lock-tc"
        value={tc}
        onChange={(e) => setTc(e.target.value)}
        className="mb-2 w-full rounded-lg bg-black/50 px-3 py-2 font-mono text-lg tracking-wide outline-none ring-1 ring-stone-800"
      />
      <div className="mb-3 flex items-center gap-2">
        <select
          data-testid="lock-fps"
          value={fps}
          onChange={(e) => {
            const next = e.target.value;
            if (!isFpsName(next)) return;
            setFps(next);
            if (!dropAllowed(next)) setDrop(false);
          }}
          className="rounded-lg bg-black/50 px-2 py-2 text-sm ring-1 ring-stone-800"
        >
          {FPS_NAMES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-stone-400">
          <input
            type="checkbox"
            data-testid="lock-drop"
            checked={drop}
            disabled={!dropAllowed(fps)}
            onChange={(e) => setDrop(e.target.checked)}
          />
          drop-frame
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="lock-confirm"
          onClick={() => {
            onLock(cameraKey, tc, fps, drop);
            onClose();
          }}
          className="flex-1 rounded-lg bg-emerald-700 py-2 text-sm font-medium active:bg-emerald-600"
        >
          Lock
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-stone-800 px-4 py-2 text-sm active:bg-stone-700"
        >
          Cancel
        </button>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-stone-500">{OFFSET_MEANING}</p>
    </div>
  );
}

function MarkerList({
  markers,
  onEdit,
  onDelete,
}: {
  markers: Marker[];
  onEdit: (m: Marker, text: string) => void;
  onDelete: (m: Marker) => void;
}) {
  return (
    <section className="flex-1 pb-6" data-testid="marker-list">
      <div className="mb-1 text-[11px] uppercase tracking-widest text-stone-500">
        Recent markers ({markers.length})
      </div>
      <ul className="flex flex-col gap-1">
        {markers.map((m) => (
          <li
            key={m.id}
            data-testid="marker-row"
            data-tc={m.tc}
            data-frame={m.frame}
            data-type={m.type}
            className="flex items-center gap-2 rounded-lg bg-stone-900/70 px-2 py-2 text-sm"
          >
            <span className="font-mono tabular-nums text-stone-200" data-testid="marker-tc">
              {m.tc}
            </span>
            <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-900" style={{ background: colourOf(m.color) }}>
              {m.type}
            </span>
            <input
              data-testid="marker-note"
              defaultValue={m.note}
              onBlur={(e) => e.target.value !== m.note && onEdit(m, e.target.value)}
              placeholder="note"
              className="min-w-0 flex-1 bg-transparent text-stone-300 outline-none placeholder:text-stone-700"
            />
            <button
              type="button"
              data-testid="marker-delete"
              onClick={() => onDelete(m)}
              className="px-1 text-stone-600 active:text-red-400"
              aria-label={`delete marker at ${m.tc}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Resolve colour names (§8) to something a browser will paint. */
function colourOf(name: string): string {
  const map: Record<string, string> = {
    Red: '#f87171',
    Green: '#34d399',
    Yellow: '#fbbf24',
    Blue: '#60a5fa',
    Cream: '#e7e0cf',
  };
  return map[name] ?? '#a8a29e';
}

