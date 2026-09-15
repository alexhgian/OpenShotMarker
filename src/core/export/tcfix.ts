/**
 * The fix file (§10.4) — one file per session, the thing TCFix.py consumes. It carries
 * the camera offsets *and* the markers, so one AirDrop does both jobs.
 *
 * Shape is pinned by resolve-plugin/example.tcfix.json and validated by
 * TCFix.load_fixfile, which refuses anything whose format/version it does not know.
 */

import type { Marker, Session, Camera } from '../markers';
import { OFFSET_MEANING } from '../clock';
import { framesToTc, tcToFrames } from '../timecode';

export const TCFIX_FORMAT = 'tcfix';
export const TCFIX_VERSION = 1;
export const GENERATOR = 'tc-marker-app 0.1.0';

export interface TcfixCamera {
  label: string | null;
  fps: string;
  drop: boolean;
  offset_frames: number;
  offset_meaning?: string;
  locked_at?: string | null;
  measured_at?: string | null;
  confidence_frames?: number | null;
  bin_hint?: string;
  lock_quality?: { inliers: number; residual_frames: number } | null;
}

export interface TcfixFile {
  format: string;
  version: number;
  generator: string;
  session: { id: string; label: string; created: string; device: string };
  reference_camera: string;
  cameras: Record<string, TcfixCamera>;
  markers: Array<{
    id: string;
    camera: string;
    tc: string;
    frame: number;
    type: string;
    color: string;
    note: string;
    source: string;
    preroll_ms: number;
    /** §3.4 provenance: mono | wall-fallback | corrected. TCFix.py ignores it. */
    clock: string;
    created: string;
  }>;
}

function cameraEntry(cam: Camera, isReference: boolean): TcfixCamera {
  const entry: TcfixCamera = {
    label: cam.label,
    fps: cam.fps,
    drop: cam.drop_frame,
    offset_frames: cam.offset_frames,
    locked_at: cam.last_locked_at,
    lock_quality: cam.lock_quality,
  };
  if (!isReference) {
    // §10.4: redundant with the spec on purpose — the file outlives the reader's
    // memory of which direction the sign goes.
    entry.offset_meaning = OFFSET_MEANING;
    entry.measured_at = cam.offset_measured_at;
    entry.confidence_frames = cam.offset_confidence_frames;
  }
  if (cam.bin_hint !== null) entry.bin_hint = cam.bin_hint;
  return entry;
}

export function buildTcfix(input: {
  session: Session;
  cameras: Camera[];
  markers: Marker[];
}): TcfixFile {
  const { session, cameras, markers } = input;

  const ref = cameras.find((c) => c.key === session.reference_camera);
  if (!ref) {
    throw new Error(
      `reference_camera ${JSON.stringify(session.reference_camera)} is not in cameras ` +
        `(${cameras.map((c) => c.key).join(', ') || 'none'})`,
    );
  }

  const byId = new Map(cameras.map((c) => [c.id, c]));

  return {
    format: TCFIX_FORMAT,
    version: TCFIX_VERSION,
    generator: GENERATOR,
    session: {
      id: session.id,
      label: session.label,
      created: session.created_at,
      device: session.device,
    },
    reference_camera: session.reference_camera,
    cameras: Object.fromEntries(
      cameras.map((c) => [c.key, cameraEntry(c, c.key === session.reference_camera)]),
    ),
    markers: markers
      .filter((m) => m.deleted_at === null)
      .map((m) => {
        const cam = byId.get(m.camera_id);
        if (!cam) throw new Error(`marker ${m.id} references unknown camera ${m.camera_id}`);
        // The plugin prefers `frame` and falls back to `tc` (§10.4); if the two ever
        // disagreed it would silently place the marker somewhere else. Cheap to check.
        if (tcToFrames(m.tc, cam.fps, cam.drop_frame) !== m.frame) {
          throw new Error(
            `marker ${m.id} is inconsistent: tc ${m.tc} is not frame ${m.frame} at ` +
              `${cam.fps}${cam.drop_frame ? ' DF' : ' NDF'}`,
          );
        }
        return {
          id: m.id,
          camera: cam.key,
          tc: m.tc,
          frame: m.frame,
          type: m.type,
          color: m.color,
          note: m.note,
          source: m.source,
          preroll_ms: m.preroll_ms,
          clock: m.clock,
          created: m.created_at,
        };
      }),
  };
}

export function tcfixToJson(file: TcfixFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

/** `elfyou-tuesday.tcfix.json` — safe on every filesystem TCFix.py globs. */
export function tcfixFilename(session: Session): string {
  const slug =
    session.label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'session';
  return `${slug}.tcfix.json`;
}

/** Re-derive every marker's frame from its tc — the check the acceptance criteria name. */
export function verifyTcfix(file: TcfixFile): void {
  for (const m of file.markers) {
    const cam = file.cameras[m.camera];
    if (!cam) throw new Error(`marker ${m.id} references camera ${m.camera}, which is not listed`);
    const derived = tcToFrames(m.tc, cam.fps, cam.drop);
    if (derived !== m.frame) {
      throw new Error(`marker ${m.id}: tc ${m.tc} derives frame ${derived}, file says ${m.frame}`);
    }
    if (framesToTc(m.frame, cam.fps, cam.drop) !== m.tc) {
      throw new Error(`marker ${m.id}: frame ${m.frame} does not render back to ${m.tc}`);
    }
  }
}
